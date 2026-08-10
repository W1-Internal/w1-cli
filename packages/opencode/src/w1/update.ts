import { spawn } from "node:child_process"
import { readdir, rm, stat } from "node:fs/promises"
import nodePath from "node:path"

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
 * Clear npm's half-finished staging directories for our scope.
 *
 * A global install renames the existing package aside into `.<name>-<random>` before moving the new
 * one in. If that is interrupted — or the directory is busy, which it is here, because this very
 * process and its engine daemons live inside it — npm fails with ENOTEMPTY and can leave BOTH the
 * staging directory and an empty package directory behind. The user is then left with no CLI at
 * all: `w1` is simply gone. Clearing the leftovers lets the retry below succeed.
 */
async function clearNpmStaging(): Promise<void> {
  const root = await new Promise<string>((resolve) => {
    let out = ""
    const probe = spawn("npm", ["root", "--global"], { stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true })
    probe.stdout?.on("data", (chunk) => (out += String(chunk)))
    probe.on("error", () => resolve(""))
    probe.on("exit", () => resolve(out.trim()))
  })
  if (!root) return
  const scope = nodePath.join(root, W1_NPM_PACKAGE.split("/")[0]!)
  try {
    for (const entry of await readdir(scope)) {
      if (entry.startsWith(".")) await rm(nodePath.join(scope, entry), { recursive: true, force: true })
    }
  } catch {
    // Nothing staged, or not ours to clean — the retry simply proceeds without it.
  }
}

/** Is the package actually present and runnable right now? */
async function packageInstalled(): Promise<boolean> {
  const root = await new Promise<string>((resolve) => {
    let out = ""
    const probe = spawn("npm", ["root", "--global"], { stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true })
    probe.stdout?.on("data", (chunk) => (out += String(chunk)))
    probe.on("error", () => resolve(""))
    probe.on("exit", () => resolve(out.trim()))
  })
  if (!root) return true // cannot tell; do not cry wolf
  try {
    await stat(nodePath.join(root, W1_NPM_PACKAGE, "package.json"))
    return true
  } catch {
    return false
  }
}

function runNpmUpdateOnce(version: string): Promise<UpdateOutcome> {
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
      if (permission) {
        resolve({
          status: "failed",
          message:
            "npm could not write to the global install location. Re-run the install with the permissions your npm prefix needs.",
        })
        return
      }
      // ENOTEMPTY is npm tripping over its own leftovers while replacing a package that is
      // currently in use — which ours always is, since the update runs from inside it. Clear the
      // staging directories and try once more before reporting anything to the user.
      if (/ENOTEMPTY/i.test(stderr)) {
        void (async () => {
          await clearNpmStaging()
          const retry = await runNpmUpdateOnce(version)
          if (retry.status === "updated") {
            resolve(retry)
            return
          }
          // Never leave the user guessing whether they still have a CLI. A failed replace can
          // remove the old package outright, and "update failed" does not tell them that `w1` is
          // now gone or how to get it back.
          const present = await packageInstalled()
          resolve({
            status: "failed",
            message: present
              ? retry.message
              : `The update removed the previous install and could not finish. W1 is not currently installed. Reinstall with: npm install --global ${W1_NPM_PACKAGE}`,
          })
        })()
        return
      }
      resolve({
        status: "failed",
        message: stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ") || `npm exited with code ${code}`,
      })
    })
  })
}

/**
 * Installs the latest release globally. Uses the same command a user would type, so whatever
 * permissions their npm prefix needs are the permissions they already have.
 */
export function runNpmUpdate(version = "latest"): Promise<UpdateOutcome> {
  return runNpmUpdateOnce(version)
}
