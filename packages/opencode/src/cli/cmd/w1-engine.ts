import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EngineClient, engineClientVersion, resolveEngine, type EngineStatus } from "@/w1/engine"
import { cmd } from "./cmd"

type Args = {
  action: "status" | "stop"
  whenIdle?: boolean
  json?: boolean
}

export const EngineCommand = cmd<{}, Args>({
  command: "engine <action>",
  describe: "inspect or safely stop the shared W1 Engine",
  builder: (yargs) =>
    yargs
      .positional("action", {
        type: "string",
        choices: ["status", "stop"] as const,
        demandOption: true,
      })
      .option("when-idle", {
        type: "boolean",
        default: false,
        describe: "schedule shutdown after all active tasks finish",
      })
      .option("json", { type: "boolean", default: false, describe: "print machine-readable output" }),
  handler: async (args) => {
    const location = await resolveEngine()
    if (!location) throw new Error("W1 Engine bundle is missing. Reinstall W1 CLI.")
    const client = new EngineClient()
    try {
      await client.connect({
        location,
        clientVersion: engineClientVersion(InstallationVersion),
        autostart: false,
        converge: false,
      })
    } catch (cause) {
      if (args.action === "status" && isOffline(cause)) {
        const status = { running: false, protocolVersion: 1, packageVersion: location.packageVersion }
        process.stdout.write(args.json ? JSON.stringify(status) + "\n" : "W1 Engine is not running.\n")
        return
      }
      throw cause
    }

    try {
      if (args.action === "status") {
        const status = await client.request("engine.status", {}) as EngineStatus
        process.stdout.write(
          args.json
            ? JSON.stringify({ running: true, ...status }) + "\n"
            : `W1 Engine ${status.packageVersion} · ${status.idle ? "idle" : `${status.activeThreads} active task(s)`} · pid ${status.pid}\n`,
        )
        return
      }
      const result = await client.request("engine.stop", { whenIdle: args.whenIdle === true }) as {
        stopping: boolean
        whenIdle: boolean
        activeThreads: number
      }
      process.stdout.write(
        result.whenIdle
          ? `W1 Engine will stop after ${result.activeThreads} active task(s) finish.\n`
          : "W1 Engine is stopping.\n",
      )
    } finally {
      client.close()
    }
  },
})

function isOffline(cause: unknown) {
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : ""
  return code === "ENOENT" || code === "ECONNREFUSED"
}
