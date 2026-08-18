import { describe, expect, test } from "bun:test"

import { isNewerVersion, W1_NPM_PACKAGE } from "./update"
import { parseLocalThreadCommand } from "../cli/cmd/run/prompt.shared"

describe("W1 self-update", () => {
  test("publishes and updates from the owned scope", () => {
    expect(W1_NPM_PACKAGE).toBe("@w1-lab/cli")
    // Unscoped names are squattable, and this string decides what gets installed on a user's machine.
    expect(W1_NPM_PACKAGE.startsWith("@w1-lab/")).toBe(true)
  })

  test("detects a newer release", () => {
    expect(isNewerVersion("0.2.3", "0.2.2")).toBe(true)
    expect(isNewerVersion("0.3.0", "0.2.9")).toBe(true)
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true)
  })

  test("does not offer an update for the same or older release", () => {
    expect(isNewerVersion("0.2.2", "0.2.2")).toBe(false)
    expect(isNewerVersion("0.2.1", "0.2.2")).toBe(false)
    expect(isNewerVersion("0.1.9", "0.2.0")).toBe(false)
  })

  test("never claims an update when a version cannot be parsed", () => {
    // A registry hiccup or an odd local build must not nag the user forever.
    expect(isNewerVersion("not-a-version", "0.2.2")).toBe(false)
    expect(isNewerVersion("0.2.3", "development")).toBe(false)
  })

  test("/update is recognised as a local command", () => {
    expect(parseLocalThreadCommand("/update")).toEqual({ type: "update" })
    expect(parseLocalThreadCommand("  /update  ")).toEqual({ type: "update" })
    expect(parseLocalThreadCommand("/UPDATE")).toEqual({ type: "update" })
  })

  test("does not swallow prompts that merely mention update", () => {
    expect(parseLocalThreadCommand("/update the readme")).toBeUndefined()
    expect(parseLocalThreadCommand("update")).toBeUndefined()
    expect(parseLocalThreadCommand("please /update later")).toBeUndefined()
  })

  test("still parses the existing local commands", () => {
    expect(parseLocalThreadCommand("/new")).toEqual({ type: "new" })
    expect(parseLocalThreadCommand("/resume")).toEqual({ type: "resume" })
    expect(parseLocalThreadCommand("/resume abc123")).toEqual({ type: "resume", threadID: "abc123" })
  })
})
