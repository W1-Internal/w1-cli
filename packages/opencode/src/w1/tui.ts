import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { randomUUID } from "node:crypto"
import { createRuntimeLifecycle } from "@/cli/cmd/run/runtime.lifecycle"
import { resolveRunTuiConfig } from "@/cli/cmd/run/runtime.boot"
import type {
  FooterApi,
  FooterSubagentState,
  RunPrompt,
  StreamCommit,
} from "@/cli/cmd/run/types"
import { W1Runtime, type ProtocolFrame, type RuntimeClient } from "./runtime"
import { createW1Attachments } from "./attachments"

type Input = {
  directory: string
  threadID: string
  first: boolean
  model?: string
  fullAccess: boolean
  images: string[]
  verbose: boolean
}

type ToolTab = {
  tool: string
  input: Record<string, unknown>
  started: number
}

const MAX_TOOL_TABS = 30
const MAX_TOOL_OUTPUT = 40_000

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function elapsed(started: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (seconds < 60) return `Worked for ${seconds}s`
  return `Worked for ${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function preview(value: string) {
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n")
  return lines.slice(0, 2).map((line) => line.slice(0, 220)).join("\n")
}

function bounded(value: string) {
  if (value.length <= MAX_TOOL_OUTPUT) return value
  return value.slice(0, MAX_TOOL_OUTPUT) + "\n… output truncated in TUI"
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
      const options = Array.isArray(item.options) ? item.options : []
      return {
        header: String(item.header ?? `Question ${index + 1}`),
        question: String(item.question ?? "W1 needs your input."),
        options: options.map((option) => {
          const data = record(option)
          return {
            label: String(data.label ?? option),
            description: String(data.description ?? ""),
          }
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

export async function runW1Tui(input: Input) {
  const attachments = createW1Attachments(input)
  const initial = await Promise.all(
    input.images.map(async (image) => {
      const attachment = await attachments.fromPath(image)
      if (!attachment) throw new Error(`Unsupported image attachment: ${image}`)
      return attachment
    }),
  )
  let client: RuntimeClient | undefined
  let footer: FooterApi | undefined
  let turnStarted = 0
  let turnActive = false
  let assistantPart = ""
  let assistantOpen = false
  let elapsedTimer: ReturnType<typeof setInterval> | undefined
  let result: Record<string, unknown> | undefined
  const tools = new Map<string, ToolTab>()
  const tabs: FooterSubagentState = { tabs: [], details: {}, permissions: [], questions: [] }

  const publishTabs = () => footer?.event({ type: "stream.subagent", state: structuredClone(tabs) })
  const finishAssistant = (interrupted = false) => {
    if (!assistantOpen || !footer) return
    footer.append({
      kind: "assistant",
      text: "",
      phase: "final",
      source: "assistant",
      partID: assistantPart,
      interrupted,
    })
    assistantOpen = false
  }
  const stopElapsed = () => {
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = undefined
  }

  const onFrame = async (frame: ProtocolFrame) => {
    if (!footer) return
    const payload = frame.payload
    if (frame.tag === "EVT") {
      const type = String(payload.t ?? "")
      if (type === "say_delta") {
        footer.event({ type: "stream.patch", patch: { phase: "running", status: "Writing…" } })
        if (!assistantOpen) {
          assistantPart = `assistant-${randomUUID()}`
          assistantOpen = true
        }
        footer.append({
          kind: "assistant",
          text: String(payload.text ?? ""),
          phase: "progress",
          source: "assistant",
          partID: assistantPart,
        })
        return
      }
      if (type === "think_delta") {
        footer.event({ type: "stream.patch", patch: { phase: "running", status: "Thinking…" } })
        return
      }
      if (type === "task_state") {
        const items = Array.isArray(payload.items) ? payload.items : []
        footer.event({
          type: "stream.patch",
          patch: {
            tasks: items.map((value, index) => {
              const item = record(value)
              return {
                id: String(item.id ?? `task-${index + 1}`),
                title: String(item.title ?? "Task"),
                status: String(item.status ?? "pending"),
              }
            }),
          },
        })
        return
      }
      if (type === "action") {
        finishAssistant()
        const id = String(payload.toolCallId ?? `step-${payload.step ?? randomUUID()}`)
        const tool = String(payload.tool ?? "tool")
        const args = record(payload.input)
        tools.set(id, { tool, input: args, started: Date.now() })
        footer.append(system(`● ${tool} ${JSON.stringify(args).slice(0, 220)}`))
        tabs.tabs.push({
          sessionID: `tool:${id}`,
          partID: id,
          callID: id,
          label: tool,
          description: tool,
          status: "running",
          lastUpdatedAt: Date.now(),
          kind: "tool",
        })
        tabs.details[`tool:${id}`] = {
          sessionID: `tool:${id}`,
          commits: [system(`${tool}\n${JSON.stringify(args, null, 2)}`)],
        }
        while (tabs.tabs.length > MAX_TOOL_TABS) {
          const removed = tabs.tabs.shift()
          if (removed) delete tabs.details[removed.sessionID]
        }
        publishTabs()
        footer.event({ type: "stream.patch", patch: { phase: "running", status: `Working · ${tool}` } })
        return
      }
      if (type === "observation") {
        const id = String(payload.toolCallId ?? `step-${payload.step ?? "unknown"}`)
        const current = tools.get(id)
        const text = String(payload.observation ?? "")
        const ok = payload.ok !== false
        const short = preview(text)
        footer.append(system(`${ok ? "  ✓" : "  ✗"} ${short || (ok ? "done" : "failed")}`, ok ? "system" : "error"))
        if (current) {
          const key = `tool:${id}`
          const tab = tabs.tabs.find((item) => item.sessionID === key)
          if (tab) {
            tab.status = ok ? "completed" : "error"
            tab.lastUpdatedAt = Date.now()
            tab.title = `${current.tool} · ${Math.max(0, Date.now() - current.started)}ms`
          }
          tabs.details[key] = {
            sessionID: key,
            commits: [system(`${current.tool}\n${JSON.stringify(current.input, null, 2)}\n\n${bounded(text)}`, ok ? "system" : "error")],
          }
          publishTabs()
        }
        footer.event({ type: "stream.patch", patch: { phase: "running", status: "Thinking…" } })
        return
      }
      if (type === "error") footer.append(system(String(payload.message ?? "W1 runtime error"), "error"))
      return
    }
    if (frame.tag === "APPROVAL") {
      if (input.fullAccess) {
        client?.send({ type: "approval-response", requestId: String(payload.requestId ?? ""), decision: "accept" })
      } else {
        footer.event({ type: "stream.view", view: { type: "permission", request: permission(payload, input.threadID) } })
      }
      return
    }
    if (frame.tag === "QUESTION" || frame.tag === "USER_INPUT") {
      footer.event({ type: "stream.view", view: { type: "question", request: question(payload, input.threadID) } })
      return
    }
    if (frame.tag === "RESULT") result = payload
    if (frame.tag === "IDLE") {
      finishAssistant()
      stopElapsed()
      turnActive = false
      footer.event({ type: "turn.duration", duration: elapsed(turnStarted).replace("Worked for ", "") })
      footer.event({ type: "stream.patch", patch: { duration: elapsed(turnStarted) } })
      footer.event({ type: "turn.idle", queue: 0 })
      if (result?.error) footer.append(system(String(result.error), "error"))
      result = undefined
    }
  }

  client = await W1Runtime.startRuntime({
    cwd: input.directory,
    onFrame,
    onStderr(text) {
      if (input.verbose) process.stderr.write(text)
    },
  })

  const lifecycle = await createRuntimeLifecycle({
    directory: input.directory,
    findFiles: async () => [],
    agents: [],
    resources: [],
    sessionID: input.threadID,
    first: input.first,
    history: [],
    agent: "w1",
    model: { providerID: "w1", modelID: input.model ?? "hosted" },
    variant: undefined,
    tuiConfig: await resolveRunTuiConfig(),
    backgroundSubagents: true,
    brand: "w1",
    onPasteAttachment: attachments.fromPaste,
    onPermissionReply(next) {
      client?.send({
        type: "approval-response",
        requestId: next.requestID,
        decision: next.reply === "reject" ? "deny" : "accept",
      })
      footer?.event({ type: "stream.view", view: { type: "prompt" } })
    },
    onQuestionReply(next) {
      const answer = next.answers.flat().join(", ")
      client?.send({ type: "question-response", requestId: next.requestID, answer })
      footer?.event({ type: "stream.view", view: { type: "prompt" } })
    },
    onQuestionReject(next) {
      client?.send({ type: "question-response", requestId: next.requestID, answer: "" })
      footer?.event({ type: "stream.view", view: { type: "prompt" } })
    },
    onInterrupt() {
      finishAssistant(true)
      client?.interrupt()
    },
  }).catch(async (error) => {
    await client?.stop().catch(() => {})
    throw error
  })
  footer = lifecycle.footer

  const closed = Promise.withResolvers<void>()
  lifecycle.footer.onClose(() => closed.resolve())
  lifecycle.footer.onPrompt((prompt) => {
    if (turnActive) {
      lifecycle.footer.append(system("W1 is still working. Interrupt it before starting another turn.", "error"))
      return
    }
    const queued = initial.splice(0)
    const combined: RunPrompt = { ...prompt, parts: [...prompt.parts, ...queued.map((item) => item.part)] }
    const paths = attachmentPaths(combined)
    const pathReminder = paths.length
      ? `\n\n<system-reminder>Attached images are stored locally at:\n${paths.map((item) => `- ${item}`).join("\n")}\nUse view_image when visual inspection is needed.</system-reminder>`
      : ""
    lifecycle.footer.append({ kind: "user", text: prompt.text, phase: "final", source: "system", partID: randomUUID() })
    turnActive = true
    turnStarted = Date.now()
    lifecycle.footer.event({ type: "turn.send", queue: 0 })
    lifecycle.footer.event({ type: "stream.patch", patch: { status: "Thinking…", duration: "Worked for 0s" } })
    elapsedTimer = setInterval(() => {
      lifecycle.footer.event({ type: "stream.patch", patch: { duration: elapsed(turnStarted) } })
    }, 1000)
    elapsedTimer.unref?.()
    const images = attachmentImages(combined)
    client?.send({
      repo: input.directory,
      task: prompt.text + pathReminder,
      threadId: input.threadID,
      turnRef: randomUUID(),
      provider: "w1",
      runtimeMode: input.fullAccess ? "full-access" : "approval-required",
      first: input.first,
      ...(input.model ? { model: input.model } : {}),
      ...(images.length ? { images } : {}),
    })
    input.first = false
  })

  void client.exited.then((code) => {
    if (!lifecycle.footer.isClosed) {
      lifecycle.footer.append(system(`W1 runtime exited unexpectedly (exit ${code}).`, "error"))
      lifecycle.footer.close()
    }
  })

  try {
    await closed.promise
  } finally {
    stopElapsed()
    await client.stop().catch(() => {})
    await lifecycle.close({ showExit: true, sessionID: input.threadID, history: [] })
  }
}
