import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "fs/promises"
import os from "os"
import path from "path"
import { stageW1NpmPackages } from "../../script/package-w1-npm"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "w1-cli-npm."))
  roots.push(root)
  return root
}

async function nativeFixture(
  root: string,
  name: string,
  options: { version?: string; runtime?: boolean; engine?: boolean; buildId?: string | false } = {},
) {
  const { version = "0.2.0", runtime = true, engine = true, buildId = "engine-build" } = options
  const target = path.join(root, "dist", name)
  const windows = name.includes("-windows-")
  const platform = windows ? "win32" : name.includes("-linux-") ? "linux" : "darwin"
  const arch = name.includes("-arm64") ? "arm64" : "x64"
  await mkdir(path.join(target, "bin", "w1-runtime"), { recursive: true })
  await Bun.write(
    path.join(target, "package.json"),
    JSON.stringify({ name, version, preferUnplugged: true, os: [platform], cpu: [arch] }),
  )
  await Bun.write(path.join(target, "bin", windows ? "w1.exe" : "w1"), "fixture")
  if (runtime) await Bun.write(path.join(target, "bin", "w1-runtime", "run-stream.mjs"), "fixture runtime")
  if (engine) await Bun.write(path.join(target, "bin", "w1-runtime", "w1-engine.mjs"), "fixture engine")
  if (buildId !== false) await Bun.write(path.join(target, "bin", "w1-runtime", "BUILD_ID"), `${buildId}\n`)
  return target
}

/** Mirrors an installed npm tree: <root>/node_modules/@w1-lab/<package>. */
async function installedMeta(root: string, optionalDependencies: Record<string, string>) {
  const metaRoot = path.join(root, "node_modules", "@w1-lab", "cli")
  await mkdir(path.join(metaRoot, "bin"), { recursive: true })
  await Bun.write(
    path.join(metaRoot, "package.json"),
    JSON.stringify({ name: "@w1-lab/cli", version: "0.2.0", optionalDependencies }),
  )
  const launcher = path.join(metaRoot, "bin", "w1")
  await Bun.write(launcher, await readFile(path.resolve(import.meta.dir, "../../script/w1-npm-launcher.cjs"), "utf8"))
  return launcher
}

