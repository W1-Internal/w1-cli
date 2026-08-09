import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "fs/promises"
import os from "os"
import path from "path"
import { stageW1NpmPackages } from "../../script/package-w1-npm"

const roots: string[] = []
const CLI_REF = "a".repeat(40)
const HARNESS_REF = "b".repeat(40)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "w1-cli-npm."))
  roots.push(root)
  return root
}

async function nativeFixture(root: string, name: string, version = "0.2.0", includeRuntime = true) {
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
  if (includeRuntime) await Bun.write(path.join(target, "bin", "w1-runtime", "run-stream.mjs"), "fixture runtime")
  await Bun.write(path.join(target, "bin", "w1-runtime", "w1-engine.mjs"), "fixture engine")
  await Bun.write(path.join(target, "bin", "w1-runtime", "w1-engine-client.mjs"), "fixture engine client")
  await Bun.write(path.join(target, "bin", "w1-runtime", "BUILD_ID"), HARNESS_REF + "\n")
  await Bun.write(path.join(target, "bin", "w1-runtime", "standard_fonts", "LICENSE_FOXIT"), "fixture font")
  await Bun.write(path.join(target, "bin", "w1-runtime", "node_modules", "@napi-rs", "canvas", "package.json"), "{}")
  await Bun.write(path.join(target, "assets", "skills", "fixture", "SKILL.md"), "# fixture")
  await Bun.write(path.join(target, "assets", "plugins", "fixture", "plugin.json"), "{}")
  return target
}

function stageOptions(root: string, output = path.join(root, "staged")) {
  return {
    dist: path.join(root, "dist"),
    output,
    allowPublicRuntime: true,
    cliRef: CLI_REF,
    harnessRef: HARNESS_REF,
  }
}

