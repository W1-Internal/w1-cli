import { read as readClipboard } from "@opencode-ai/tui/clipboard"
import { readLocalAttachment } from "@opencode-ai/tui/prompt/local-attachment"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { RunPromptAttachment } from "@/cli/cmd/run/types"
import { assertAttachmentBytes } from "./tui-contract"

const supported = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

function extension(mime: string) {
  if (mime === "image/jpeg") return ".jpg"
  if (mime === "image/webp") return ".webp"
  if (mime === "image/gif") return ".gif"
  return ".png"
}

function pastedPath(text: string, directory: string) {
  const value = text.trim().replace(/^['"]+|['"]+$/g, "")
  if (!value || value.includes("\n")) return
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value)
    } catch {
      return
    }
  }
  return path.resolve(directory, value.replace(/\\(.)/g, "$1"))
}

export function createW1Attachments(input: { directory: string; threadID: string }) {
  const folder = path.join(input.directory, ".w1", "attachments", input.threadID.replace(/[^a-zA-Z0-9._-]/g, "_"))

  async function persist(bytes: Uint8Array, mime: string, filename?: string): Promise<RunPromptAttachment> {
    assertAttachmentBytes(bytes.byteLength)
    const target = path.join(folder, `${Date.now()}-${randomUUID()}${extension(mime)}`)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" })
    const content = Buffer.from(bytes).toString("base64")
    return {
      part: {
        type: "file",
        mime,
        filename: filename ?? path.basename(target),
        url: `data:${mime};base64,${content}`,
        source: {
          type: "file",
          path: target,
          text: { start: 0, end: 0, value: "" },
        },
      },
    }
  }

  async function fromPath(value: string) {
    const source = pastedPath(value, input.directory)
    if (!source) return
    const attachment = await readLocalAttachment(source)
    if (attachment?.type !== "binary" || !supported.has(attachment.mime)) return
    return persist(attachment.content, attachment.mime, path.basename(source))
  }

  return {
    async fromPaste(text: string) {
      if (text.trim()) return fromPath(text)
      const clipboard = await readClipboard()
      if (!clipboard) return
      if (clipboard.mime === "text/plain") return { text: clipboard.data }
      if (!supported.has(clipboard.mime)) return
      return persist(Buffer.from(clipboard.data, "base64"), clipboard.mime, "clipboard")
    },
    fromPath,
  }
}
