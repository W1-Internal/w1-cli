export const W1_MAX_ATTACHMENT_BYTES = 14 * 1024 * 1024

export type ActorApprovalDecision = "accept" | "acceptForSession" | "deny"

export function actorApprovalDecision(reply?: string, fullAccess = false): ActorApprovalDecision {
  if (fullAccess) return "acceptForSession"
  if (reply === "reject") return "deny"
  if (reply === "always") return "acceptForSession"
  return "accept"
}

export function interactionWasDelivered(value: unknown): value is { delivered: true } {
  return Boolean(value && typeof value === "object" && "delivered" in value && value.delivered === true)
}

export function appendTransientNarration(current: string, delta: unknown) {
  return current + String(delta ?? "")
}

export function isAmbiguousEngineFailure(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /W1 Engine (?:request timed out|disconnected|is not connected)|engine connection timeout/i.test(message)
}

/** A wake the thread is still subscribed to, as a RESULT reports it. */
export type W1Wake = { jobId: string; label: string; nextCheckAt: string }

/**
 * Read the bounded wake receipt off a turn's result.
 *
 * It is keyed off the RECORD, never off the terminal status: since 2026-08-11 the turn that arms
 * a wait finishes normally with the model's own words, and `awaiting_job` is reported only by a
 * waker's own re-check. Reading the status here would drop every wait an ordinary turn armed.
 */
export function readW1Wake(value: unknown): W1Wake | undefined {
  const wait = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const jobId = typeof wait.jobId === "string" ? wait.jobId : ""
  if (!jobId) return undefined
  return {
    jobId,
    label: typeof wait.label === "string" && wait.label ? wait.label : "background job",
    nextCheckAt: typeof wait.nextCheckAt === "string" ? wait.nextCheckAt : "",
  }
}

/**
 * How long to sleep before asking the engine to re-check a wait.
 *
 * The engine owns the job and the schedule; this only decides WHEN to ask. A missing or
 * unparseable `nextCheckAt` must still wake — silence is the failure being fixed here (Kai's
 * 2-minute wake sat 13 minutes with nothing watching it), so it falls back to a short retry
 * rather than never firing. The floor keeps a due-in-the-past check from spinning.
 */
export function w1WakeDelayMs(wake: W1Wake, nowMs: number): number {
  const due = Date.parse(wake.nextCheckAt)
  const target = Number.isFinite(due) && due > 0 ? due - nowMs : 15_000
  return Math.min(2_147_000_000, Math.max(250, target))
}

export function assertAttachmentBytes(byteLength: number) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("W1 received an invalid image attachment.")
  if (byteLength > W1_MAX_ATTACHMENT_BYTES) {
    throw new Error("Image attachments must be 14 MiB or smaller so they fit safely in the W1 Engine connection.")
  }
}
