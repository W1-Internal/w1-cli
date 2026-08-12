import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EngineClient, W1_ENGINE_MAX_FRAME_BYTES, assertEngineFrameBytes, engineClientVersion, resolveEngine, selectedMessagesAfterSnapshot, type ThreadPush } from "./engine"

/**
 * A scripted engine library standing where w1-engine-lib.mjs ships. Same role the fake socket
 * server played before ENGINE ZERO: fixed responses, deliberately awkward push ordering (a
 * transient BEFORE the subscribe response, a duplicate of the snapshot AFTER it), so the
 * client's orphan-buffering and dedupe are exercised through the real import seam.
 */
async function scriptedEngineDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "w1-engine-fixture-"))
  await writeFile(
    path.join(dir, "w1-engine-lib.mjs"),
    `const EV = (sequence) => ({
      schemaVersion: 1, eventId: "event-" + sequence, threadId: "thread-1", turnId: "turn-1",
      sequence, kind: "turn.submitted", phase: "accepted", at: "2026-08-09T00:00:00.000Z", data: { text: "hello" },
    });
    const THREAD = (threadId, updatedAt) => ({
      threadId, workspaceId: "workspace-1", workspacePath: "/workspace", title: threadId, state: "idle",
      createdAt: updatedAt, updatedAt, lastSequence: 1, archived: false,
    });
    export async function createInProcessW1Engine(options) {
      const listeners = new Set();
      const emit = (message) => { for (const listener of listeners) listener(message); };
      return {
        attach() {
          return {
            async request(method, params) {
              if (method === "engine.status") {
                return { engineVersion: options.engineVersion, buildId: options.buildId, state: "idle", activeTurnCount: 0 };
              }
              if (method === "events.subscribe") {
                emit({ type: "transient", subscriptionId: "sub-1", threadId: "thread-1", event: { tag: "EVT", data: { t: "think_delta" } } });
                setTimeout(() => {
                  emit({ type: "event", subscriptionId: "sub-1", threadId: "thread-1", cursor: 1, event: EV(1) });
                  emit({ type: "event", subscriptionId: "sub-1", threadId: "thread-1", cursor: 2, event: EV(2) });
                }, 0);
                return { subscriptionId: "sub-1", replay: [EV(1)], cursor: 1, active: true };
              }
              if (method === "catalog.subscribe") {
                emit({ type: "catalog", subscriptionId: "catalog-1", workspacePath: params.workspacePath, cursor: 1, thread: THREAD("snapshot-duplicate", "2026-08-09T00:00:01.000Z") });
                setTimeout(() => {
                  emit({ type: "catalog", subscriptionId: "catalog-1", workspacePath: params.workspacePath, cursor: 2, thread: THREAD("live", "2026-08-09T00:00:02.000Z") });
                }, 0);
                return { subscriptionId: "catalog-1", snapshot: { cursor: 1, threads: [THREAD("snapshot", "2026-08-09T00:00:00.000Z")] } };
              }
              if (method === "events.unsubscribe" || method === "catalog.unsubscribe") return { unsubscribed: true };
              throw new Error("fixture does not script " + method);
            },
            onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            detach() { listeners.clear(); },
          };
        },
        async close() {},
      };
    }`,
  )
  return {
    dir,
    location: {
      enginePath: path.join(dir, "w1-engine.mjs"),
      workerPath: path.join(dir, "run-stream.mjs"),
      buildId: "fixture-build",
      source: "environment" as const,
    },
  }
}

const originalEngine = process.env.W1_ENGINE_PATH
const originalRuntime = process.env.W1_RUNTIME_PATH

afterEach(() => {
  if (originalEngine === undefined) delete process.env.W1_ENGINE_PATH
  else process.env.W1_ENGINE_PATH = originalEngine
  if (originalRuntime === undefined) delete process.env.W1_RUNTIME_PATH
  else process.env.W1_RUNTIME_PATH = originalRuntime
})

