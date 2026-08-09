import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { randomUUID } from "node:crypto"
import { createRuntimeLifecycle, type Lifecycle } from "@/cli/cmd/run/runtime.lifecycle"
import { resolveRunTuiConfig } from "@/cli/cmd/run/runtime.boot"
import type { FooterApi, FooterSubagentState, RunPrompt, StreamCommit } from "@/cli/cmd/run/types"
import { createW1Attachments } from "./attachments"
import { W1Auth } from "./auth"
import {
  EngineClient,
  engineClientVersion,
  resolveEngine,
  type ConversationItem,
  type EngineEvent,
  type EnginePush,
  type ThreadSummary,
} from "./engine"

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
type Controller = {
  id: string
  title: string
  state: ThreadSummary["state"]
  cursor: number
  hydrated: boolean
  buffered: EnginePush[]
  items: ConversationItem[]
  seen: Set<string>
  turnStarted: number
  assistantPart: string
  assistantOpen: boolean
  sawSay: boolean
  result?: Record<string, unknown>
  pending?: PendingInteraction
  tools: Map<string, ToolTab>
  tabs: FooterSubagentState
  subscription?: { close(): void }
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

function system(text: string, kind: "system" | "error" = "system"): StreamCommit {
  return { kind, text, phase: "final", source: "system", partID: randomUUID() }
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

function dataUrl(value: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value)
  if (!match) throw new Error("W1 could not encode the image attachment.")
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
    tools: new Map(),
    tabs: { tabs: [], details: {}, permissions: [], questions: [] },
  }
}

