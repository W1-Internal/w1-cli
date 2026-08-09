import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EngineClient, W1_ENGINE_MAX_FRAME_BYTES, assertEngineFrameBytes, engineClientVersion, resolveEngine, selectedMessagesAfterSnapshot, type EngineEvent, type ThreadPush, type ThreadSummary } from "./engine"

const originalEngine = process.env.W1_ENGINE_PATH
const originalRuntime = process.env.W1_RUNTIME_PATH
const originalState = process.env.W1_ENGINE_STATE_DIR
const originalFixtureExit = process.env.W1_FIXTURE_EXIT_ON_CLOSE

afterEach(() => {
  if (originalEngine === undefined) delete process.env.W1_ENGINE_PATH
  else process.env.W1_ENGINE_PATH = originalEngine
  if (originalRuntime === undefined) delete process.env.W1_RUNTIME_PATH
  else process.env.W1_RUNTIME_PATH = originalRuntime
  if (originalState === undefined) delete process.env.W1_ENGINE_STATE_DIR
  else process.env.W1_ENGINE_STATE_DIR = originalState
  if (originalFixtureExit === undefined) delete process.env.W1_FIXTURE_EXIT_ON_CLOSE
  else process.env.W1_FIXTURE_EXIT_ON_CLOSE = originalFixtureExit
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
        clientPath: path.join(root, "w1-engine-client.mjs"),
        workerPath: worker,
        buildId: "engine-build",
        packageVersion: "0.0.0",
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
        location: { enginePath: "unused", clientPath: "unused", workerPath: "unused", buildId: "build-1", packageVersion: "1.0.0", source: "environment" },
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
        location: { enginePath: "unused", clientPath: "unused", workerPath: "unused", buildId: "build-1", packageVersion: "1.0.0", source: "environment" },
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

  test("refuses an automatic engine upgrade while the older daemon is active", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "w1-engine-active-upgrade-"))
    const socketPath = path.join(root, "engine.sock")
    const server = createServer((socket) => respondAsEngine(socket, {
      buildId: "old-build",
      packageVersion: "1.0.0",
      activeThreads: 2,
    }))
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const client = new EngineClient(socketPath)
    try {
      await expect(client.connect({
        location: { enginePath: "unused", clientPath: "unused", workerPath: "unused", buildId: "new-build", packageVersion: "2.0.0", source: "environment" },
        clientVersion: "2.0.0",
      })).rejects.toThrow("upgrade to 2.0.0 was refused until it is idle")
    } finally {
      client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  test("accepts a newer compatible daemon instead of downgrading it", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "w1-engine-newer-"))
    const socketPath = path.join(root, "engine.sock")
    const server = createServer((socket) => respondAsEngine(socket, {
      buildId: "newer-build",
      packageVersion: "3.0.0",
      activeThreads: 0,
    }))
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const client = new EngineClient(socketPath)
    try {
      await client.connect({
        location: { enginePath: "unused", clientPath: "unused", workerPath: "unused", buildId: "older-build", packageVersion: "2.0.0", source: "environment" },
        clientVersion: "2.0.0",
      })
      expect(client.connected).toBe(true)
    } finally {
      client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a different build claiming the same package version", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "w1-engine-integrity-"))
    const socketPath = path.join(root, "engine.sock")
    const server = createServer((socket) => respondAsEngine(socket, {
      buildId: "unexpected-build",
      packageVersion: "2.0.0",
      activeThreads: 0,
    }))
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const client = new EngineClient(socketPath)
    try {
      await expect(client.connect({
        location: { enginePath: "unused", clientPath: "unused", workerPath: "unused", buildId: "expected-build", packageVersion: "2.0.0", source: "environment" },
        clientVersion: "2.0.0",
      })).rejects.toThrow("W1 Engine integrity mismatch")
    } finally {
      client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  test("replaces an idle older daemon with the packaged engine", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "w1-engine-idle-upgrade-"))
    const endpoint = path.join(root, "ipc", "w1-v1.sock")
    await mkdir(path.dirname(endpoint), { recursive: true })
    const enginePath = path.join(root, "fixture-engine.mjs")
    const workerPath = path.join(root, "run-stream.mjs")
    await copyFile(path.join(import.meta.dir, "fixture-engine.mjs"), enginePath)
    await writeFile(workerPath, "export {}\n")
    await writeFile(path.join(root, "BUILD_ID"), "new-build\n")
    process.env.W1_ENGINE_STATE_DIR = root
    process.env.W1_FIXTURE_EXIT_ON_CLOSE = "1"
    let stopped = false
    const server = createServer((socket) => respondAsEngine(socket, {
      buildId: "old-build",
      packageVersion: "1.0.0",
      activeThreads: 0,
      onStop() {
        stopped = true
        setImmediate(() => server.close())
      },
    }))
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    const client = new EngineClient(endpoint)
    try {
      await client.connect({
        location: { enginePath, clientPath: "unused", workerPath, buildId: "new-build", packageVersion: "2.0.0", source: "environment" },
        clientVersion: "2.0.0",
        timeoutMs: 5_000,
      })
      expect(stopped).toBe(true)
      expect(client.connected).toBe(true)
    } finally {
      client.close()
      await Bun.sleep(50)
      await rm(root, { recursive: true, force: true })
    }
  })
})

function respondAsEngine(socket: import("node:net").Socket, input: {
  buildId: string
  packageVersion: string
  activeThreads: number
  onStop?: () => void
}) {
  socket.setEncoding("utf8")
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const boundary = buffer.indexOf("\n")
      if (boundary < 0) break
      const request = JSON.parse(buffer.slice(0, boundary)) as { id: string; method: string }
      buffer = buffer.slice(boundary + 1)
      const result = request.method === "protocol.handshake"
        ? { protocolVersion: 1, buildId: input.buildId, minimumClientVersion: "0.0.0" }
        : request.method === "engine.status"
          ? {
              pid: process.pid,
              protocolVersion: 1,
              buildId: input.buildId,
              packageVersion: input.packageVersion,
              activeThreads: input.activeThreads,
              idle: input.activeThreads === 0,
              stopWhenIdle: false,
            }
          : { accepted: true, stopping: true, whenIdle: false, activeThreads: input.activeThreads }
      socket.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n", () => {
        if (request.method === "engine.stop") input.onStop?.()
      })
    }
  })
}
