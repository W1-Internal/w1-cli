#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))
const packagePattern = /^w1-cli-(darwin|linux|windows)-(arm64|x64)(?:-baseline)?(?:-musl)?$/

type NativeManifest = {
  name: string
  version: string
  os: string[]
  cpu: string[]
  libc?: string[]
  preferUnplugged?: boolean
}

type Options = {
  dist: string
  output: string
  allowPublicRuntime?: boolean
  cliRef?: string
  harnessRef?: string
}

const exactRef = /^[0-9a-f]{40}$/

function argument(name: string) {
  const prefix = `--${name}=`
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

function unique(values: string[]) {
  return [...new Set(values)].sort()
}

async function regularFile(target: string) {
  return stat(target)
    .then((value) => value.isFile())
    .catch(() => false)
}

async function requiredDirectory(target: string) {
  const info = await stat(target).catch(() => undefined)
  return info?.isDirectory() === true && (await readdir(target)).length > 0
}

async function filesBelow(root: string, relative = ""): Promise<string[]> {
  const target = path.join(root, relative)
  const entries = await readdir(target, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.posix.join(relative.replaceAll(path.sep, "/"), entry.name)
    const absolute = path.join(root, child)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`Refusing to package symbolic link: ${child}`)
    if (info.isDirectory()) files.push(...(await filesBelow(root, child)))
    else if (info.isFile()) files.push(child)
    else throw new Error(`Refusing to package non-regular runtime entry: ${child}`)
  }
  return files
}

async function hashRecord(root: string, relative: string) {
  const bytes = await readFile(path.join(root, relative))
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength }
}

