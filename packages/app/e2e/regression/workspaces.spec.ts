import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { installSseTransport } from "../utils/sse-transport"

const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const root = "C:/OpenCode/WorkspaceProject"
const workspace = "C:/OpenCode/worktree/project/feature"
const createdWorkspace = "C:/OpenCode/worktree/project/quick-contrast-fix"
const project = {
  id: "proj_workspaces",
  worktree: root,
  vcs: "git" as const,
  name: "workspace-project",
  time: { created: 1, updated: 1 },
  sandboxes: [workspace],
}
const provider = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: { test: { id: "test", name: "Test model", limit: { context: 200_000 } } },
    },
  ],
  connected: ["opencode"],
  default: { providerID: "opencode", modelID: "test" },
}
const diff = {
  file: "src/workspace.ts",
  additions: 3,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-export const workspace = false\n+export const workspace = true",
}

function userMessage(sessionID: string, id: string, text: string, withDiff = false) {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "opencode", modelID: "test" },
      ...(withDiff ? { summary: { diffs: [diff] } } : {}),
    },
    parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text }],
  }
}

async function init(page: Page, tab: Record<string, unknown>) {
  await page.addInitScript(
    ({ root, server, tab }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: root, expanded: true }] }, lastProject: { local: root } }),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify([{ server, ...tab }]))
    },
    { root, server, tab },
  )
}

test("selects an existing workspace from the start menu", async ({ page }) => {
  const draftID = "draft_workspaces"
  await mockOpenCodeServer(page, {
    directory: root,
    project,
    provider,
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await init(page, { type: "draft", draftID, directory: root })

  await page.goto(`/new-session?draftId=${draftID}`)
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))

  await page.getByRole("button", { name: /^local$/i }).click()
  await page.getByRole("menuitem", { name: /Workspace/ }).hover()
  await page.getByRole("menuitem", { name: "feature" }).click()
  await expect(page.getByRole("button", { name: /feature/ })).toBeVisible()
})

test("lists and manually deletes workspaces from settings", async ({ page }) => {
  const draftID = "draft_workspace_settings"
  const cleanWorkspace = `${workspace}-clean`
  const inventory = { ...project, sandboxes: [cleanWorkspace] }

  const transport = await installSseTransport<{ directory: string; payload: Record<string, unknown> }>(page, { server })
  await mockOpenCodeServer(page, {
    directory: root,
    project: inventory,
    provider,
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  let releaseSessions = () => {}
  const sessionsReady = new Promise<void>((resolve) => {
    releaseSessions = resolve
  })
  await page.route("**/session?**", async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== "GET" || url.pathname !== "/session" || url.searchParams.get("limit") !== "1000")
      return route.fallback()
    await sessionsReady
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "[]",
    })
  })
  await page.route("**/experimental/worktree**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "DELETE" },
      })
      return
    }
    if (route.request().method() !== "DELETE") return route.fallback()
    await transport.send({
      directory: "global",
      payload: {
        id: "evt_workspace_deleted_settings",
        type: "project.updated",
        properties: { ...inventory, sandboxes: [] },
      },
    })
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "true",
    })
  })
  await init(page, { type: "draft", draftID, directory: root })

  await page.goto(`/new-session?draftId=${draftID}`)
  await transport.waitForConnection()
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))

  const app = page.locator('[data-component="session-new-design"]')
  const appNode = await app.elementHandle()
  await page.getByRole("button", { name: /local|new workspace/i }).click()
  const workspacesTrigger = page.getByRole("menuitem", { name: /Workspace/ })
  if (await workspacesTrigger.isVisible()) await workspacesTrigger.hover()
  await page.getByRole("menuitem", { name: "View all" }).click()

  const settings = page.locator(".settings-v2-dialog")
  await expect(settings.getByRole("tab", { name: "Workspaces" })).toHaveAttribute("data-selected")
  expect(await appNode?.evaluate((node) => node.isConnected)).toBe(true)
  releaseSessions()
  await expect(settings.getByText(cleanWorkspace, { exact: true })).toBeVisible()

  await settings.getByRole("button", { name: 'Delete workspace "feature-clean"?' }).click()
  const confirmation = page
    .locator('[data-component="dialog-v2"]')
    .filter({ hasText: 'Delete workspace "feature-clean"?' })
  const removed = page.waitForRequest(
    (request) => request.method() === "DELETE" && new URL(request.url()).pathname === "/experimental/worktree",
  )
  await confirmation.getByRole("button", { name: "Delete workspace" }).click()
  const request = await removed
  expect(new URL(request.url()).searchParams.get("directory")).toBe(root)
  expect(request.postDataJSON()).toEqual({ directory: cleanWorkspace })
  await expect(settings.getByText(cleanWorkspace, { exact: true })).toHaveCount(0)
})

