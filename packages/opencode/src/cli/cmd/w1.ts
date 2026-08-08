import { cmd } from "./cmd"
import { W1Runtime, type ProtocolFrame, type RuntimeClient } from "@/w1/runtime"
import { createInterface, type Interface } from "readline/promises"
import { randomUUID } from "crypto"
import path from "path"
import { stat } from "fs/promises"

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
}

type Args = {
  project?: string
  prompt?: string
  session?: string
  model?: string
  image?: string[]
  verbose?: boolean
  fullAccess?: boolean
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

    const readline = createInterface({ input: process.stdin, output: process.stdout })
    const state = {
      directory,
      threadID: args.session?.trim() || `cli-${randomUUID()}`,
      first: !args.session,
      turn: undefined as TurnState | undefined,
      client: undefined as RuntimeClient | undefined,
      pendingImages: await Promise.all((args.image ?? []).map(imageDataUrl)),
    }

    const onFrame = async (frame: ProtocolFrame) => {
      if (frame.tag === "EVT") renderEvent(frame.payload, state.turn, Boolean(args.verbose))
      if (frame.tag === "APPROVAL") await answerApproval(readline, state.client, frame.payload)
      if (frame.tag === "QUESTION" || frame.tag === "USER_INPUT") {
        await answerQuestion(readline, state.client, frame.payload)
      }
      if (frame.tag === "RESULT" && state.turn) state.turn.result = frame.payload
      if (frame.tag === "IDLE" && state.turn) {
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
        state.turn?.done.reject(new Error(`W1 runtime exited unexpectedly (exit ${code}).`))
      })
      const interrupt = () => {
        if (state.turn) {
          state.client?.interrupt()
          write(`\n${color.dim}stopping W1…${color.reset}\n`)
          return
        }
        readline.close()
      }
      process.on("SIGINT", interrupt)
      header(directory, state.client.location.source, state.threadID)

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
          if (request === "/exit" || request === "/quit") break
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
          setExitCode(result)
        }
      } finally {
        process.off("SIGINT", interrupt)
      }
    } finally {
      readline.close()
      await state.client?.stop()
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
  state.turn = { done: Promise.withResolvers<Record<string, unknown>>(), sawSay: false }
  state.client.send({
    repo: state.directory,
    task,
    threadId: state.threadID,
    turnRef: randomUUID(),
    provider: "w1",
    runtimeMode: args.fullAccess ? "full-access" : "approval-required",
    first: state.first,
    ...(args.model ? { model: args.model } : {}),
    ...(state.pendingImages.length ? { images: state.pendingImages } : {}),
  })
  state.first = false
  state.pendingImages = []
  const result = await state.turn.done.promise
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
    if (type === "think_delta" && !verbose) return
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
    const input = event.input && typeof event.input === "object" ? event.input : {}
    const preview = JSON.stringify(input)
    write(
      `${color.lime}●${color.reset} ${color.bold}${String(event.tool ?? "tool")}${color.reset} ${color.dim}${preview.slice(0, 180)}${preview.length > 180 ? "…" : ""}${color.reset}\n`,
    )
    return
  }
  if (type === "observation" && (verbose || event.ok === false)) {
    const line = String(event.observation ?? "").split("\n")[0]
    write(
      `${event.ok === false ? color.red : color.dim}${event.ok === false ? "  error" : "  done"}: ${line.slice(0, 180)}${color.reset}\n`,
    )
    return
  }
  if (type === "error") {
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

function header(directory: string, runtime: string, threadID: string) {
  write(
    `\n${color.lime}${color.bold}W1${color.reset} ${color.dim}· ${path.basename(directory)} · ${runtime} runtime · ${threadID}${color.reset}\n`,
  )
  write(`${color.dim}One W1 actor, directly in your terminal. /help for commands.${color.reset}\n\n`)
}

function help() {
  write(
    [
      "",
      `${color.bold}/help${color.reset}       show commands`,
      `${color.bold}/image PATH${color.reset} attach an image to the next turn`,
      `${color.bold}/clear${color.reset}      start a new W1 thread`,
      `${color.bold}/doctor${color.reset}     show the diagnostic command`,
      `${color.bold}/exit${color.reset}       quit`,
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
