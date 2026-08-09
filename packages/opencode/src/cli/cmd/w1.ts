import { cmd } from "./cmd"
import { W1Runtime, type ProtocolFrame, type RuntimeClient } from "@/w1/runtime"
import { createInterface, type Interface } from "readline/promises"
import { randomUUID } from "crypto"
import path from "path"
import { stat } from "fs/promises"
import { W1Auth } from "@/w1/auth"

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  lime: "\x1b[38;5;190m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
}

type TurnState = {
  done: {
    promise: Promise<Record<string, unknown>>
    resolve(value: Record<string, unknown>): void
    reject(reason?: unknown): void
  }
  result?: Record<string, unknown>
  stream?: "say" | "think"
  sawSay: boolean
  activity: ActivityIndicator
}

type Args = {
  project?: string
  prompt?: string
  session?: string
  model?: string
  image?: string[]
  verbose?: boolean
  fullAccess?: boolean
  yolo?: boolean
  plain?: boolean
}

export const W1Command = cmd<{}, Args>({
  command: "$0 [project]",
  describe: "start W1 in this project",
  builder: (yargs) =>
    yargs
      .positional("project", { type: "string", describe: "project directory" })
      .option("prompt", { type: "string", describe: "run one prompt and exit" })
      .option("session", { type: "string", describe: "resume a W1 thread ID" })
      .option("model", { type: "string", describe: "W1 model override" })
      .option("image", { type: "array", string: true, describe: "attach an image path" })
      .option("verbose", { type: "boolean", default: false, describe: "show reasoning and protocol detail" })
      .option("full-access", {
        type: "boolean",
        default: false,
        describe: "allow tools without approval prompts",
      })
      .option("yolo", {
        type: "boolean",
        default: false,
        describe: "allow every tool without approval prompts (alias for --full-access)",
      })
      .option("plain", {
        type: "boolean",
        default: false,
        describe: "use the basic line-oriented interface instead of the W1 TUI",
      }),
  handler: async (args) => {
    const directory = path.resolve(args.project ?? process.cwd())
    if (
      !(await stat(directory)
        .then((value) => value.isDirectory())
        .catch(() => false))
    ) {
      throw new Error(`Project directory does not exist: ${directory}`)
    }

    const piped = process.stdin.isTTY ? undefined : (await Bun.stdin.text()).trim()
    const initialPrompt = args.prompt?.trim() || piped || undefined
    if (!initialPrompt && !process.stdin.isTTY) {
      throw new Error("Pass --prompt or pipe a request into w1.")
    }

    if (!(await W1Auth.readSession())) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Not signed in. Run `w1 login` in an interactive terminal, then retry.")
      }
      write(`${color.yellow}W1 needs a browser session before the first turn.${color.reset}\n`)
      const session = await W1Auth.signIn({
        onStart(url) {
          write(`Opening your browser. If it does not open, visit:\n${color.dim}${url}${color.reset}\n`)
          write("Waiting for sign-in…\n")
        },
      })
      write(`Signed in${session.email ? ` as ${session.email}` : ""}.\n`)
    }

    const fullAccess = Boolean(args.fullAccess || args.yolo)
    if (!initialPrompt && process.stdin.isTTY && !args.plain) {
      const { runW1Tui } = await import("@/w1/tui")
      await runW1Tui({
        directory,
        threadID: args.session?.trim() || `cli-${randomUUID()}`,
        first: !args.session,
        model: args.model,
        fullAccess,
        images: args.image ?? [],
        verbose: Boolean(args.verbose),
      })
      return
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout })
    const state = {
      directory,
      threadID: args.session?.trim() || `cli-${randomUUID()}`,
      first: !args.session,
      closing: false,
      turn: undefined as TurnState | undefined,
      client: undefined as RuntimeClient | undefined,
      pendingImages: await Promise.all((args.image ?? []).map(imageDataUrl)),
    }
    let stopPromise: Promise<void> | undefined
    let lastInterrupt = 0
    const stopRuntime = () => (stopPromise ??= state.client?.stop() ?? Promise.resolve())

    const onFrame = async (frame: ProtocolFrame) => {
      if (frame.tag === "EVT") renderEvent(frame.payload, state.turn, Boolean(args.verbose))
      if (frame.tag === "APPROVAL") {
        state.turn?.activity.clear()
        if (fullAccess) acceptApproval(state.client, frame.payload)
        else await answerApproval(readline, state.client, frame.payload)
        state.turn?.activity.set("Working")
      }
      if (frame.tag === "QUESTION" || frame.tag === "USER_INPUT") {
        state.turn?.activity.clear()
        await answerQuestion(readline, state.client, frame.payload)
        state.turn?.activity.set("Thinking")
      }
      if (frame.tag === "RESULT" && state.turn) state.turn.result = frame.payload
      if (frame.tag === "IDLE" && state.turn) {
        state.turn.activity.clear()
        breakStream(state.turn)
        state.turn.done.resolve(state.turn.result ?? { status: "internal_error", error: "missing result" })
      }
      if (
        args.verbose &&
        !["EVT", "RESULT", "IDLE", "READY", "APPROVAL", "QUESTION", "USER_INPUT"].includes(frame.tag)
      ) {
        write(`${color.dim}${frame.tag.toLowerCase()} ${JSON.stringify(frame.payload)}${color.reset}\n`)
      }
    }

    try {
      state.client = await W1Runtime.startRuntime({
        cwd: directory,
        onFrame,
        onStderr: (text) => {
          if (args.verbose) process.stderr.write(`${color.dim}${text}${color.reset}`)
        },
      })
      state.client.exited.then((code) => {
        state.turn?.activity.clear()
        if (state.closing) state.turn?.done.reject(new Error("W1 session closed."))
        else state.turn?.done.reject(new Error(`W1 runtime exited unexpectedly (exit ${code}).`))
      })
      const interrupt = () => {
        if (state.closing) {
          if (Date.now() - lastInterrupt < 250) return
          restoreTerminal()
          process.exit(130)
        }
        lastInterrupt = Date.now()
        state.closing = true
        process.exitCode = 130
        state.turn?.activity.clear()
        write(`\n${color.dim}closing W1…${color.reset}\n`)
        readline.close()
        void stopRuntime()
        if (state.turn) {
          state.turn.done.reject(new Error("W1 session closed."))
          return
        }
      }
      process.on("SIGINT", interrupt)
      readline.on("SIGINT", interrupt)
      header(directory, state.client.location.source, state.threadID, fullAccess)

      try {
        if (initialPrompt) {
          const result = await runTurn(state, initialPrompt, args)
          setExitCode(result)
          return
        }

        for (;;) {
          let request: string
          try {
            request = (await readline.question(`${color.lime}›${color.reset} `)).trim()
          } catch {
            break
          }
          if (!request) continue
          if (["exit", "quit", "/exit", "/quit"].includes(request.toLowerCase())) break
          if (request === "/help") {
            help()
            continue
          }
          if (request === "/clear") {
            state.threadID = `cli-${randomUUID()}`
            state.first = true
            write(`${color.dim}new thread ${state.threadID}${color.reset}\n`)
            continue
          }
          if (request.startsWith("/image ")) {
            state.pendingImages.push(await imageDataUrl(request.slice(7).trim()))
            write(`${color.dim}image attached for the next turn${color.reset}\n`)
            continue
          }
          if (request === "/doctor") {
            write(`${color.dim}Run \`w1 doctor\` outside the session for the full environment report.${color.reset}\n`)
            continue
          }
          const result = await runTurn(state, request, args)
          if (state.closing) break
          setExitCode(result)
        }
      } catch (error) {
        if (!state.closing) throw error
      } finally {
        process.off("SIGINT", interrupt)
        readline.off("SIGINT", interrupt)
      }
    } finally {
      readline.close()
      await stopRuntime()
      restoreTerminal()
    }
  },
})

