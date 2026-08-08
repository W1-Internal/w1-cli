import type { DecodedLegacyMessagePage } from "./session-message-decode"
import type { SessionInfo } from "@opencode-ai/client/promise"
import type { Session } from "@opencode-ai/sdk/v2/client"

type Response = { id: number; data?: unknown; error?: string }

let worker: Worker | undefined
let nextID = 0
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

export function decodeSessionMessages(buffer: ArrayBuffer) {
  return decode<DecodedLegacyMessagePage>("messages", buffer)
}

export function decodeSessionList(buffer: ArrayBuffer) {
  return decode<SessionInfo[]>("sessions", buffer)
}

export function decodeHomeSessionPage(buffer: ArrayBuffer, options: { directories: string[]; limit: number }) {
  return decode<{ data: Session[]; cursor: { next?: string } }>("homeSessions", buffer, options)
}

function decode<T>(
  type: "messages" | "sessions" | "homeSessions",
  buffer: ArrayBuffer,
  options?: { directories: string[]; limit: number },
) {
  const id = ++nextID
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as T), reject })
    getWorker().postMessage({ id, type, buffer, options }, [buffer])
  })
}

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL("./session-message-decoder.worker.ts", import.meta.url), { type: "module" })
  worker.onmessage = (event: MessageEvent<Response>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.error) {
      request.reject(new Error(event.data.error))
      return
    }
    request.resolve(event.data.data)
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
