import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useLayout, getProjectAvatarVariant } from "@/context/layout"
import { InlineServerSelect } from "./parts/server-select"
import { DialogEditProjectV2 } from "../dialog-edit-project-v2"
import "./settings-v2.css"

export const SettingsProjectsV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const layout = useLayout()
  const [selectedServer, setSelectedServer] = createSignal<ServerConnection.Key | "all">(server.key)

  const projects = createMemo(() => {
    return layout.projects.list()
  })

  const openProjectSettings = (project: ReturnType<typeof layout.projects.list>[number]) => {
    const currentServer = server.current ?? global.servers.list()[0]
    if (!currentServer) return
    dialog.push(() => <DialogEditProjectV2 project={project} server={currentServer} />)
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-v2-tab-title">{language.t("settings.projects.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.projects.description")}</span>
          </div>
          <InlineServerSelect
            value={selectedServer()}
            onChange={setSelectedServer}
            includeAll
          />
        </div>
      </div>

      <div class="settings-v2-tab-body">
        <div class="flex flex-col gap-2 w-full">
          <Show
            when={projects().length > 0}
            fallback={
              <div class="py-12 text-center text-v2-text-text-muted text-13-regular">
                {language.t("settings.projects.empty")}
              </div>
            }
          >
            <For each={projects()}>
              {(project) => {
                const name = () => project.name || project.worktree.split(/[/\\]/).pop() || project.worktree
                const color = () => getProjectAvatarVariant(project.icon?.color)

                return (
                  <div
                    class="group flex items-center justify-between gap-5 px-4 py-2.5 rounded-lg bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] cursor-pointer transition-all hover:bg-v2-background-bg-layer-01"
                    onClick={() => openProjectSettings(project)}
                  >
                    <div class="flex items-center gap-2.5 min-w-0 flex-1">
                      <ProjectAvatar
                        fallback={name()}
                        variant={color()}
                        class="shrink-0"
                      />
                      <span class="text-13-medium text-v2-text-text-base truncate">{name()}</span>
                    </div>
                    <div class="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <IconButtonV2
                        type="button"
                        variant="ghost-muted"
                        size="small"
                        icon={<IconV2 name="settings-gear" size="small" class="text-v2-icon-icon-muted" />}
                        onClick={(e: MouseEvent) => {
                          e.stopPropagation()
                          openProjectSettings(project)
                        }}
                      />
                    </div>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </div>
    </>
  )
}