async function runTurn(
  state: {
    directory: string
    threadID: string
    first: boolean
    turn?: TurnState
    client?: RuntimeClient
    pendingImages: string[]
  },
  task: string,
  args: Args,
) {
  if (!state.client) throw new Error("W1 runtime is not connected.")
  state.turn = {
    done: Promise.withResolvers<Record<string, unknown>>(),
    sawSay: false,
    activity: new ActivityIndicator(),
  }
  state.turn.activity.set("Thinking")
  state.client.send({
    repo: state.directory,
    task,
    threadId: state.threadID,
    turnRef: randomUUID(),
    provider: "w1",
    runtimeMode: args.fullAccess || args.yolo ? "full-access" : "approval-required",
    first: state.first,
    ...(args.model ? { model: args.model } : {}),
    ...(state.pendingImages.length ? { images: state.pendingImages } : {}),
  })
  state.first = false
  state.pendingImages = []
  const result = await state.turn.done.promise
  state.turn.activity.clear()
  if (!state.turn.sawSay && typeof result.summary === "string" && result.summary.trim()) {
    write(`${color.bold}${result.summary.trim()}${color.reset}\n`)
  }
  if (result.error) write(`${color.red}${String(result.error)}${color.reset}\n`)
  const detail = [result.status, typeof result.steps === "number" ? `${result.steps} steps` : undefined]
    .filter(Boolean)
    .join(" · ")
  if (detail) write(`${color.dim}${detail}${color.reset}\n\n`)
  state.turn = undefined
  return result
}

