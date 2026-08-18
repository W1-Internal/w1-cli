import { randomUUID } from "node:crypto"
import { closeSync, openSync, readFileSync, rmSync, writeSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// Claim this surface's engine instance at import time, BEFORE any endpoint is computed — the CLI
// client and the engine it spawns must derive the same socket path, and the client derives it from
// this variable. Set on the process itself, not just on the child, which is exactly the mistake
// that made 0.2.4 unable to reach its own engine.
process.env.W1_CLIENT_SURFACE ||= "cli"

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

/** Mirrors the engine's normalizeSurface (src/engine/state.ts). Both sides must slug identically. */
const W1_LEGACY_SHARED_SURFACE = "shared"

export function normalizeEngineSurface(raw: string | undefined) {
  const slug = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug.slice(0, 32) : W1_LEGACY_SHARED_SURFACE
}

/**
 * ENGINE ZERO: this CLI HOSTS its engine — there is no endpoint, no daemon, no other side of a
 * cross-repository contract to drift from. What remains is the STATE ROOT: the same per-surface
 * directory the daemon era used, so threads survive the cutover byte for byte. The whole 0.2.4
 * class of bug (client and engine deriving different endpoints) is unrepresentable now; both
 * halves are one process.
 */
export function resolveStateRoot() {
  const configured = process.env.W1_ENGINE_STATE_DIR?.trim()
  if (configured) return path.resolve(configured)
  const surface = normalizeEngineSurface(process.env.W1_CLIENT_SURFACE)
  // Surface roots are SIBLINGS of the shared root, never children of it — nesting them makes the
  // history seed a self-copy, which fails and leaves the surface with an empty journal.
  return surface === W1_LEGACY_SHARED_SURFACE
    ? path.join(homedir(), ".w1", "engine", `v${W1_ENGINE_PROTOCOL_VERSION}`)
    : path.join(homedir(), ".w1", "engine", "surfaces", surface, `v${W1_ENGINE_PROTOCOL_VERSION}`)
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

/**
 * One in-process host per state root. Two concurrent `w1` invocations used to multiplex through
 * the daemon; now the second gets ONE honest line and an escape hatch instead of a corrupted
 * journal. A lock whose recorded pid is dead is litter and is reclaimed silently.
 */
function acquireHostLock(stateRoot: string): () => void {
  mkdirSync(stateRoot, { recursive: true })
  const lockPath = path.join(stateRoot, "host.lock")
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lockPath, "wx")
      writeSync(fd, JSON.stringify({ pid: process.pid }))
      closeSync(fd)
      const release = () => {
        try {
          rmSync(lockPath, { force: true })
        } catch {}
      }
      process.once("exit", release)
      return release
    } catch {
      let pid = 0
      try {
        pid = Number((JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }).pid ?? 0)
      } catch {}
      let alive = false
      if (pid === process.pid) {
        // Our own pid means a second host in THIS process — still two hosts on one journal.
        alive = true
      } else if (pid > 1) {
        try {
          process.kill(pid, 0)
          alive = true
        } catch {
          alive = false
        }
      }
      if (alive) {
        throw new Error(
          `Another W1 is already running this workspace's engine (pid ${pid}). Close it first, or run this one against its own state with W1_ENGINE_STATE_DIR.`,
        )
      }
      try {
        rmSync(lockPath, { force: true })
      } catch {}
    }
  }
  throw new Error("Could not claim the W1 engine state root — a lock keeps reappearing.")
}

type InProcessEngineModule = {
  createInProcessW1Engine(options: Record<string, unknown>): Promise<{
    attach(): {
      request(method: string, params?: unknown): Promise<unknown>
      onMessage(listener: (message: Record<string, unknown>) => void): () => void
      detach(): void
    }
    close(): Promise<void>
  }>
}

export class EngineClient {
  private host?: Awaited<ReturnType<InProcessEngineModule["createInProcessW1Engine"]>>
  private peer?: ReturnType<Awaited<ReturnType<InProcessEngineModule["createInProcessW1Engine"]>>["attach"]>
  private releaseLock?: () => void
  private opening?: Promise<void>
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly workspaceSubscriptions = new Map<string, WorkspaceSubscription>()
  private readonly orphanMessages = new Map<string, EnginePush[]>()
  private readonly disconnectListeners = new Set<() => void>()

