import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"

export const W1_RUNTIME_MANIFEST_SCHEMA = 1 as const

export type W1RuntimeManifest = {
  schemaVersion: typeof W1_RUNTIME_MANIFEST_SCHEMA
  package: {
    name: string
    version: string
    platform: string
    arch: string
  }
  protocol: {
    engine: number
    worker: string
  }
  build: {
    cli: string
    engine: string
    harnessRef: string
  }
  entrypoints: {
    cli: string
    engine: string
    engineClient: string
    worker: string
  }
  files: Record<string, { sha256: string; bytes: number }>
  assets: {
    skills: string
    plugins: string
    fonts: string
    nativeDependencies: string
  }
}

const SHA256 = /^[0-9a-f]{64}$/
const GIT_REF = /^[0-9a-f]{40}$/

async function hashFile(target: string) {
  const bytes = await readFile(target)
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength }
}

async function requireDirectory(root: string, relative: string, label: string) {
  const target = path.resolve(root, relative)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`W1 ${label} escapes the package root.`)
  const info = await lstat(target).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`W1 ${label} is missing: ${relative}`)
  if ((await readdir(target)).length === 0) throw new Error(`W1 ${label} is empty: ${relative}`)
}

async function filesBelow(root: string, relative: string): Promise<string[]> {
  const directory = packagePath(root, relative)
  const files: string[] = []
  for (const name of (await readdir(directory)).sort()) {
    const child = path.posix.join(relative, name)
    const target = packagePath(root, child)
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error(`W1 runtime contains a symbolic link: ${child}`)
    if (info.isDirectory()) files.push(...(await filesBelow(root, child)))
    else if (info.isFile()) files.push(child)
    else throw new Error(`W1 runtime contains a non-regular entry: ${child}`)
  }
  return files
}

function packagePath(root: string, relative: string) {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\")) {
    throw new Error(`W1 runtime manifest contains an invalid path: ${relative}`)
  }
  const target = path.resolve(root, relative)
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error(`W1 runtime manifest path escapes its package: ${relative}`)
  }
  return target
}

export async function validateW1RuntimePackage(root: string): Promise<W1RuntimeManifest> {
  const resolvedRoot = path.resolve(root)
  const manifestPath = path.join(resolvedRoot, "w1-runtime-manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as W1RuntimeManifest
  if (manifest.schemaVersion !== W1_RUNTIME_MANIFEST_SCHEMA) throw new Error("Unsupported W1 runtime manifest schema.")
  if (!manifest.package?.name || !manifest.package.version || !manifest.package.platform || !manifest.package.arch) {
    throw new Error("W1 runtime manifest package identity is incomplete.")
  }
  if (manifest.protocol?.engine !== 1 || manifest.protocol?.worker !== "w1-stdio-v1") {
    throw new Error("W1 runtime manifest protocol is incompatible.")
  }
  if (!GIT_REF.test(manifest.build?.cli) || !GIT_REF.test(manifest.build?.harnessRef)) {
    throw new Error("W1 runtime manifest build identity is invalid.")
  }
  if (!manifest.build.engine) throw new Error("W1 runtime manifest engine identity is missing.")

  const requiredEntrypoints = [
    manifest.entrypoints?.cli,
    manifest.entrypoints?.engine,
    manifest.entrypoints?.engineClient,
    manifest.entrypoints?.worker,
  ]
  for (const relative of requiredEntrypoints) {
    if (typeof relative !== "string" || !manifest.files[relative]) {
      throw new Error(`W1 runtime manifest is missing an entrypoint hash: ${String(relative)}`)
    }
  }

  const expectedFiles = Object.keys(manifest.files).sort()
  const actualFiles = [...(await filesBelow(resolvedRoot, "bin")), ...(await filesBelow(resolvedRoot, "assets"))].sort()
  if (expectedFiles.length !== actualFiles.length || expectedFiles.some((value, index) => value !== actualFiles[index])) {
    throw new Error("W1 runtime file inventory does not match its signed manifest.")
  }

  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (!SHA256.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
      throw new Error(`W1 runtime manifest contains an invalid hash record: ${relative}`)
    }
    const target = packagePath(resolvedRoot, relative)
    const info = await lstat(target).catch(() => undefined)
    if (!info?.isFile()) throw new Error(`W1 runtime file is missing: ${relative}`)
    const actual = await hashFile(target)
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`W1 runtime integrity check failed: ${relative}`)
    }
  }

  await requireDirectory(resolvedRoot, manifest.assets.skills, "skills")
  await requireDirectory(resolvedRoot, manifest.assets.plugins, "plugins")
  await requireDirectory(resolvedRoot, manifest.assets.fonts, "fonts")
  await requireDirectory(resolvedRoot, manifest.assets.nativeDependencies, "native dependencies")
  return manifest
}
