import { spawn } from "node:child_process"

/** The published npm identity. Everything W1 ships lives under the owned @w1-lab scope. */
export const W1_NPM_PACKAGE = "@w1-lab/cli"

const REGISTRY = "https://registry.npmjs.org"

function parse(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** True when `candidate` is a strictly newer release than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parse(candidate)
  const now = parse(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index++) {
    if (next[index] !== now[index]) return next[index]! > now[index]!
  }
  return false
}

/**
 * Reads the latest published version. Returns undefined on any failure: a start-up notice must
 * never block the CLI or surface a network error to someone who just wants to work.
 */
export async function latestPublishedVersion(timeoutMs = 2500): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${REGISTRY}/${W1_NPM_PACKAGE.replace("/", "%2f")}/latest`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === "string" ? body.version : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export type UpdateOutcome =
  | { status: "updated"; version: string }
  | { status: "current"; version: string }
  | { status: "failed"; message: string }

/**
 * Installs the latest release globally. Uses the same command a user would type, so whatever
 * permissions their npm prefix needs are the permissions they already have.
 */
export function runNpmUpdate(version = "latest"): Promise<UpdateOutcome> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "--global", `${W1_NPM_PACKAGE}@${version}`, "--no-fund", "--no-audit"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    })
    let stderr = ""
    child.stdout?.on("data", () => {})
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    child.on("error", (cause) => {
      resolve({
        status: "failed",
        message:
          cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT"
            ? "npm was not found on PATH. Install Node.js, or reinstall with: npm install --global " + W1_NPM_PACKAGE
            : cause instanceof Error
              ? cause.message
              : String(cause),
      })
    })
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ status: "updated", version })
        return
      }
      const permission = /EACCES|permission denied/i.test(stderr)
      resolve({
        status: "failed",
        message: permission
          ? "npm could not write to the global install location. Re-run the install with the permissions your npm prefix needs."
          : (stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ") || `npm exited with code ${code}`),
      })
    })
  })
}