export async function stageW1NpmPackages(options: Options) {
  if (!options.allowPublicRuntime) {
    throw new Error(
      "Refusing to stage the bundled W1 runtime for public npm. " +
        "Set W1_NPM_ALLOW_PUBLIC_RUNTIME=1 only after explicitly approving that source exposure.",
    )
  }
  const dist = path.resolve(options.dist)
  const output = path.resolve(options.output)
  const cliRef = options.cliRef?.trim()
  const harnessRef = options.harnessRef?.trim()
  if (!cliRef || !exactRef.test(cliRef)) throw new Error("W1 npm staging requires an exact 40-character CLI ref.")
  if (!harnessRef || !exactRef.test(harnessRef)) throw new Error("W1 npm staging requires an exact 40-character harness ref.")
  const entries = await readdir(dist, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isDirectory() && packagePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (!names.length) throw new Error(`No W1 native packages found in ${dist}`)

  const manifests: NativeManifest[] = []
  for (const name of names) {
    const source = path.join(dist, name)
    const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as NativeManifest
    if (manifest.name !== name || !packagePattern.test(manifest.name)) {
      throw new Error(`Invalid W1 native package manifest: ${name}`)
    }
    if (!manifest.version || manifest.os?.length !== 1 || manifest.cpu?.length !== 1) {
      throw new Error(`Incomplete W1 native package manifest: ${name}`)
    }
    const executable = path.join(source, "bin", name.includes("-windows-") ? "w1.exe" : "w1")
    const runtimeRoot = path.join(source, "bin", "w1-runtime")
    const runtime = path.join(runtimeRoot, "run-stream.mjs")
    const engine = path.join(runtimeRoot, "w1-engine.mjs")
    const engineClient = path.join(runtimeRoot, "w1-engine-client.mjs")
    const buildFile = path.join(runtimeRoot, "BUILD_ID")
    if (!(await regularFile(executable))) throw new Error(`${name} is missing its native W1 executable`)
    if (!(await regularFile(runtime))) throw new Error(`${name} is missing bin/w1-runtime/run-stream.mjs`)
    if (!(await regularFile(engine))) throw new Error(`${name} is missing bin/w1-runtime/w1-engine.mjs`)
    if (!(await regularFile(engineClient))) throw new Error(`${name} is missing bin/w1-runtime/w1-engine-client.mjs`)
    if (!(await regularFile(buildFile))) throw new Error(`${name} is missing bin/w1-runtime/BUILD_ID`)
    const engineBuildId = (await readFile(buildFile, "utf8")).trim()
    if (engineBuildId !== harnessRef) {
      throw new Error(`${name} engine build ${engineBuildId || "<empty>"} does not match harness ref ${harnessRef}`)
    }
    for (const required of [
      path.join(source, "assets", "skills"),
      path.join(source, "assets", "plugins"),
      path.join(runtimeRoot, "standard_fonts"),
      path.join(runtimeRoot, "node_modules", "@napi-rs"),
    ]) {
      if (!(await requiredDirectory(required))) throw new Error(`${name} is missing required runtime directory ${path.relative(source, required)}`)
    }
    manifests.push(manifest)
  }

  const versions = unique(manifests.map((manifest) => manifest.version))
  if (versions.length !== 1) throw new Error(`W1 native package versions disagree: ${versions.join(", ")}`)
  const version = versions[0]!
  const license = await readFile(path.join(repositoryRoot, "LICENSE"), "utf8")
  const launcher = await readFile(path.join(packageRoot, "script", "w1-npm-launcher.cjs"), "utf8")

  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })

  for (const manifest of manifests) {
    const source = path.join(dist, manifest.name)
    const target = path.join(output, manifest.name)
    await cp(source, target, { recursive: true })
    const executable = path.join(target, "bin", manifest.name.includes("-windows-") ? "w1.exe" : "w1")
    if (!manifest.name.includes("-windows-")) await chmod(executable, 0o755)
    await writeFile(path.join(target, "LICENSE"), license)
    const engineBuildId = (await readFile(path.join(target, "bin", "w1-runtime", "BUILD_ID"), "utf8")).trim()
    const runtimeFiles = [
      ...(await filesBelow(target, "bin")),
      ...(await filesBelow(target, "assets")),
    ].sort()
    const files = Object.fromEntries(await Promise.all(runtimeFiles.map(async (relative) => [relative, await hashRecord(target, relative)])))
    await writeFile(
      path.join(target, "w1-runtime-manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          package: {
            name: manifest.name,
            version: manifest.version,
            platform: manifest.os[0],
            arch: manifest.cpu[0],
          },
          protocol: { engine: 1, worker: "w1-stdio-v1" },
          build: { cli: cliRef, engine: engineBuildId, harnessRef },
          entrypoints: {
            cli: `bin/${manifest.name.includes("-windows-") ? "w1.exe" : "w1"}`,
            engine: "bin/w1-runtime/w1-engine.mjs",
            engineClient: "bin/w1-runtime/w1-engine-client.mjs",
            worker: "bin/w1-runtime/run-stream.mjs",
          },
          files,
          assets: {
            skills: "assets/skills",
            plugins: "assets/plugins",
            fonts: "bin/w1-runtime/standard_fonts",
            nativeDependencies: "bin/w1-runtime/node_modules/@napi-rs",
          },
        },
        null,
        2,
      ) + "\n",
    )
    await writeFile(
      path.join(target, "package.json"),
      JSON.stringify(
        {
          ...manifest,
          description: `Native W1 CLI runtime for ${manifest.os[0]}/${manifest.cpu[0]}`,
          license: "MIT",
          repository: { type: "git", url: "git+https://github.com/W1-Internal/w1-cli.git" },
          homepage: "https://w1lab.com",
          files: ["bin", "assets", "w1-runtime-manifest.json", "LICENSE"],
          publishConfig: { access: "public", tag: "next", provenance: true },
        },
        null,
        2,
      ) + "\n",
    )
  }

  const metaRoot = path.join(output, "w1-cli")
  await mkdir(path.join(metaRoot, "bin"), { recursive: true })
  await writeFile(path.join(metaRoot, "bin", "w1"), launcher, { mode: 0o755 })
  await writeFile(path.join(metaRoot, "LICENSE"), license)
  await writeFile(
    path.join(metaRoot, "package.json"),
    JSON.stringify(
      {
        name: "w1-cli",
        version,
        description: "W1, the agentic work surface for your terminal.",
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/W1-Internal/w1-cli.git" },
        homepage: "https://w1lab.com",
        bugs: { url: "https://github.com/W1-Internal/w1-cli/issues" },
        keywords: ["w1", "ai", "agent", "coding", "terminal"],
        bin: { w1: "bin/w1" },
        files: ["bin", "LICENSE"],
        os: unique(manifests.flatMap((manifest) => manifest.os)),
        cpu: unique(manifests.flatMap((manifest) => manifest.cpu)),
        engines: { node: ">=18" },
        optionalDependencies: Object.fromEntries(manifests.map((manifest) => [manifest.name, version])),
        publishConfig: { access: "public", tag: "next", provenance: true },
      },
      null,
      2,
    ) + "\n",
  )

  return { version, nativePackages: manifests.map((manifest) => manifest.name), metaPackage: "w1-cli" }
}

if (import.meta.main) {
  const dist = argument("dist") ?? path.join(packageRoot, "dist")
  const output = argument("output") ?? path.join(dist, "npm")
  const result = await stageW1NpmPackages({
    dist,
    output,
    allowPublicRuntime: process.env.W1_NPM_ALLOW_PUBLIC_RUNTIME === "1",
    cliRef: process.env.W1_CLI_REF,
    harnessRef: process.env.W1_HARNESS_REF,
  })
  console.log(JSON.stringify(result))
}
