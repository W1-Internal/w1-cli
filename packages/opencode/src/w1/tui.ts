import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { randomUUID } from "node:crypto"
import { createRuntimeLifecycle, type Lifecycle } from "@/cli/cmd/run/runtime.lifecycle"
import { resolveRunTuiConfig } from "@/cli/cmd/run/runtime.boot"
import type { FooterApi, FooterSubagentState, RunPrompt, StreamCommit } from "@/cli/cmd/run/types"
import { createW1Attachments } from "./attachments"
import { isNewerVersion, latestPublishedVersion, runNpmUpdate } from "./update"
import { W1Auth } from "./auth"
import {
  EngineClient,
  engineClientVersion,
  resolveEngine,
  selectedMessagesAfterSnapshot,
  type ConversationItem,
  type EngineEvent,
  type ThreadPush,
  type ThreadSummary,
} from "./engine"
import {
  actorApprovalDecision,
  appendTransientNarration,
  assertAttachmentBytes,
  interactionWasDelivered,
  isAmbiguousEngineFailure,
} from "./tui-contract"

type Input = {
  directory: string
  threadID: string
  first: boolean
  model?: string
  fullAccess: boolean
  images: string[]
  verbose: boolean
}

type ToolTab = { tool: string; input: Record<string, unknown>; started: number }
type PendingInteraction = { kind: "question"; request: QuestionRequest } | { kind: "permission"; request: PermissionRequest }
type PendingSubmit = {
  clientRequestId: string
  workspacePath: string
  text: string
  threadId: string
  attachmentIds?: string[]
  workerRequest: { runtimeMode: string; first: boolean; model?: string }
}
type Controller = {
  id: string
  title: string
  state: ThreadSummary["state"]
  cursor: number
  hydrated: boolean
  buffered: ThreadPush[]
  items: ConversationItem[]
  seen: Set<string>
  turnStarted: number
  assistantPart: string
  assistantOpen: boolean
  sawSay: boolean
  narration: string
  result?: Record<string, unknown>
  pending?: PendingInteraction
  pendingSubmit?: PendingSubmit
  tools: Map<string, ToolTab>
  tabs: FooterSubagentState
  subscription?: { close(): Promise<void> }
}

