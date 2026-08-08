import { Show, createMemo, type Component } from "solid-js"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName, useServer } from "@/context/server"

export interface ServerSelectOption {
  key: ServerConnection.Key | "all"
  label: string
  isDefault?: boolean
  isAll?: boolean
}

export const InlineServerSelect: Component<{
  value: ServerConnection.Key | "all"
  onChange: (key: ServerConnection.Key | "all") => void
  includeAll?: boolean
  disabled?: boolean
}> = (props) => {
  const language = useLanguage()
  const global = useGlobal()
  const server = useServer()

  const hasMultipleServers = createMemo(() => global.servers.list().length > 1)

  const options = createMemo<ServerSelectOption[]>(() => {
    const list: ServerSelectOption[] = []
    if (props.includeAll) {
      list.push({
        key: "all",
        label: language.t("settings.server.all"),
        isAll: true,
      })
    }

    const servers = global.servers.list()
    for (const item of servers) {
      const key = ServerConnection.key(item)
      const isDefault = key === server.key
      list.push({
        key,
        label: serverName(item) || key,
        isDefault,
      })
    }

    return list
  })

  const currentOption = createMemo(() => {
    return options().find((opt) => opt.key === props.value) ?? options()[0]
  })

  return (
    <Show when={hasMultipleServers()}>
      <SelectV2
        appearance="inline"
        data-action="settings-server-select"
        options={options()}
        current={currentOption()}
        value={(opt) => opt.key}
        label={(opt) => opt.label}
        disabled={props.disabled}
        placement="bottom-end"
        gutter={6}
        onSelect={(opt) => {
          if (opt) props.onChange(opt.key)
        }}
      />
    </Show>
  )
}
