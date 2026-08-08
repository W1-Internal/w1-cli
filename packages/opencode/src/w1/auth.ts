import { randomBytes, randomUUID } from "crypto"
import { chmod, mkdir, open as openFile, readFile, rename, rm } from "fs/promises"
import { createServer } from "http"
import os from "os"
import path from "path"
import openBrowser from "open"

const DEFAULT_BACKEND_URL = "https://app.w1lab.com"
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const TELEMETRY_ID = /^w1:[0-9a-f]{24}$/i

export type Session = {
  token: string
  email: string | null
  telemetryId: string | null
  savedAt: string
}

type StorageOptions = {
  home?: string
}

type SignInOptions = StorageOptions & {
  backendUrl?: string
  timeoutMs?: number
  allowDevelopmentBackend?: boolean
  openBrowser?: (url: string) => Promise<void>
  onStart?: (url: string) => void
  now?: () => Date
  nonce?: string
}

type SignOutOptions = StorageOptions & {
  backendUrl?: string
  allowDevelopmentBackend?: boolean
  fetch?: typeof globalThis.fetch
}

export function sessionPath(home = os.homedir()) {
  return path.join(home, ".w1", "auth.json")
}

export function resolveBackendUrl(input?: string, allowDevelopmentBackend = false) {
  const raw = (input ?? process.env.W1_BACKEND_URL ?? DEFAULT_BACKEND_URL).trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("W1 backend URL is invalid.")
  }
  const host = url.hostname.toLowerCase()
  const w1Host = host === "w1lab.com" || host.endsWith(".w1lab.com")
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
  const development = allowDevelopmentBackend || process.env.W1_DEV === "1" || process.env.NODE_ENV === "development"
  if (!(url.protocol === "https:" && w1Host) && !(development && loopback && /^https?:$/.test(url.protocol))) {
    throw new Error("W1 sign-in only allows secure w1lab.com backends (or loopback in development).")
  }
  if (url.username || url.password) throw new Error("W1 backend URL must not contain credentials.")
  return url.origin
}

export async function readSession(options: StorageOptions = {}): Promise<Session | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sessionPath(options.home), "utf8")) as Record<string, unknown>
    const token = typeof parsed.token === "string" ? parsed.token.trim() : ""
    if (!token) return
    return {
      token,
      email: typeof parsed.email === "string" && parsed.email.trim() ? parsed.email.trim() : null,
      telemetryId:
        typeof parsed.telemetryId === "string" && TELEMETRY_ID.test(parsed.telemetryId) ? parsed.telemetryId : null,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    }
  } catch {
    return
  }
}

export async function writeSession(session: Session, options: StorageOptions = {}) {
  const target = sessionPath(options.home)
  const directory = path.dirname(target)
  const temporary = path.join(directory, `.auth.${process.pid}.${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700).catch(() => {})
  const handle = await openFile(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(session, null, 2) + "\n", "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, 0o600).catch(() => {})
  try {
    await rename(temporary, target)
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    await rm(target, { force: true })
    await rename(temporary, target)
  }
  await chmod(target, 0o600).catch(() => {})
}

export async function signIn(options: SignInOptions = {}): Promise<Session> {
  const backend = resolveBackendUrl(options.backendUrl, options.allowDevelopmentBackend)
  const nonce = options.nonce ?? randomBytes(24).toString("base64url")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const browser = options.openBrowser ?? (async (url: string) => void (await openBrowser(url)))
  const result = Promise.withResolvers<Session>()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/done") {
      response.writeHead(404)
      response.end()
      return
    }
    if (url.searchParams.get("flow") !== nonce) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
      response.end("Invalid W1 sign-in callback.")
      return
    }
    const token = url.searchParams.get("token")?.trim() ?? ""
    const email = url.searchParams.get("email")?.trim() || null
    const telemetry = url.searchParams.get("telemetry_id")?.trim() ?? ""
    const error = url.searchParams.get("error")?.trim() ?? ""
    if (!token) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      response.end(callbackPage(false))
      finish(new Error(`W1 sign-in failed: ${error || "no token returned"}`))
      return
    }
    const session: Session = {
      token,
      email,
      telemetryId: TELEMETRY_ID.test(telemetry) ? telemetry : null,
      savedAt: (options.now?.() ?? new Date()).toISOString(),
    }
    try {
      await writeSession(session, options)
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      response.end(callbackPage(true))
      finish(undefined, session)
    } catch (cause) {
      response.writeHead(500, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      response.end(callbackPage(false))
      finish(new Error(`Signed in, but W1 could not save the shared session: ${message(cause)}`))
    }
  })

  function finish(error?: Error, session?: Session) {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    server.close()
    if (error) result.reject(error)
    else if (session) result.resolve(session)
  }

  server.on("error", (error) => finish(new Error(`W1 loopback sign-in failed: ${message(error)}`)))
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve)
    server.once("error", reject)
  }).catch((error) => {
    finish(new Error(`W1 could not start its browser callback: ${message(error)}`))
    throw error
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    finish(new Error("W1 could not resolve its browser callback port."))
    return result.promise
  }
  const callback = new URL(`http://127.0.0.1:${address.port}/done`)
  callback.searchParams.set("flow", nonce)
  const start = new URL("/auth/start", backend)
  start.searchParams.set("cb", callback.toString())
  const startUrl = start.toString()
  options.onStart?.(startUrl)
  timer = setTimeout(() => finish(new Error("W1 sign-in timed out. Run `w1 login` to try again.")), timeoutMs)
  await browser(startUrl).catch(() => {
    // The URL is always printed before this call so headless users can open it manually.
  })
  return result.promise
}

export async function signOut(options: SignOutOptions = {}) {
  const session = await readSession(options)
  if (session) {
    const backend = resolveBackendUrl(options.backendUrl, options.allowDevelopmentBackend)
    await (options.fetch ?? globalThis.fetch)(`${backend}/auth/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {})
  }
  await rm(sessionPath(options.home), { force: true })
  return Boolean(session)
}

function callbackPage(success: boolean) {
  return `<!doctype html><meta charset=utf-8><meta name=referrer content=no-referrer><body style="font-family:system-ui;background:#0f0f0c;color:#e7e2d6;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#bccb4f;font-weight:600">${success ? "You're signed in to W1" : "Sign-in failed"}</h2><p style="opacity:.7">${success ? "Return to the terminal — you can close this tab." : "Close this tab and run w1 login again."}</p></div>`
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export * as W1Auth from "./auth"
