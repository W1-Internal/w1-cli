import { describe, expect, test } from "bun:test"
import {
  W1_MAX_ATTACHMENT_BYTES,
  actorApprovalDecision,
  appendTransientNarration,
  assertAttachmentBytes,
  interactionWasDelivered,
  isAmbiguousEngineFailure,
} from "./tui-contract"

describe("W1 TUI actor and recovery contracts", () => {
  test("uses the actor decision vocabulary for approvals and yolo", () => {
    expect(actorApprovalDecision("once")).toBe("accept")
    expect(actorApprovalDecision("always")).toBe("acceptForSession")
    expect(actorApprovalDecision("reject")).toBe("deny")
    expect(actorApprovalDecision(undefined, true)).toBe("acceptForSession")
  })

  test("does not clear an interaction until the engine confirms delivery", () => {
    expect(interactionWasDelivered({ delivered: true })).toBe(true)
    expect(interactionWasDelivered({ delivered: false })).toBe(false)
    expect(interactionWasDelivered(undefined)).toBe(false)
  })

  test("retains transient narration while another task is visible", () => {
    let narration = ""
    narration = appendTransientNarration(narration, "The first half ")
    narration = appendTransientNarration(narration, "still arrives in the background.")
    expect(narration).toBe("The first half still arrives in the background.")
  })

  test("reuses an idempotency key only for ambiguous submit failures", () => {
    expect(isAmbiguousEngineFailure(new Error("W1 Engine request timed out: turn.submit"))).toBe(true)
    expect(isAmbiguousEngineFailure(new Error("W1 Engine disconnected."))).toBe(true)
    expect(isAmbiguousEngineFailure(new Error("permission denied"))).toBe(false)
  })

  test("rejects attachments too large for the engine frame before persistence", () => {
    expect(() => assertAttachmentBytes(W1_MAX_ATTACHMENT_BYTES)).not.toThrow()
    expect(() => assertAttachmentBytes(W1_MAX_ATTACHMENT_BYTES + 1)).toThrow("14 MiB")
  })
})
