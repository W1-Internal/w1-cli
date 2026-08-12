#!/usr/bin/env bun

import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))
const packagePattern = /^w1-cli-(darwin|linux|windows)-(arm64|x64)(?:-baseline)?(?:-musl)?$/

/**
 * Everything W1 publishes lives under one owned npm scope. Unscoped native names are squattable:
 * the meta package resolves each platform dependency by name, so whoever owns that name controls
 * the executable this launcher spawns. A scope makes ownership — not validation — the control, and
 * covers platform names that do not exist yet.
 */
const NPM_SCOPE = "@w1-lab"
export const W1_NPM_META_PACKAGE = `${NPM_SCOPE}/cli`

/** Build output stays `w1-cli-<platform>-<arch>`; only the published identity is scoped. */
export function publishedNameFor(buildDirectoryName: string) {
  if (!packagePattern.test(buildDirectoryName)) {
    throw new Error(`Refusing to publish an unrecognised W1 native package: ${buildDirectoryName}`)
  }
  return `${NPM_SCOPE}/${buildDirectoryName.replace(/^w1-/, "")}`
}

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
  const buildIds: string[] = []
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
    const engine = path.join(source, "bin", "w1-runtime", "w1-engine.mjs")
    const engineLib = path.join(source, "bin", "w1-runtime", "w1-engine-lib.mjs")
    const buildIdFile = path.join(source, "bin", "w1-runtime", "BUILD_ID")
    if (!(await regularFile(executable))) throw new Error(`${name} is missing its native W1 executable`)
    if (!(await regularFile(runtime))) throw new Error(`${name} is missing bin/w1-runtime/run-stream.mjs`)
    // A published build must carry an identified engine. Without these the launcher would start a
    // binary that can only resolve an engine from a user-writable path or a source checkout.
    if (!(await regularFile(engine))) throw new Error(`${name} is missing bin/w1-runtime/w1-engine.mjs`)
    // ENGINE ZERO: the CLI HOSTS its engine by importing this library — without it every run
    // dies on connect with a reinstall message, so its absence must fail the publish, not the user.
    if (!(await regularFile(engineLib))) throw new Error(`${name} is missing bin/w1-runtime/w1-engine-lib.mjs`)
    if (!(await regularFile(buildIdFile))) throw new Error(`${name} is missing bin/w1-runtime/BUILD_ID`)
    const buildId = (await readFile(buildIdFile, "utf8")).trim()
    if (!buildId || buildId === "source" || buildId.endsWith("-dirty")) {
      throw new Error(`${name} has an unpublishable engine BUILD_ID: ${buildId || "(empty)"}`)
    }
    buildIds.push(buildId)
    manifests.push(manifest)
  }

  const distinctBuildIds = unique(buildIds)
  if (distinctBuildIds.length !== 1) {
    throw new Error(`W1 native packages disagree on engine BUILD_ID: ${distinctBuildIds.join(", ")}`)
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
          name: publishedNameFor(manifest.name),
          description: `Native W1 CLI runtime for ${manifest.os[0]}/${manifest.cpu[0]}`,
          license: "MIT",
          repository: { type: "git", url: "git+https://github.com/W1-Internal/w1-cli.git" },
          homepage: "https://w1lab.com",
          // `assets` carries the bundled skills the runtime loads from disk. The build stages them
          // into the package root, so omitting them here would publish a binary that cannot find them.
          files: ["bin", "assets", "LICENSE"],
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
        name: W1_NPM_META_PACKAGE,
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
        optionalDependencies: Object.fromEntries(
          manifests.map((manifest) => [publishedNameFor(manifest.name), version]),
        ),
        publishConfig: { access: "public", tag: "next", provenance: true },
      },
      null,
      2,
    ) + "\n",
  )

  return {
    version,
    buildId: distinctBuildIds[0]!,
    /** Staging directory names, which stay unscoped so build and publish paths agree. */
    nativeDirectories: manifests.map((manifest) => manifest.name),
    /** Registry identities actually published. */
    nativePackages: manifests.map((manifest) => publishedNameFor(manifest.name)),
    metaPackage: W1_NPM_META_PACKAGE,
  }
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
