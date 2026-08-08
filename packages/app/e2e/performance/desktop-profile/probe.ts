import type { Page } from "@playwright/test"
import type { Options, ProbeResult } from "./types"

export async function installProbe(page: Page, options: Options) {
  await page.addInitScript((attributeResponses) => {
    const state = {
      longTasks: [] as number[],
      animationFrames: [] as ProbeResult["animationFrames"],
      frameGaps: [] as number[],
      responseText: [] as ProbeResult["responseText"],
    }
    ;(window as Window & { __opencodeRendererProfile?: typeof state }).__opencodeRendererProfile = state
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      new PerformanceObserver((list) =>
        state.longTasks.push(...list.getEntries().map((entry) => entry.duration)),
      ).observe({ type: "longtask" })
    }
    if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      new PerformanceObserver((list) =>
        state.animationFrames.push(
          ...list.getEntries().map((entry) => {
            const frame = entry as PerformanceEntry & {
              blockingDuration: number
              scripts?: {
                duration: number
                forcedStyleAndLayoutDuration?: number
                sourceFunctionName?: string
                sourceURL?: string
                sourceCharPosition?: number
                invoker?: string
                invokerType?: string
              }[]
            }
            return {
              duration: frame.duration,
              blockingDuration: frame.blockingDuration,
              forcedStyleAndLayoutDuration:
                frame.scripts?.reduce((sum, script) => sum + (script.forcedStyleAndLayoutDuration ?? 0), 0) ?? 0,
              scripts:
                frame.scripts?.map((script) => ({
                  function: script.sourceFunctionName || "(anonymous)",
                  source: script.sourceURL?.split("/").at(-1) || "(document)",
                  position: script.sourceCharPosition ?? -1,
                  invoker: script.invoker ?? "(unknown)",
                  invokerType: script.invokerType ?? "(unknown)",
                  duration: script.duration,
                  forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration ?? 0,
                })) ?? [],
            }
          }),
        ),
      ).observe({ type: "long-animation-frame" })
    }
    let previous = performance.now()
    const frame = (now: number) => {
      const gap = now - previous
      if (gap > 20) state.frameGaps.push(gap)
      previous = now
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    if (!attributeResponses) return
    const responseText = Response.prototype.text
    Response.prototype.text = function () {
      const started = performance.now()
      const url = this.url
      return responseText.call(this).then((text) => {
        state.responseText.push({ url, duration: performance.now() - started })
        return text
      })
    }
  }, options.responseURLs)
}

export async function resetProbe(page: Page) {
  await page.evaluate(() => {
    const state = (window as Window & { __opencodeRendererProfile?: ProbeResult }).__opencodeRendererProfile
    if (!state) return
    state.longTasks.length = 0
    state.animationFrames.length = 0
    state.frameGaps.length = 0
    state.responseText.length = 0
  })
}

export async function collectProbe(page: Page) {
  return page.evaluate(
    () => (window as Window & { __opencodeRendererProfile?: ProbeResult }).__opencodeRendererProfile!,
  )
}

export function summarizeProbe(probe: ProbeResult) {
  const scripts = new Map<
    string,
    {
      function: string
      source: string
      position: number
      invoker: string
      invokerType: string
      durationMs: number
      forcedStyleAndLayoutMs: number
    }
  >()
  probe.animationFrames
    .flatMap((frame) => frame.scripts)
    .forEach((script) => {
      const key = `${script.source}:${script.position}:${script.invoker}`
      const current = scripts.get(key) ?? {
        function: script.function,
        source: script.source,
        position: script.position,
        invoker: script.invoker,
        invokerType: script.invokerType,
        durationMs: 0,
        forcedStyleAndLayoutMs: 0,
      }
      current.durationMs += script.duration
      current.forcedStyleAndLayoutMs += script.forcedStyleAndLayoutDuration
      scripts.set(key, current)
    })
  return {
    longTasks: {
      count: probe.longTasks.length,
      totalMs: sum(probe.longTasks),
      maxMs: Math.max(0, ...probe.longTasks),
    },
    longAnimationFrames: {
      count: probe.animationFrames.length,
      totalBlockingMs: sum(probe.animationFrames.map((frame) => frame.blockingDuration)),
      maxDurationMs: Math.max(0, ...probe.animationFrames.map((frame) => frame.duration)),
      forcedStyleAndLayoutMs: sum(probe.animationFrames.map((frame) => frame.forcedStyleAndLayoutDuration)),
      scripts: [...scripts.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 15),
    },
    frameGaps: {
      count: probe.frameGaps.length,
      maxMs: Math.max(0, ...probe.frameGaps),
    },
    responseText: probe.responseText
      .map((item) => ({ path: responsePath(item.url), durationMs: item.duration }))
      .sort((a, b) => b.durationMs - a.durationMs),
  }
}

export async function startCPUProfile(page: Page, enabled: boolean) {
  if (!enabled) return { stop: async () => [] }
  const session = await page.context().newCDPSession(page)
  await session.send("Profiler.enable")
  await session.send("Profiler.setSamplingInterval", { interval: 1_000 })
  await session.send("Profiler.start")
  return {
    async stop() {
      const result = await session.send("Profiler.stop")
      await session.detach()
      const self = new Map<number, number>()
      result.profile.samples?.forEach((id, index) => {
        self.set(id, (self.get(id) ?? 0) + (result.profile.timeDeltas?.[index] ?? 0) / 1_000)
      })
      return result.profile.nodes
        .map((node) => ({
          function: node.callFrame.functionName || "(anonymous)",
          source: sourceName(node.callFrame.url),
          line: node.callFrame.lineNumber + 1,
          selfMs: self.get(node.id) ?? 0,
        }))
        .filter((node) => node.selfMs >= 1)
        .sort((a, b) => b.selfMs - a.selfMs)
        .slice(0, 40)
    },
  }
}

function responsePath(value: string) {
  try {
    return new URL(value).pathname
  } catch {
    return value
  }
}

function sourceName(value: string) {
  if (!value) return "(native)"
  try {
    return new URL(value).pathname.split("/").at(-1) || "(document)"
  } catch {
    return value.split(/[\\/]/).at(-1) || value
  }
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}
