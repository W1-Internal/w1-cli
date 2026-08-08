import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { Options } from "./types"

export async function prepareDesktopState(
  options: Options,
  databasePath: string,
  userData: string,
  run: number,
  projectIDs: string[],
) {
  const database = new Database(databasePath)
  const projects = database.query("SELECT id, worktree, sandboxes FROM project ORDER BY id").all() as {
    id: string
    worktree: string
    sandboxes: string
  }[]
  const selected = new Set(projectIDs)
  const profileProjects = projects.filter((project) => selected.has(project.id))
  const worktrees =
    options.mode === "partial-snapshot"
      ? await remapDirectories(database, profileProjects, path.join(options.output, "workspaces", String(run)))
      : profileProjects.map((project) => project.worktree)
  database.close()

  await Bun.write(
    path.join(userData, "opencode.settings"),
    JSON.stringify({ firstLaunchOnboardingComplete: true, oldLayoutEligible: true, tauriMigrated: true }),
  )
  await Bun.write(
    path.join(userData, "opencode.global.dat"),
    JSON.stringify({
      server: JSON.stringify({
        list: [],
        projects: { local: worktrees.map((worktree) => ({ worktree, expanded: true })) },
        lastProject: worktrees[0] ? { local: worktrees[0] } : {},
        recentlyClosed: {},
      }),
    }),
  )
}

async function remapDirectories(
  database: Database,
  projects: { id: string; worktree: string; sandboxes: string }[],
  root: string,
) {
  await mkdir(root, { recursive: true })
  const mappings = new Map<string, string>()
  const worktrees = await Promise.all(
    projects.map(async (project, index) => {
      const worktree = path.join(root, `project-${String(index + 1).padStart(3, "0")}`)
      await mkdir(worktree, { recursive: true })
      mappings.set(project.worktree, worktree)
      const sandboxes = JSON.parse(project.sandboxes) as string[]
      const nextSandboxes = await Promise.all(
        sandboxes.map(async (sandbox, sandboxIndex) => {
          const next = path.join(worktree, `sandbox-${sandboxIndex + 1}`)
          await mkdir(next, { recursive: true })
          mappings.set(sandbox, next)
          return next
        }),
      )
      database.run("UPDATE project SET worktree = ?, sandboxes = ? WHERE id = ?", worktree, JSON.stringify(nextSandboxes), project.id)
      return worktree
    }),
  )
  const byProject = new Map(projects.map((project, index) => [project.id, worktrees[index]!]))
  const sessions = database.query("SELECT id, project_id, directory FROM session").all() as {
    id: string
    project_id: string
    directory: string
  }[]
  const directories = database.query("SELECT * FROM project_directory").all() as {
    project_id: string
    directory: string
    type: string | null
    strategy: string | null
    time_created: number
  }[]
  const selected = new Set(projects.map((project) => project.id))
  const nextDirectories = await Promise.all(
    directories.filter((item) => selected.has(item.project_id)).map(async (item, index) => {
      const directory =
        mappings.get(item.directory) ?? path.join(byProject.get(item.project_id) ?? root, `directory-${index + 1}`)
      await mkdir(directory, { recursive: true })
      return { ...item, directory }
    }),
  )
  database.transaction(() => {
    sessions.filter((session) => selected.has(session.project_id)).forEach((session) =>
      database.run(
        "UPDATE session SET directory = ? WHERE id = ?",
        mappings.get(session.directory) ?? byProject.get(session.project_id) ?? worktrees[0]!,
        session.id,
      ),
    )
    database.run(
      `DELETE FROM project_directory WHERE project_id IN (${projects.map(() => "?").join(",")})`,
      ...projects.map((project) => project.id),
    )
    nextDirectories.forEach((item) =>
      database.run(
        `INSERT INTO project_directory (project_id, directory, type, strategy, time_created)
         VALUES (?, ?, ?, ?, ?)`,
        item.project_id,
        item.directory,
        item.type,
        item.strategy,
        item.time_created,
      ),
    )
  })()
  return worktrees
}
