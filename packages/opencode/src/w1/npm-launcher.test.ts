import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const LAUNCHER = path.join(import.meta.dir, "..", "..", "script", "w1-npm-launcher.cjs")
const VERSION = "9.9.9"
const NATIVE = process.platform === "win32" ? "@w1-lab/cli-windows-x64" : `@w1-lab/cli-${process.platform}-${process.arch}`

/** A global npm tree exactly as npm lays one out, so the launcher resolves through real modules. */
function install(options: { natives: Array<{ name: string; version: string; marker: string }> }) {
  const root = mkdtempSync(path.join(tmpdir(), "w1-launcher-"))
  const scope = path.join(root, "node_modules", "@w1-lab")
  mkdirSync(path.join(scope, "cli", "bin"), { recursive: true })
  writeFileSync(
    path.join(scope, "cli", "package.json"),
    JSON.stringify({ name: "@w1-lab/cli", version: VERSION, optionalDependencies: { [NATIVE]: VERSION } }),
  )
  writeFileSync(path.join(scope, "cli", "bin", "w1"), require("node:fs").readFileSync(LAUNCHER))
  for (const native of options.natives) {
    // Node resolves by package NAME, so each package lives at its own directory — exactly as npm
    // lays it out. A stale entry is therefore an ABANDONED VARIANT: you needed cli-windows-x64
    // once, you need cli-windows-x64-baseline now, and the old one sits there forever.
    const dir = path.join(scope, native.name.replace("@w1-lab/", ""))
    mkdirSync(path.join(dir, "bin", "w1-runtime"), { recursive: true })
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: native.name, version: native.version }))
    const exe = path.join(dir, "bin", process.platform === "win32" ? "w1.exe" : "w1")
    writeFileSync(exe, `#!/bin/sh\necho "${native.marker}"\n`)
    chmodSync(exe, 0o755)
    for (const file of ["run-stream.mjs", "w1-engine.mjs"]) {
      writeFileSync(path.join(dir, "bin", "w1-runtime", file), "//")
    }
    writeFileSync(path.join(dir, "bin", "w1-runtime", "BUILD_ID"), "a".repeat(40))
  }
  return { root, scope, launcher: path.join(scope, "cli", "bin", "w1") }
}

const run = (launcher: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [launcher], { encoding: "utf8", env: { ...process.env, ...env } })

describe.skipIf(process.platform === "win32")("the CLI repairs its own install", () => {
  test("sweeps a native left behind by an older release", () => {
    // Every release pins its natives to its own version, so an old one is dead weight the launcher
    // skips — ~200MB that makes `npm ls` look healthy while W1 refuses to start.
    const tree = install({
      natives: [
        { name: NATIVE, version: VERSION, marker: "CURRENT" },
        { name: `${NATIVE}-baseline`, version: "0.0.1", marker: "ABANDONED" },
      ],
    })
    const result = run(tree.launcher)
    expect(result.stdout).toContain("CURRENT")
    expect(result.stderr).toContain("stale runtime")
    expect(existsSync(path.join(tree.scope, `${NATIVE.replace("@w1-lab/", "")}-baseline`))).toBe(false)
    expect(existsSync(path.join(tree.scope, NATIVE.replace("@w1-lab/", "")))).toBe(true)
  })

  test("installs the native package itself when npm left it out", () => {
    // npm does not reliably add a NEWLY PUBLISHED optional dependency to an existing global
    // install — it reports "changed 2 packages" and silently omits it. That stranded the Windows
    // baseline the day it shipped.
    const tree = install({ natives: [] })
    const bin = path.join(tree.root, "fakebin")
    mkdirSync(bin, { recursive: true })
    const record = path.join(tree.root, "npm-args.txt")
    writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "$*" > ${record}\nexit 1\n`)
    chmodSync(path.join(bin, "npm"), 0o755)

    const result = run(tree.launcher, { PATH: `${bin}:${process.env.PATH}` })
    expect(result.stderr).toContain("repairing its install")
    // Exactly the scoped package pinned to this launcher's version — never a floating range.
    expect(require("node:fs").readFileSync(record, "utf8")).toContain(`${NATIVE}@${VERSION}`)
  })

  test("never re-enters repair, so a broken machine cannot loop", () => {
    const tree = install({ natives: [] })
    const result = run(tree.launcher, { W1_NPM_REPAIRED: "1" })
    expect(result.stderr).not.toContain("repairing its install")
    expect(result.stderr).toContain("could not install it for you")
    expect(result.status).toBe(1)
  })
})
