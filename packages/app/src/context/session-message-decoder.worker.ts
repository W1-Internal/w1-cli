import { decodeHomeSessionPage, decodeLegacyMessagePage, decodeLegacySessionList } from "./session-message-decode"

type DecoderRequest = {
  id: number
  type: "messages" | "sessions" | "homeSessions"
  buffer: ArrayBuffer
  options?: { directories: string[]; limit: number }
}

self.onmessage = (event: MessageEvent<DecoderRequest>) => {
  try {
    self.postMessage({
      id: event.data.id,
      data: (() => {
        if (event.data.type === "messages") return decodeLegacyMessagePage(event.data.buffer)
        if (event.data.type === "sessions") return decodeLegacySessionList(event.data.buffer)
        return decodeHomeSessionPage(event.data.buffer, event.data.options)
      })(),
    })
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) })
  }
}

export {}
