import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { createServer } from "node:net"

const root = process.env.W1_ENGINE_STATE_DIR || path.join(homedir(), ".w1", "engine", "v1")
const endpoint = path.join(root, "ipc", "w1-v1.sock")
const buildId = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "BUILD_ID"), "utf8").trim()
mkdirSync(path.dirname(endpoint), { recursive: true })
const threads = new Map()
const subscriptions = new Map()
let sequence = 0

function event(threadId, turnId, kind, data) {
  return { schemaVersion: 1, eventId: randomUUID(), threadId, turnId, sequence: ++sequence, kind, phase: kind === "turn.completed" ? "terminal" : "runtime", at: new Date().toISOString(), data }
}

function push(threadId, value, transient = false) {
  const subscription = subscriptions.get(threadId)
  if (!subscription) return
  subscription.socket.write(JSON.stringify(transient
    ? { type: "transient", subscriptionId: subscription.id, threadId, event: value }
    : { type: "event", subscriptionId: subscription.id, threadId, cursor: value.sequence, event: value }) + "\n")
}

const server = createServer((socket) => {
  socket.setEncoding("utf8")
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const boundary = buffer.indexOf("\n")
      if (boundary < 0) break
      const request = JSON.parse(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 1)
      const ok = (result) => socket.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n")
      if (request.method === "protocol.handshake") ok({ protocolVersion: 1, buildId, minimumClientVersion: "0.0.0" })
      else if (request.method === "auth.snapshot") ok({ state: "signed_in" })
      else if (request.method === "engine.threads.list") ok([...threads.values()])
      else if (request.method === "engine.conversation.get") ok(threads.get(request.params.threadId)?.conversation ?? [])
      else if (request.method === "events.subscribe") {
        const id = randomUUID()
        subscriptions.set(request.params.threadId, { id, socket })
        ok({ subscribed: true, subscriptionId: id, replay: [], cursor: 0, active: false })
      } else if (request.method === "engine.attachment.put") {
        const sha256 = createHash("sha256").update(request.params.base64).digest("hex")
        ok({ attachmentId: `sha256:${sha256}`, sha256, bytes: Buffer.from(request.params.base64, "base64").length, mimeType: request.params.mimeType, durable: true })
      } else if (request.method === "turn.submit") {
        const { threadId, text } = request.params
        const turnId = randomUUID()
        const submitted = event(threadId, turnId, "turn.submitted", { text, workspacePath: request.params.workspacePath })
        const summary = { threadId, workspaceId: "fixture", workspacePath: request.params.workspacePath, title: text.slice(0, 80), state: "running", createdAt: submitted.at, updatedAt: submitted.at, lastSequence: submitted.sequence, conversation: [] }
        threads.set(threadId, summary)
        if (process.env.W1_FIXTURE_RECEIVED) writeFileSync(process.env.W1_FIXTURE_RECEIVED, JSON.stringify(request.params))
        ok({ accepted: true, durable: true, eventId: submitted.eventId, threadId, turnId, sequence: submitted.sequence })
        push(threadId, submitted)
        push(threadId, event(threadId, turnId, "worker.event", { tag: "EVT", payload: { t: "task_state", items: [{ id: "t1", title: "Inspect runtime", status: "in_progress" }] } }))
        push(threadId, event(threadId, turnId, "worker.event", { tag: "EVT", payload: { t: "action", tool: "read", toolCallId: "call-1", input: { path: "README.md" } } }))
        push(threadId, event(threadId, turnId, "worker.event", { tag: "EVT", payload: { t: "observation", toolCallId: "call-1", ok: true, observation: "line one\nline two\nline three" } }))
        push(threadId, { tag: "EVT", data: { t: "say_delta", text: "| Check | Result |\n|---|---|\n| TUI | Ready |" } }, true)
        const completed = event(threadId, turnId, "turn.completed", { ok: true, payload: { status: "model_finished", summary: "| Check | Result |\n|---|---|\n| TUI | Ready |" } })
        summary.state = "idle"
        summary.updatedAt = completed.at
        summary.lastSequence = completed.sequence
        summary.conversation = [
          { eventId: submitted.eventId, threadId, turnId, sequence: submitted.sequence, at: submitted.at, kind: "user.message", role: "user", text },
          { eventId: completed.eventId, threadId, turnId, sequence: completed.sequence, at: completed.at, kind: "assistant.message", role: "assistant", text: completed.data.payload.summary, status: "model_finished" },
        ]
        push(threadId, completed)
      } else if (request.method === "turn.respond" || request.method === "turn.stop") ok({ delivered: true, stopped: true })
      else ok({})
    }
  })
  socket.on("close", () => {
    if (process.env.W1_FIXTURE_EXIT_ON_CLOSE === "1") server.close(() => process.exit(0))
  })
})

server.listen(endpoint)
