import { expect, test } from "bun:test"
import path from "path"
import os from "os"

test("the W1 command completes a streamed turn through the real stdio adapter", async () => {
  const root = (await Bun.$`mktemp -d ${path.join(os.tmpdir(), "w1-cli-command.XXXXXX")}`.text()).trim()
  const runtime = path.join(root, "mock-runtime.mjs")
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
      env: { ...process.env, W1_RUNTIME_PATH: runtime },
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
