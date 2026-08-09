import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { homedir, userInfo } from "node:os"
import path from "node:path"
import { createConnection, type Socket } from "node:net"

export const W1_ENGINE_PROTOCOL_VERSION = 1
export const W1_ENGINE_MAX_FRAME_BYTES = 20 * 1024 * 1024
const W1_ENGINE_UNSUBSCRIBE_TIMEOUT_MS = 750

export function assertEngineFrameBytes(byteLength: number) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength >= W1_ENGINE_MAX_FRAME_BYTES) {
    throw new Error("W1 Engine request is too large for the 20 MiB IPC frame limit.")
  }
}

export function engineClientVersion(value: string) {
  return /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(value.trim()) ? value.trim() : "0.0.0"
}

function compareVersions(leftValue: string, rightValue: string): -1 | 0 | 1 | undefined {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
  }
  const left = parse(leftValue)
  const right = parse(rightValue)
  if (!left || !right) return
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]! ? 1 : -1
  }
  return 0
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
  archived: boolean
}

export type EngineStatus = {
  protocolVersion: 1
  engineVersion: string
  buildId: string
  minimumClientVersion: string
  state: "idle" | "active"
  activeTurnCount: number
  activeTurns: Array<{ threadId: string; turnId: string; state: "running" | "terminalizing" }>
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
  listener: (message: ThreadPush) => void
}

type WorkspaceSubscription = {
  workspacePath: string
  cursor: number
  listener: (message: CatalogPush) => void
}

export type EnginePush =
  | { type: "event"; subscriptionId: string; threadId: string; cursor: number; event: EngineEvent }
  | { type: "transient"; subscriptionId: string; threadId: string; event: { tag: string; data: Record<string, unknown> } }
  | { type: "catalog"; subscriptionId: string; workspacePath: string; cursor: number; thread: ThreadSummary }

export type ThreadPush = Exclude<EnginePush, { type: "catalog" }>
export type CatalogPush = Extract<EnginePush, { type: "catalog" }>