function renderEvent(event: Record<string, unknown>, turn: TurnState | undefined, verbose: boolean) {
  if (!turn) return
  const type = String(event.t ?? "")
  if (type === "say_delta" || type === "think_delta") {
    if (type === "think_delta" && !verbose) {
      turn.activity.set("Thinking")
      return
    }
    turn.activity.clear()
    const stream = type === "say_delta" ? "say" : "think"
    if (turn.stream && turn.stream !== stream) write("\n")
    if (turn.stream !== stream && stream === "think") write(`${color.dim}thinking: `)
    turn.stream = stream
    if (stream === "say") turn.sawSay = true
    write(`${String(event.text ?? "")}${stream === "think" ? color.reset : ""}`)
    return
  }
  breakStream(turn)
  if (type === "action") {
    turn.activity.clear()
    const input = event.input && typeof event.input === "object" ? event.input : {}
    const preview = JSON.stringify(input)
    write(
      `${color.lime}●${color.reset} ${color.bold}${String(event.tool ?? "tool")}${color.reset} ${color.dim}${preview.slice(0, 180)}${preview.length > 180 ? "…" : ""}${color.reset}\n`,
    )
    turn.activity.set("Working")
    return
  }
  if (type === "observation") {
    turn.activity.clear()
    if (verbose || event.ok === false) {
      const line = String(event.observation ?? "").split("\n")[0]
      write(
        `${event.ok === false ? color.red : color.dim}${event.ok === false ? "  error" : "  done"}: ${line.slice(0, 180)}${color.reset}\n`,
      )
    }
    turn.activity.set("Thinking")
    return
  }
  if (type === "error") {
    turn.activity.clear()
    write(`${color.red}error: ${String(event.message ?? "runtime error")}${color.reset}\n`)
    return
  }
  if (verbose && type) write(`${color.dim}${type} ${JSON.stringify(event)}${color.reset}\n`)
}

async function answerApproval(
  readline: Interface,
  client: RuntimeClient | undefined,
  payload: Record<string, unknown>,
) {
  if (!client) return
  const requestID = String(payload.requestId ?? "")
  const detail = String(payload.detail ?? payload.reason ?? "W1 wants to use a protected tool.")
  const answer = (await readline.question(`\n${color.yellow}${detail}${color.reset}\nAllow? [y/N] `))
    .trim()
    .toLowerCase()
  client.send({
    type: "approval-response",
    requestId: requestID,
    decision: answer === "y" || answer === "yes" ? "accept" : "deny",
  })
}