test("submits the owning prompt after a new workspace becomes ready", async ({ page }) => {
  const draftID = "draft_workspace_submit"
  const sessionID = "ses_workspace_submit"
  const session = {
    id: sessionID,
    slug: "workspace-submit",
    projectID: project.id,
    directory: createdWorkspace,
    title: "New session",
    version: "dev",
    time: { created: 1, updated: 2 },
  }
  const transport = await installSseTransport<{ directory: string; payload: Record<string, unknown> }>(page, { server })
  await mockOpenCodeServer(page, {
    directory: root,
    project,
    provider,
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/experimental/worktree**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST" },
      })
      return
    }
    if (route.request().method() !== "POST") return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ name: "quick-contrast-fix", directory: createdWorkspace, branch: "quick-contrast-fix" }),
    })
  })
  await page.route("**/session**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== "/session") return route.fallback()
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST" },
      })
      return
    }
    if (route.request().method() !== "POST") return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(session),
    })
  })
  await page.route(`**/session/${sessionID}/prompt_async**`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST" },
      })
      return
    }
    await route.fulfill({
      status: 204,
      headers: { "access-control-allow-origin": "*" },
    })
  })
  await init(page, { type: "draft", draftID, directory: root })

  await page.goto(`/new-session?draftId=${draftID}`)
  await transport.waitForConnection()
  await page.getByRole("button", { name: /^local$/i }).click()
  await page.getByRole("menuitem", { name: "New workspace" }).click()
  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await editor.fill("Build workspace support")
  await page.locator('[data-action="prompt-submit"]').click()

  const lifecycle = page.locator('[data-timeline-row="WorkspaceLifecycle"]')
  await expect(lifecycle).toContainText("Creating workspace")
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === `/session/${sessionID}/prompt_async`,
  )
  await transport.send({
    directory: createdWorkspace,
    payload: {
      id: "evt_submit_ready",
      type: "worktree.ready",
      properties: { name: "quick-contrast-fix" },
    },
  })
  await sent
  await expect(lifecycle).toContainText("Workspace created")
})

test("moves a changed local session through workspace creation without changing lifecycle semantics", async ({
  page,
}) => {
  const sessionID = "ses_workspace_move_new"
  const messageID = "msg_workspace_move_new"
  const session = {
    id: sessionID,
    slug: "workspace-move-new",
    projectID: project.id,
    directory: root,
    title: "Create a workspace",
    version: "dev",
    time: { created: 1, updated: 2 },
  }
  const transport = await installSseTransport<{ directory: string; payload: Record<string, unknown> }>(page, { server })
  await mockOpenCodeServer(page, {
    directory: root,
    project,
    provider,
    sessions: [session],
    pageMessages: () => ({ items: [userMessage(sessionID, messageID, "Create isolated workspace", true)] }),
    vcsDiff: [diff],
  })
  await page.route("**/experimental/worktree**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST" },
      })
      return
    }
    if (route.request().method() !== "POST") return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ name: "quick-contrast-fix", directory: createdWorkspace, branch: "quick-contrast-fix" }),
    })
  })
  await page.route("**/experimental/control-plane/move-session", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST" },
      })
      return
    }
    session.directory = createdWorkspace
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "null",
    })
  })
  await init(page, { type: "session", sessionId: sessionID })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await transport.waitForConnection()
  await page.locator("[data-session-title]").getByRole("button", { name: "Session details" }).click()
  const panel = page.locator('[data-component="session-summary-panel"]')
  await panel.getByRole("button", { name: "Local repository" }).click()
  await expect(page.getByRole("menuitem", { name: "New workspace" })).toBeVisible()
  await page.getByRole("menuitem", { name: "New workspace" }).click()

  const lifecycle = page.locator('[data-timeline-row="WorkspaceLifecycle"]')
  await expect(lifecycle).toContainText("Creating workspace")
  const moved = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/experimental/control-plane/move-session",
  )
  await transport.send({
    directory: createdWorkspace,
    payload: {
      id: "evt_worktree_ready",
      type: "worktree.ready",
      properties: { name: "quick-contrast-fix" },
    },
  })
  expect((await moved).postDataJSON()).toEqual({
    sessionID,
    destination: { directory: createdWorkspace },
    moveChanges: true,
  })
  await transport.send({
    directory: createdWorkspace,
    payload: {
      id: "evt_workspace_created",
      type: "session.next.moved",
      properties: {
        timestamp: Date.now(),
        sessionID,
        location: { directory: createdWorkspace },
        subdirectory: "",
      },
    },
  })
  await expect(lifecycle).toContainText("Workspace created")
})
