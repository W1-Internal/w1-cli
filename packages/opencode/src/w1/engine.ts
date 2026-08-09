import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { homedir, userInfo } from "node:os"
import path from "node:path"
import { createConnection, type Socket } from "node:net"

export const W1_ENGINE_PROTOCOL_VERSION = 1

export function engineClientVersion(value: string) {
  return /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(value.trim()) ? value.trim() : "0.0.0"
}

export type EngineEvent = {
  schemaVersion: 1
  eventId: string
  threadId: string
  turnId: string
  sequence: number
  kind: string
  phase: string
  at: string
  data: Record<string, unknown>
}

export type ConversationItem = {
  eventId: string
  threadId: string
  turnId: string
  sequence: number
  at: string
  kind: "user.message" | "user.response" | "assistant.message" | "tool.event" | "question" | "runtime.event"
  role: "user" | "assistant" | "runtime"
  text?: string
  status?: string
  data?: Record<string, unknown>
}

export type ThreadSummary = {
  threadId: string
  workspaceId: string
  workspacePath: string
  title: string
  state: "idle" | "running" | "awaiting_user" | "failed"
  createdAt: string
  updatedAt: string
  lastSequence: number
}

export type EngineLocation = {
  enginePath: string
  workerPath: string
  buildId: string
  source: "environment" | "packaged" | "shared" | "development"
}

type Subscription = {
  threadId: string
  cursor: number
  listener: (message: EnginePush) => void
}

export type EnginePush =
  | { type: "event"; subscriptionId: string; threadId: string; cursor: number; event: EngineEvent }
  | { type: "transient"; subscriptionId: string; threadId: string; event: { tag: string; data: Record<string, unknown> } }

type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string; retryable: boolean; structural?: Record<string, unknown> } }

function resolveEndpoint() {
  if (process.platform === "win32") {
    const owner = createHash("sha256").update(`${userInfo().username}\0${homedir()}`).digest("hex").slice(0, 16)
    return `\\\\.\\pipe\\w1-${owner}-v${W1_ENGINE_PROTOCOL_VERSION}`
  }
  const configured = process.env.W1_ENGINE_STATE_DIR?.trim()
  return path.join(
    configured ? path.resolve(configured) : path.join(homedir(), ".w1", "engine", `v${W1_ENGINE_PROTOCOL_VERSION}`),
    "ipc",
    `w1-v${W1_ENGINE_PROTOCOL_VERSION}.sock`,
  )
}

async function readBuildId(folder: string) {
  return (await Bun.file(path.join(folder, "BUILD_ID")).text().catch(() => "source")).trim() || "source"
}

export async function resolveEngine(): Promise<EngineLocation | undefined> {
  const configuredEngine = process.env.W1_ENGINE_PATH?.trim()
  const configuredWorker = process.env.W1_RUNTIME_PATH?.trim()
  const candidates = [
    ...(configuredEngine
      ? [{
          enginePath: path.resolve(configuredEngine),
          workerPath: path.resolve(configuredWorker || path.join(path.dirname(configuredEngine), "run-stream.mjs")),
          source: "environment" as const,
        }]
      : []),
    {
      enginePath: path.join(path.dirname(process.execPath), "w1-runtime", "w1-engine.mjs"),
      workerPath: path.join(path.dirname(process.execPath), "w1-runtime", "run-stream.mjs"),
      source: "packaged" as const,
    },
    {
      enginePath: path.join(homedir(), ".w1", "runtime", "w1-engine.mjs"),
      workerPath: path.join(homedir(), ".w1", "runtime", "run-stream.mjs"),
      source: "shared" as const,
    },
    {
      enginePath: path.resolve(import.meta.dir, "../../../../../harness/vscode-extension/out/harness/w1-engine.mjs"),
      workerPath: path.resolve(import.meta.dir, "../../../../../harness/vscode-extension/out/harness/run-stream.mjs"),
      source: "development" as const,
    },
  ]
  for (const candidate of candidates) {
    if (!(await Bun.file(candidate.enginePath).exists()) || !(await Bun.file(candidate.workerPath).exists())) continue
    return { ...candidate, buildId: await readBuildId(path.dirname(candidate.enginePath)) }
  }
}

function canAutostart(cause: unknown) {
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : ""
  return code === "ENOENT" || code === "ECONNREFUSED"
}

