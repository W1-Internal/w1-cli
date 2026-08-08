import { expect, test } from "bun:test"
import { mkdir } from "fs/promises"
import path from "path"
import os from "os"

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
      cmd: [process.execPath, path.resolve(import.meta.dir, "../index.ts"), root, "--prompt", "hello"],
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
      cmd: [process.execPath, path.resolve(import.meta.dir, "../index.ts"), root, "--prompt", "hello", "--yolo"],
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