describe("W1 npm package contract", () => {
  test("stages a scoped no-postinstall meta package and complete native packages", async () => {
    const root = await temporaryRoot()
    await nativeFixture(root, "w1-cli-darwin-arm64")
    await nativeFixture(root, "w1-cli-darwin-x64")
    await nativeFixture(root, "w1-cli-darwin-x64-baseline")
    await nativeFixture(root, "w1-cli-windows-x64")

    const output = path.join(root, "staged")
    const result = await stageW1NpmPackages({ dist: path.join(root, "dist"), output, allowPublicRuntime: true })
    expect(result).toEqual({
      version: "0.2.0",
      buildId: "engine-build",
      nativeDirectories: [
        "w1-cli-darwin-arm64",
        "w1-cli-darwin-x64",
        "w1-cli-darwin-x64-baseline",
        "w1-cli-windows-x64",
      ],
      nativePackages: [
        "@w1-lab/cli-darwin-arm64",
        "@w1-lab/cli-darwin-x64",
        "@w1-lab/cli-darwin-x64-baseline",
        "@w1-lab/cli-windows-x64",
      ],
      metaPackage: "@w1-lab/cli",
    })

    const meta = JSON.parse(await readFile(path.join(output, "w1-cli", "package.json"), "utf8"))
    expect(meta).toMatchObject({
      name: "@w1-lab/cli",
      version: "0.2.0",
      bin: { w1: "bin/w1" },
      os: ["darwin", "win32"],
      cpu: ["arm64", "x64"],
      publishConfig: { access: "public", tag: "next", provenance: true },
      optionalDependencies: {
        "@w1-lab/cli-darwin-arm64": "0.2.0",
        "@w1-lab/cli-darwin-x64": "0.2.0",
        "@w1-lab/cli-darwin-x64-baseline": "0.2.0",
        "@w1-lab/cli-windows-x64": "0.2.0",
      },
    })
    expect(meta.scripts).toBeUndefined()
    // Every declared dependency must live under the owned scope, or ownership stops being the control.
    for (const name of Object.keys(meta.optionalDependencies)) expect(name.startsWith("@w1-lab/")).toBe(true)

    const native = JSON.parse(await readFile(path.join(output, "w1-cli-darwin-arm64", "package.json"), "utf8"))
    expect(native.name).toBe("@w1-lab/cli-darwin-arm64")
    expect(native.files).toContain("assets")
    expect(await readFile(path.join(output, "w1-cli-darwin-arm64", "bin", "w1-runtime", "run-stream.mjs"), "utf8")).toBe(
      "fixture runtime",
    )
    expect((await stat(path.join(output, "w1-cli", "bin", "w1"))).mode & 0o111).not.toBe(0)
    expect(await readFile(path.join(output, "w1-cli", "LICENSE"), "utf8")).toContain("MIT License")
  })

  test("fails closed when a native package is missing its bundled runtime", async () => {
    const root = await temporaryRoot()
    await nativeFixture(root, "w1-cli-darwin-arm64", { runtime: false })
    await expect(
      stageW1NpmPackages({
        dist: path.join(root, "dist"),
        output: path.join(root, "staged"),
        allowPublicRuntime: true,
      }),
    ).rejects.toThrow("missing bin/w1-runtime/run-stream.mjs")
  })

  test("fails closed when a native package is missing its engine bundle", async () => {
    const root = await temporaryRoot()
    await nativeFixture(root, "w1-cli-darwin-arm64", { engine: false })
    await expect(
      stageW1NpmPackages({
        dist: path.join(root, "dist"),
        output: path.join(root, "staged"),
        allowPublicRuntime: true,
      }),
    ).rejects.toThrow("missing bin/w1-runtime/w1-engine.mjs")
  })

  test("refuses to publish an unidentified or dirty engine build", async () => {
    for (const buildId of ["source", "abc123-dirty", ""] as const) {
      const root = await temporaryRoot()
      await nativeFixture(root, "w1-cli-darwin-arm64", { buildId })
      await expect(
        stageW1NpmPackages({
          dist: path.join(root, "dist"),
          output: path.join(root, "staged"),
          allowPublicRuntime: true,
        }),
      ).rejects.toThrow("unpublishable engine BUILD_ID")
    }
  })

  test("refuses to publish native packages built from different engines", async () => {
    const root = await temporaryRoot()
    await nativeFixture(root, "w1-cli-darwin-arm64", { buildId: "engine-a" })
    await nativeFixture(root, "w1-cli-windows-x64", { buildId: "engine-b" })
    await expect(
      stageW1NpmPackages({
        dist: path.join(root, "dist"),
        output: path.join(root, "staged"),
        allowPublicRuntime: true,
      }),
    ).rejects.toThrow("disagree on engine BUILD_ID")
  })

  test("requires an explicit public-runtime exposure decision", async () => {
    const root = await temporaryRoot()
    await nativeFixture(root, "w1-cli-darwin-arm64")
    await expect(
      stageW1NpmPackages({ dist: path.join(root, "dist"), output: path.join(root, "staged") }),
    ).rejects.toThrow("W1_NPM_ALLOW_PUBLIC_RUNTIME=1")
  })

  test("launcher fails closed when npm omitted the compatible native package", async () => {
    const root = await temporaryRoot()
    const launcher = await installedMeta(root, {})
    const child = Bun.spawn({ cmd: ["node", launcher], stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(1)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain("native package")
    expect(stderr).toContain("@w1-lab/cli@")
    expect(await new Response(child.stdout).text()).toBe("")
  })

  test.skipIf(process.platform === "win32")(
    "launcher refuses a native package whose engine is unidentified",
    async () => {
      const root = await temporaryRoot()
      const platform = process.platform === "darwin" ? "darwin" : "linux"
      const arch = process.arch === "arm64" ? "arm64" : "x64"
      const name = `@w1-lab/cli-${platform}-${arch}`
      const nativeRoot = path.join(root, "node_modules", name)
      await mkdir(path.join(nativeRoot, "bin", "w1-runtime"), { recursive: true })
      await Bun.write(path.join(nativeRoot, "package.json"), JSON.stringify({ name, version: "0.2.0" }))
      await Bun.write(path.join(nativeRoot, "bin", "w1-runtime", "run-stream.mjs"), "fixture runtime")
      // Engine bundle present, but BUILD_ID says this is an unpublished source runtime.
      await Bun.write(path.join(nativeRoot, "bin", "w1-runtime", "w1-engine.mjs"), "fixture engine")
      await Bun.write(path.join(nativeRoot, "bin", "w1-runtime", "BUILD_ID"), "source\n")
      const executable = path.join(nativeRoot, "bin", "w1")
      await Bun.write(executable, '#!/bin/sh\nprintf "native:%s" "$1"\n')
      await chmod(executable, 0o755)

      const launcher = await installedMeta(root, { [name]: "0.2.0" })
      const child = Bun.spawn({ cmd: ["node", launcher, "--version"], stdout: "pipe", stderr: "pipe" })
      expect(await child.exited).toBe(1)
      expect(await new Response(child.stdout).text()).toBe("")
    },
  )

  test.skipIf(process.platform === "win32")("launcher runs the native package with its runtime beside it", async () => {
    const root = await temporaryRoot()
    const platform = process.platform === "darwin" ? "darwin" : "linux"
    const arch = process.arch === "arm64" ? "arm64" : "x64"
    const name = `@w1-lab/cli-${platform}-${arch}`
    const nativeRoot = path.join(root, "node_modules", name)
    await mkdir(path.join(nativeRoot, "bin", "w1-runtime"), { recursive: true })
    await Bun.write(path.join(nativeRoot, "package.json"), JSON.stringify({ name, version: "0.2.0" }))
    await Bun.write(path.join(nativeRoot, "bin", "w1-runtime", "run-stream.mjs"), "fixture runtime")
    await Bun.write(path.join(nativeRoot, "bin", "w1-runtime", "w1-engine.mjs"), "fixture engine")
    await Bun.write(path.join(nativeRoot, "bin", "w1-runtime", "BUILD_ID"), "engine-build\n")
    const executable = path.join(nativeRoot, "bin", "w1")
    await Bun.write(executable, '#!/bin/sh\nprintf "native:%s" "$1"\n')
    await chmod(executable, 0o755)

    const launcher = await installedMeta(root, { [name]: "0.2.0" })
    const child = Bun.spawn({ cmd: ["node", launcher, "--version"], stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("native:--version")
    expect(await new Response(child.stderr).text()).toBe("")
  })
})
