import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { ExternalLink } from "../external-link"
import { InlineServerSelect } from "./parts/server-select"
import "./settings-v2.css"

type ExtensionSubTab = "mcps" | "plugins" | "skills"

interface McpRowItem {
  name: string
  status?: string
}

interface PluginRowItem {
  name: string
}

interface SkillRowItem {
  name: string
}

export const SettingsExtensionsV2: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const serverSync = useServerSync()
  const [selectedServer, setSelectedServer] = createSignal<ServerConnection.Key | "all">(server.key)
  const [activeSubTab, setActiveSubTab] = createSignal<ExtensionSubTab>("mcps")

  const [mcpOverrides, setMcpOverrides] = createSignal<Record<string, boolean>>({})
  const mcps = createMemo<McpRowItem[]>(() => {
    const configMcp = (serverSync().data.config as { mcp?: Record<string, { disabled?: boolean }> })?.mcp ?? {}
    const configEntries = Object.entries(configMcp).map(([name, conf]) => ({
      name,
      status: conf.disabled ? "disabled" : "connected",
    }))

    const firstProject = server.projects.list()[0]?.worktree
    const childMcp = firstProject ? serverSync().child(firstProject, { mcp: true })[0].mcp : {}
    const childEntries = Object.entries(childMcp ?? {}).map(([name, stat]) => ({
      name,
      status: stat?.status,
    }))

    const map = new Map<string, McpRowItem>()
    for (const item of configEntries) map.set(item.name, item)
    for (const item of childEntries) {
      const existing = map.get(item.name)
      map.set(item.name, { ...existing, ...item })
    }

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  })

  const isMcpEnabled = (item: McpRowItem) => {
    if (mcpOverrides()[item.name] !== undefined) return mcpOverrides()[item.name]
    return item.status === "connected"
  }

  const handleMcpToggle = (item: McpRowItem, checked: boolean) => {
    setMcpOverrides((prev) => ({ ...prev, [item.name]: checked }))
    const firstProject = server.projects.list()[0]?.worktree
    if (firstProject) {
      void serverSync().mcp.toggle(firstProject, item.name)
    }
  }

  const plugins = createMemo<PluginRowItem[]>(() => {
    const raw = serverSync().data.config.plugin ?? []
    return raw.map((item) => {
      const name = typeof item === "string" ? item : item[0]
      return { name }
    })
  })

  const skills = createMemo<SkillRowItem[]>(() => {
    const configSkills = (serverSync().data.config as { skills?: string[] })?.skills ?? []
    return configSkills.map((name) => ({ name }))
  })

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-v2-tab-title">{language.t("settings.tab.extensions")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.mcps.description")}</span>
          </div>
          <InlineServerSelect value={selectedServer()} onChange={setSelectedServer} includeAll />
        </div>
      </div>

      <div class="settings-v2-tab-body">
        {/* Sub-Tabs Pill Strip */}
        <div class="settings-v2-extensions-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeSubTab() === "mcps"}
            data-selected={activeSubTab() === "mcps" ? "" : undefined}
            onClick={() => setActiveSubTab("mcps")}
          >
            {language.t("settings.tab.mcps")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSubTab() === "plugins"}
            data-selected={activeSubTab() === "plugins" ? "" : undefined}
            onClick={() => setActiveSubTab("plugins")}
          >
            {language.t("settings.tab.plugins")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSubTab() === "skills"}
            data-selected={activeSubTab() === "skills" ? "" : undefined}
            onClick={() => setActiveSubTab("skills")}
          >
            {language.t("settings.tab.skills")}
          </button>
        </div>

        {/* MCPs Sub-Tab */}
        <Show when={activeSubTab() === "mcps"}>
          <div class="settings-v2-section">
            <div class="flex items-center justify-between">
              <span class="text-13-medium text-v2-text-text-base">
                {language.t("settings.extensions.availableAll")}
              </span>
              <span class="text-13-regular text-v2-text-faint">{language.t("settings.extensions.manageConfig")}</span>
            </div>
            <div class="bg-[var(--v2-background-bg-base)] border-[0.5px] border-[var(--v2-border-border-base)] rounded-[8px] pl-4 pr-3 overflow-hidden">
              <For each={mcps()}>
                {(item) => (
                  <div class="py-4 flex items-center justify-between border-b-[0.5px] border-[var(--v2-border-border-base)] last:border-b-0">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <Icon name="mcp" class="text-v2-icon-icon-muted shrink-0" />
                      <span class="text-13-medium text-v2-text-text-base truncate">{item.name}</span>
                    </div>
                    <Switch
                      checked={isMcpEnabled(item)}
                      onChange={(checked) => handleMcpToggle(item, checked)}
                      hideLabel
                    >
                      {item.name}
                    </Switch>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Plugins Sub-Tab */}
        <Show when={activeSubTab() === "plugins"}>
          <div class="settings-v2-section">
            <div class="flex items-center justify-between">
              <span class="text-13-medium text-v2-text-text-base">
                {language.t("settings.extensions.availableAll")}
              </span>
              <span class="text-13-regular text-v2-text-faint">{language.t("settings.extensions.manageConfig")}</span>
            </div>
            <div class="bg-[var(--v2-background-bg-base)] border-[0.5px] border-[var(--v2-border-border-base)] rounded-[8px] pl-4 pr-3 overflow-hidden">
              <For each={plugins()}>
                {(plugin) => (
                  <div class="py-4 flex items-center justify-between border-b-[0.5px] border-[var(--v2-border-border-base)] last:border-b-0">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <Icon name="cube" class="text-v2-icon-icon-muted shrink-0" />
                      <span class="text-13-medium text-v2-text-text-base truncate font-mono">{plugin.name}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Skills Sub-Tab */}
        <Show when={activeSubTab() === "skills"}>
          <div class="settings-v2-section">
            <div class="flex items-center justify-between">
              <span class="text-13-medium text-v2-text-text-base">
                {language.t("settings.extensions.availableAll")}
              </span>
              <ExternalLink
                class="text-13-regular text-v2-text-accent hover:underline"
                href="https://opencode.ai/docs/skills/"
              >
                {language.t("settings.extensions.addSkills")}
              </ExternalLink>
            </div>
            <div class="bg-[var(--v2-background-bg-base)] border-[0.5px] border-[var(--v2-border-border-base)] rounded-[8px] pl-4 pr-3 overflow-hidden">
              <For each={skills()}>
                {(skill) => (
                  <div class="py-4 flex items-center justify-between border-b-[0.5px] border-[var(--v2-border-border-base)] last:border-b-0">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <Icon name="post-skill" class="text-v2-icon-icon-muted shrink-0" />
                      <span class="text-13-medium text-v2-text-text-base truncate">{skill.name}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </>
  )
}
