import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { pathToFileURL } from "url"
import { W1Command } from "./cli/cmd/w1"
import { DoctorCommand } from "./cli/cmd/doctor"
import { AuthCommand, LoginCommand, LogoutCommand } from "./cli/cmd/w1-auth"
import { EngineCommand } from "./cli/cmd/w1-engine"

const args = hideBin(process.argv)

if (args[0] === "__runtime") {
  const runtimePath = args[1]
  if (!runtimePath) throw new Error("W1 runtime path is missing.")
  process.argv = [process.execPath, runtimePath, "--serve"]
  const runtime = (await import(pathToFileURL(runtimePath).href)) as {
    serve?: () => Promise<void>
    installRuntimeSignalHandlers?: () => () => void
  }
  if (runtime.serve) {
    const removeSignalHandlers = runtime.installRuntimeSignalHandlers?.()
    await runtime.serve().finally(() => removeSignalHandlers?.())
  } else {
    await new Promise<void>((resolve) => process.stdin.once("close", resolve))
  }
  process.exit(0)
}

if (args[0] === "__engine") {
  const enginePath = args[1]
  if (!enginePath) throw new Error("W1 Engine path is missing.")
  await import(pathToFileURL(enginePath).href)
} else {

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("w1 ")) {
    process.stderr.write("W1" + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("w1")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .middleware(async () => {
    process.env.AGENT = "1"
    process.env.W1 = "1"
    process.env.W1_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AuthCommand)
  .command(LoginCommand)
  .command(LogoutCommand)
  .command(DoctorCommand)
  .command(EngineCommand)
  .command(W1Command)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
}
