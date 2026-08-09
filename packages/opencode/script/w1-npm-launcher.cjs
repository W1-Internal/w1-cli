#!/usr/bin/env node

const childProcess = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { createRequire } = require("module")

const requireFromHere = createRequire(__filename)
const meta = requireFromHere(path.join(__dirname, "..", "package.json"))

function platformName() {
  if (process.platform === "darwin") return "darwin"
  if (process.platform === "linux") return "linux"
  if (process.platform === "win32") return "windows"
  throw new Error(`Unsupported operating system: ${process.platform}`)
}

function architectureName() {
  if (process.arch === "arm64") return "arm64"
  if (process.arch === "x64") return "x64"
  throw new Error(`Unsupported CPU architecture: ${process.arch}`)
}

function supportsAvx2(platform, arch) {
  if (arch !== "x64") return true
  try {
    if (platform === "linux") return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    if (platform === "darwin") {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      return result.status === 0 && result.stdout.trim() === "1"
    }
    if (platform === "windows") {
      const command =
        '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
      for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        return ["true", "1"].includes(result.stdout.trim().toLowerCase())
      }
    }
  } catch {
    // Unknown capability must use the conservative baseline build.
  }
  return false
}

function isMusl(platform) {
  if (platform !== "linux") return false
  if (fs.existsSync("/etc/alpine-release")) return true
  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8", timeout: 1500 })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function packageCandidates(platform, arch) {
  const base = `w1-cli-${platform}-${arch}`
  const baseline = arch === "x64" && !supportsAvx2(platform, arch)
  if (platform === "linux") {
    const musl = isMusl(platform)
    if (arch === "x64" && musl)
      return baseline
        ? [`${base}-baseline-musl`, `${base}-musl`]
        : [`${base}-musl`, `${base}-baseline-musl`]
    if (musl) return [`${base}-musl`]
    if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
  }
  if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
  return [base]
}

function packageFile(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\")) throw new Error(`invalid runtime path: ${relative}`)
  const target = path.resolve(root, relative)
  if (target === root || !target.startsWith(root + path.sep)) throw new Error(`runtime path escapes package: ${relative}`)
  return target
}

function requireDirectory(root, relative, label) {
  const target = packageFile(root, relative)
  const info = fs.lstatSync(target, { throwIfNoEntry: false })
  if (!info || !info.isDirectory() || fs.readdirSync(target).length === 0) throw new Error(`${label} is missing: ${relative}`)
}

function filesBelow(root, relative) {
  const directory = packageFile(root, relative)
  const files = []
  for (const name of fs.readdirSync(directory).sort()) {
    const child = path.posix.join(relative, name)
    const target = packageFile(root, child)
    const info = fs.lstatSync(target)
    if (info.isSymbolicLink()) throw new Error(`runtime contains a symbolic link: ${child}`)
    if (info.isDirectory()) files.push(...filesBelow(root, child))
    else if (info.isFile()) files.push(child)
    else throw new Error(`runtime contains a non-regular entry: ${child}`)
  }
  return files
}

function validateNativePackage(root, name, platform, arch) {
  const manifestPath = path.join(root, "w1-runtime-manifest.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (manifest.schemaVersion !== 1) throw new Error("unsupported runtime manifest schema")
  if (
    manifest.package?.name !== name ||
    manifest.package?.version !== meta.version ||
    manifest.package?.platform !== (platform === "windows" ? "win32" : platform) ||
    manifest.package?.arch !== arch
  ) {
    throw new Error("runtime package identity does not match this installation")
  }
  if (manifest.protocol?.engine !== 1 || manifest.protocol?.worker !== "w1-stdio-v1") {
    throw new Error("runtime package protocol is incompatible")
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.build?.cli) || !/^[0-9a-f]{40}$/.test(manifest.build?.harnessRef)) {
    throw new Error("runtime package build identity is invalid")
  }
  const entrypoints = [
    manifest.entrypoints?.cli,
    manifest.entrypoints?.engine,
    manifest.entrypoints?.engineClient,
    manifest.entrypoints?.worker,
  ]
  for (const relative of entrypoints) {
    if (typeof relative !== "string" || !manifest.files?.[relative]) throw new Error(`runtime entrypoint is unverified: ${relative}`)
  }
  const expectedFiles = Object.keys(manifest.files || {}).sort()
  const actualFiles = [...filesBelow(root, "bin"), ...filesBelow(root, "assets")].sort()
  if (expectedFiles.length !== actualFiles.length || expectedFiles.some((value, index) => value !== actualFiles[index])) {
    throw new Error("runtime file inventory does not match its signed manifest")
  }
  for (const [relative, expected] of Object.entries(manifest.files || {})) {
    if (!/^[0-9a-f]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
      throw new Error(`runtime hash record is invalid: ${relative}`)
    }
    const target = packageFile(root, relative)
    const info = fs.lstatSync(target, { throwIfNoEntry: false })
    if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error(`runtime file is missing: ${relative}`)
    const bytes = fs.readFileSync(target)
    const digest = crypto.createHash("sha256").update(bytes).digest("hex")
    if (bytes.byteLength !== expected.bytes || digest !== expected.sha256) throw new Error(`runtime integrity check failed: ${relative}`)
  }
  requireDirectory(root, manifest.assets?.skills, "runtime skills")
  requireDirectory(root, manifest.assets?.plugins, "runtime plugins")
  requireDirectory(root, manifest.assets?.fonts, "runtime fonts")
  requireDirectory(root, manifest.assets?.nativeDependencies, "runtime native dependencies")
  return packageFile(root, manifest.entrypoints.cli)
}

function resolveNativePackage() {
  const platform = platformName()
  const arch = architectureName()
  const candidates = packageCandidates(platform, arch)
  const declared = meta.optionalDependencies || {}
  for (const name of candidates) {
    if (declared[name] !== meta.version) continue
    let manifestPath
    try {
      manifestPath = requireFromHere.resolve(`${name}/package.json`)
    } catch {
      // Try the next explicitly declared compatible package.
      continue
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (manifest.name !== name || manifest.version !== meta.version) {
      throw new Error(`native package identity is invalid: ${name}`)
    }
    const root = path.dirname(manifestPath)
    return validateNativePackage(root, name, platform, arch)
  }
  throw new Error(
    `The W1 native package for ${platform}/${arch} is missing or incomplete. ` +
      `Reinstall exactly this release with: npm install --global w1-cli@${meta.version}`,
  )
}

function main() {
  let executable
  try {
    executable = resolveNativePackage()
  } catch (error) {
    console.error(`W1 could not start: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const child = childProcess.spawn(executable, process.argv.slice(2), { stdio: "inherit", windowsHide: false })
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      try {
        child.kill(signal)
      } catch {
        // The child may already have exited.
      }
    })
  }
  child.on("error", (error) => {
    console.error(`W1 could not start its native executable: ${error.message}`)
    process.exit(1)
  })
  child.on("exit", (code, signal) => {
    if (signal) {
      try {
        process.kill(process.pid, signal)
        return
      } catch {
        process.exit(1)
      }
    }
    process.exit(typeof code === "number" ? code : 1)
  })
}

main()
