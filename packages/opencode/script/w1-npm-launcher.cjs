#!/usr/bin/env node

const childProcess = require("child_process")
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
  // Scoped: only the @w1-lab org can publish these names, so resolution cannot land on a squatted
  // package. Ownership is the control here — every check below is satisfiable by whoever owns the name.
  const base = `@w1-lab/cli-${platform}-${arch}`
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

function resolveNativePackage() {
  const platform = platformName()
  const arch = architectureName()
  const candidates = packageCandidates(platform, arch)
  const declared = meta.optionalDependencies || {}
  for (const name of candidates) {
    if (declared[name] !== meta.version) continue
    try {
      const manifestPath = requireFromHere.resolve(`${name}/package.json`)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      if (manifest.name !== name || manifest.version !== meta.version) continue
      const root = path.dirname(manifestPath)
      const executable = path.join(root, "bin", platform === "windows" ? "w1.exe" : "w1")
      const runtimeRoot = path.join(root, "bin", "w1-runtime")
      const runtime = path.join(runtimeRoot, "run-stream.mjs")
      const engine = path.join(runtimeRoot, "w1-engine.mjs")
      const buildIdFile = path.join(runtimeRoot, "BUILD_ID")
      if (!fs.existsSync(executable) || !fs.existsSync(runtime)) continue
      // Fail closed on engine identity. A packaged build must never fall through to a user-writable
      // ~/.w1/runtime or a source checkout because its own engine bundle is absent or unidentified.
      if (!fs.existsSync(engine) || !fs.existsSync(buildIdFile)) continue
      const buildId = fs.readFileSync(buildIdFile, "utf8").trim()
      if (!buildId || buildId === "source") continue
      return executable
    } catch {
      // Try the next explicitly declared compatible package.
    }
  }
  throw new Error(
    `The W1 native package for ${platform}/${arch} is missing or incomplete. ` +
      `Reinstall exactly this release with: npm install --global @w1-lab/cli@${meta.version}`,
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