describe("W1 npm package contract", () => {
  test("stages a no-postinstall meta package and complete native packages", async () => {
    const root = await temporaryRoot()
    await nativeFixture(root, "w1-cli-darwin-arm64")
    await nativeFixture(root, "w1-cli-darwin-x64")
    await nativeFixture(root, "w1-cli-darwin-x64-baseline")

    const output = path.join(root, "staged")
    const result = await stageW1NpmPackages(stageOptions(root, output))
    expect(result).toEqual({
      version: "0.2.0",
      nativePackages: ["w1-cli-darwin-arm64", "w1-cli-darwin-x64", "w1-cli-darwin-x64-baseline"],
      metaPackage: "w1-cli",
    })

    const meta = JSON.parse(await readFile(path.join(output, "w1-cli", "package.json"), "utf8"))
    expect(meta).toMatchObject({
      name: "w1-cli",
      version: "0.2.0",
      bin: { w1: "bin/w1" },
      os: ["darwin"],
      cpu: ["arm64", "x64"],
      publishConfig: { access: "public", tag: "next", provenance: true },
      optionalDependencies: {
        "w1-cli-darwin-arm64": "0.2.0",
        "w1-cli-darwin-x64": "0.2.0",
        "w1-cli-darwin-x64-baseline": "0.2.0",
      },
    })
    expect(meta.scripts).toBeUndefined()
    expect(await readFile(path.join(output, "w1-cli-darwin-arm64", "bin", "w1-runtime", "run-stream.mjs"), "utf8")).toBe(
      "fixture runtime",
    )
    const runtimeManifest = JSON.parse(
      await readFile(path.join(output, "w1-cli-darwin-arm64", "w1-runtime-manifest.json"), "utf8"),
    )
    expect(runtimeManifest).toMatchObject({
      schemaVersion: 1,
      package: { name: "w1-cli-darwin-arm64", version: "0.2.0", platform: "darwin", arch: "arm64" },
      protocol: { engine: 1, worker: "w1-stdio-v1" },
      build: { cli: CLI_REF, engine: HARNESS_REF, harnessRef: HARNESS_REF },
      entrypoints: {
        cli: "bin/w1",
        engine: "bin/w1-runtime/w1-engine.mjs",
        engineClient: "bin/w1-runtime/w1-engine-client.mjs",
        worker: "bin/w1-runtime/run-stream.mjs",
      },
    })
    expect(runtimeManifest.files["bin/w1-runtime/w1-engine.mjs"].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await stat(path.join(output, "w1-cli", "bin", "w1"))).mode & 0o111).not.toBe(0)
    expect(await readFile(path.join(output, "w1-cli", "LICENSE"), "utf8")).toContain("MIT License")
  })

  test("fails closed when a native package is missing its bundled runtime", async () => {
    const root = await temporaryRoot()
    await nativeFixture(root, "w1-cli-darwin-arm64", "0.2.0", false)
    await expect(
      stageW1NpmPackages(stageOptions(root)),
    ).rejects.toThrow("missing bin/w1-runtime/run-stream.mjs")
  })

  test("requires an explicit public-runtime exposure decision", async () => {
    const root = await temporaryRoot()
    await nativeFixture(root, "w1-cli-darwin-arm64")
    await expect(
      stageW1NpmPackages({ ...stageOptions(root), allowPublicRuntime: false }),
    ).rejects.toThrow("W1_NPM_ALLOW_PUBLIC_RUNTIME=1")
  })

  test("launcher fails closed when npm omitted the compatible native package", async () => {
    const root = await temporaryRoot()
    const metaRoot = path.join(root, "node_modules", "w1-cli")
    await mkdir(path.join(metaRoot, "bin"), { recursive: true })
    await Bun.write(
      path.join(metaRoot, "package.json"),
      JSON.stringify({ name: "w1-cli", version: "0.2.0", optionalDependencies: {} }),
    )
    await Bun.write(
      path.join(metaRoot, "bin", "w1"),
      await readFile(path.resolve(import.meta.dir, "../../script/w1-npm-launcher.cjs"), "utf8"),
    )
    const child = Bun.spawn({ cmd: ["node", path.join(metaRoot, "bin", "w1")], stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain("native package")
    expect(await new Response(child.stdout).text()).toBe("")
  })

  test.skipIf(process.platform === "win32")("launcher runs the native package with its runtime beside it", async () => {
    const root = await temporaryRoot()
    const platform = process.platform === "darwin" ? "darwin" : "linux"
    const arch = process.arch === "arm64" ? "arm64" : "x64"
    const name = `w1-cli-${platform}-${arch}`
    const modules = path.join(root, "node_modules")
    const metaRoot = path.join(modules, "w1-cli")
    const nativeRoot = path.join(modules, name)
    await nativeFixture(root, name)
    const executable = path.join(nativeRoot, "bin", "w1")
    await stageW1NpmPackages(stageOptions(root, modules))
    await Bun.write(executable, '#!/bin/sh\nprintf "native:%s" "$1"\n')
    await chmod(executable, 0o755)
    // The executable is part of the signed manifest, so restage after replacing the fixture.
    await Bun.write(path.join(root, "dist", name, "bin", "w1"), '#!/bin/sh\nprintf "native:%s" "$1"\n')
    await stageW1NpmPackages(stageOptions(root, modules))
    const launcher = path.join(metaRoot, "bin", "w1")
    const child = Bun.spawn({ cmd: ["node", launcher, "--version"], stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("native:--version")
    expect(await new Response(child.stderr).text()).toBe("")
  })

  test.skipIf(process.platform === "win32")("launcher fails closed when a bundled runtime file is tampered", async () => {
    const root = await temporaryRoot()
    const platform = process.platform === "darwin" ? "darwin" : "linux"
    const arch = process.arch === "arm64" ? "arm64" : "x64"
    const name = `w1-cli-${platform}-${arch}`
    const modules = path.join(root, "node_modules")
    await nativeFixture(root, name)
    await stageW1NpmPackages(stageOptions(root, modules))
    await Bun.write(path.join(modules, name, "bin", "w1-runtime", "run-stream.mjs"), "tampered")
    const child = Bun.spawn({ cmd: ["node", path.join(modules, "w1-cli", "bin", "w1")], stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain("runtime integrity check failed")
  })

  test("staging fails closed when assets or the adjacent engine client are missing", async () => {
    const root = await temporaryRoot()
    const target = await nativeFixture(root, "w1-cli-darwin-arm64")
    await rm(path.join(target, "assets", "skills"), { recursive: true, force: true })
    await expect(stageW1NpmPackages(stageOptions(root))).rejects.toThrow("required runtime directory assets/skills")
    await Bun.write(path.join(target, "assets", "skills", "fixture", "SKILL.md"), "# fixture")
    await rm(path.join(target, "bin", "w1-runtime", "w1-engine-client.mjs"))
    await expect(stageW1NpmPackages(stageOptions(root))).rejects.toThrow("missing bin/w1-runtime/w1-engine-client.mjs")
  })
})
