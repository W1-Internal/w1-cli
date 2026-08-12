/**
 * ENGINE ZERO test fixture: the in-process engine library, scripted.
 *
 * The TUI tests point W1_ENGINE_PATH at fixture-engine.mjs in this directory, and the client
 * derives its library as `w1-engine-lib.mjs` BESIDE the engine entry — which is this file. It
 * plays the same script the socket-daemon fixture played (threads, catalog pushes, one canned
 * turn with a task list, an action, a table answer), through the in-process peer contract the
 * real library exports. If the real library's contract changes shape, port it here the same day.
 */
import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"

export async function createInProcessW1Engine(options) {
  const threads = new Map()
  const peers = new Set()
  const subscriptions = new Map()
  const catalogSubscriptions = new Map()
  let sequence = 0
  let catalogCursor = 0

  const event = (threadId, turnId, kind, data) => ({
    schemaVersion: 1,
    eventId: randomUUID(),
    threadId,
    turnId,
    sequence: ++sequence,
    kind,
    phase: kind === "turn.completed" ? "terminal" : "runtime",
    at: new Date().toISOString(),
    data,
  })

  const broadcast = (message) => {
    for (const peer of peers) {
      for (const listener of peer.listeners) listener(message)
    }
  }

  const push = (threadId, value, transient = false) => {
    const subscription = subscriptions.get(threadId)
    if (!subscription) return
    broadcast(
      transient
        ? { type: "transient", subscriptionId: subscription.id, threadId, event: value }
        : { type: "event", subscriptionId: subscription.id, threadId, cursor: value.sequence, event: value },
    )
  }

  const summary = (value) => {
    if (!value) return value
    const { conversation: _conversation, ...thread } = value
    return { archived: false, ...thread }
  }

  const pushCatalog = (value) => {
    const thread = summary(value)
    const cursor = ++catalogCursor
    for (const subscription of catalogSubscriptions.values()) {
      if (path.resolve(subscription.workspacePath) !== path.resolve(thread.workspacePath)) continue
      broadcast({ type: "catalog", subscriptionId: subscription.id, workspacePath: subscription.workspacePath, cursor, thread })
    }
  }

  async function handle(method, params) {
    if (method === "engine.status") {
      return { protocolVersion: 1, engineVersion: options.engineVersion ?? "0.0.0", buildId: options.buildId ?? "fixture", minimumClientVersion: "0.0.0", state: "idle", activeTurnCount: 0, activeTurns: [] }
    }
    if (method === "auth.snapshot") return { state: "signed_in" }
    if (method === "engine.threads.list") return [...threads.values()].map(summary)
    if (method === "engine.conversation.get") return threads.get(params.threadId)?.conversation ?? []
    if (method === "engine.conversation.snapshot") {
      const thread = threads.get(params.threadId)
      return { items: thread?.conversation ?? [], lastSequence: thread?.lastSequence ?? 0 }
    }
    if (method === "catalog.subscribe") {
      const id = randomUUID()
      catalogSubscriptions.set(id, { id, workspacePath: params.workspacePath })
      return {
        subscriptionId: id,
        snapshot: {
          cursor: catalogCursor,
          threads: [...threads.values()]
            .filter((thread) => !thread.archived && path.resolve(thread.workspacePath) === path.resolve(params.workspacePath))
            .map(summary),
        },
      }
    }
    if (method === "catalog.unsubscribe") {
      catalogSubscriptions.delete(params.subscriptionId)
      return { unsubscribed: true }
    }
    if (method === "events.subscribe") {
      const id = randomUUID()
      subscriptions.set(params.threadId, { id })
      return { subscribed: true, subscriptionId: id, replay: [], cursor: 0, active: false }
    }
    if (method === "events.unsubscribe") {
      for (const [threadId, subscription] of subscriptions) {
        if (subscription.id === params.subscriptionId) subscriptions.delete(threadId)
      }
      return { unsubscribed: true }
    }
    if (method === "engine.thread.archive") {
      const thread = threads.get(params.threadId)
      if (thread) {
        thread.archived = params.archived === true
        thread.updatedAt = new Date().toISOString()
        pushCatalog(thread)
      }
      return { archived: params.archived === true }
    }
    if (method === "engine.attachment.put") {
      const sha256 = createHash("sha256").update(params.base64).digest("hex")
      return { attachmentId: `sha256:${sha256}`, sha256, bytes: Buffer.from(params.base64, "base64").length, mimeType: params.mimeType, durable: true }
    }
    if (method === "turn.submit") {
      const { threadId, text } = params
      const turnId = randomUUID()
      const submitted = event(threadId, turnId, "turn.submitted", { text, workspacePath: params.workspacePath })
      const record = { threadId, workspaceId: "fixture", workspacePath: params.workspacePath, title: text.slice(0, 80), state: "running", createdAt: submitted.at, updatedAt: submitted.at, lastSequence: submitted.sequence, conversation: [] }
      threads.set(threadId, record)
      if (process.env.W1_FIXTURE_RECEIVED) writeFileSync(process.env.W1_FIXTURE_RECEIVED, JSON.stringify(params))
      queueMicrotask(() => {
        pushCatalog(record)
        push(threadId, submitted)
        push(threadId, event(threadId, turnId, "worker.event", {
          tag: "EVT",
          payload: {
            t: "task_state",
            items: Array.from({ length: 12 }, (_, index) => ({
              id: `t${index + 1}`,
              title: `Audit task ${index + 1}`,
              status: index < 4 ? "completed" : index === 4 ? "in_progress" : "pending",
            })),
          },
        }))
        push(threadId, event(threadId, turnId, "worker.event", { tag: "EVT", payload: { t: "action", tool: "read", toolCallId: "call-1", input: { path: "README.md" } } }))
        push(threadId, event(threadId, turnId, "worker.event", { tag: "EVT", payload: { t: "observation", toolCallId: "call-1", ok: true, observation: "line one\nline two\nline three" } }))
        push(threadId, { tag: "EVT", data: { t: "say_delta", text: "| Check | Result |\n|---|---|\n| TUI | Ready |" } }, true)
        const completed = event(threadId, turnId, "turn.completed", { ok: true, payload: { status: "model_finished", summary: "| Check | Result |\n|---|---|\n| TUI | Ready |" } })
        record.state = "idle"
        record.updatedAt = completed.at
        record.lastSequence = completed.sequence
        record.conversation = [
          { eventId: submitted.eventId, threadId, turnId, sequence: submitted.sequence, at: submitted.at, kind: "user.message", role: "user", text },
          { eventId: completed.eventId, threadId, turnId, sequence: completed.sequence, at: completed.at, kind: "assistant.message", role: "assistant", text: completed.data.payload.summary, status: "model_finished" },
        ]
        push(threadId, completed)
        pushCatalog(record)
      })
      return { accepted: true, durable: true, eventId: submitted.eventId, threadId, turnId, sequence: submitted.sequence }
    }
    if (method === "turn.respond" || method === "turn.stop") return { delivered: true, stopped: true }
    return {}
  }

  return {
    attach() {
      const peer = { listeners: new Set() }
      peers.add(peer)
      return {
        request: (method, params) => handle(method, params),
        onMessage(listener) {
          peer.listeners.add(listener)
          return () => peer.listeners.delete(listener)
        },
        detach() {
          peers.delete(peer)
          peer.listeners.clear()
        },
      }
    },
    async close() {
      peers.clear()
      subscriptions.clear()
      catalogSubscriptions.clear()
    },
  }
}