export class EngineClient {
  private socket?: Socket
  private buffer = ""
  private readonly pending = new Map<string, {
    resolve(value: unknown): void
    reject(cause: Error): void
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly pendingSubscriptions = new Map<string, Subscription & { buffered: EnginePush[] }>()

  constructor(readonly endpoint = resolveEndpoint()) {}

  get connected() {
    return this.socket?.writable === true && !this.socket.destroyed
  }

  async connect(input: { location: EngineLocation; clientVersion: string; timeoutMs?: number }) {
    try {
      await this.open(Math.min(input.timeoutMs ?? 2_000, 2_000))
    } catch (cause) {
      if (!canAutostart(cause)) throw cause
      const compiled = typeof W1_CLI_COMPILED !== "undefined" && W1_CLI_COMPILED
      const command = process.execPath
      const args = compiled
        ? [
            "__engine",
            input.location.enginePath,
            "--worker-command",
            process.execPath,
            "--worker-arg",
            "__runtime",
            "--worker-arg",
            input.location.workerPath,
          ]
        : [
            input.location.enginePath,
            "--worker-command",
            process.execPath,
            "--worker-arg",
            input.location.workerPath,
            "--worker-arg",
            "--serve",
          ]
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false })
      child.unref()
      const deadline = Date.now() + (input.timeoutMs ?? 8_000)
      let last: unknown = cause
      while (Date.now() < deadline && !this.socket) {
        try {
          await this.open(500)
        } catch (next) {
          last = next
          await Bun.sleep(100)
        }
      }
      if (!this.socket) throw new Error(`W1 Engine did not start: ${last instanceof Error ? last.message : String(last)}`)
    }
    const handshake = await this.request("protocol.handshake", {
      surface: "cli",
      clientVersion: input.clientVersion,
      platform: process.platform,
      channel: "release",
    }) as { protocolVersion?: number; buildId?: string }
    if (handshake.protocolVersion !== W1_ENGINE_PROTOCOL_VERSION) {
      this.close()
      throw new Error("The W1 CLI and Engine protocol versions are incompatible.")
    }
    if (handshake.buildId !== input.location.buildId) {
      this.close()
      throw new Error(`The running W1 Engine belongs to another build (expected ${input.location.buildId}, got ${handshake.buildId ?? "unknown"}).`)
    }
  }

  private open(timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.endpoint)
      const timer = setTimeout(() => {
        socket.destroy()
        const error = Object.assign(new Error("engine connection timeout"), { code: "ETIMEDOUT" })
        reject(error)
      }, timeoutMs)
      socket.once("connect", () => {
        clearTimeout(timer)
        this.socket = socket
        this.bind(socket)
        resolve()
      })
      socket.once("error", (cause) => {
        clearTimeout(timer)
        socket.destroy()
        reject(cause)
      })
    })
  }

  private bind(socket: Socket) {
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      this.buffer += String(chunk)
      for (;;) {
        const boundary = this.buffer.indexOf("\n")
        if (boundary < 0) break
        const line = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 1)
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.type === "event" || message.type === "transient") {
          const push = message as EnginePush
          const subscription = this.subscriptions.get(push.subscriptionId)
          const pending = !subscription ? this.pendingSubscriptions.get(push.threadId) : undefined
          if (pending) {
            pending.buffered.push(push)
            continue
          }
          if (subscription && push.type === "event") {
            if (push.event.sequence <= subscription.cursor) continue
            subscription.cursor = push.event.sequence
          }
          subscription?.listener(push)
          continue
        }
        const response = message as RpcResponse
        const pending = this.pending.get(response.id)
        if (!pending) continue
        this.pending.delete(response.id)
        clearTimeout(pending.timer)
        if (response.ok) pending.resolve(response.result)
        else pending.reject(Object.assign(new Error(response.error.message), response.error))
      }
    })
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined
      this.buffer = ""
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error("W1 Engine disconnected."))
      }
      this.pending.clear()
      this.subscriptions.clear()
      this.pendingSubscriptions.clear()
    })
  }

  request(method: string, params: unknown, timeoutMs = 15_000) {
    if (!this.socket?.writable) return Promise.reject(new Error("W1 Engine is not connected."))
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`W1 Engine request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.write(`${JSON.stringify({ id, protocolVersion: W1_ENGINE_PROTOCOL_VERSION, method, params })}\n`)
    })
  }

  async subscribeThread(input: { threadId: string; afterSequence: number }, listener: (message: EnginePush) => void) {
    const subscription: Subscription & { buffered: EnginePush[] } = { ...input, cursor: input.afterSequence, listener, buffered: [] }
    this.pendingSubscriptions.set(input.threadId, subscription)
    let result: { subscriptionId: string; replay: EngineEvent[]; cursor: number; active: boolean }
    try {
      result = await this.request("events.subscribe", input) as typeof result
    } catch (cause) {
      this.pendingSubscriptions.delete(input.threadId)
      throw cause
    }
    this.subscriptions.set(result.subscriptionId, subscription)
    for (const event of [...result.replay].sort((left, right) => left.sequence - right.sequence)) {
      if (event.sequence <= subscription.cursor) continue
      subscription.cursor = event.sequence
      listener({ type: "event", subscriptionId: result.subscriptionId, threadId: input.threadId, cursor: event.sequence, event })
    }
    subscription.cursor = Math.max(subscription.cursor, result.cursor)
    this.pendingSubscriptions.delete(input.threadId)
    for (const push of subscription.buffered.splice(0)) {
      if (push.type === "event") {
        if (push.event.sequence <= subscription.cursor) continue
        subscription.cursor = push.event.sequence
      }
      listener(push)
    }
    return {
      cursor: subscription.cursor,
      active: result.active,
      close: () => this.subscriptions.delete(result.subscriptionId),
    }
  }

  close() {
    this.socket?.destroy()
    this.socket = undefined
    this.buffer = ""
  }
}
