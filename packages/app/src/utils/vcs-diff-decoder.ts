import type { FileDiffInfo } from "@opencode-ai/client/promise"

type Response = { id: number; data?: FileDiffInfo[]; error?: string }

let worker: Worker | undefined
let nextID = 0
const pending = new Map<number, { resolve: (value: FileDiffInfo[]) => void; reject: (error: Error) => void }>()
let lastInput = 0
document.addEventListener(
  "beforeinput",
  () => {
    lastInput = performance.now()
  },
  { capture: true },
)

export function decodeVcsDiff(buffer: ArrayBuffer) {
  const id = ++nextID
  return new Promise<FileDiffInfo[]>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, buffer }, [buffer])
  })
}

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL("./vcs-diff-decoder.worker.ts", import.meta.url), { type: "module" })
  worker.onmessage = (event: MessageEvent<Response>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.error) {
      request.reject(new Error(event.data.error))
      return
    }
    resolveWhenInputIdle(request.resolve, event.data.data ?? [])
  }
  worker.onerror = (event) => {
    const error = new Error(event.message)
    pending.forEach((request) => request.reject(error))
    pending.clear()
    worker?.terminate()
    worker = undefined
  }
  return worker
}

function resolveWhenInputIdle(resolve: (value: FileDiffInfo[]) => void, value: FileDiffInfo[], initial = true) {
  const active = document.activeElement
  const editing =
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  const delay = Math.max(lastInput + 100 - performance.now(), initial && editing ? 100 : 0)
  if (delay <= 0) {
    resolve(value)
    return
  }
  setTimeout(() => resolveWhenInputIdle(resolve, value, false), delay)
}
