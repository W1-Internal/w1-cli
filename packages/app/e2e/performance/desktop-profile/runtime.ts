import { chromium, type Page } from "@playwright/test"
import { copyFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { prepareDesktopState } from "./desktop-state"
import { progress } from "./progress"
import type { Options } from "./types"

export async function withDesktop<T>(
  options: Options,
  desktop: string,
  run: number,
  projectIDs: string[],
  use: (page: Page) => Promise<T>,
) {
  const port = availablePort()
  const endpoint = `http://127.0.0.1:${port}`
  const userData = path.join(options.output, `user-data-${run}`)
  const database =
    options.mode === "partial-snapshot" ? path.join(options.output, `working-database-${run}.db`) : options.database
  await rm(userData, { recursive: true, force: true })
  await mkdir(userData, { recursive: true })
  if (database !== options.database) await copyFile(options.database, database)
  await prepareDesktopState(options, database, userData, run, projectIDs)
  const electron = path.join(
    desktop,
    "node_modules",
    "electron",
    "dist",
    (await Bun.file(path.join(desktop, "node_modules", "electron", "path.txt")).text()).trim(),
  )
  progress("launching Electron", { run, port })
  const child = Bun.spawn([electron, "."], {
    cwd: desktop,
    env: {
      ...process.env,
      OPENCODE_DB: database,
      OPENCODE_CHANNEL: "dev",
      OPENCODE_PROFILE_LOAF: "1",
      OPENCODE_PROFILE_CDP_PORT: String(port),
      OPENCODE_PROFILE_USER_DATA: userData,
      OPENCODE_PERFORMANCE_TRACE_DIR: options.diagnostics ? path.join(options.output, "traces", String(run)) : "",
      OPENCODE_PERFORMANCE_RUN_ID: `desktop-${run}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = drain(child.stdout, "stdout")
  const stderr = drain(child.stderr, "stderr")
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined

  try {
    progress("waiting for CDP", { run })
    await waitForCDP(endpoint, child, stdout, stderr)
    progress("connecting Playwright", { run })
    browser = await chromium.connectOverCDP(endpoint)
    progress("waiting for renderer", { run })
    const page = await waitForRenderer(browser)
    progress("waiting for desktop API", { run })
    await page.waitForFunction(() => typeof window.api === "object", undefined, { timeout: 60_000 })
    progress("desktop ready", { run })
    return await use(page)
  } finally {
    progress("stopping Electron", { run })
    await browser?.close().catch(() => {})
    await killTree(child.pid)
    await Promise.allSettled([stdout, stderr])
    if (database !== options.database) {
      await Bun.sleep(500)
      await rm(database, { force: true }).catch(() => undefined)
    }
  }
}

export async function run(command: string[], cwd: string, database: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, OPENCODE_DB: database, OPENCODE_CHANNEL: "dev" },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`)
}

function availablePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port
  server.stop(true)
  return port
}

async function waitForCDP(
  endpoint: string,
  child: ReturnType<typeof Bun.spawn>,
  stdout: Promise<string>,
  stderr: Promise<string>,
) {
  const timeout = Date.now() + 5 * 60_000
  let heartbeat = Date.now() + 10_000
  while (Date.now() < timeout) {
    const ready = await fetch(`${endpoint}/json/version`)
      .then((response) => response.ok)
      .catch(() => false)
    if (ready) return
    if (child.exitCode !== null)
      throw new Error(`Desktop exited before CDP was ready (${child.exitCode})\n${await stdout}\n${await stderr}`)
    if (Date.now() >= heartbeat) {
      progress("still waiting for CDP")
      heartbeat = Date.now() + 10_000
    }
    await Bun.sleep(250)
  }
  throw new Error("Timed out waiting for desktop CDP")
}

async function waitForRenderer(browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>) {
  const timeout = Date.now() + 60_000
  let heartbeat = Date.now() + 10_000
  while (Date.now() < timeout) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("oc://renderer"))
    if (page) return page
    if (Date.now() >= heartbeat) {
      progress("still waiting for renderer")
      heartbeat = Date.now() + 10_000
    }
    await Bun.sleep(100)
  }
  throw new Error("Desktop renderer target was not found")
}

async function drain(stream: ReadableStream<Uint8Array>, label: string) {
  const decoder = new TextDecoder()
  let output = ""
  let pending = ""
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    output = (output + text).slice(-50_000)
    const lines = (pending + text).split(/\r?\n/)
    pending = lines.pop() ?? ""
    lines.filter(Boolean).forEach((line) => progress(`Electron ${label}`, { line: line.slice(0, 500) }))
  }
  if (pending) progress(`Electron ${label}`, { line: pending.slice(0, 500) })
  return output + decoder.decode()
}

async function killTree(pid: number) {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGTERM")
    return
  }
  const child = Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
  await child.exited
}
