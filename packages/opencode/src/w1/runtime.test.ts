import { describe, expect, test } from "bun:test"
import { W1Runtime } from "./runtime"
import path from "path"
import os from "os"

describe("W1 runtime protocol", () => {
  test("parses tagged frames and rejects ordinary or malformed output", () => {
    expect(W1Runtime.parseProtocolLine('@@READY@@{"pid":42}')).toEqual({
      tag: "READY",
      payload: { pid: 42 },
    })
    expect(W1Runtime.parseProtocolLine("ordinary stdout")).toBeUndefined()
    expect(W1Runtime.parseProtocolLine("@@EVT@@{broken")).toBeUndefined()
    expect(W1Runtime.parseProtocolLine("@@EVT@@[]")).toBeUndefined()
  })

  test("prefers an explicitly configured runtime", async () => {
    const root = await Bun.$`mktemp -d ${path.join(os.tmpdir(), "w1-cli-runtime.XXXXXX")}`.text()
    const runtime = path.join(root.trim(), "run-stream.mjs")
    await Bun.write(runtime, "export async function serve() {}\n")
    const previous = process.env.W1_RUNTIME_PATH
    process.env.W1_RUNTIME_PATH = runtime
    try {
      expect(await W1Runtime.resolveRuntime()).toEqual({ path: runtime, source: "environment" })
    } finally {
      if (previous === undefined) delete process.env.W1_RUNTIME_PATH
      else process.env.W1_RUNTIME_PATH = previous
      await Bun.$`rm -rf ${root.trim()}`
    }
  })

  test("starts the warm stdio runtime and preserves event order through IDLE", async () => {
    const root = (await Bun.$`mktemp -d ${path.join(os.tmpdir(), "w1-cli-daemon.XXXXXX")}`.text()).trim()
    const runtime = path.join(root, "mock-runtime.mjs")
    await Bun.write(
      runtime,
      [
        'import { createInterface } from "node:readline"',
        'process.stdout.write("@@READY@@{\\"pid\\":1}\\n")',
        "const lines = createInterface({ input: process.stdin })",
        'lines.on("line", () => {',
        '  process.stdout.write("@@EVT@@{\\"t\\":\\"say_delta\\",\\"text\\":\\"hello\\"}\\n")',
        '  process.stdout.write("@@RESULT@@{\\"status\\":\\"model_finished\\",\\"summary\\":\\"hello\\"}\\n")',
        '  process.stdout.write("@@IDLE@@{}\\n")',
        "})",
        "export async function serve() {}",
        "",
      ].join("\n"),
    )
    const previous = process.env.W1_RUNTIME_PATH
    process.env.W1_RUNTIME_PATH = runtime
    const frames: string[] = []
    const idle = Promise.withResolvers<void>()
    let client: Awaited<ReturnType<typeof W1Runtime.startRuntime>> | undefined
    try {
      client = await W1Runtime.startRuntime({
        cwd: root,
        onStderr() {},
        onFrame(frame) {
          frames.push(frame.tag)
          if (frame.tag === "IDLE") idle.resolve()
        },
      })
      client.send({ repo: root, task: "hello", threadId: "test" })
      await idle.promise
      expect(frames).toEqual(["READY", "EVT", "RESULT", "IDLE"])
    } finally {
      await client?.stop()
      if (previous === undefined) delete process.env.W1_RUNTIME_PATH
      else process.env.W1_RUNTIME_PATH = previous
      await Bun.$`rm -rf ${root}`
    }
  })
})
