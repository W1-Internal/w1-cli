import type { Page } from "@playwright/test"
import { progress } from "./progress"

export async function setDesktopRoute(page: Page, route: string) {
  await page.evaluate(async (value) => {
    const api = window.api as typeof window.api & { getWindowID?: () => Promise<string> }
    const id = (await api.getWindowID?.()) ?? "browser"
    localStorage.setItem(`opencode.desktop.window.${id}.last-active-url`, value)
  }, route)
}

export async function waitForQuietDOM(page: Page) {
  progress("waiting for DOM to settle")
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let settled = false
        let timer = setTimeout(done, 750)
        const deadline = setTimeout(done, 30_000)
        const observer = new MutationObserver(() => {
          clearTimeout(timer)
          timer = setTimeout(done, 750)
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        function done() {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          observer.disconnect()
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }
      }),
  )
  progress("DOM settled")
}

export async function waitForSelector(page: Page, selector: string, label: string) {
  progress("waiting for UI", { label })
  try {
    await page.waitForSelector(selector, { timeout: 30_000 })
  } catch (error) {
    progress("UI wait failed", {
      label,
      url: page.url(),
      body: (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 500),
    })
    throw error
  }
  progress("UI ready", { label })
}

export async function domCounts(page: Page, review = false) {
  return page.evaluate((review) => ({
    elements: document.getElementsByTagName("*").length,
    ...(review
      ? {
          diffViewers: document.querySelectorAll('[data-component="file"][data-mode="diff"]').length,
          diffLines: document.querySelectorAll("[data-line]").length,
        }
      : {
          timelineRows: document.querySelectorAll("[data-timeline-row]").length,
          messageRows: document.querySelectorAll("[data-message-id]").length,
          markdownRoots: document.querySelectorAll('[data-component="markdown"]').length,
          diffViewers: document.querySelectorAll('[data-component="file"][data-mode="diff"]').length,
        }),
  }), review)
}

export function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

export function percentile(values: number[], quantile: number) {
  return values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * quantile) - 1)] ?? 0
}
