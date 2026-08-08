import { Database } from "bun:sqlite"
import { afterAll, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { createPartialSnapshot, fingerprint } from "./corpus"
import { parseOptions } from "./options"

const directory = path.join(import.meta.dir, `.tmp-${process.pid}`)
const source = path.join(directory, "source.db")
const partialSnapshot = path.join(directory, "partial-snapshot.db")
await mkdir(directory, { recursive: true })
const database = new Database(source, { create: true })
database.run("CREATE TABLE sample (value TEXT NOT NULL)")
database.run("INSERT INTO sample VALUES ('repeatable')")
database.close()

afterAll(() => rm(directory, { recursive: true, force: true }))

test("parses a portable fixed-window partial snapshot invocation", () => {
  const options = parseOptions([
    "--mode",
    "partial-snapshot",
    "--db",
    source,
    "--window-end",
    "2026-08-04T06:14:26.878Z",
    "--window-hours",
    "24",
    "--scenarios",
    "home,calibration",
    "--runs",
    "3",
    "--skip-build",
  ])!

  expect(options.database).toBe(source)
  expect(options.windowEnd).toBe(1_785_824_066_878)
  expect(options.windowStart).toBe(1_785_737_666_878)
  expect(options.scenarios).toEqual(["home", "calibration"])
  expect(options.runs).toBe(3)
  expect(options.build).toBe(false)
})

test("creates a consistent private partial database snapshot", async () => {
  const options = parseOptions(["--db", source, "--window-end", "2026-08-04T06:14:26.878Z"])!
  await createPartialSnapshot(source, partialSnapshot, options, [])
  const copy = new Database(partialSnapshot, { readonly: true })
  expect(copy.query("SELECT value FROM sample").get()).toEqual({ value: "repeatable" })
  copy.close()
  expect(await fingerprint(partialSnapshot)).toEqual({
    bytes: expect.any(Number),
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
})
