import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createPartialSnapshot, fingerprint, loadCorpus } from "./desktop-profile/corpus"
import { parseOptions } from "./desktop-profile/options"
import { installProbe } from "./desktop-profile/probe"
import { progress } from "./desktop-profile/progress"
import { withDesktop, run } from "./desktop-profile/runtime"
import { runScenarios } from "./desktop-profile/scenarios"

const root = path.resolve(import.meta.dir, "../../../..")
const desktop = path.join(root, "packages/desktop")
const options = parseOptions(process.argv.slice(2))
if (!options) process.exit(0)

await mkdir(options.output, { recursive: true })
progress("loading corpus", { mode: options.mode })
let corpus = loadCorpus(options)
if (options.partialSnapshotOut) {
  progress("creating partial snapshot")
  await createPartialSnapshot(options.database, options.partialSnapshotOut, options, corpus.targets)
  options.database = options.partialSnapshotOut
  options.mode = "partial-snapshot"
  corpus = loadCorpus(options)
}
if (options.build) {
  progress("building desktop production bundle")
  await run(["bun", "run", "build"], desktop, options.database)
}

progress("corpus ready", { targets: corpus.targets.map((target) => target.label), runs: options.runs })
const runs = []
for (let index = 1; index <= options.runs; index++) {
  runs.push(
    await withDesktop(options, desktop, index, corpus.projectIDs, async (page) => {
      await installProbe(page, options)
      await page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}")
        localStorage.setItem(
          "settings.v3",
          JSON.stringify({ ...settings, general: { ...settings.general, newLayoutDesigns: true } }),
        )
      })
      return runScenarios(page, options, corpus.targets, corpus.typingText)
    }),
  )
}

const report = {
  schemaVersion: 2,
  source: options.mode === "partial-snapshot" ? "partial-database-snapshot" : "local-opencode-db",
  command: process.argv.slice(2),
  diagnostics: options.diagnostics,
  profileCPU: options.cpu,
  database: await fingerprint(options.database),
  window: {
    start: new Date(options.windowStart).toISOString(),
    end: new Date(options.windowEnd).toISOString(),
  },
  revision: (await Bun.$`git rev-parse HEAD`.cwd(root).text()).trim(),
  targets: corpus.targets.map(({ id: _, projectID: __, directory: ___, title: ____, ...target }) => target),
  summary: summarize(runs),
  runs: runs.map((results, index) => ({ index: index + 1, results })),
}
const file = path.join(options.output, "renderer-profile.json")
await Bun.write(file, JSON.stringify(report, null, 2))
console.log(`PROFILE_REPORT ${file}`)
console.log(`PROFILE_SUMMARY ${JSON.stringify(report.summary)}`)
console.log(JSON.stringify(report, null, 2))

function summarize(runs: unknown[][]) {
  type Result = {
    name: string
    elapsedMs?: number
    longTasks: { count: number; totalMs: number; maxMs: number }
    longAnimationFrames: { totalBlockingMs: number }
    typing?: { p50Ms: number; p95Ms: number; maxMs: number }
  }
  return Object.fromEntries(
    [...Map.groupBy(runs.flat() as Result[], (result) => result.name)].map(([name, samples]) => [
      name,
      {
        samples: samples.length,
        elapsedMedianMs: median(samples.flatMap((sample) => sample.elapsedMs ?? [])),
        longTasks: {
          maxCount: Math.max(...samples.map((sample) => sample.longTasks.count)),
          maxTotalMs: Math.max(...samples.map((sample) => sample.longTasks.totalMs)),
          maxTaskMs: Math.max(...samples.map((sample) => sample.longTasks.maxMs)),
        },
        maxBlockingMs: Math.max(...samples.map((sample) => sample.longAnimationFrames.totalBlockingMs)),
        ...(samples[0]?.typing
          ? {
              typingMedianMs: {
                p50: median(samples.flatMap((sample) => sample.typing?.p50Ms ?? [])),
                p95: median(samples.flatMap((sample) => sample.typing?.p95Ms ?? [])),
                max: median(samples.flatMap((sample) => sample.typing?.maxMs ?? [])),
              },
            }
          : {}),
      },
    ]),
  )
}

function median(values: number[]) {
  if (values.length === 0) return
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
}
