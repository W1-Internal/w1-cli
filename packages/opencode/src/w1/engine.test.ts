import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EngineClient, W1_ENGINE_MAX_FRAME_BYTES, assertEngineFrameBytes, engineClientVersion, resolveEngine, selectedMessagesAfterSnapshot, type EngineEvent, type ThreadPush, type ThreadSummary } from "./engine"

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

  test("buffers replay-to-live pushes and deduplicates durable sequence numbers", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "w1-engine-client-"))
    const socketPath = path.join(root, "engine.sock")
    const event = (sequence: number): EngineEvent => ({
      schemaVersion: 1,
      eventId: `event-${sequence}`,
      threadId: "thread-1",
      turnId: "turn-1",
      sequence,
      kind: "turn.submitted",
      phase: "accepted",
      at: "2026-08-09T00:00:00.000Z",
      data: { text: "hello" },
    })
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk
        for (;;) {
          const boundary = buffer.indexOf("\n")
          if (boundary < 0) break
          const request = JSON.parse(buffer.slice(0, boundary)) as { id: string; method: string }
          buffer = buffer.slice(boundary + 1)
          if (request.method === "protocol.handshake") {
            socket.write(JSON.stringify({ id: request.id, ok: true, result: { protocolVersion: 1, buildId: "build-1" } }) + "\n")
          }
          if (request.method === "events.subscribe") {
            socket.write(JSON.stringify({ type: "transient", subscriptionId: "sub-1", threadId: "thread-1", event: { tag: "EVT", data: { t: "think_delta" } } }) + "\n")
            socket.write(JSON.stringify({ id: request.id, ok: true, result: { subscriptionId: "sub-1", replay: [event(1)], cursor: 1, active: true } }) + "\n")
            socket.write(JSON.stringify({ type: "event", subscriptionId: "sub-1", threadId: "thread-1", cursor: 1, event: event(1) }) + "\n")
            socket.write(JSON.stringify({ type: "event", subscriptionId: "sub-1", threadId: "thread-1", cursor: 2, event: event(2) }) + "\n")
          }
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const client = new EngineClient(socketPath)
    try {
      await client.connect({
        location: { enginePath: "unused", workerPath: "unused", buildId: "build-1", source: "environment" },
        clientVersion: "1.0.0",
      })
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
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  test("installs an exact workspace snapshot before live catalog changes", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "w1-engine-catalog-"))
    const socketPath = path.join(root, "engine.sock")
    const thread = (threadId: string, updatedAt: string): ThreadSummary => ({
      threadId,
      workspaceId: "workspace-1",
      workspacePath: root,
      title: threadId,
      state: "idle",
      createdAt: updatedAt,
      updatedAt,
      lastSequence: 1,
    })
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk
        for (;;) {
          const boundary = buffer.indexOf("\n")
          if (boundary < 0) break
          const request = JSON.parse(buffer.slice(0, boundary)) as { id: string; method: string }
          buffer = buffer.slice(boundary + 1)
          if (request.method === "protocol.handshake") {
            socket.write(JSON.stringify({ id: request.id, ok: true, result: { protocolVersion: 1, buildId: "build-1" } }) + "\n")
          }
          if (request.method === "catalog.subscribe") {
            socket.write(JSON.stringify({ type: "catalog", subscriptionId: "catalog-1", workspacePath: root, cursor: 1, thread: thread("snapshot-duplicate", "2026-08-09T00:00:01.000Z") }) + "\n")
            socket.write(JSON.stringify({ id: request.id, ok: true, result: { subscriptionId: "catalog-1", snapshot: { cursor: 1, threads: [thread("snapshot", "2026-08-09T00:00:00.000Z")] } } }) + "\n")
            socket.write(JSON.stringify({ type: "catalog", subscriptionId: "catalog-1", workspacePath: root, cursor: 2, thread: thread("live", "2026-08-09T00:00:02.000Z") }) + "\n")
          }
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const client = new EngineClient(socketPath)
    try {
      await client.connect({
        location: { enginePath: "unused", workerPath: "unused", buildId: "build-1", source: "environment" },
        clientVersion: "1.0.0",
      })
      const snapshots: string[][] = []
      const live: string[] = []
      await client.subscribeWorkspace(
        { workspacePath: root },
        (message) => live.push(message.thread.threadId),
        (snapshot) => snapshots.push(snapshot.threads.map((item) => item.threadId)),
      )
      await Bun.sleep(10)
      expect(snapshots).toEqual([["snapshot"]])
      expect(live).toEqual(["live"])
    } finally {
      client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
})
