import { expect, test } from "bun:test"
import { mkdir } from "fs/promises"
import path from "path"
import os from "os"
import * as Pty from "@opencode-ai/core/pty/pty.bun"
import { createW1Attachments } from "./attachments"

test("the W1 command completes a streamed turn through the real stdio adapter", async () => {
  const root = (await Bun.$`mktemp -d ${path.join(os.tmpdir(), "w1-cli-command.XXXXXX")}`.text()).trim()
  const runtime = path.join(root, "mock-runtime.mjs")
  await mkdir(path.join(root, ".w1"), { recursive: true })
  await Bun.write(path.join(root, ".w1", "auth.json"), JSON.stringify({ token: "w1s_fixture" }))
  await Bun.write(
    runtime,
    [
      'import { createInterface } from "node:readline"',
      'process.stdout.write("@@READY@@{\\"pid\\":1}\\n")',
      "const lines = createInterface({ input: process.stdin })",
      'lines.on("line", () => {',
      '  process.stdout.write("@@EVT@@{\\"t\\":\\"say_delta\\",\\"text\\":\\"W1 is alive.\\"}\\n")',
      '  process.stdout.write("@@RESULT@@{\\"status\\":\\"model_finished\\",\\"summary\\":\\"W1 is alive.\\",\\"steps\\":1}\\n")',
      '  process.stdout.write("@@IDLE@@{}\\n")',
      "})",
      "export async function serve() {}",
      "",
    ].join("\n"),
  )

  try {
    const child = Bun.spawn({
      cmd: [process.execPath, path.resolve(import.meta.dir, "../w1-index.ts"), root, "--prompt", "hello"],
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, W1_RUNTIME_PATH: runtime },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("W1 is alive.")
    expect(stdout).toContain("model_finished · 1 steps")
  } finally {
    await Bun.$`rm -rf ${root}`
  }
})

test("--yolo enables full access and shows activity without exposing reasoning", async () => {
  const root = (await Bun.$`mktemp -d ${path.join(os.tmpdir(), "w1-cli-yolo.XXXXXX")}`.text()).trim()
  const runtime = path.join(root, "mock-runtime.mjs")
  await mkdir(path.join(root, ".w1"), { recursive: true })
  await Bun.write(path.join(root, ".w1", "auth.json"), JSON.stringify({ token: "w1s_fixture" }))
  await Bun.write(
    runtime,
    [
      'import { createInterface } from "node:readline"',
      'process.stdout.write("@@READY@@{\\"pid\\":1}\\n")',
      "const lines = createInterface({ input: process.stdin })",
      "let turn",
      'lines.on("line", (line) => {',
      "  const frame = JSON.parse(line)",
      "  if (!turn) {",
      "    turn = frame",
      '  process.stdout.write("@@EVT@@{\\"t\\":\\"think_delta\\",\\"text\\":\\"private reasoning\\"}\\n")',
      '  process.stdout.write("@@APPROVAL@@{\\"requestId\\":\\"approval-1\\",\\"detail\\":\\"read a file\\"}\\n")',
      "    return",
      "  }",
      '  process.stdout.write("@@EVT@@{\\"t\\":\\"action\\",\\"tool\\":\\"read\\",\\"input\\":{\\"path\\":\\"README.md\\"}}\\n")',
      '  process.stdout.write("@@EVT@@{\\"t\\":\\"observation\\",\\"ok\\":true,\\"observation\\":\\"done\\"}\\n")',
      '  process.stdout.write(`@@EVT@@${JSON.stringify({ t: "say_delta", text: `mode:${turn.runtimeMode}:${frame.decision}` })}\\n`)',
      '  process.stdout.write("@@RESULT@@{\\"status\\":\\"model_finished\\",\\"steps\\":1}\\n")',
      '  process.stdout.write("@@IDLE@@{}\\n")',
      "})",
      "export async function serve() {}",
      "",
    ].join("\n"),
  )

  try {
    const child = Bun.spawn({
      cmd: [process.execPath, path.resolve(import.meta.dir, "../w1-index.ts"), root, "--prompt", "hello", "--yolo"],
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, W1_RUNTIME_PATH: runtime },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("Thinking…")
    expect(stdout).toContain("Working…")
    expect(stdout).toContain("mode:full-access:accept")
    expect(stdout).not.toContain("Allow?")
    expect(stdout).not.toContain("private reasoning")
  } finally {
    await Bun.$`rm -rf ${root}`
  }
})

test.skipIf(process.platform === "win32")("interactive W1 uses the product TUI and renders runtime state", async () => {
  const root = (await Bun.$`mktemp -d ${path.join(os.tmpdir(), "w1-cli-tui.XXXXXX")}`.text()).trim()
  const runtime = path.join(root, "mock-runtime.mjs")
  const received = path.join(root, "received-turn.json")
  const image = path.join(root, "reference.png")
  const engine = path.join(import.meta.dir, "fixture-engine.mjs")
  await mkdir(path.join(root, ".w1"), { recursive: true })
  await Bun.write(path.join(root, ".w1", "auth.json"), JSON.stringify({ token: "w1s_fixture" }))
  await Bun.write(image, Buffer.from("89504e470d0a1a0a", "hex"))
  await Bun.write(
    runtime,
    [
      'import { writeFileSync } from "node:fs"',
      'import { createInterface } from "node:readline"',
      'process.stdout.write("@@READY@@{\\"pid\\":1}\\n")',
      "const lines = createInterface({ input: process.stdin })",
      'lines.on("line", (line) => {',
      `  writeFileSync(${JSON.stringify(received)}, line)`,
      '  process.stdout.write("@@EVT@@{\\"t\\":\\"task_state\\",\\"items\\":[{\\"id\\":\\"t1\\",\\"title\\":\\"Inspect runtime\\",\\"status\\":\\"in_progress\\"}]}\\n")',
      '  process.stdout.write("@@EVT@@{\\"t\\":\\"action\\",\\"tool\\":\\"read\\",\\"toolCallId\\":\\"call-1\\",\\"input\\":{\\"path\\":\\"README.md\\"}}\\n")',
      '  process.stdout.write("@@EVT@@{\\"t\\":\\"observation\\",\\"toolCallId\\":\\"call-1\\",\\"ok\\":true,\\"observation\\":\\"line one\\\\nline two\\\\nline three\\"}\\n")',
      '  process.stdout.write("@@EVT@@{\\"t\\":\\"say_delta\\",\\"text\\":\\"| Check | Result |\\\\n|---|---|\\\\n| TUI | Ready |\\"}\\n")',
      '  process.stdout.write("@@RESULT@@{\\"status\\":\\"model_finished\\",\\"steps\\":1}\\n")',
      '  process.stdout.write("@@IDLE@@{}\\n")',
      "})",
      "export async function serve() {}",
      "",
    ].join("\n"),
  )

  try {
    const child = Pty.spawn(process.execPath, [path.resolve(import.meta.dir, "../w1-index.ts"), root, "--image", image], {
      name: "xterm-256color",
      cols: 110,
      rows: 34,
      // Keep Bun's source loader rooted at this package so it applies the Solid/OpenTUI
      // tsconfig. The project under test is still `root` via the positional argument above.
      cwd: path.resolve(import.meta.dir, "../.."),
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          W1_RUNTIME_PATH: runtime,
          W1_ENGINE_PATH: engine,
          W1_FIXTURE_RECEIVED: received,
          W1_FIXTURE_EXIT_ON_CLOSE: "1",
        }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    })
    let output = ""
    child.onData((data) => (output += data))
    const exited = Promise.withResolvers<number>()
    child.onExit((event) => exited.resolve(event.exitCode))
    // OpenTUI probes terminal capabilities before the composer is ready. Synchronize on the
    // rendered prompt instead of racing a fixed startup sleep (slow CI otherwise drops input).
    for (let attempt = 0; attempt < 250 && !output.includes("Ask anything"); attempt++) await Bun.sleep(20)
    if (!output.includes("Ask anything")) {
      throw new Error(`interactive W1 composer did not become ready; tail=${JSON.stringify(output.slice(-4_000))}`)
    }
    child.write("audit this\r")
    for (
      let attempt = 0;
      attempt < 250 && (!(await Bun.file(received).exists()) || !output.includes("Inspect runtime"));
      attempt++
    ) await Bun.sleep(20)
    for (const expected of ["Inspect runtime", "Ready"]) {
      if (!output.includes(expected)) {
        throw new Error(`interactive W1 output missing ${JSON.stringify(expected)}; tail=${JSON.stringify(output.slice(-4_000))}`)
      }
    }
    expect(output).not.toContain("line three")
    const turn = JSON.parse(await Bun.file(received).text())
    expect(turn).toMatchObject({
      attachmentIds: [expect.stringMatching(/^sha256:/)],
      workerRequest: { runtimeMode: "approval-required", first: true },
    })
    expect(turn).not.toHaveProperty("images")
    expect(turn.workerRequest).not.toHaveProperty("history")
    for (const expected of ["audit this", path.join(".w1", "attachments")]) {
      if (!turn.text.includes(expected)) {
        throw new Error(`engine turn text missing ${JSON.stringify(expected)}; text=${JSON.stringify(turn.text)}`)
      }
    }
    child.write("exit\r")
    const exitCode = await Promise.race([exited.promise, Bun.sleep(3_000).then(() => -1)])
    if (exitCode === -1) child.kill("SIGKILL")
    expect(exitCode, output).toBe(0)
  } finally {
    await Bun.$`rm -rf ${root}`
  }
})

test("image path attachments are persisted under the local W1 state directory", async () => {
  const root = (await Bun.$`mktemp -d ${path.join(os.tmpdir(), "w1-cli-image.XXXXXX")}`.text()).trim()
  const source = path.join(root, "source.png")
  await Bun.write(source, Buffer.from("89504e470d0a1a0a", "hex"))
  try {
    const attachment = await createW1Attachments({ directory: root, threadID: "thread/test" }).fromPath(source)
    expect(attachment?.part.mime).toBe("image/png")
    expect(attachment?.part.source?.type).toBe("file")
    if (attachment?.part.source?.type !== "file") throw new Error("missing persisted image path")
    expect(attachment.part.source.path).toContain(path.join(".w1", "attachments", "thread_test"))
    expect(await Bun.file(attachment.part.source.path).exists()).toBe(true)
  } finally {
    await Bun.$`rm -rf ${root}`
  }
})

test.skipIf(process.platform === "win32")(
  "interactive exit closes immediately without sending a model turn",
  async () => {
    const root = (await Bun.$`mktemp -d ${path.join(os.tmpdir(), "w1-cli-exit.XXXXXX")}`.text()).trim()
    const runtime = path.join(root, "mock-runtime.mjs")
    const received = path.join(root, "received-turn.json")
    await mkdir(path.join(root, ".w1"), { recursive: true })
    await Bun.write(path.join(root, ".w1", "auth.json"), JSON.stringify({ token: "w1s_fixture" }))
    await Bun.write(
      runtime,
      [
        'import { appendFileSync } from "node:fs"',
        'import { createInterface } from "node:readline"',
        'process.stdout.write("@@READY@@{\\"pid\\":1}\\n")',
        "const lines = createInterface({ input: process.stdin })",
        'lines.on("line", (line) => {',
        `  appendFileSync(${JSON.stringify(received)}, line + "\\n")`,
        '  process.stdout.write("@@RESULT@@{\\"status\\":\\"model_finished\\",\\"steps\\":0}\\n")',
        '  process.stdout.write("@@IDLE@@{}\\n")',
        "})",
        "export async function serve() {}",
        "",
      ].join("\n"),
    )

    try {
      const child = Pty.spawn(process.execPath, [path.resolve(import.meta.dir, "../w1-index.ts"), root, "--plain"], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: root,
        env: Object.fromEntries(
          Object.entries({ ...process.env, HOME: root, USERPROFILE: root, W1_RUNTIME_PATH: runtime }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      })
      let output = ""
      child.onData((data) => (output += data))
      const exited = Promise.withResolvers<number>()
      child.onExit((event) => exited.resolve(event.exitCode))
      for (let attempt = 0; attempt < 100 && !output.includes("›"); attempt++) await Bun.sleep(20)
      expect(output).toContain("›")
      child.write("exit\r")
      const exitCode = await Promise.race([exited.promise, Bun.sleep(3_000).then(() => -1)])
      if (exitCode === -1) child.kill("SIGKILL")
      expect(exitCode, output).toBe(0)
      expect(await Bun.file(received).exists()).toBe(false)
    } finally {
      await Bun.$`rm -rf ${root}`
    }
  },
)

test.skipIf(process.platform === "win32")("Ctrl+C closes W1 and its runtime during an active turn", async () => {
  const root = (await Bun.$`mktemp -d ${path.join(os.tmpdir(), "w1-cli-interrupt.XXXXXX")}`.text()).trim()
  const runtime = path.join(root, "mock-runtime.mjs")
  const runtimePid = path.join(root, "runtime.pid")
  await mkdir(path.join(root, ".w1"), { recursive: true })
  await Bun.write(path.join(root, ".w1", "auth.json"), JSON.stringify({ token: "w1s_fixture" }))
  await Bun.write(
    runtime,
    [
      'import { writeFileSync } from "node:fs"',
      'import { createInterface } from "node:readline"',
      `writeFileSync(${JSON.stringify(runtimePid)}, String(process.pid))`,
      'process.stdout.write("@@READY@@{\\"pid\\":1}\\n")',
      "const lines = createInterface({ input: process.stdin })",
      'lines.on("line", () => process.stdout.write("@@EVT@@{\\"t\\":\\"think_delta\\",\\"text\\":\\"private\\"}\\n"))',
      "export async function serve() {}",
      "",
    ].join("\n"),
  )

  try {
    const child = Pty.spawn(process.execPath, [path.resolve(import.meta.dir, "../w1-index.ts"), root, "--plain"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: root,
      env: Object.fromEntries(
        Object.entries({ ...process.env, HOME: root, USERPROFILE: root, W1_RUNTIME_PATH: runtime }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    })
    let output = ""
    child.onData((data) => (output += data))
    const exited = Promise.withResolvers<number>()
    child.onExit((event) => exited.resolve(event.exitCode))
    for (let attempt = 0; attempt < 100 && !output.includes("›"); attempt++) await Bun.sleep(20)
    child.write("keep working\r")
    for (let attempt = 0; attempt < 100 && !output.includes("Thinking"); attempt++) await Bun.sleep(20)
    expect(output).toContain("Thinking")
    child.write("\x03")
    const exitCode = await Promise.race([exited.promise, Bun.sleep(3_000).then(() => -1)])
    if (exitCode === -1) child.kill("SIGKILL")
    expect(exitCode, output).toBe(130)
    const pid = Number(await Bun.file(runtimePid).text())
    await Bun.sleep(50)
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    await Bun.$`rm -rf ${root}`
  }
})
