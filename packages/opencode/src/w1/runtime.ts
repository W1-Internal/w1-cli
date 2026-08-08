import path from "path"
import os from "os"

declare global {
  const W1_CLI_COMPILED: boolean
  const W1_CLI_BUILD_ID: string
}

export const buildID = typeof W1_CLI_BUILD_ID === "string" ? W1_CLI_BUILD_ID : "development"

export type ProtocolFrame = {
  tag: string
  payload: Record<string, unknown>
}

export type RuntimeLocation = {
  path: string
  source: "environment" | "packaged" | "shared" | "development"
}

export type RuntimeClient = {
  location: RuntimeLocation
  send(frame: Record<string, unknown>): void
  interrupt(): void
  stop(): Promise<void>
  exited: Promise<number>
}

export function parseProtocolLine(line: string): ProtocolFrame | undefined {
  const match = /^@@([A-Z_]+)@@(.*)$/.exec(line.trim())
  if (!match) return
  try {
    const parsed = match[2] ? JSON.parse(match[2]) : {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    return { tag: match[1], payload: parsed as Record<string, unknown> }
  } catch {
    return
  }
}

export async function resolveRuntime(): Promise<RuntimeLocation | undefined> {
  const configured = process.env.W1_RUNTIME_PATH?.trim()
  const candidates: RuntimeLocation[] = [
    ...(configured ? [{ path: path.resolve(configured), source: "environment" as const }] : []),
    {
      path: path.join(path.dirname(process.execPath), "w1-runtime", "run-stream.mjs"),
      source: "packaged",
    },
    {
      path: path.join(os.homedir(), ".w1", "runtime", "run-stream.mjs"),
      source: "shared",
    },
    {
      path: path.resolve(import.meta.dir, "../../../../../harness/vscode-extension/out/harness/run-stream.mjs"),
      source: "development",
    },
  ]
  for (const candidate of candidates) {
    if (await Bun.file(candidate.path).exists()) return candidate
  }
}

export async function startRuntime(input: {
  cwd: string
  onFrame(frame: ProtocolFrame): void | Promise<void>
  onStderr(text: string): void
}): Promise<RuntimeClient> {
  const location = await resolveRuntime()
  if (!location) {
    throw new Error("W1 runtime is missing. Reinstall W1 CLI or set W1_RUNTIME_PATH to run-stream.mjs.")
  }

  const compiled = typeof W1_CLI_COMPILED !== "undefined" && W1_CLI_COMPILED
  const command = compiled
    ? [process.execPath, "__runtime", location.path]
    : [process.execPath, location.path, "--serve"]
  const child = Bun.spawn({
    cmd: command,
    cwd: input.cwd,
    env: { ...process.env, W1_SURFACE: "cli" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const ready = Promise.withResolvers<void>()

  void readLines(child.stdout, async (line) => {
    const frame = parseProtocolLine(line)
    if (!frame) return
    if (frame.tag === "READY") ready.resolve()
    await input.onFrame(frame)
  })
  void readText(child.stderr, input.onStderr)
  void child.exited.then((code) => {
    ready.reject(new Error(`W1 runtime exited before becoming ready (exit ${code}).`))
  })

  await Promise.race([
    ready.promise,
    Bun.sleep(15_000).then(() => {
      throw new Error("W1 runtime did not become ready within 15 seconds.")
    }),
  ])

  return {
    location,
    send(frame) {
      child.stdin.write(JSON.stringify(frame) + "\n")
      child.stdin.flush()
    },
    interrupt() {
      child.kill("SIGINT")
    },
    async stop() {
      child.stdin.end()
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
      if (!stopped) child.kill("SIGTERM")
      await child.exited
    },
    exited: child.exited,
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, consume: (line: string) => void | Promise<void>) {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    buffer += decoder.decode(next.value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) await consume(line)
  }
  buffer += decoder.decode()
  if (buffer) await consume(buffer)
}

async function readText(stream: ReadableStream<Uint8Array>, consume: (text: string) => void) {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    consume(decoder.decode(next.value, { stream: true }))
  }
  const tail = decoder.decode()
  if (tail) consume(tail)
}

export * as W1Runtime from "./runtime"
