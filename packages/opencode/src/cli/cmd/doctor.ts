import { cmd } from "./cmd"
import { W1Runtime } from "@/w1/runtime"
import { EngineClient, engineClientVersion, resolveEngine, type ThreadSummary } from "@/w1/engine"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "path"
import { stat } from "fs/promises"
import { W1Auth } from "@/w1/auth"

type Check = {
  name: string
  status: "ok" | "warn" | "fail"
  detail: string
}

export const DoctorCommand = cmd<{}, { project?: string; json?: boolean }>({
  command: "doctor [project]",
  describe: "diagnose W1 without starting an agent turn",
  builder: (yargs) =>
    yargs
      .positional("project", { type: "string", describe: "project directory" })
      .option("json", { type: "boolean", default: false, describe: "print machine-readable output" }),
  handler: async (args) => {
    const directory = path.resolve(args.project ?? process.cwd())
    const checks = await diagnostics(directory)
    if (args.json) {
      process.stdout.write(JSON.stringify({ product: "w1", directory, checks }, null, 2) + "\n")
    } else {
      process.stdout.write(`W1 doctor · ${directory}\n\n`)
      for (const check of checks) {
        const mark = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗"
        process.stdout.write(` ${mark} ${check.name.padEnd(12)} ${check.detail}\n`)
      }
      process.stdout.write(
        "\nEditor reconnect errors are separate from these OS/runtime checks. A backend or auth failure still affects every surface.\n",
      )
    }
    if (checks.some((check) => check.status === "fail")) process.exitCode = 2
  },
})

async function diagnostics(directory: string) {
  const checks: Check[] = []
  checks.push({ name: "build", status: "ok", detail: W1Runtime.buildID })
  checks.push(
    (await stat(directory)
      .then((value) => value.isDirectory())
      .catch(() => false))
      ? { name: "filesystem", status: "ok", detail: "project path exists" }
      : { name: "filesystem", status: "fail", detail: "project path does not exist" },
  )

  const git = Bun.spawnSync({
    cmd: ["git", "-C", directory, "rev-parse", "--is-inside-work-tree"],
    stdout: "pipe",
    stderr: "pipe",
  })
  checks.push(
    git.exitCode === 0
      ? { name: "git", status: "ok", detail: "repository discovered" }
      : { name: "git", status: "warn", detail: "folder is not a Git repository" },
  )

  const authPath = W1Auth.sessionPath()
  const auth = await W1Auth.readSession()
  checks.push(
    auth
      ? {
          name: "session",
          status: "ok",
          detail: `shared W1 session is present${auth.email ? ` for ${auth.email}` : ""}`,
        }
      : {
          name: "session",
          status: "fail",
          detail: `not signed in; run \`w1 login\` (shared store: ${authPath})`,
        },
  )

  const runtime = await W1Runtime.resolveRuntime()
  checks.push(
    runtime
      ? { name: "runtime", status: "ok", detail: `${runtime.source}: ${runtime.path}` }
      : { name: "runtime", status: "fail", detail: "run-stream.mjs was not found" },
  )

  const engine = await resolveEngine()
  checks.push(
    engine
      ? { name: "engine", status: "ok", detail: `${engine.source}: ${engine.enginePath}` }
      : { name: "engine", status: "fail", detail: "w1-engine.mjs was not found" },
  )

  if (engine) {
    const client = new EngineClient()
    try {
      await client.connect({ location: engine, clientVersion: engineClientVersion(InstallationVersion) })
      checks.push({ name: "handshake", status: "ok", detail: `daemon protocol v1 · build ${engine.buildId}` })
      const auth = await client.request("auth.snapshot", {}) as { state?: string }
      checks.push({
        name: "engine auth",
        status: auth.state === "signed_in" ? "ok" : "fail",
        detail: auth.state === "signed_in" ? "daemon sees the shared W1 session" : "daemon is signed out",
      })
      const threads = await client.request("engine.threads.list", { workspacePath: directory }) as ThreadSummary[]
      checks.push({
        name: "history",
        status: "ok",
        detail: `${threads.length} workspace thread${threads.length === 1 ? "" : "s"} · ${threads.filter((item) => item.state === "running").length} running`,
      })
    } catch (error) {
      checks.push({
        name: "handshake",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      client.close()
    }
  }

  try {
    const response = await fetch("https://app.w1lab.com", {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    checks.push({
      name: "backend",
      status: response.status < 500 ? "ok" : "warn",
      detail: `app.w1lab.com responded HTTP ${response.status}`,
    })
  } catch (error) {
    checks.push({
      name: "backend",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  checks.push({
    name: "terminal",
    status: process.stdin.isTTY && process.stdout.isTTY ? "ok" : "warn",
    detail: process.stdin.isTTY && process.stdout.isTTY ? "interactive TTY available" : "non-interactive input/output",
  })
  return checks
}
