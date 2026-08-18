import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { W1Auth } from "./auth"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryHome() {
  const root = await mkdtemp(path.join(os.tmpdir(), "w1-cli-auth."))
  roots.push(root)
  return root
}

describe("W1 shared browser auth", () => {
  test("rejects non-W1 production backends", () => {
    expect(() => W1Auth.resolveBackendUrl("https://example.com")).toThrow("secure w1lab.com")
    expect(W1Auth.resolveBackendUrl("https://api.w1lab.com/path")).toBe("https://api.w1lab.com")
  })

  test("reads only sessions with a non-empty token", async () => {
    const home = await temporaryHome()
    const target = W1Auth.sessionPath(home)
    await Bun.write(target, JSON.stringify({ email: "missing@example.com" }))
    expect(await W1Auth.readSession({ home })).toBeUndefined()
    await writeFile(target, JSON.stringify({ token: "  w1s_test  ", email: "kai@example.com", telemetryId: "invalid" }))
    expect(await W1Auth.readSession({ home })).toMatchObject({
      token: "w1s_test",
      email: "kai@example.com",
      telemetryId: null,
    })
  })

  test("opens WorkOS sign-in, rejects a forged callback, and writes the desktop-compatible session", async () => {
    const home = await temporaryHome()
    const session = await W1Auth.signIn({
      home,
      backendUrl: "https://app.w1lab.com",
      timeoutMs: 2_000,
      nonce: "test-flow",
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      async openBrowser(landingUrl) {
        // The browser is now pointed at the LOOPBACK first, so the first paint is instant and the
        // auth hosts get preconnected. Opening the hosted URL directly left the tab blank for
        // seconds on a cold connection and looked hung.
        const landing = new URL(landingUrl)
        expect(landing.hostname).toBe("127.0.0.1")
        expect(landing.pathname).toBe("/go")

        const page = await fetch(landing)
        expect(page.status).toBe(200)
        const html = await page.text()
        expect(html).toContain("Signing you in to W1")
        expect(html).toContain('rel=preconnect href="https://api.workos.com"')

        // A landing request without the flow nonce must not reveal or drive the sign-in.
        const forgedLanding = new URL(landing)
        forgedLanding.searchParams.set("flow", "wrong")
        expect((await fetch(forgedLanding)).status).toBe(400)

        // The page redirects to the real hosted sign-in; follow it the way the browser would.
        const target = html.match(/location\.replace\("([^"]+)"\)/)?.[1] ?? ""
        const start = new URL(target)
        expect(start.origin).toBe("https://app.w1lab.com")
        expect(start.pathname).toBe("/auth/start")
        const callback = new URL(start.searchParams.get("cb") ?? "")
        const forged = new URL(callback)
        forged.searchParams.set("flow", "wrong")
        forged.searchParams.set("token", "forged")
        expect((await fetch(forged)).status).toBe(400)
        callback.searchParams.set("token", "w1s_real")
        callback.searchParams.set("email", "kai@example.com")
        callback.searchParams.set("telemetry_id", "w1:0123456789abcdef01234567")
        expect((await fetch(callback)).status).toBe(200)
      },
    })
    expect(session).toEqual({
      token: "w1s_real",
      email: "kai@example.com",
      telemetryId: "w1:0123456789abcdef01234567",
      savedAt: "2026-08-09T00:00:00.000Z",
    })
    expect(JSON.parse(await readFile(W1Auth.sessionPath(home), "utf8"))).toEqual(session)
    if (process.platform !== "win32") {
      expect((await stat(W1Auth.sessionPath(home))).mode & 0o777).toBe(0o600)
    }
  })

  test("replaces malformed pre-existing storage with a fresh session", async () => {
    const home = await temporaryHome()
    const target = W1Auth.sessionPath(home)
    await Bun.write(target, "broken")
    await chmod(target, 0o400).catch(() => {})
    await W1Auth.writeSession(
      { token: "w1s_new", email: null, telemetryId: null, savedAt: "2026-08-09T00:00:00.000Z" },
      { home },
    )
    expect((await W1Auth.readSession({ home }))?.token).toBe("w1s_new")
  })

  test("revokes best-effort and always removes the shared session", async () => {
    const home = await temporaryHome()
    await W1Auth.writeSession(
      { token: "w1s_secret", email: null, telemetryId: null, savedAt: "2026-08-09T00:00:00.000Z" },
      { home },
    )
    const requests: Array<{ url: string; authorization: string | null }> = []
    expect(
      await W1Auth.signOut({
        home,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
          })
          throw new Error("offline")
        }) as unknown as typeof fetch,
      }),
    ).toBe(true)
    expect(requests).toEqual([{ url: "https://app.w1lab.com/auth/revoke", authorization: "Bearer w1s_secret" }])
    expect(await W1Auth.readSession({ home })).toBeUndefined()
  })
})
