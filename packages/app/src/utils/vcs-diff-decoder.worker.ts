import { decodeVcsDiffData } from "./vcs-diff-data"

type Request = { id: number; buffer: ArrayBuffer }

self.onmessage = (event: MessageEvent<Request>) => {
  try {
    self.postMessage({ id: event.data.id, data: decodeVcsDiffData(event.data.buffer) })
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) })
  }
}

export {}