describe("W1 Engine CLI client", () => {
  test("uses a protocol-safe version for source checkouts", () => {
    expect(engineClientVersion("local")).toBe("0.0.0")
    expect(engineClientVersion("0.1.3")).toBe("0.1.3")
  })

  test("rejects oversized IPC frames before writing to the daemon socket", () => {
    expect(() => assertEngineFrameBytes(W1_ENGINE_MAX_FRAME_BYTES - 1)).not.toThrow()
    expect(() => assertEngineFrameBytes(W1_ENGINE_MAX_FRAME_BYTES)).toThrow("20 MiB")
  })

  test("keeps only post-snapshot live messages during selected-thread hydration", () => {
    const durable = (sequence: number): ThreadPush => ({
      type: "event",
      subscriptionId: "sub-1",
      threadId: "thread-1",
      cursor: sequence,
      event: {
        schemaVersion: 1,
        eventId: `event-${sequence}`,
        threadId: "thread-1",
        turnId: "turn-1",
        sequence,
        kind: "worker.event",
        phase: "runtime",
        at: "2026-08-09T00:00:00.000Z",
        data: {},
      },
    })
    const transient = (text: string): ThreadPush => ({
      type: "transient",
      subscriptionId: "sub-1",
      threadId: "thread-1",
      event: { tag: "EVT", data: { t: "say_delta", text } },
    })
    const selected = selectedMessagesAfterSnapshot([
      transient("before"),
      durable(4),
      transient("after"),
      durable(6),
    ], 5)
    expect(selected.map((message) => message.type === "event" ? message.event.sequence : message.event.data.text)).toEqual(["after", 6])
  })

  test("resolves an engine and actor bundle as one pinned runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "w1-engine-location-"))
    try {
      const engine = path.join(root, "w1-engine.mjs")
      const worker = path.join(root, "run-stream.mjs")
      await writeFile(engine, "export {}\n")
      await writeFile(worker, "export {}\n")
      await writeFile(path.join(root, "BUILD_ID"), "engine-build\n")
      process.env.W1_ENGINE_PATH = engine
      process.env.W1_RUNTIME_PATH = worker

      expect(await resolveEngine()).toEqual({
        enginePath: engine,
        workerPath: worker,
        buildId: "engine-build",
        source: "environment",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("routes replay, orphan-buffered transients, and live pushes through the in-process seam", async () => {
    const fixture = await scriptedEngineDir()
    const stateRoot = await mkdtemp(path.join(tmpdir(), "w1-engine-state-"))
    const client = new EngineClient(stateRoot)
    try {
      await client.connect({ location: fixture.location, clientVersion: "1.0.0" })
      const received: number[] = []
      const transient: string[] = []
      await client.subscribeThread({ threadId: "thread-1", afterSequence: 0 }, (message) => {
        if (message.type === "event") received.push(message.event.sequence)
        else if (message.type === "transient") transient.push(message.event.tag)
      })
      await Bun.sleep(10)
      expect(received).toEqual([1, 2])
      expect(transient).toEqual(["EVT"])
    } finally {
      client.close()
      await rm(fixture.dir, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("installs an exact workspace snapshot before live catalog changes", async () => {
    const fixture = await scriptedEngineDir()
    const stateRoot = await mkdtemp(path.join(tmpdir(), "w1-engine-state-"))
    const client = new EngineClient(stateRoot)
    try {
      await client.connect({ location: fixture.location, clientVersion: "1.0.0" })
      const snapshots: string[][] = []
      const live: string[] = []
      await client.subscribeWorkspace(
        { workspacePath: "/workspace" },
        (message) => live.push(message.thread.threadId),
        (snapshot) => snapshots.push(snapshot.threads.map((item) => item.threadId)),
      )
      await Bun.sleep(10)
      expect(snapshots).toEqual([["snapshot"]])
      expect(live).toEqual(["live"])
    } finally {
      client.close()
      await rm(fixture.dir, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("one host per state root: the second claimant gets one honest line, and the lock dies with its owner", async () => {
    const fixture = await scriptedEngineDir()
    const stateRoot = await mkdtemp(path.join(tmpdir(), "w1-engine-lock-"))
    const first = new EngineClient(stateRoot)
    const second = new EngineClient(stateRoot)
    try {
      await first.connect({ location: fixture.location, clientVersion: "1.0.0" })
      await expect(second.connect({ location: fixture.location, clientVersion: "1.0.0" })).rejects.toThrow(
        "Another W1 is already running",
      )
      first.close()
      await second.connect({ location: fixture.location, clientVersion: "1.0.0" })
      expect(second.connected).toBe(true)
    } finally {
      first.close()
      second.close()
      await rm(fixture.dir, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("a missing engine library is one actionable line, not a spawn ladder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "w1-engine-missing-"))
    const stateRoot = await mkdtemp(path.join(tmpdir(), "w1-engine-state-"))
    const client = new EngineClient(stateRoot)
    try {
      await expect(
        client.connect({
          location: { enginePath: path.join(dir, "w1-engine.mjs"), workerPath: path.join(dir, "run-stream.mjs"), buildId: "x", source: "environment" },
          clientVersion: "1.0.0",
        }),
      ).rejects.toThrow("missing its engine library")
    } finally {
      client.close()
      await rm(dir, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