function acceptApproval(client: RuntimeClient | undefined, payload: Record<string, unknown>) {
  client?.send({
    type: "approval-response",
    requestId: String(payload.requestId ?? ""),
    decision: "accept",
  })
}

async function answerQuestion(
  readline: Interface,
  client: RuntimeClient | undefined,
  payload: Record<string, unknown>,
) {
  if (!client) return
  const first =
    Array.isArray(payload.questions) && payload.questions[0] && typeof payload.questions[0] === "object"
      ? (payload.questions[0] as Record<string, unknown>)
      : payload
  const question = String(first.question ?? "W1 needs your input.")
  const options = Array.isArray(first.options)
    ? first.options.map((option) =>
        option && typeof option === "object" && "label" in option
          ? String((option as Record<string, unknown>).label)
          : String(option),
      )
    : []
  if (options.length)
    write(`${color.dim}${options.map((option, index) => `${index + 1}. ${option}`).join("  ")}${color.reset}\n`)
  const answer = await readline.question(`${color.yellow}${question}${color.reset}\n› `)
  client.send({ type: "question-response", requestId: String(payload.requestId ?? ""), answer })
}

async function imageDataUrl(value: string) {
  const file = Bun.file(path.resolve(value))
  if (!(await file.exists())) throw new Error(`Image not found: ${value}`)
  const extension = path.extname(value).toLowerCase()
  const mime =
    extension === ".png"
      ? "image/png"
      : extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : extension === ".webp"
          ? "image/webp"
          : extension === ".gif"
            ? "image/gif"
            : undefined
  if (!mime) throw new Error(`Unsupported image type: ${extension || value}`)
  return `data:${mime};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`
}

function breakStream(turn: TurnState) {
  if (turn.stream) write("\n")
  turn.stream = undefined
}

function header(directory: string, runtime: string, threadID: string, fullAccess: boolean) {
  write(
    `\n${color.lime}${color.bold}W1${color.reset} ${color.dim}· ${path.basename(directory)} · ${runtime} runtime · ${threadID}${color.reset}${fullAccess ? ` ${color.yellow}· YOLO${color.reset}` : ""}\n`,
  )
  write(`${color.dim}One W1 actor, directly in your terminal. /help for commands.${color.reset}\n\n`)
}

class ActivityIndicator {
  private label?: "Thinking" | "Working"
  private frame = 0
  private timer?: ReturnType<typeof setInterval>
  private readonly animated = Boolean(process.stdout.isTTY)
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

  set(label: "Thinking" | "Working") {
    if (this.label === label) return
    this.clear()
    this.label = label
    if (!this.animated) {
      write(`${label}…\n`)
      return
    }
    this.render()
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % this.frames.length
      this.render()
    }, 80)
    this.timer.unref?.()
  }

  clear() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.label && this.animated) write("\r\x1b[2K")
    this.label = undefined
    this.frame = 0
  }

  private render() {
    if (!this.label) return
    write(`\r\x1b[2K${color.lime}${this.frames[this.frame]}${color.reset} ${color.dim}${this.label}…${color.reset}`)
  }
}

function help() {
  write(
    [
      "",
      `${color.bold}/help${color.reset}       show commands`,
      `${color.bold}/image PATH${color.reset} attach an image to the next turn`,
      `${color.bold}/clear${color.reset}      start a new W1 thread`,
      `${color.bold}/doctor${color.reset}     show the diagnostic command`,
      `${color.bold}exit | /exit${color.reset} quit (Ctrl+C and Ctrl+D also work)`,
      "",
    ].join("\n"),
  )
}

function setExitCode(result: Record<string, unknown>) {
  if (result.status && result.status !== "model_finished") process.exitCode = 2
}

function write(text: string) {
  process.stdout.write(text)
}

function restoreTerminal() {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(false)
  process.stdin.pause()
}
