import { Component, Show, createMemo, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ExternalLink } from "../external-link"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import {
  createAppearanceSettingsController,
  type AppearanceSettingsController,
} from "./general-controllers"
import "./settings-v2.css"

const schemeOptions: ("system" | "light" | "dark")[] = ["system", "light", "dark"]
const densityOptions: ("compact" | "default" | "comfortable")[] = ["compact", "default", "comfortable"]

const fontSettings = {
  ui: {
    action: "settings-ui-font",
    title: "settings.general.row.uiFont.title",
    description: "settings.general.row.uiFont.description",
    font: "ui",
    input: "setUI",
  },
  code: {
    action: "settings-code-font",
    title: "settings.general.row.font.title",
    description: "settings.general.row.font.description",
    font: "code",
    input: "setCode",
  },
  terminal: {
    action: "settings-terminal-font",
    title: "settings.general.row.terminalFont.title",
    description: "settings.general.row.terminalFont.description",
    font: "terminal",
    input: "setTerminal",
  },
} as const

const FontSetting: Component<{
  kind: "ui" | "code" | "terminal"
  fonts: AppearanceSettingsController["fonts"]
}> = (props) => {
  const language = useLanguage()
  const config = () => fontSettings[props.kind]
  return (
    <SettingsRowV2 title={language.t(config().title)} description={language.t(config().description)}>
      <div class="w-full sm:w-[220px]">
        <TextInputV2
          data-action={config().action}
          type="text"
          appearance="base"
          value={props.fonts[config().font]().value}
          onInput={(event) => props.fonts[config().input](event.currentTarget.value)}
          placeholder={props.fonts[config().font]().placeholder}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={language.t(config().title)}
          style={{ "font-family": props.fonts[config().font]().family }}
        />
      </div>
    </SettingsRowV2>
  )
}

export const SettingsAppearanceV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const appearance = createAppearanceSettingsController()
  const desktop = createMemo(() => platform.platform === "desktop")
  const [density, setDensity] = createSignal<"compact" | "default" | "comfortable">("default")

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => desktop() && "getPinchZoomEnabled" in platform,
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch(() => setPinchZoom(!checked))
  }

  const restoreDefaults = () => {
    appearance.scheme.select("system")
    appearance.fonts.setUI("")
    appearance.fonts.setCode("")
    appearance.fonts.setTerminal("")
    setDensity("default")
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.tab.appearance")}</h2>
          <ButtonV2 size="small" variant="ghost-muted" onClick={restoreDefaults}>
            {language.t("settings.action.restoreDefaults")}
          </ButtonV2>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.general.row.colorScheme.title")}
              description={language.t("settings.general.row.colorScheme.description")}
            >
              <SelectV2
                appearance="inline"
                data-action="settings-color-scheme"
                options={schemeOptions}
                current={schemeOptions.find((option) => option === appearance.scheme.current())}
                placement="bottom-end"
                gutter={6}
                label={(option) => {
                  if (option === "system") return language.t("theme.scheme.system")
                  if (option === "light") return language.t("theme.scheme.light")
                  return language.t("theme.scheme.dark")
                }}
                onSelect={(option) => option && appearance.scheme.select(option)}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.general.row.theme.title")}
              description={
                <>
                  {language.t("settings.general.row.theme.description")}{" "}
                  <ExternalLink class="settings-v2-link" href="https://opencode.ai/docs/themes/">
                    {language.t("common.learnMore")}
                  </ExternalLink>
                </>
              }
            >
              <SelectV2
                appearance="inline"
                data-action="settings-theme"
                options={appearance.theme.options()}
                current={appearance.theme.current()}
                placement="bottom-end"
                gutter={6}
                value={(option) => option.id}
                label={(option) => option.name}
                onSelect={appearance.theme.select}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.appearance.density.title")}
              description={language.t("settings.appearance.density.description")}
            >
              <SelectV2
                appearance="inline"
                data-action="settings-density"
                options={densityOptions}
                current={density()}
                placement="bottom-end"
                gutter={6}
                label={(option) => {
                  if (option === "compact") return language.t("settings.appearance.density.compact")
                  if (option === "comfortable") return language.t("settings.appearance.density.comfortable")
                  return language.t("settings.appearance.density.default")
                }}
                onSelect={(option) => option && setDensity(option)}
              />
            </SettingsRowV2>

            <FontSetting kind="ui" fonts={appearance.fonts} />
            <FontSetting kind="code" fonts={appearance.fonts} />
            <FontSetting kind="terminal" fonts={appearance.fonts} />
          </SettingsListV2>
        </div>

        <Show when={desktop()}>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("settings.general.section.display")}</h3>
            <SettingsListV2>
              <SettingsRowV2
                title={language.t("settings.general.row.pinchZoom.title")}
                description={language.t("settings.general.row.pinchZoom.description")}
              >
                <div data-action="settings-pinch-zoom">
                  <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
                </div>
              </SettingsRowV2>
            </SettingsListV2>
          </div>
        </Show>
      </div>
    </>
  )
}