export function selectedMessagesAfterSnapshot(messages: ThreadPush[], snapshotSequence: number) {
  let durableBoundary = -1
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.type === "event" && message.event.sequence <= snapshotSequence) durableBoundary = index
  }
  return messages.slice(durableBoundary + 1).filter((message) =>
    message.type === "transient" || message.event.sequence > snapshotSequence,
  )
}

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
  private readonly workspaceSubscriptions = new Map<string, WorkspaceSubscription>()
  private readonly orphanMessages = new Map<string, EnginePush[]>()
  private readonly disconnectListeners = new Set<() => void>()

  constructor(readonly endpoint = resolveEndpoint()) {}

  get connected() {
    return this.socket?.writable === true && !this.socket.destroyed
  }

  onDisconnect(listener: () => void) {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  async connect(input: { location: EngineLocation; clientVersion: string; timeoutMs?: number }): Promise<void> {
    if (this.connected) return
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
            "--engine-version",
            input.clientVersion,
            "--worker-command",
            process.execPath,
            "--worker-arg",
            "__runtime",
            "--worker-arg",
            input.location.workerPath,
          ]
        : [
            input.location.enginePath,
            "--engine-version",
            input.clientVersion,
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
    }) as { protocolVersion?: number; engineVersion?: string; buildId?: string; minimumClientVersion?: string }
    if (handshake.protocolVersion !== W1_ENGINE_PROTOCOL_VERSION) {
      this.close()
      throw new Error("The W1 CLI and Engine protocol versions are incompatible.")
    }
    const runningVersion = String(handshake.engineVersion ?? "0.0.0")
    const comparison = compareVersions(runningVersion, input.clientVersion)
    if (comparison === undefined) {
      this.close()
      throw new Error("The running W1 Engine returned an invalid version handshake.")
    }
    if (comparison === 0 && handshake.buildId !== input.location.buildId) {
      this.close()
      throw new Error(`The running W1 Engine has the same version but another build identity (expected ${input.location.buildId}, got ${handshake.buildId ?? "unknown"}).`)
    }
    if (comparison < 0) {
      const replacement = await this.request("engine.shutdown", {
        expectedEngineVersion: runningVersion,
        expectedBuildId: String(handshake.buildId ?? ""),
        replacementEngineVersion: input.clientVersion,
        replacementBuildId: input.location.buildId,
      }) as { accepted?: boolean; reason?: string; status?: EngineStatus }
      if (!replacement.accepted) {
        this.close()
        const active = replacement.status?.activeTurnCount ?? 0
        throw new Error(replacement.reason === "active_turns"
          ? `The older W1 Engine is still running ${active} task${active === 1 ? "" : "s"}; it will upgrade when those tasks finish.`
          : `The running W1 Engine refused replacement (${replacement.reason ?? "unknown reason"}).`)
      }
      this.close()
      await Bun.sleep(75)
      return this.connect(input)
    }
  }

  async reconnect(input: { location: EngineLocation; clientVersion: string; attempts?: number; delayMs?: number }) {
    const attempts = Math.max(1, Math.min(5, Math.floor(input.attempts ?? 4)))
    const delayMs = Math.max(0, Math.min(10_000, Math.floor(input.delayMs ?? 250)))
    this.close()
    let failure: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await Bun.sleep(delayMs)
      try {
        await this.connect(input)
        return
      } catch (cause) {
        failure = cause
        this.close()
      }
    }
    throw failure instanceof Error ? failure : new Error(String(failure ?? "W1 Engine reconnect failed."))
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
        if (message.type === "event" || message.type === "transient" || message.type === "catalog") {
          const push = message as EnginePush
          if (push.type === "catalog") {
            const subscription = this.workspaceSubscriptions.get(push.subscriptionId)
            if (!subscription) {
              const buffered = this.orphanMessages.get(push.subscriptionId) ?? []
              buffered.push(push)
              this.orphanMessages.set(push.subscriptionId, buffered)
              continue
            }
            if (!Number.isInteger(push.cursor) || push.cursor <= subscription.cursor) continue
            subscription.cursor = push.cursor
            subscription.listener(push)
            continue
          }
          const subscription = this.subscriptions.get(push.subscriptionId)
          if (!subscription) {
            const buffered = this.orphanMessages.get(push.subscriptionId) ?? []
            buffered.push(push)
            this.orphanMessages.set(push.subscriptionId, buffered)
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
      const current = this.socket === socket
      if (current) this.socket = undefined
      this.buffer = ""
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error("W1 Engine disconnected."))
      }
      this.pending.clear()
      this.subscriptions.clear()
      this.workspaceSubscriptions.clear()
      this.orphanMessages.clear()
      if (current) {
        for (const listener of this.disconnectListeners) listener()
      }
    })
  }

  request(method: string, params: unknown, timeoutMs = 15_000) {
    if (!this.socket?.writable) return Promise.reject(new Error("W1 Engine is not connected."))
    const id = randomUUID()
    const frame = `${JSON.stringify({ id, protocolVersion: W1_ENGINE_PROTOCOL_VERSION, method, params })}\n`
    try {
      assertEngineFrameBytes(Buffer.byteLength(frame))
    } catch (cause) {
      return Promise.reject(cause)
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`W1 Engine request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.write(frame)
    })
  }

  async subscribeThread(input: { threadId: string; afterSequence: number; workspacePath?: string }, listener: (message: ThreadPush) => void) {
    const subscription: Subscription = { threadId: input.threadId, cursor: input.afterSequence, listener }
    let result: { subscriptionId: string; replay: EngineEvent[]; cursor: number; active: boolean }
    result = await this.request("events.subscribe", input) as typeof result
    this.subscriptions.set(result.subscriptionId, subscription)
    for (const event of [...result.replay].sort((left, right) => left.sequence - right.sequence)) {
      if (event.sequence <= subscription.cursor) continue
      subscription.cursor = event.sequence
      listener({ type: "event", subscriptionId: result.subscriptionId, threadId: input.threadId, cursor: event.sequence, event })
    }
    subscription.cursor = Math.max(subscription.cursor, result.cursor)
    for (const push of this.orphanMessages.get(result.subscriptionId) ?? []) {
      if (push.type === "catalog") continue
      if (push.type === "event") {
        if (push.event.sequence <= subscription.cursor) continue
        subscription.cursor = push.event.sequence
      }
      listener(push as ThreadPush)
    }
    this.orphanMessages.delete(result.subscriptionId)
    return {
      cursor: subscription.cursor,
      active: result.active,
      close: async () => {
        this.subscriptions.delete(result.subscriptionId)
        this.orphanMessages.delete(result.subscriptionId)
        await this.request("events.unsubscribe", { subscriptionId: result.subscriptionId }, W1_ENGINE_UNSUBSCRIBE_TIMEOUT_MS)
      },
    }
  }

  async subscribeWorkspace(
    input: { workspacePath: string },
    listener: (message: CatalogPush) => void,
    onSnapshot?: (snapshot: { cursor: number; threads: ThreadSummary[] }) => void,
  ) {
    const workspacePath = path.resolve(input.workspacePath)
    const subscription: WorkspaceSubscription = { workspacePath, cursor: 0, listener }
    const result = await this.request("catalog.subscribe", { workspacePath }) as {
      subscriptionId: string
      snapshot: { cursor: number; threads: ThreadSummary[] }
    }
    onSnapshot?.(result.snapshot)
    subscription.cursor = result.snapshot.cursor
    this.workspaceSubscriptions.set(result.subscriptionId, subscription)
    for (const message of this.orphanMessages.get(result.subscriptionId) ?? []) {
      if (message.type !== "catalog" || message.cursor <= subscription.cursor) continue
      subscription.cursor = message.cursor
      listener(message)
    }
    this.orphanMessages.delete(result.subscriptionId)
    return {
      cursor: subscription.cursor,
      threads: result.snapshot.threads,
      close: async () => {
        this.workspaceSubscriptions.delete(result.subscriptionId)
        this.orphanMessages.delete(result.subscriptionId)
        await this.request("catalog.unsubscribe", { subscriptionId: result.subscriptionId }, W1_ENGINE_UNSUBSCRIBE_TIMEOUT_MS)
      },
    }
  }

  close() {
    this.socket?.destroy()
    this.socket = undefined
    this.buffer = ""
  }
}
