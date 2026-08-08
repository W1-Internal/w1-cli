import type { Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { startChromeTrace } from "../chrome-trace"
import { collectProbe, resetProbe, startCPUProfile, summarizeProbe } from "./probe"
import { progress } from "./progress"
import { domCounts, percentile, setDesktopRoute, sum, waitForQuietDOM, waitForSelector } from "./scenario-utils"
import type { Options, Target } from "./types"

export async function runScenarios(page: Page, options: Options, targets: Target[], typingText: string) {
  const results: unknown[] = []
  if (options.scenarios.includes("home")) results.push(await profileHome(page, options))
  if (options.scenarios.includes("calibration")) results.push(await profileCalibration(page))
  if (options.scenarios.includes("session")) {
    for (const target of targets) results.push(await profileSession(page, options, target))
  }
  if (options.scenarios.some((scenario) => ["composer", "history", "review"].includes(scenario))) {
    await openSession(page, targets[2]!)
  }
  if (options.scenarios.includes("composer")) results.push(await profileComposer(page, options, typingText))
  if (options.scenarios.includes("history")) results.push(await profileHistory(page, options, targets[2]!))
  if (options.scenarios.includes("review")) {
    const review = await profileReview(page, options)
    if (review) results.push(review)
  }
  return results
}

async function profileHome(page: Page, options: Options) {
  const measured = await measure(page, options, "home", async () => {
    await setDesktopRoute(page, "/")
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
    await waitForSelector(page, '[data-component="home-session-row"]', "Home session rows")
    await waitForQuietDOM(page)
  })
  return { ...measured, dom: await domCounts(page) }
}

async function profileCalibration(page: Page) {
  await resetProbe(page)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(function opencodeProfileCalibration() {
          const end = performance.now() + 80
          while (performance.now() < end) {
            // Deliberate benchmark-only main-thread block.
          }
          requestAnimationFrame(() => setTimeout(resolve, 100))
        })
      }),
  )
  return { name: "attribution-calibration", ...summarizeProbe(await collectProbe(page)) }
}

async function profileSession(page: Page, options: Options, target: Target) {
  await prepareHome(page)
  const measured = await measure(page, options, `session-${target.label}`, async () => {
    await navigateSession(page, target)
    await waitForSelector(page, '[data-component="prompt-input"]', "session composer")
    await waitForQuietDOM(page)
  })
  return { ...measured, context: targetContext(target), dom: await domCounts(page) }
}

async function profileComposer(page: Page, options: Options, typingText: string) {
  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]').first()
  await editor.click()
  await page.keyboard.press("Control+A")
  await page.keyboard.press("Backspace")
  const printable = [...typingText].filter((character) => !["\r", "\n", "\t"].includes(character))
  const measuredText = printable.slice(-120).join("")
  const prefix = printable.slice(0, -measuredText.length).join("")
  if (prefix) await page.keyboard.insertText(prefix)
  await waitForQuietDOM(page)
  const durations: number[] = []
  const measured = await measure(page, options, "composer-typing", async () => {
    for (const character of measuredText) {
      const started = performance.now()
      await page.keyboard.type(character)
      durations.push(performance.now() - started)
    }
    await waitForQuietDOM(page)
  })
  await page.keyboard.press("Control+A")
  await page.keyboard.press("Backspace")
  return {
    ...measured,
    context: { promptCharacters: printable.length, measuredCharacters: measuredText.length },
    typing: {
      totalMs: sum(durations),
      meanMs: sum(durations) / durations.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: Math.max(...durations),
    },
  }
}

async function profileHistory(page: Page, options: Options, target: Target) {
  await waitForSelector(page, '[data-component="prompt-input"]', "history session composer")
  await waitForQuietDOM(page)
  let requests = 0
  const onResponse = (response: { url(): string }) => {
    if (/\/session\/[^/]+\/message(?:\?|$)/.test(response.url())) requests++
  }
  page.on("response", onResponse)
  const measured = await measure(page, options, "session-max-history-boundary", async () => {
    const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") }).first()
    await scroller.evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -10_000, bubbles: true }))
      element.dispatchEvent(new Event("scroll", { bubbles: true }))
    })
    const timeout = Date.now() + 60_000
    while (requests === 0 && Date.now() < timeout) await page.waitForTimeout(50)
    if (requests === 0) throw new Error("History boundary did not request a page")
    await waitForQuietDOM(page)
  })
  page.off("response", onResponse)
  return { ...measured, context: targetContext(target), messageRequests: requests }
}

async function profileReview(page: Page, options: Options) {
  const button = page.getByRole("button", { name: "Toggle review" })
  if (!(await button.isVisible().catch(() => false))) return
  const panel = page.locator("#review-panel")
  if (await panel.isVisible().catch(() => false)) {
    await button.click()
    await panel.waitFor({ state: "hidden", timeout: 60_000 })
    await waitForQuietDOM(page)
  }
  const measured = await measure(page, options, "review-open", async () => {
    await button.click()
    await panel.waitFor({ state: "visible", timeout: 60_000 })
    await waitForQuietDOM(page)
  })
  return { ...measured, dom: await domCounts(page, true) }
}

async function measure(page: Page, options: Options, name: string, action: () => Promise<void>) {
  progress("scenario started", { name })
  await resetProbe(page)
  const stopTrace = options.diagnostics ? await startChromeTrace(page, name) : undefined
  const cpu = await startCPUProfile(page, options.cpu)
  const started = performance.now()
  await action()
  const result = {
    name,
    elapsedMs: performance.now() - started,
    ...summarizeProbe(await collectProbe(page)),
    cpu: await cpu.stop(),
    trace: await stopTrace?.(),
  }
  progress("scenario completed", { name, elapsedMs: Math.round(result.elapsedMs), longTasks: result.longTasks.count })
  return result
}

async function openSession(page: Page, target: Target) {
  await navigateSession(page, target)
  await waitForSelector(page, '[data-component="prompt-input"]', "session composer")
  await waitForQuietDOM(page)
}

async function prepareHome(page: Page) {
  await setDesktopRoute(page, "/")
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
  await waitForSelector(page, '[data-component="home-session-row"]', "Home session rows")
  await waitForQuietDOM(page)
}

async function navigateSession(page: Page, target: Target) {
  await setDesktopRoute(page, `/server/${base64Encode("sidecar")}/session/${target.id}`)
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
}

function targetContext(target: Target) {
  return { serializedBytes: target.bytes, messages: target.messages, parts: target.parts, userTurns: target.userTurns }
}