  constructor(readonly stateRoot = resolveStateRoot()) {}

  get connected() {
    return this.peer !== undefined
  }

  onDisconnect(listener: () => void) {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  /**
   * ENGINE ZERO: hosting, not dialing. The engine library ships BESIDE the worker bundle this
   * CLI already carries, so the engine and this client are the same build by construction —
   * every handshake, version-comparison, build-identity and replacement branch the daemon era
   * needed is gone because the question can no longer arise. Workers spawn as this process's
   * direct children (through our own binary's __runtime entry when compiled) and die with us.
   */
  async connect(input: { location: EngineLocation; clientVersion: string; timeoutMs?: number }): Promise<void> {
    if (this.connected) return
    this.opening ??= (async () => {
      const libPath = path.join(path.dirname(input.location.enginePath), "w1-engine-lib.mjs")
      if (!(await Bun.file(libPath).exists())) {
        throw new Error(
          "This W1 install is missing its engine library (w1-engine-lib.mjs) — reinstall with: npm install -g @w1-lab/cli@latest",
        )
      }
      const release = acquireHostLock(this.stateRoot)
      try {
        const mod = (await import(pathToFileURL(libPath).href)) as InProcessEngineModule
        const compiled = typeof W1_CLI_COMPILED !== "undefined" && W1_CLI_COMPILED
        const host = await mod.createInProcessW1Engine({
          stateRoot: this.stateRoot,
          engineVersion: input.clientVersion,
          buildId: input.location.buildId,
          clientSurface: "cli",
          workerCommand: process.execPath,
          workerArgs: compiled
            ? ["__runtime", input.location.workerPath]
            : [input.location.workerPath, "--serve"],
        })
        this.host = host
        this.peer = host.attach()
        this.releaseLock = release
        this.peer.onMessage((message) => this.route(message))
      } catch (cause) {
        release()
        throw cause
      }
    })().finally(() => {
      this.opening = undefined
    })
    return this.opening
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

  /** Pushes from the in-process engine — same shapes, same order the socket wire carried. */
  private route(message: Record<string, unknown>) {
    if (message.type !== "event" && message.type !== "transient" && message.type !== "catalog") return
    const push = message as EnginePush
    if (push.type === "catalog") {
      const subscription = this.workspaceSubscriptions.get(push.subscriptionId)
      if (!subscription) {
        const buffered = this.orphanMessages.get(push.subscriptionId) ?? []
        buffered.push(push)
        this.orphanMessages.set(push.subscriptionId, buffered)
        return
      }
      if (!Number.isInteger(push.cursor) || push.cursor <= subscription.cursor) return
      subscription.cursor = push.cursor
      subscription.listener(push)
      return
    }
    const subscription = this.subscriptions.get(push.subscriptionId)
    if (!subscription) {
      const buffered = this.orphanMessages.get(push.subscriptionId) ?? []
      buffered.push(push)
      this.orphanMessages.set(push.subscriptionId, buffered)
      return
    }
    if (push.type === "event") {
      if (push.event.sequence <= subscription.cursor) return
      subscription.cursor = push.event.sequence
    }
    subscription.listener(push)
  }

  request(method: string, params: unknown, _timeoutMs = 15_000) {
    const peer = this.peer
    if (!peer) return Promise.reject(new Error("W1 Engine is not connected."))
    // The 20 MiB bound survives the daemon: it was always the product's attachment/turn budget,
    // not a transport accident, and keeping it means no payload behaves differently in-process.
    try {
      assertEngineFrameBytes(Buffer.byteLength(JSON.stringify({ id: randomUUID(), method, params })))
    } catch (cause) {
      return Promise.reject(cause)
    }
    return peer.request(method, params)
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
    const hadPeer = this.peer !== undefined
    this.peer?.detach()
    this.peer = undefined
    const host = this.host
    this.host = undefined
    if (host) void host.close()
    this.releaseLock?.()
    this.releaseLock = undefined
    this.subscriptions.clear()
    this.workspaceSubscriptions.clear()
    this.orphanMessages.clear()
    if (hadPeer) {
      for (const listener of this.disconnectListeners) listener()
    }
  }
}
