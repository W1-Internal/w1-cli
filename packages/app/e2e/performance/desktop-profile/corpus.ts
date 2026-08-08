import { Database } from "bun:sqlite"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { progress } from "./progress"
import type { Options, Target } from "./types"

export async function createPartialSnapshot(source: string, destination: string, options: Options, targets: Target[]) {
  await mkdir(path.dirname(destination), { recursive: true })
  await rm(destination, { force: true })
  const input = new Database(source, { readonly: true })
  const schema = input
    .query(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
    )
    .all() as { type: string; name: string; sql: string }[]
  input.close()

  const output = new Database(destination, { create: true })
  output.run("PRAGMA foreign_keys = OFF")
  schema.filter((item) => item.type === "table").forEach((item) => output.run(item.sql))
  output.run("ATTACH DATABASE ? AS source", source)
  const selected = [...new Set(targets.map((target) => target.id))]
  const placeholders = selected.map(() => "?").join(",")

  for (const table of schema.filter((item) => item.type === "table").map((item) => item.name)) {
    progress("copying partial snapshot table", { table })
    if (table === "event") continue
    if (table === "message") {
      output.run(
        `INSERT INTO main.message SELECT * FROM source.message
         WHERE (time_created >= ? AND time_created < ? AND session_id IN (
           SELECT id FROM source.session WHERE parent_id IS NULL
         )) OR session_id IN (${placeholders})`,
        options.windowStart,
        options.windowEnd,
        ...selected,
      )
      continue
    }
    if (table === "part") {
      output.run("INSERT INTO main.part SELECT * FROM source.part WHERE message_id IN (SELECT id FROM main.message)")
      continue
    }
    if (["session_context_epoch", "session_input", "session_message", "session_share", "todo"].includes(table)) {
      output.run(
        `INSERT INTO main."${table}" SELECT * FROM source."${table}" WHERE session_id IN (${placeholders})`,
        ...selected,
      )
      continue
    }
    output.run(`INSERT INTO main."${table}" SELECT * FROM source."${table}"`)
  }
  output.run("DETACH DATABASE source")
  schema.filter((item) => item.type !== "table").forEach((item) => output.run(item.sql))
  output.close()
}

export async function fingerprint(file: string) {
  const input = Bun.file(file)
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of input.stream()) hasher.update(chunk)
  return { bytes: input.size, sha256: hasher.digest("hex") }
}

export function loadCorpus(options: Options) {
  const database = new Database(options.database, { readonly: true })
  database.run("PRAGMA query_only = ON")
  const sessions = database
    .query(
      `SELECT id, project_id AS projectID, directory, title
       FROM session AS candidate
       WHERE parent_id IS NULL
         AND EXISTS (
           SELECT 1 FROM message
           WHERE session_id = candidate.id AND time_created >= ? AND time_created < ?
         )`,
    )
    .all(options.windowStart, options.windowEnd) as { id: string; projectID: string; directory: string; title: string }[]
  const messageRows = database.query(
    `SELECT id, data FROM message
     WHERE session_id = ? AND time_created >= ? AND time_created < ?
     ORDER BY time_created, id`,
  )
  const partRows = database.query(`SELECT data FROM part WHERE message_id = ? ORDER BY id`)
  const ranked = sessions
    .map((session) => {
      const messages = messageRows.all(session.id, options.windowStart, options.windowEnd) as {
        id: string
        data: string
      }[]
      const parts = messages.flatMap((message) => partRows.all(message.id) as { data: string }[])
      return {
        ...session,
        bytes:
          messages.reduce((sum, message) => sum + Buffer.byteLength(message.data), 0) +
          parts.reduce((sum, part) => sum + Buffer.byteLength(part.data), 0),
        messages: messages.length,
        parts: parts.length,
        userTurns: messages.filter((message) => JSON.parse(message.data).role === "user").length,
      }
    })
    .filter((session) => session.messages > 0)
    .sort((a, b) => a.bytes - b.bytes || a.id.localeCompare(b.id))
  if (ranked.length === 0) throw new Error("No sessions found in the profile window")
  const select = (label: Target["label"], percentile: number) => ({
    label,
    ...ranked[Math.max(0, Math.ceil(ranked.length * percentile) - 1)]!,
  })
  const targets = [select("p50", 0.5), select("p95", 0.95), select("max", 1)] satisfies Target[]
  const typingText = loadTypingText(database, partRows, messageRows, targets[2]!, options)
  const projectIDs = [...new Set(ranked.map((session) => session.projectID))]
  database.close()
  return { targets, typingText, projectIDs }
}

function loadTypingText(
  database: Database,
  partRows: ReturnType<Database["query"]>,
  messageRows: ReturnType<Database["query"]>,
  target: Target,
  options: Options,
) {
  const messages = messageRows.all(target.id, options.windowStart, options.windowEnd) as { id: string; data: string }[]
  const text = messages
    .filter((message) => JSON.parse(message.data).role === "user")
    .flatMap((message) =>
      (partRows.all(message.id) as { data: string }[]).flatMap((part) => {
        const data = JSON.parse(part.data)
        return data.type === "text" && typeof data.text === "string" ? [data.text] : []
      }),
    )
    .sort((a, b) => b.length - a.length)[0]
  if (!text) throw new Error("No real user prompt found for composer profiling")
  return text
}
