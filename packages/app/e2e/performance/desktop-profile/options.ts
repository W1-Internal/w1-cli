import { Global } from "@opencode-ai/core/global"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { scenarios, type Options, type Scenario } from "./types"

const help = `Desktop renderer profiler

Usage:
  bun run profile:desktop [options]

Options:
  --mode local|partial-snapshot
                                Local corpus or fixed partial snapshot (default: local)
  --db <path>                  SQLite database (default: opencode data directory)
  --partial-snapshot-out <path>
                                Copy the benchmark corpus to a private partial snapshot
  --output <directory>         Report directory (default: OS temp directory)
  --window-end <ISO|epoch>     End of corpus window (default: now; required for partial snapshot)
  --window-hours <hours>       Corpus window size (default: 24)
  --scenarios <names>          Comma list: ${scenarios.join(",")} (default: all)
  --runs <count>               Restart Electron and repeat (default: 1)
  --skip-build                 Use the existing desktop production build
  --diagnostics                Capture Chrome traces
  --cpu                        Capture sampled CPU summaries
  --response-urls              Attribute Response.text durations by URL
  --help                       Show this message

Partial snapshots contain private application data. Do not commit or share them.
`

export function parseOptions(args: string[], now = Date.now()): Options | undefined {
  if (args.includes("--help")) {
    console.log(help)
    return
  }

  const value = (name: string) => {
    const index = args.indexOf(name)
    if (index === -1) return
    const result = args[index + 1]
    if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`)
    return result
  }
  const mode = value("--mode") ?? "local"
  if (mode !== "local" && mode !== "partial-snapshot") throw new Error(`Unsupported mode: ${mode}`)
  const endValue = value("--window-end")
  if (mode === "partial-snapshot" && !endValue)
    throw new Error("--window-end is required in partial-snapshot mode")
  const windowEnd = endValue ? parseTime(endValue) : now
  const windowHours = number(value("--window-hours") ?? "24", "--window-hours")
  const selected = (value("--scenarios")?.split(",") ?? [...scenarios]).map((item) => item.trim())
  if (selected.some((item) => !scenarios.includes(item as Scenario)))
    throw new Error(`--scenarios must contain only: ${scenarios.join(", ")}`)
  const database = path.resolve(value("--db") ?? path.join(Global.Path.data, "opencode.db"))
  if (!existsSync(database)) throw new Error(`Database does not exist: ${database}`)

  return {
    mode,
    database,
    output: path.resolve(
      value("--output") ?? path.join(tmpdir(), "opencode-performance", new Date(windowEnd).toISOString().replace(/[:.]/g, "-")),
    ),
    windowStart: windowEnd - windowHours * 60 * 60 * 1_000,
    windowEnd,
    scenarios: selected as Scenario[],
    runs: number(value("--runs") ?? "1", "--runs"),
    build: !args.includes("--skip-build"),
    diagnostics: args.includes("--diagnostics"),
    cpu: args.includes("--cpu"),
    responseURLs: args.includes("--response-urls"),
    partialSnapshotOut: value("--partial-snapshot-out")
      ? path.resolve(value("--partial-snapshot-out")!)
      : undefined,
  }
}

function parseTime(value: string) {
  const result = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(result)) throw new Error(`Invalid --window-end: ${value}`)
  return result
}

function number(value: string, option: string) {
  const result = Number(value)
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${option} must be greater than zero`)
  return result
}
