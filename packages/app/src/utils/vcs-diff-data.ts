import type { FileDiffInfo } from "@opencode-ai/client/promise"

export function decodeVcsDiffData(buffer: ArrayBuffer): FileDiffInfo[] {
  const text = new TextDecoder().decode(buffer)
  return (text ? JSON.parse(text) : []).map(
    (file: {
      file: string
      patch?: string
      additions: number
      deletions: number
      status?: "added" | "deleted" | "modified"
    }) => ({
      file: file.file,
      patch: file.patch ?? "",
      additions: file.additions,
      deletions: file.deletions,
      status: file.status ?? "modified",
    }),
  )
}
