/**
 * The CLI must derive the SAME state root the engine library derives.
 *
 * ENGINE ZERO retired the endpoint half of this contract — there is no socket and no pipe,
 * because the engine lives in this process. What remains load-bearing is the STATE ROOT: the
 * directory that holds the journal and threads. The daemon era shipped 0.2.4 and 0.2.5 broken
 * because two repositories answered "where is the engine?" differently; the state root is the
 * one place that question still exists, and this test restates the engine's rule independently:
 * an unset surface is the legacy shared root; any other surface is a SIBLING directory under
 * `engine/surfaces/<slug>`; W1_ENGINE_STATE_DIR wins outright. If the engine's rule changes,
 * this fails — which is the point.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import path from "node:path"

import { normalizeEngineSurface, resolveStateRoot } from "../src/w1/engine"

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

describe("engine state-root parity", () => {
  test("W1_CLIENT_SURFACE=cli resolves the per-surface root, not the shared one", () => {
    process.env.W1_CLIENT_SURFACE = "cli"
    delete process.env.W1_ENGINE_STATE_DIR
    expect(resolveStateRoot()).toBe(surfaceRoot("cli"))
    // The exact wrong answer that shipped twice in the daemon era.
    expect(resolveStateRoot()).not.toBe(sharedRoot)
  })

  test("an unset surface keeps the legacy shared root so older state is still found", () => {
    delete process.env.W1_CLIENT_SURFACE
    delete process.env.W1_ENGINE_STATE_DIR
    expect(resolveStateRoot()).toBe(sharedRoot)
  })

  test("surface roots are siblings of the shared root, never nested inside it", () => {
    process.env.W1_CLIENT_SURFACE = "cli"
    delete process.env.W1_ENGINE_STATE_DIR
    // Nesting makes the history seed a self-copy, which fails and empties the journal — the
    // user's conversations look deleted.
    expect(resolveStateRoot().startsWith(sharedRoot + path.sep)).toBe(false)
  })

  test("W1_ENGINE_STATE_DIR still wins outright, as the engine treats it", () => {
    process.env.W1_CLIENT_SURFACE = "cli"
    process.env.W1_ENGINE_STATE_DIR = path.join(path.sep, "tmp", "w1-explicit-root")
    expect(resolveStateRoot()).toBe(path.resolve(path.join(path.sep, "tmp", "w1-explicit-root")))
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
    process.env.W1_CLIENT_SURFACE = "../../../etc"
    delete process.env.W1_ENGINE_STATE_DIR
    const resolved = resolveStateRoot()
    expect(resolved.startsWith(path.join(homedir(), ".w1", "engine", "surfaces"))).toBe(true)
    expect(resolved).not.toContain("..")
  })
})
