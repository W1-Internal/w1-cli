import type { SessionInfo, SessionMessageInfo } from "@opencode-ai/client/promise"
import type { Message, Part, Session, V2SessionListResponse } from "@opencode-ai/sdk/v2/client"
import { message as cleanMessage } from "@/utils/diffs"
import { pathKey } from "@/utils/path-key"
import { parseHomeSessionIndex } from "./global-sync/home-session-index"
import { takeRecentSessions } from "./global-sync/session-trim"

export type DecodedLegacyMessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  source: SessionMessageInfo[]
}

export function decodeLegacyMessagePage(buffer: ArrayBuffer): DecodedLegacyMessagePage {
  const text = new TextDecoder().decode(buffer)
  const items = (text ? (JSON.parse(text) as { info?: Message; parts?: Part[] }[]) : []).filter(
    (item): item is { info: Message; parts: Part[] } => !!item.info?.id && Array.isArray(item.parts),
  )
  return {
    session: items.map((item) => cleanMessage(item.info)).sort((a, b) => compare(a.id, b.id)),
    part: items.map((item) => ({
      id: item.info.id,
      part: item.parts.filter((part) => !!part?.id).sort((a, b) => compare(a.id, b.id)),
    })),
    source: items
      .slice()
      .sort((a, b) => compare(a.info.id, b.info.id))
      .map((item) =>
        item.info.role === "user"
          ? {
              id: item.info.id,
              type: "user" as const,
              text: item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
              time: item.info.time,
            }
          : {
              id: item.info.id,
              type: "assistant" as const,
              agent: item.info.agent ?? item.info.mode,
              model: { id: item.info.modelID, providerID: item.info.providerID, variant: item.info.variant },
              content: [],
              time: item.info.time,
            },
      ),
  }
}

export function decodeLegacySessionList(buffer: ArrayBuffer) {
  const text = new TextDecoder().decode(buffer)
  return (text ? (JSON.parse(text) as Session[]) : []).map(legacySessionInfo)
}

export function decodeHomeSessionPage(buffer: ArrayBuffer, options?: { directories: string[]; limit: number }) {
  const text = new TextDecoder().decode(buffer)
  const page = (text ? JSON.parse(text) : { data: [], cursor: {} }) as V2SessionListResponse
  const sessions = parseHomeSessionIndex(page.data)
  if (!options) return { data: sessions, cursor: page.cursor }
  const directories = new Set(options.directories.map(pathKey))
  return {
    data: [...Map.groupBy(sessions, (session) => pathKey(session.directory))]
      .filter(([directory]) => directories.has(directory))
      .flatMap(([, items]) => takeRecentSessions(items, options.limit, Number.NEGATIVE_INFINITY)),
    cursor: page.cursor,
  }
}

export function legacySessionInfo(session: Session): SessionInfo {
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID,
    agent: session.agent,
    model: session.model && {
      id: session.model.id,
      providerID: session.model.providerID,
      variant: session.model.variant,
    },
    cost: session.cost ?? 0,
    tokens: session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: session.time,
    title: session.title,
    location: { directory: session.directory, workspaceID: session.workspaceID },
    subpath: session.path,
    revert: session.revert && {
      messageID: session.revert.messageID,
      partID: session.revert.partID,
      snapshot: session.revert.snapshot,
    },
  }
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}
