#!/usr/bin/env bun

import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises"
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
}

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

export async function stageW1NpmPackages(options: Options) {
  if (!options.allowPublicRuntime) {
    throw new Error(
      "Refusing to stage the bundled W1 runtime for public npm. " +
        "Set W1_NPM_ALLOW_PUBLIC_RUNTIME=1 only after explicitly approving that source exposure.",
    )
  }
  const dist = path.resolve(options.dist)
  const output = path.resolve(options.output)
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
    const runtime = path.join(source, "bin", "w1-runtime", "run-stream.mjs")
    if (!(await regularFile(executable))) throw new Error(`${name} is missing its native W1 executable`)
    if (!(await regularFile(runtime))) throw new Error(`${name} is missing bin/w1-runtime/run-stream.mjs`)
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
    await writeFile(
      path.join(target, "package.json"),
      JSON.stringify(
        {
          ...manifest,
          description: `Native W1 CLI runtime for ${manifest.os[0]}/${manifest.cpu[0]}`,
          license: "MIT",
          repository: { type: "git", url: "git+https://github.com/W1-Internal/w1-cli.git" },
          homepage: "https://w1lab.com",
          files: ["bin", "LICENSE"],
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
  })
  console.log(JSON.stringify(result))
}
