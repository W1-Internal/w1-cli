import { Component, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import {
  createSoundSettingsController,
  soundOptions,
  type SoundSettingsController,
} from "./general-controllers"
import "./settings-v2.css"

const badgeOptions: ("count" | "dot" | "none")[] = ["count", "dot", "none"]
const focusOptions: ("auto" | "always" | "never")[] = ["auto", "always", "never"]

const soundSettings = {
  agent: {
    action: "settings-sounds-agent",
    title: "settings.general.sounds.agent.title",
    description: "settings.general.sounds.agent.description",
  },
  permissions: {
    action: "settings-sounds-permissions",
    title: "settings.general.sounds.permissions.title",
    description: "settings.general.sounds.permissions.description",
  },
  errors: {
    action: "settings-sounds-errors",
    title: "settings.general.sounds.errors.title",
    description: "settings.general.sounds.errors.description",
  },
} as const

const SoundSetting: Component<{
  kind: "agent" | "permissions" | "errors"
  channel: SoundSettingsController["agent"]
}> = (props) => {
  const language = useLanguage()
  const config = () => soundSettings[props.kind]
  return (
    <SettingsRowV2 title={language.t(config().title)} description={language.t(config().description)}>
      <SelectV2
        appearance="inline"
        data-action={config().action}
        options={soundOptions}
        current={props.channel.current()}
        value={(option) => option.id}
        label={(option) => language.t(option.label)}
        onHighlight={props.channel.highlight}
        onSelect={props.channel.select}
        placement="bottom-end"
        gutter={6}
      />
    </SettingsRowV2>
  )
}

export const SettingsNotificationsV2: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const sounds = createSoundSettingsController()
  const [unreadBadge, setUnreadBadge] = createSignal<"count" | "dot" | "none">("count")
  const [focusMode, setFocusMode] = createSignal<"auto" | "always" | "never">("auto")

  const restoreDefaults = () => {
    settings.notifications.setAgent(true)
    settings.notifications.setPermissions(true)
    settings.notifications.setErrors(true)
    settings.sounds.setAgent("bip-bop-01")
    settings.sounds.setPermissions("alert-01")
    settings.sounds.setErrors("nope-01")
    setUnreadBadge("count")
    setFocusMode("auto")
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.tab.notifications")}</h2>
          <ButtonV2 size="small" variant="ghost-muted" onClick={restoreDefaults}>
            {language.t("settings.action.restoreDefaults")}
          </ButtonV2>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.general.section.notifications")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.general.notifications.agent.title")}
              description={language.t("settings.general.notifications.agent.description")}
            >
              <div data-action="settings-notifications-agent">
                <Switch
                  checked={settings.notifications.agent()}
                  onChange={(checked) => settings.notifications.setAgent(checked)}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.general.notifications.permissions.title")}
              description={language.t("settings.general.notifications.permissions.description")}
            >
              <div data-action="settings-notifications-permissions">
                <Switch
                  checked={settings.notifications.permissions()}
                  onChange={(checked) => settings.notifications.setPermissions(checked)}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.general.notifications.errors.title")}
              description={language.t("settings.general.notifications.errors.description")}
            >
              <div data-action="settings-notifications-errors">
                <Switch
                  checked={settings.notifications.errors()}
                  onChange={(checked) => settings.notifications.setErrors(checked)}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.general.section.sounds")}</h3>
          <SettingsListV2>
            <SoundSetting kind="agent" channel={sounds.agent} />
            <SoundSetting kind="permissions" channel={sounds.permissions} />
            <SoundSetting kind="errors" channel={sounds.errors} />

            <SettingsRowV2
              title={language.t("settings.notifications.unreadBadge.title")}
              description={language.t("settings.notifications.unreadBadge.description")}
            >
              <SelectV2
                appearance="inline"
                data-action="settings-unread-badge"
                options={badgeOptions}
                current={unreadBadge()}
                placement="bottom-end"
                gutter={6}
                label={(option) => {
                  if (option === "dot") return language.t("settings.notifications.unreadBadge.dot")
                  if (option === "none") return language.t("settings.notifications.unreadBadge.none")
                  return language.t("settings.notifications.unreadBadge.count")
                }}
                onSelect={(option) => option && setUnreadBadge(option)}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.notifications.focusMode.title")}
              description={language.t("settings.notifications.focusMode.description")}
            >
              <SelectV2
                appearance="inline"
                data-action="settings-focus-mode"
                options={focusOptions}
                current={focusMode()}
                placement="bottom-end"
                gutter={6}
                label={(option) => {
                  if (option === "always") return language.t("settings.notifications.focusMode.always")
                  if (option === "never") return language.t("settings.notifications.focusMode.never")
                  return language.t("settings.notifications.focusMode.auto")
                }}
                onSelect={(option) => option && setFocusMode(option)}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
