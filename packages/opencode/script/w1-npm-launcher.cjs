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

function usableExecutable(name, platform) {
  if ((meta.optionalDependencies || {})[name] !== meta.version) return null
  try {
    const manifestPath = requireFromHere.resolve(`${name}/package.json`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (manifest.name !== name || manifest.version !== meta.version) return null
    const root = path.dirname(manifestPath)
    const executable = path.join(root, "bin", platform === "windows" ? "w1.exe" : "w1")
    const runtimeRoot = path.join(root, "bin", "w1-runtime")
    if (!fs.existsSync(executable) || !fs.existsSync(path.join(runtimeRoot, "run-stream.mjs"))) return null
    // Fail closed on engine identity. A packaged build must never fall through to a user-writable
    // ~/.w1/runtime or a source checkout because its own engine bundle is absent or unidentified.
    const buildIdFile = path.join(runtimeRoot, "BUILD_ID")
    if (!fs.existsSync(path.join(runtimeRoot, "w1-engine.mjs")) || !fs.existsSync(buildIdFile)) return null
    const buildId = fs.readFileSync(buildIdFile, "utf8").trim()
    if (!buildId || buildId === "source") return null
    return executable
  } catch {
    return null
  }
}

/**
 * Install the native package this machine needs, right now, without asking.
 *
 * npm does not reliably add a NEWLY PUBLISHED optional dependency to an existing global install —
 * `npm i -g @w1-lab/cli@latest` reports "changed 2 packages" and silently leaves the new one out.
 * That is exactly what happened the day `cli-windows-x64-baseline` first shipped: the package was
 * published and complete, the machine that needed it never received it, and W1 answered with an
 * error telling the user to run the same command that had just failed them.
 *
 * A tool that knows precisely which package it is missing, and the exact version, has no business
 * making a person fix that by hand. It repairs itself and carries on. Bounded by design: one
 * attempt, guarded by W1_NPM_REPAIRED so a repaired process can never re-enter, and only ever
 * installing a scoped @w1-lab name pinned to this launcher's own version — it can neither loop nor
 * be talked into fetching something else.
 */
function repairNativePackage(candidates, platform) {
  if (process.env.W1_NPM_REPAIRED === "1") return null
  const wanted = candidates.find((name) => (meta.optionalDependencies || {})[name] === meta.version)
  if (!wanted) return null
  const spec = `${wanted}@${meta.version}`
  process.stderr.write(`W1 is repairing its install (${spec})…\n`)
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const result = childProcess.spawnSync(npm, ["install", "--global", "--no-fund", "--no-audit", spec], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    windowsHide: true,
    shell: process.platform === "win32",
  })
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim().split("\n").slice(-3).join(" ").slice(0, 300)
    process.stderr.write(`W1 could not repair its install automatically${detail ? `: ${detail}` : "."}\n`)
    return null
  }
  // Resolution is cached per process, so re-exec rather than re-resolve in place.
  const relaunch = childProcess.spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, W1_NPM_REPAIRED: "1" },
  })
  process.exit(typeof relaunch.status === "number" ? relaunch.status : 1)
}

function resolveNativePackage() {
  const platform = platformName()
  const arch = architectureName()
  const candidates = packageCandidates(platform, arch)
  for (const name of candidates) {
    const executable = usableExecutable(name, platform)
    if (executable) return executable
  }
  repairNativePackage(candidates, platform)
  throw new Error(
    `The W1 native package for ${platform}/${arch} is missing, and W1 could not install it for you. ` +
      `Check your network, then run: npm install --global @w1-lab/cli@${meta.version}`,
  )
}

/**
 * Delete native packages left behind by older releases.
 *
 * Every W1 version pins its natives to its own version, so a native at any OTHER version is dead
 * weight the moment the meta package moves: ~200MB per stale copy, and — worse — a machine that
 * accumulates them looks fine to `npm ls` while W1 refuses to start, because the launcher requires
 * an exact version match and skips them all. Users do not know that, so they reinstall, get
 * "changed 2 packages", and are told to reinstall again.
 *
 * Swept opportunistically AFTER a successful resolve, so a failure here can never stop W1 running.
 * Only ever removes directories under the same node_modules that already hold a @w1-lab/cli-*
 * package, and only when the manifest inside names a @w1-lab/cli-* package at a version that is
 * not ours — never a path we merely guessed at.
 */
function sweepStaleNatives(executable) {
  if (process.env.W1_NPM_NO_SWEEP === "1") return
  try {
    const scopeRoot = path.dirname(path.dirname(path.dirname(executable)))
    if (path.basename(scopeRoot) !== "@w1-lab") return
    for (const entry of fs.readdirSync(scopeRoot)) {
      if (!entry.startsWith("cli-")) continue
      const candidate = path.join(scopeRoot, entry)
      const manifestPath = path.join(candidate, "package.json")
      if (!fs.existsSync(manifestPath)) continue
      let manifest
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      } catch {
        continue
      }
      if (typeof manifest.name !== "string" || !manifest.name.startsWith("@w1-lab/cli-")) continue
      if (manifest.version === meta.version) continue
      fs.rmSync(candidate, { recursive: true, force: true })
      process.stderr.write(`W1 removed a stale runtime (${manifest.name}@${manifest.version}).\n`)
    }
  } catch {
    // Housekeeping is never worth failing a run over.
  }
}

function main() {
  let executable
  try {
    executable = resolveNativePackage()
  } catch (error) {
    console.error(`W1 could not start: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  sweepStaleNatives(executable)

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
