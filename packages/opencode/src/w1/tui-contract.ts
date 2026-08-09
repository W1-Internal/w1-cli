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

export function assertAttachmentBytes(byteLength: number) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("W1 received an invalid image attachment.")
  if (byteLength > W1_MAX_ATTACHMENT_BYTES) {
    throw new Error("Image attachments must be 14 MiB or smaller so they fit safely in the W1 Engine connection.")
  }
}