export async function runW1Tui(input: Input) {
  const location = await resolveEngine()
  if (!location) throw new Error("W1 Engine is missing. Reinstall W1 CLI or set W1_ENGINE_PATH to w1-engine.mjs.")
  const engine = new EngineClient()
  await engine.connect({ location, clientVersion: engineClientVersion(InstallationVersion) })
  const auth = await engine.request("auth.snapshot", {}) as { state?: string }
  if (auth.state !== "signed_in") {
    const session = await W1Auth.readSession()
    if (!session) throw new Error("The W1 Engine is signed out. Run `w1 login` and try again.")
    await engine.request("auth.import_existing_session", { token: session.token, ...(session.email ? { email: session.email } : {}) })
  }

  let activeThreadID = input.threadID
  let summaries = await engine.request("engine.threads.list", { workspacePath: input.directory }) as ThreadSummary[]
  const controllers = new Map<string, Controller>()
  const requestOwners = new Map<string, string>()
  let footer: FooterApi | undefined
  let lifecycle: Lifecycle | undefined
  let elapsedTimer: ReturnType<typeof setInterval> | undefined
  let initial = await initialAttachments(input, activeThreadID)
  let refreshing = false
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

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
        })),
      },
    })
  }
  const refreshThreads = async () => {
    if (refreshing) return
    refreshing = true
    try {
      summaries = await engine.request("engine.threads.list", { workspacePath: input.directory }) as ThreadSummary[]
      for (const item of summaries) {
        const controller = controllers.get(item.threadId)
        if (controller) {
          controller.title = item.title
          controller.state = item.state
        }
      }
      publishThreads()
    } finally {
      refreshing = false
    }
  }
  const scheduleRefresh = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refreshThreads()
    }, 100)
    refreshTimer.unref?.()
  }

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
        if (isVisible(controller)) footer!.event({ type: "stream.patch", patch: { phase: "running", status: "Writing…" } })
        if (!controller.assistantOpen) {
          controller.assistantPart = `assistant-${randomUUID()}`
          controller.assistantOpen = true
        }
        if (isVisible(controller)) footer!.append({ kind: "assistant", text: String(payload.text ?? ""), phase: "progress", source: "assistant", partID: controller.assistantPart })
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
        if (isVisible(controller)) footer!.append(system(`● ${tool} ${JSON.stringify(args).slice(0, 220)}`))
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
        if (isVisible(controller)) footer!.append(system(`${ok ? "  ✓" : "  ✗"} ${preview(text) || (ok ? "done" : "failed")}`, ok ? "system" : "error"))
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
        await engine.request("turn.respond", { threadId: controller.id, frame: { type: "approval-response", requestId: request.id, approved: true } })
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
    scheduleRefresh()
  }

  const onDurable = async (controller: Controller, event: EngineEvent) => {
    if (controller.seen.has(event.eventId)) return
    controller.seen.add(event.eventId)
    controller.cursor = Math.max(controller.cursor, event.sequence)
    if (event.kind === "turn.submitted") {
      controller.state = "running"
      controller.turnStarted = Date.parse(event.at) || Date.now()
      controller.sawSay = false
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
    scheduleRefresh()
  }

  const onPush = async (controller: Controller, push: EnginePush) => {
    if (!controller.hydrated) {
      controller.buffered.push(push)
      return
    }
    if (push.type === "event") await onDurable(controller, push.event)
    else await onFrame(controller, push.event.tag, push.event.data)
  }

  const ensureController = async (id: string) => {
    const existing = controllers.get(id)
    if (existing) return existing
    const summary = summaries.find((item) => item.threadId === id)
    const controller = newController(id, summary)
    controllers.set(id, controller)
    const subscription = await engine.subscribeThread({ threadId: id, afterSequence: 0 }, (push) => void onPush(controller, push))
    controller.subscription = subscription
    controller.state = subscription.active ? "running" : controller.state
    controller.items = await engine.request("engine.conversation.get", { threadId: id }) as ConversationItem[]
    controller.cursor = Math.max(controller.cursor, ...controller.items.map((item) => item.sequence), 0)
    for (const item of controller.items) controller.seen.add(item.eventId)
    controller.hydrated = true
    for (const push of controller.buffered.splice(0)) await onPush(controller, push)
    return controller
  }

  const replay = async (controller: Controller) => {
    if (!lifecycle || !footer) return
    await lifecycle.resetForReplay({ sessionTitle: controller.title, sessionID: controller.id, history: history(controller.items) })
    controller.tools.clear()
    controller.tabs = { tabs: [], details: {}, permissions: [], questions: [] }
    controller.assistantOpen = false
    controller.sawSay = false
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
    footer.event({ type: "stream.subagent", state: structuredClone(controller.tabs) })
    footer.event({ type: "stream.patch", patch: {
      phase: controller.state === "running" || controller.state === "awaiting_user" ? "running" : "idle",
      status: controller.state === "awaiting_user" ? "Needs input" : controller.state === "running" ? "Working…" : "Ready",
      duration: controller.turnStarted ? elapsed(controller.turnStarted) : "",
    } })
    showPending(controller)
    publishThreads()
  }

  const switchThread = async (id: string) => {
    const target = id.trim()
    if (!target || target === activeThreadID) return true
    await refreshThreads()
    if (!summaries.some((item) => item.threadId === target)) {
      footer?.append(system(`That task is not in this workspace: ${target}`, "error"))
      return false
    }
    activeThreadID = target
    const controller = await ensureController(target)
    controller.items = await engine.request("engine.conversation.get", { threadId: target }) as ConversationItem[]
    for (const item of controller.items) controller.seen.add(item.eventId)
    await replay(controller)
    return true
  }

  const newThread = async () => {
    activeThreadID = `cli-${randomUUID()}`
    const controller = await ensureController(activeThreadID)
    await replay(controller)
    return true
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
      await engine.request("turn.respond", { threadId, frame: { type: "approval-response", requestId: next.requestID, approved: next.reply !== "reject" } })
      const controller = controllers.get(threadId)
      if (controller?.pending?.request.id === next.requestID) controller.pending = undefined
      if (threadId === activeThreadID) footer?.event({ type: "stream.view", view: { type: "prompt" } })
    },
    async onQuestionReply(next) {
      const threadId = requestOwners.get(next.requestID) ?? activeThreadID
      await engine.request("turn.respond", { threadId, frame: { type: "question-response", requestId: next.requestID, answer: next.answers?.flat().join(", ") ?? "" } })
      const controller = controllers.get(threadId)
      if (controller?.pending?.request.id === next.requestID) controller.pending = undefined
      if (threadId === activeThreadID) footer?.event({ type: "stream.view", view: { type: "prompt" } })
    },
    async onQuestionReject(next) {
      const threadId = requestOwners.get(next.requestID) ?? activeThreadID
      await engine.request("turn.respond", { threadId, frame: { type: "question-response", requestId: next.requestID, answer: "" } })
      if (threadId === activeThreadID) footer?.event({ type: "stream.view", view: { type: "prompt" } })
    },
    onInterrupt() {
      const controller = active()
      if (!controller) return
      finishAssistant(controller, true)
      void engine.request("turn.stop", { threadId: controller.id })
    },
    onThreadCatalogRequest: refreshThreads,
    onThreadSelect: switchThread,
    onThreadNew: newThread,
  })
  footer = lifecycle.footer
  await replay(initialController)

  const closed = Promise.withResolvers<void>()
  footer.onClose(() => closed.resolve())
  footer.onPrompt((prompt) => void (async () => {
    const controller = active()
    if (!controller) return
    if (controller.state === "running" || controller.state === "awaiting_user") {
      footer!.append(system("This task is still working. Use /new or /resume to switch without stopping it.", "error"))
      return
    }
    const queued = initial.splice(0)
    const combined: RunPrompt = { ...prompt, parts: [...prompt.parts, ...queued.map((item) => item.part)] }
    const paths = attachmentPaths(combined)
    const reminder = paths.length
      ? `\n\n<system-reminder>Attached images are stored locally at:\n${paths.map((item) => `- ${item}`).join("\n")}\nUse view_image when visual inspection is needed.</system-reminder>`
      : ""
    const attachmentIds = await Promise.all(attachmentImages(combined).map(async (image) => {
      const encoded = dataUrl(image)
      const ack = await engine.request("engine.attachment.put", encoded) as { attachmentId: string }
      return ack.attachmentId
    }))
    controller.turnStarted = Date.now()
    controller.state = "running"
    controller.sawSay = false
    await engine.request("turn.submit", {
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
    })
    initial = []
  })().catch((cause) => {
    const controller = active()
    if (controller) controller.state = "failed"
    footer?.event({ type: "turn.idle", queue: 0 })
    footer?.append(system(cause instanceof Error ? cause.message : String(cause), "error"))
    scheduleRefresh()
  }))

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
    if (elapsedTimer) clearInterval(elapsedTimer)
    if (refreshTimer) clearTimeout(refreshTimer)
    for (const controller of controllers.values()) controller.subscription?.close()
    engine.close()
    await lifecycle.close({ showExit: true, sessionID: activeThreadID, history: history(active()?.items ?? []) })
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
