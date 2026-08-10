/**
 * The CLI and the engine it spawns must derive the SAME socket path.
 *
 * They live in two repositories and each computes the endpoint from scratch. When they disagreed,
 * the CLI waited on `~/.w1/engine/v1/ipc/w1-v1.sock` while its own engine bound
 * `~/.w1/engine/surfaces/cli/v1/ipc/w1-v1.sock`, and every run on a clean machine died with
 * `connect ENOENT`. That shipped as 0.2.4 and again as 0.2.5, past a full green suite both times,
 * because no test ever asked the two halves the same question.
 *
 * This is that test. The expected values below are the engine's rule, restated independently:
 * an unset surface is the legacy shared root; any other surface is a SIBLING directory under
 * `engine/surfaces/<slug>`; on Windows the slug lives in the pipe name because named pipes have no
 * directories. If the engine's rule changes, this fails — which is the point.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import path from "node:path"

import { normalizeEngineSurface, resolveEndpoint } from "../src/w1/engine"

const originalSurface = process.env.W1_CLIENT_SURFACE
const originalStateDir = process.env.W1_ENGINE_STATE_DIR

afterEach(() => {
  if (originalSurface === undefined) delete process.env.W1_CLIENT_SURFACE
  else process.env.W1_CLIENT_SURFACE = originalSurface
  if (originalStateDir === undefined) delete process.env.W1_ENGINE_STATE_DIR
  else process.env.W1_ENGINE_STATE_DIR = originalStateDir
})

const sharedRoot = path.join(homedir(), ".w1", "engine", "v1")
const surfaceRoot = (surface: string) => path.join(homedir(), ".w1", "engine", "surfaces", surface, "v1")

describe("engine endpoint parity", () => {
  test("W1_CLIENT_SURFACE=cli resolves the per-surface socket, not the shared one", () => {
    process.env.W1_CLIENT_SURFACE = "cli"
    if (process.platform === "win32") {
      expect(resolveEndpoint()).toMatch(/^\\\\\.\\pipe\\w1-[0-9a-f]{16}-cli-v1$/)
      return
    }
    expect(resolveEndpoint()).toBe(path.join(surfaceRoot("cli"), "ipc", "w1-v1.sock"))
    // The exact wrong answer that shipped twice.
    expect(resolveEndpoint()).not.toBe(path.join(sharedRoot, "ipc", "w1-v1.sock"))
  })

  test("an unset surface keeps the legacy shared endpoint so older callers still work", () => {
    delete process.env.W1_CLIENT_SURFACE
    if (process.platform === "win32") {
      expect(resolveEndpoint()).toMatch(/^\\\\\.\\pipe\\w1-[0-9a-f]{16}-v1$/)
      return
    }
    expect(resolveEndpoint()).toBe(path.join(sharedRoot, "ipc", "w1-v1.sock"))
  })

  test("surface roots are siblings of the shared root, never nested inside it", () => {
    if (process.platform === "win32") return
    process.env.W1_CLIENT_SURFACE = "cli"
    // Nesting makes the history seed a self-copy, which fails and empties the journal — the user's
    // conversations look deleted.
    expect(resolveEndpoint().startsWith(sharedRoot + path.sep)).toBe(false)
  })

  test("W1_ENGINE_STATE_DIR still wins outright, as the engine treats it", () => {
    if (process.platform === "win32") return
    process.env.W1_CLIENT_SURFACE = "cli"
    process.env.W1_ENGINE_STATE_DIR = "/tmp/w1-explicit-root"
    expect(resolveEndpoint()).toBe(path.join("/tmp/w1-explicit-root", "ipc", "w1-v1.sock"))
  })

  test("slugs the way the engine slugs, so both sides land in one directory", () => {
    expect(normalizeEngineSurface(undefined)).toBe("shared")
    expect(normalizeEngineSurface("")).toBe("shared")
    expect(normalizeEngineSurface("CLI")).toBe("cli")
    expect(normalizeEngineSurface("vs code")).toBe("vs-code")
    expect(normalizeEngineSurface("../escape")).toBe("escape")
    expect(normalizeEngineSurface("a".repeat(64))).toBe("a".repeat(32))
  })

  test("a surface name can never escape the engine root", () => {
    if (process.platform === "win32") return
    process.env.W1_CLIENT_SURFACE = "../../../etc"
    const resolved = resolveEndpoint()
    expect(resolved.startsWith(path.join(homedir(), ".w1", "engine", "surfaces"))).toBe(true)
    expect(resolved).not.toContain("..")
  })
})
