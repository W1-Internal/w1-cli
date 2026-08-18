import { describe, expect, test } from "bun:test"
import {
  W1_MAX_ATTACHMENT_BYTES,
  actorApprovalDecision,
  appendTransientNarration,
  assertAttachmentBytes,
  interactionWasDelivered,
  isAmbiguousEngineFailure,
  readW1Wake,
  w1WakeDelayMs,
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

describe("W1 CLI waker", () => {
  test("arms off the wake record, not the terminal status", () => {
    // The turn that arms a wait now ends `model_finished` with the model's own words. Keying the
    // waker off `awaiting_job` would mean the CLI never wakes for the only turn that ever arms.
    const wake = readW1Wake({ jobId: "abc123", label: "2-minute wake test", nextCheckAt: "2026-08-11T10:12:00.000Z" })
    expect(wake).toEqual({ jobId: "abc123", label: "2-minute wake test", nextCheckAt: "2026-08-11T10:12:00.000Z" })
    expect(readW1Wake(undefined)).toBeUndefined()
    expect(readW1Wake({ label: "no id" })).toBeUndefined()
  })

  test("names an unlabelled job rather than showing nothing", () => {
    expect(readW1Wake({ jobId: "abc123" })?.label).toBe("background job")
  })

  test("sleeps until the check is due", () => {
    const now = Date.parse("2026-08-11T10:10:00.000Z")
    expect(w1WakeDelayMs({ jobId: "a", label: "x", nextCheckAt: "2026-08-11T10:12:00.000Z" }, now)).toBe(120_000)
  })

  test("still wakes when the engine gives no usable next check", () => {
    // Silence is the bug being fixed: Kai's 2-minute wake sat for 13 minutes because nothing was
    // watching it. A missing timestamp must retry soon, never mean "never".
    const now = Date.parse("2026-08-11T10:10:00.000Z")
    expect(w1WakeDelayMs({ jobId: "a", label: "x", nextCheckAt: "" }, now)).toBe(15_000)
    expect(w1WakeDelayMs({ jobId: "a", label: "x", nextCheckAt: "not a date" }, now)).toBe(15_000)
  })

  test("a check already due fires promptly instead of spinning", () => {
    const now = Date.parse("2026-08-11T10:10:00.000Z")
    expect(w1WakeDelayMs({ jobId: "a", label: "x", nextCheckAt: "2026-08-11T10:00:00.000Z" }, now)).toBe(250)
  })
})