const MAX_TOOL_TABS = 30
const MAX_TOOL_OUTPUT = 40_000

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function elapsed(started: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (seconds < 60) return `Worked for ${seconds}s`
  return `Worked for ${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function preview(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n").slice(0, 2).map((line) => line.slice(0, 220)).join("\n")
}

function bounded(value: string) {
  return value.length <= MAX_TOOL_OUTPUT ? value : value.slice(0, MAX_TOOL_OUTPUT) + "\n… output truncated in TUI"
}

function toolInput(tool: string, input: Record<string, unknown>) {
  if (tool === "task_update" && Array.isArray(input.tasks)) return `${input.tasks.length} tasks`
  return JSON.stringify(input).slice(0, 220)
}

function toolCall(tool: string, input: Record<string, unknown>) {
  const detail = toolInput(tool, input)
  return system(`   ● ${tool}${detail ? ` ${detail}` : ""}`, "system", true)
}

function toolResult(text: string, ok: boolean) {
  const lines = (preview(text) || (ok ? "done" : "failed")).split("\n")
  return system(
    lines.map((line, index) => index === 0 ? `      └─ ${ok ? "✓" : "✗"} ${line}` : `         ${line}`).join("\n"),
    ok ? "system" : "error",
    true,
  )
}

function system(text: string, kind: "system" | "error" = "system", compact = false): StreamCommit {
  return { kind, text, phase: "final", source: "system", partID: randomUUID(), ...(compact ? { compact: true } : {}) }
}

function question(payload: Record<string, unknown>, sessionID: string): QuestionRequest {
  const raw = Array.isArray(payload.questions) ? payload.questions : [payload]
  return {
    id: String(payload.requestId ?? randomUUID()),
    sessionID,
    questions: raw.map((value, index) => {
      const item = record(value)
      return {
        header: String(item.header ?? `Question ${index + 1}`),
        question: String(item.question ?? "W1 needs your input."),
        options: (Array.isArray(item.options) ? item.options : []).map((option) => {
          const data = record(option)
          return { label: String(data.label ?? option), description: String(data.description ?? "") }
        }),
        multiple: item.multiple === true,
        custom: item.allowFreeText !== false && item.custom !== false,
      }
    }),
  }
}

function permission(payload: Record<string, unknown>, sessionID: string): PermissionRequest {
  const detail = String(payload.detail ?? payload.reason ?? "W1 wants to use a protected tool.")
  return {
    id: String(payload.requestId ?? randomUUID()),
    sessionID,
    permission: String(payload.permission ?? "tool"),
    patterns: [detail],
    metadata: { input: record(payload.input), detail },
    always: [],
  }
}

function attachmentPaths(prompt: RunPrompt) {
  return prompt.parts.flatMap((part) =>
    part.type === "file" && part.mime.startsWith("image/") && part.source?.type === "file" && part.source.path
      ? [part.source.path]
      : [],
  )
}

function attachmentImages(prompt: RunPrompt) {
  return prompt.parts.flatMap((part) =>
    part.type === "file" && part.mime.startsWith("image/") && part.url.startsWith("data:") ? [part.url] : [],
  )
}

function history(items: ConversationItem[]): RunPrompt[] {
  return items.flatMap((item) =>
    (item.kind === "user.message" || item.kind === "assistant.message") && item.text
      ? [{ text: item.text, parts: [] }]
      : [],
  )
}

function projectConversationItem(event: EngineEvent): ConversationItem | undefined {
  if (event.kind === "turn.submitted") {
    return { eventId: event.eventId, threadId: event.threadId, turnId: event.turnId, sequence: event.sequence, at: event.at, kind: "user.message", role: "user", text: String(event.data.text ?? "") }
  }
  if (event.kind === "turn.completed") {
    const payload = record(event.data.payload)
    return { eventId: event.eventId, threadId: event.threadId, turnId: event.turnId, sequence: event.sequence, at: event.at, kind: "assistant.message", role: "assistant", text: String(payload.summary ?? payload.reply ?? "").trim(), status: String(payload.status ?? event.data.status ?? "completed") }
  }
  if (event.kind === "user.response") {
    return { eventId: event.eventId, threadId: event.threadId, turnId: event.turnId, sequence: event.sequence, at: event.at, kind: "user.response", role: "user", ...(typeof event.data.answer === "string" ? { text: event.data.answer } : {}), data: { ...event.data } }
  }
  if (event.kind !== "worker.event") return
  const tag = String(event.data.tag ?? "")
  const payload = record(event.data.payload)
  const eventType = String(payload.t ?? "")
  const kind = tag === "QUESTION"
    ? "question"
    : tag === "EVT" && ["action", "observation", "tool_registered", "tool_running"].includes(eventType)
      ? "tool.event"
      : "runtime.event"
  return { eventId: event.eventId, threadId: event.threadId, turnId: event.turnId, sequence: event.sequence, at: event.at, kind, role: "runtime", data: { tag, payload } }
}

function dataUrl(value: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value)
  if (!match) throw new Error("W1 could not encode the image attachment.")
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0
  assertAttachmentBytes(Math.max(0, Math.floor(match[2].length * 3 / 4) - padding))
  return { mimeType: match[1], base64: match[2] }
}

function newController(id: string, summary?: ThreadSummary): Controller {
  return {
    id,
    title: summary?.title ?? "New session",
    state: summary?.state ?? "idle",
    cursor: 0,
    hydrated: false,
    buffered: [],
    items: [],
    seen: new Set(),
    turnStarted: 0,
    assistantPart: "",
    assistantOpen: false,
    sawSay: false,
    narration: "",
    tools: new Map(),
    tabs: { tabs: [], details: {}, permissions: [], questions: [] },
  }
}

export async function runW1Tui(input: Input) {
  const location = await resolveEngine()
  if (!location) throw new Error("W1 Engine is missing. Reinstall W1 CLI or set W1_ENGINE_PATH to w1-engine.mjs.")
  const engine = new EngineClient()
  const clientVersion = engineClientVersion(InstallationVersion)
  const connection = { location, clientVersion }
  const syncEngineAuth = async () => {
    const auth = await engine.request("auth.snapshot", {}) as { state?: string }
    if (auth.state === "signed_in") return
    const session = await W1Auth.readSession()
    if (!session) throw new Error("The W1 Engine is signed out. Run `w1 login` and try again.")
    await engine.request("auth.import_existing_session", { token: session.token, ...(session.email ? { email: session.email } : {}) })
  }
  await engine.connect(connection)
  await syncEngineAuth()

  let activeThreadID = input.threadID
  let summaries: ThreadSummary[] = []
  const controllers = new Map<string, Controller>()
  const requestOwners = new Map<string, string>()
  let footer: FooterApi | undefined
  let lifecycle: Lifecycle | undefined
  let elapsedTimer: ReturnType<typeof setInterval> | undefined
  let catalogSubscription: { close(): Promise<void> } | undefined
  let closing = false
  let reconnecting: Promise<void> | undefined
  let initial = await initialAttachments(input, activeThreadID)

  const active = () => controllers.get(activeThreadID)
  const isVisible = (controller: Controller) => controller.id === activeThreadID && footer

  const publishTabs = (controller: Controller) => {
    if (isVisible(controller)) footer!.event({ type: "stream.subagent", state: structuredClone(controller.tabs) })
  }
  const finishAssistant = (controller: Controller, interrupted = false) => {
    if (!controller.assistantOpen) return
    if (isVisible(controller)) {
      footer!.append({ kind: "assistant", text: "", phase: "final", source: "assistant", partID: controller.assistantPart, interrupted })
    }
    controller.assistantOpen = false
  }
  const publishThreads = () => {
    footer?.event({
      type: "thread.catalog",
      catalog: {
        currentThreadID: activeThreadID,
        threads: summaries.map((item) => ({
          threadID: item.threadId,
          title: item.title,
          status: item.state,
          updatedAt: Date.parse(item.updatedAt),
          archived: item.archived === true,
        })),
      },
    })
  }

  const updateSummary = (next: ThreadSummary) => {
    summaries = [next, ...summaries.filter((item) => item.threadId !== next.threadId)]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    const controller = controllers.get(next.threadId)
    if (controller) {
      controller.title = next.title
      controller.state = next.state
      controller.cursor = Math.max(controller.cursor, next.lastSequence)
    }
    publishThreads()
  }

  const subscribeCatalog = async () => {
    catalogSubscription = await engine.subscribeWorkspace(
      { workspacePath: input.directory },
      (message) => updateSummary(message.thread),
      (snapshot) => {
        const archived = summaries.filter((item) => item.archived && !snapshot.threads.some((next) => next.threadId === item.threadId))
        summaries = [...snapshot.threads, ...archived]
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        publishThreads()
      },
    )
    const all = await engine.request("engine.threads.list", {
      workspacePath: input.directory,
      includeArchived: true,
    }) as ThreadSummary[]
    const archived = all.filter((item) => item.archived)
    summaries = [...summaries.filter((item) => !item.archived && !archived.some((next) => next.threadId === item.threadId)), ...archived]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    publishThreads()
  }
  await subscribeCatalog()

  const showPending = (controller: Controller) => {
    if (!isVisible(controller)) return
    footer!.event({
      type: "stream.view",
      view: controller.pending
        ? { type: controller.pending.kind, request: controller.pending.request } as
            | { type: "question"; request: QuestionRequest }
            | { type: "permission"; request: PermissionRequest }
        : { type: "prompt" },
    })
  }

  const onFrame = async (controller: Controller, tag: string, payload: Record<string, unknown>) => {
    if (tag === "EVT") {
      const type = String(payload.t ?? "")
      if (type === "say_delta") {
        controller.sawSay = true
        const delta = String(payload.text ?? "")
        controller.narration = appendTransientNarration(controller.narration, delta)
        if (isVisible(controller)) footer!.event({ type: "stream.patch", patch: { phase: "running", status: "Writing…" } })
        if (!controller.assistantOpen) {
          controller.assistantPart = `assistant-${randomUUID()}`
          controller.assistantOpen = true
        }
        if (isVisible(controller)) footer!.append({ kind: "assistant", text: delta, phase: "progress", source: "assistant", partID: controller.assistantPart })
        return
      }
      if (type === "think_delta") {
        if (isVisible(controller)) footer!.event({ type: "stream.patch", patch: { phase: "running", status: "Thinking…" } })
        return
      }
      if (type === "task_state") {
        const items = Array.isArray(payload.items) ? payload.items : []
        if (isVisible(controller)) footer!.event({
          type: "stream.patch",
          patch: { tasks: items.map((value, index) => {
            const item = record(value)
            return { id: String(item.id ?? `task-${index + 1}`), title: String(item.title ?? "Task"), status: String(item.status ?? "pending") }
          }) },
        })
        return
      }
      if (type === "action") {
        finishAssistant(controller)
        const id = String(payload.toolCallId ?? `step-${payload.step ?? randomUUID()}`)
        const tool = String(payload.tool ?? "tool")
        const args = record(payload.input)
        controller.tools.set(id, { tool, input: args, started: Date.now() })
        if (isVisible(controller)) footer!.append(toolCall(tool, args))
        controller.tabs.tabs.push({ sessionID: `tool:${id}`, partID: id, callID: id, label: tool, description: tool, status: "running", lastUpdatedAt: Date.now(), kind: "tool" })
        controller.tabs.details[`tool:${id}`] = { sessionID: `tool:${id}`, commits: [system(`${tool}\n${JSON.stringify(args, null, 2)}`)] }
        while (controller.tabs.tabs.length > MAX_TOOL_TABS) {
          const removed = controller.tabs.tabs.shift()
          if (removed) delete controller.tabs.details[removed.sessionID]
        }
        publishTabs(controller)
        if (isVisible(controller)) footer!.event({ type: "stream.patch", patch: { phase: "running", status: `Working · ${tool}` } })
        return
      }
      if (type === "observation") {
        const id = String(payload.toolCallId ?? `step-${payload.step ?? "unknown"}`)
        const current = controller.tools.get(id)
        const text = String(payload.observation ?? "")
        const ok = payload.ok !== false
        if (isVisible(controller)) footer!.append(toolResult(text, ok))
        if (current) {
          const key = `tool:${id}`
          const tab = controller.tabs.tabs.find((item) => item.sessionID === key)
          if (tab) {
            tab.status = ok ? "completed" : "error"
            tab.lastUpdatedAt = Date.now()
            tab.title = `${current.tool} · ${Math.max(0, Date.now() - current.started)}ms`
          }
          controller.tabs.details[key] = { sessionID: key, commits: [system(`${current.tool}\n${JSON.stringify(current.input, null, 2)}\n\n${bounded(text)}`, ok ? "system" : "error")] }
          publishTabs(controller)
        }
        return
      }
      if (type === "error" && isVisible(controller)) footer!.append(system(String(payload.message ?? "W1 runtime error"), "error"))
      return
    }
    if (tag === "APPROVAL") {
      const request = permission(payload, controller.id)
      requestOwners.set(request.id, controller.id)
      if (input.fullAccess) {
        try {
          const acknowledgement = await engine.request("turn.respond", {
            threadId: controller.id,
            frame: { type: "approval-response", requestId: request.id, decision: actorApprovalDecision(undefined, true) },
          })
          if (interactionWasDelivered(acknowledgement)) return
        } catch {
          // The engine reconnect path runs independently; keep the request visible until delivery.
        }
        if (!controller.pending) {
          controller.pending = { kind: "permission", request }
          controller.state = "awaiting_user"
          showPending(controller)
          if (isVisible(controller)) footer!.append(system("W1 could not deliver the automatic approval. The approval is still waiting.", "error"))
        }
      } else {
        controller.pending = { kind: "permission", request }
        controller.state = "awaiting_user"
        showPending(controller)
      }
      return
    }
    if (tag === "QUESTION" || tag === "USER_INPUT") {
      const request = question(payload, controller.id)
      requestOwners.set(request.id, controller.id)
      controller.pending = { kind: "question", request }
      controller.state = "awaiting_user"
      showPending(controller)
      return
    }
    if (tag === "RESULT") controller.result = payload
  }

  const finishTurn = (controller: Controller, payload: Record<string, unknown>) => {
    controller.result = payload
    finishAssistant(controller)
    controller.state = payload.error || String(payload.status ?? "").includes("error") ? "failed" : "idle"
    if (isVisible(controller)) {
      const duration = elapsed(controller.turnStarted || Date.now())
      footer!.event({ type: "turn.duration", duration: duration.replace("Worked for ", "") })
      footer!.event({ type: "stream.patch", patch: { duration, status: controller.state === "failed" ? "Stopped" : "Ready" } })
      footer!.event({ type: "turn.idle", queue: 0 })
      if (payload.error) footer!.append(system(String(payload.error), "error"))
      else if (controller.state === "failed") footer!.append(system(`W1 stopped: ${String(payload.status ?? "engine error")}`, "error"))
      else if (!controller.sawSay && typeof payload.summary === "string" && payload.summary.trim()) {
        footer!.append({ kind: "assistant", text: payload.summary, phase: "final", source: "assistant", partID: randomUUID() })
      }
    }
    controller.pending = undefined
    controller.pendingSubmit = undefined
    controller.narration = ""
  }

  const onDurable = async (controller: Controller, event: EngineEvent) => {
    if (controller.seen.has(event.eventId)) return
    controller.seen.add(event.eventId)
    controller.cursor = Math.max(controller.cursor, event.sequence)
    const item = projectConversationItem(event)
    if (item) controller.items.push(item)
    if (event.kind === "turn.submitted") {
      controller.state = "running"
      controller.turnStarted = Date.parse(event.at) || Date.now()
      controller.sawSay = false
      controller.narration = ""
      controller.pendingSubmit = undefined
      if (isVisible(controller)) {
        footer!.append({ kind: "user", text: String(event.data.text ?? ""), phase: "final", source: "system", partID: event.eventId })
        footer!.event({ type: "turn.send", queue: 0 })
        footer!.event({ type: "stream.patch", patch: { status: "Thinking…", duration: elapsed(controller.turnStarted) } })
      }
    } else if (event.kind === "worker.event") {
      await onFrame(controller, String(event.data.tag ?? ""), record(event.data.payload))
    } else if (event.kind === "user.response") {
      const owner = String(event.data.requestId ?? "")
      requestOwners.delete(owner)
      if (controller.pending?.request.id === owner) controller.pending = undefined
      controller.state = "running"
      showPending(controller)
    } else if (event.kind === "turn.completed" || event.kind === "request.failed") {
      finishTurn(controller, record(event.data.payload ?? event.data))
    } else if (event.kind === "thread.renamed") {
      controller.title = String(event.data.title ?? controller.title)
    }
  }

  const onPush = async (controller: Controller, push: ThreadPush) => {
    if (!controller.hydrated) {
      controller.buffered.push(push)
      return
    }
    if (push.type === "event") await onDurable(controller, push.event)
    else await onFrame(controller, push.event.tag, push.event.data)
  }

  const installSnapshot = async (
    controller: Controller,
    snapshot: { items: ConversationItem[]; lastSequence: number },
  ) => {
    controller.items = snapshot.items
    controller.cursor = Math.max(controller.cursor, snapshot.lastSequence)
    controller.seen = new Set(snapshot.items.map((item) => item.eventId))
    const pending = selectedMessagesAfterSnapshot(controller.buffered.splice(0), snapshot.lastSequence)
    controller.hydrated = true
    for (const push of pending) await onPush(controller, push)
  }

  const refreshConversation = async (controller: Controller) => {
    controller.hydrated = false
    const snapshot = await engine.request("engine.conversation.snapshot", {
      threadId: controller.id,
      workspacePath: input.directory,
    }) as { items: ConversationItem[]; lastSequence: number }
    await installSnapshot(controller, snapshot)
  }

  const subscribeController = async (controller: Controller) => {
    controller.hydrated = false
    controller.buffered = []
    const subscription = await engine.subscribeThread(
      { threadId: controller.id, workspacePath: input.directory, afterSequence: 0 },
      (push) => void onPush(controller, push),
    )
    controller.subscription = subscription
    controller.state = subscription.active ? "running" : controller.state
    await refreshConversation(controller)
  }

  const ensureController = async (id: string) => {
    const existing = controllers.get(id)
    if (existing) return existing
    const summary = summaries.find((item) => item.threadId === id)
    const controller = newController(id, summary)
    controllers.set(id, controller)
    try {
      await subscribeController(controller)
      return controller
    } catch (cause) {
      controllers.delete(id)
      await controller.subscription?.close().catch(() => undefined)
      throw cause
    }
  }

  const replay = async (controller: Controller, reset = true) => {
    if (!lifecycle || !footer) return
    if (reset) {
      await lifecycle.resetForReplay({ sessionTitle: controller.title, sessionID: controller.id, history: history(controller.items) })
    }
    controller.tools.clear()
    controller.tabs = { tabs: [], details: {}, permissions: [], questions: [] }
    controller.assistantOpen = false
    controller.sawSay = Boolean(controller.narration)
    const answered = new Set(controller.items.flatMap((item) =>
      item.kind === "user.response" && typeof item.data?.requestId === "string" ? [item.data.requestId] : [],
    ))
    for (const item of controller.items) {
      if (item.kind === "user.message" && item.text) footer.append({ kind: "user", text: item.text, phase: "final", source: "system", partID: item.eventId })
      if (item.kind === "assistant.message" && item.text) footer.append({ kind: "assistant", text: item.text, phase: "final", source: "assistant", partID: item.eventId })
      if ((item.kind === "tool.event" || item.kind === "question" || item.kind === "runtime.event") && item.data) {
        const payload = record(item.data.payload)
        const requestID = typeof payload.requestId === "string" ? payload.requestId : ""
        if (!requestID || !answered.has(requestID)) {
          await onFrame(controller, String(item.data.tag ?? ""), payload)
        }
      }
    }
    if ((controller.state === "running" || controller.state === "awaiting_user") && controller.narration) {
      controller.assistantPart = `assistant-${randomUUID()}`
      controller.assistantOpen = true
      footer.append({
        kind: "assistant",
        text: controller.narration,
        phase: "progress",
        source: "assistant",
        partID: controller.assistantPart,
      })
    }
    footer.event({ type: "stream.subagent", state: structuredClone(controller.tabs) })
    footer.event({ type: "stream.patch", patch: {
      phase: controller.state === "running" || controller.state === "awaiting_user" ? "running" : "idle",
      status: controller.state === "awaiting_user" ? "Needs input" : controller.state === "running" ? "Working…" : "Ready",
      duration: controller.turnStarted ? elapsed(controller.turnStarted) : "",
    } })
    showPending(controller)
    publishThreads()
  }

  const activateController = async (controller: Controller) => {
    const previous = activeThreadID
    activeThreadID = controller.id
    try {
      await replay(controller)
    } catch (cause) {
      activeThreadID = previous
      const prior = controllers.get(previous)
      if (prior) await replay(prior).catch(() => undefined)
      throw cause
    }
  }

  const switchThread = async (id: string) => {
    const target = id.trim()
    if (!target || target === activeThreadID) return true
    if (!summaries.some((item) => item.threadId === target)) {
      footer?.append(system(`That task is not in this workspace: ${target}`, "error"))
      return false
    }
    const existed = controllers.has(target)
    const controller = await ensureController(target)
    if (existed) await refreshConversation(controller)
    await activateController(controller)
    return true
  }

  const newThread = async () => {
    const target = `cli-${randomUUID()}`
    const controller = await ensureController(target)
    await activateController(controller)
    return true
  }

  const archiveThread = async (id: string, archived: boolean) => {
    const summary = summaries.find((item) => item.threadId === id)
    if (!summary) return false
    if (summary.state === "running" || summary.state === "awaiting_user") {
      footer?.append(system("A working task cannot be archived. Stop it or wait for it to finish first.", "error"))
      return false
    }
    await engine.request("engine.thread.archive", {
      clientRequestId: randomUUID(),
      workspacePath: input.directory,
      threadId: id,
      archived,
    })
    updateSummary({ ...summary, archived, updatedAt: new Date().toISOString() })
    return true
  }

  const recoverEngine = async () => {
    if (closing) throw new Error("W1 is closing.")
    if (engine.connected) return
    if (reconnecting) return reconnecting
    reconnecting = (async () => {
      let failure: unknown
      for (const delay of [0, 250, 750, 1_500]) {
        if (delay) await Bun.sleep(delay)
        if (closing) throw new Error("W1 is closing.")
        try {
          await engine.reconnect({ ...connection, attempts: 1 })
          await syncEngineAuth()
          await subscribeCatalog()
          for (const controller of controllers.values()) {
            controller.subscription = undefined
            await subscribeController(controller)
          }
          const controller = active()
          if (controller && footer) await replay(controller)
          footer?.append(system("Reconnected to W1 Engine. Background tasks and the selected task were restored."))
          return
        } catch (cause) {
          failure = cause
          engine.close()
        }
      }
      throw failure instanceof Error ? failure : new Error(String(failure ?? "W1 Engine reconnect failed."))
    })().finally(() => {
      reconnecting = undefined
    })
    return reconnecting
  }

  let updating = false

  /**
   * Tells the user, once per launch, that updates are self-service. Deliberately synchronous and
   * offline: a registry read here would either delay the first prompt or land a surprise line in the
   * middle of a conversation once it finally resolved. /update does the network check on demand.
   */
  const announceUpdates = () => {
    footer?.append(system(`W1 ${clientVersion} · run /update to install the latest version.`, "system", true))
  }

  const runSelfUpdate = async () => {
    if (updating) return
    updating = true
    footer?.append(system("Updating W1…", "system", true))
    try {
      const latest = await latestPublishedVersion()
      if (latest && !isNewerVersion(latest, clientVersion)) {
        footer?.append(system(`W1 ${clientVersion} is already the latest version.`, "system", true))
        return
      }
      const outcome = await runNpmUpdate()
      if (outcome.status === "failed") {
        footer?.append(system(`Update failed: ${outcome.message}`, "error"))
        return
      }
      footer?.append(
        system(
          `W1 updated to ${latest ?? "the latest version"}. Restart W1 for it to take effect — your threads are kept.`,
          "system",
          true,
        ),
      )
    } finally {
      updating = false
    }
  }

  const initialController = await ensureController(activeThreadID)
  lifecycle = await createRuntimeLifecycle({
    directory: input.directory,
    findFiles: async () => [],
    agents: [],
    resources: [],
    sessionID: activeThreadID,
    sessionTitle: initialController.title,
    getSessionID: () => activeThreadID,
    first: input.first,
    history: history(initialController.items),
    agent: "w1",
    model: { providerID: "w1", modelID: input.model ?? "hosted" },
    variant: undefined,
    tuiConfig: await resolveRunTuiConfig(),
    backgroundSubagents: true,
    brand: "w1",
    onPasteAttachment(text) {
      return createW1Attachments({ directory: input.directory, threadID: activeThreadID }).fromPaste(text)
    },
    async onPermissionReply(next) {
      const threadId = requestOwners.get(next.requestID) ?? activeThreadID
      const acknowledgement = await engine.request("turn.respond", {
        threadId,
        frame: { type: "approval-response", requestId: next.requestID, decision: actorApprovalDecision(next.reply) },
      })
      if (!interactionWasDelivered(acknowledgement)) {
        footer?.append(system("W1 could not deliver that approval. It is still waiting for your decision.", "error"))
        return
      }
      const controller = controllers.get(threadId)
      if (controller?.pending?.request.id === next.requestID) controller.pending = undefined
      if (threadId === activeThreadID) footer?.event({ type: "stream.view", view: { type: "prompt" } })
    },
    async onQuestionReply(next) {
      const threadId = requestOwners.get(next.requestID) ?? activeThreadID
      const acknowledgement = await engine.request("turn.respond", { threadId, frame: { type: "question-response", requestId: next.requestID, answer: next.answers?.flat().join(", ") ?? "" } })
      if (!interactionWasDelivered(acknowledgement)) {
        footer?.append(system("W1 could not deliver that answer. It is still waiting for your response.", "error"))
        return
      }
      const controller = controllers.get(threadId)
      if (controller?.pending?.request.id === next.requestID) controller.pending = undefined
      if (threadId === activeThreadID) footer?.event({ type: "stream.view", view: { type: "prompt" } })
    },
    async onQuestionReject(next) {
      const threadId = requestOwners.get(next.requestID) ?? activeThreadID
      const acknowledgement = await engine.request("turn.respond", { threadId, frame: { type: "question-response", requestId: next.requestID, answer: "" } })
      if (!interactionWasDelivered(acknowledgement)) {
        footer?.append(system("W1 could not dismiss that question. It is still waiting for your response.", "error"))
        return
      }
      const controller = controllers.get(threadId)
      if (controller?.pending?.request.id === next.requestID) controller.pending = undefined
      if (threadId === activeThreadID) footer?.event({ type: "stream.view", view: { type: "prompt" } })
    },
    onInterrupt() {
      const controller = active()
      if (!controller) return
      finishAssistant(controller, true)
      void engine.request("turn.stop", { threadId: controller.id })
    },
    onThreadCatalogRequest: publishThreads,
    onThreadSelect: switchThread,
    onThreadNew: newThread,
    onThreadArchive: archiveThread,
    onUpdate: runSelfUpdate,
  })
  footer = lifecycle.footer
  announceUpdates()
  const removeDisconnectListener = engine.onDisconnect(() => {
    if (closing) return
    footer?.event({ type: "stream.patch", patch: { status: "Reconnecting to W1 Engine…" } })
    void recoverEngine().catch((cause) => {
      footer?.append(system(`W1 Engine reconnect failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error"))
    })
  })

  const submitTurn = async (controller: Controller, submission: PendingSubmit) => {
    controller.pendingSubmit = submission
    try {
      await engine.request("turn.submit", submission)
      controller.pendingSubmit = undefined
    } catch (cause) {
      if (!isAmbiguousEngineFailure(cause)) {
        controller.pendingSubmit = undefined
        throw cause
      }
      try {
        await recoverEngine()
        await engine.request("turn.submit", submission)
        controller.pendingSubmit = undefined
      } catch (retryCause) {
        if (!isAmbiguousEngineFailure(retryCause)) controller.pendingSubmit = undefined
        throw retryCause
      }
    }
  }

  const closed = Promise.withResolvers<void>()
  footer.onClose(() => closed.resolve())
  footer.onPrompt((prompt) => void (async () => {
    const controller = active()
    if (!controller) return
    try {
      if (controller.state === "running" || controller.state === "awaiting_user") {
        footer!.append(system("This task is still working. Use /new or /resume to switch without stopping it.", "error"))
        return
      }
      if (!engine.connected) await recoverEngine()
      const queued = initial.splice(0)
      const combined: RunPrompt = { ...prompt, parts: [...prompt.parts, ...queued.map((item) => item.part)] }
      const paths = attachmentPaths(combined)
      const attachmentIds = await Promise.all(attachmentImages(combined).map(async (image) => {
        const encoded = dataUrl(image)
        const ack = await engine.request("engine.attachment.put", encoded) as { attachmentId: string }
        return ack.attachmentId
      }))
      // Tell the model the HANDLES, not just where the bytes sit on disk.
      //
      // The reminder used to list local file paths only, so a model asked to look at an image had
      // no handle to use and invented one from the visible filename —
      // view_image {"path":"attachment:WhatsApp Image 2026-07-27 at 20.29.54.jpeg"} — which is not
      // a handle and always failed. Naming the real handles removes the guess.
      //
      // The engine ids the same bytes as `sha256:<full hex>` while view_image handles are
      // `attachment:<first 12 of that hex>`. Two spellings of one identity; convert rather than
      // leave the model to reconcile them.
      const handles = attachmentIds.flatMap((id) => {
        const hex = /^sha256:([a-f0-9]{64})$/.exec(id)?.[1]
        return hex ? [`attachment:${hex.slice(0, 12)}`] : []
      })
      const reminderLines = [
        ...(handles.length
          ? [
              `Attached images, ready for view_image (pass the handle as "path"):`,
              ...handles.map((handle, index) => `- ${handle}${paths[index] ? ` (${paths[index]})` : ""}`),
            ]
          : []),
        ...(handles.length === 0 && paths.length
          ? [`Attached images are stored locally at:`, ...paths.map((item) => `- ${item}`)]
          : []),
      ]
      const reminder = reminderLines.length
        ? `\n\n<system-reminder>${reminderLines.join("\n")}\nUse view_image when visual inspection is needed. Do not invent a handle from a filename.</system-reminder>`
        : ""
      const submission: PendingSubmit = {
        clientRequestId: randomUUID(),
        workspacePath: input.directory,
        text: prompt.text + reminder,
        threadId: controller.id,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        workerRequest: {
          runtimeMode: input.fullAccess ? "full-access" : "approval-required",
          first: controller.items.length === 0,
          ...(input.model ? { model: input.model } : {}),
        },
      }
      controller.turnStarted = Date.now()
      controller.state = "running"
      controller.sawSay = false
      controller.narration = ""
      await submitTurn(controller, submission)
      initial = []
    } catch (cause) {
      if (!isAmbiguousEngineFailure(cause)) controller.state = "failed"
      footer?.event({ type: "turn.idle", queue: 0 })
      footer?.append(system(cause instanceof Error ? cause.message : String(cause), "error"))
    }
  })())
  // The lifecycle already owns the initial session and splash. Resetting a brand-new
  // OpenTUI footer races terminal startup in compiled hosts; replay resets are only
  // needed after an actual session switch or engine rehydration.
  await replay(initialController, false)

  elapsedTimer = setInterval(() => {
    const controller = active()
    if (controller?.turnStarted && (controller.state === "running" || controller.state === "awaiting_user")) {
      footer?.event({ type: "stream.patch", patch: { duration: elapsed(controller.turnStarted) } })
    }
  }, 1_000)
  elapsedTimer.unref?.()

  try {
    await closed.promise
  } finally {
    closing = true
    removeDisconnectListener()
    if (elapsedTimer) clearInterval(elapsedTimer)
    const running = summaries.filter((item) => item.state === "running" || item.state === "awaiting_user").length
    const unsubscribe = Promise.allSettled([
      ...(catalogSubscription ? [catalogSubscription.close()] : []),
      ...[...controllers.values()].flatMap((controller) => controller.subscription ? [controller.subscription.close()] : []),
    ])
    await Promise.race([unsubscribe, Bun.sleep(900)])
    engine.close()
    await lifecycle.close({ showExit: true, sessionID: activeThreadID, history: history(active()?.items ?? []) })
    process.stdout.write(running
      ? `W1 closed. ${running} background task${running === 1 ? " is" : "s are"} still running; start W1 again and use /resume.\n`
      : "W1 closed. Closing the CLI does not stop engine-owned background tasks; use /resume when you return.\n")
  }
}

async function initialAttachments(input: Input, threadID: string) {
  const attachments = createW1Attachments({ directory: input.directory, threadID })
  return Promise.all(input.images.map(async (image) => {
    const attachment = await attachments.fromPath(image)
    if (!attachment) throw new Error(`Unsupported image attachment: ${image}`)
    return attachment
  }))
}
