/** @jsxImportSource @opentui/solid */
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { RunFooterMenu, createFooterMenuState, type RunFooterMenuItem } from "./footer.menu"
import type { RunFooterTheme } from "./theme"
import type { FooterThreadCatalog, FooterThreadSummary } from "./types"

const THREAD_LIST_ROWS = 10
const THREAD_FRAME_ROWS = 7
export const RUN_THREAD_PANEL_ROWS = THREAD_LIST_ROWS + THREAD_FRAME_ROWS

const HALF_BLOCK_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: "▀",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

type ThreadEntry = RunFooterMenuItem & {
  thread: FooterThreadSummary
}

function category(status: FooterThreadSummary["status"]) {
  if (status === "running") return "Running"
  if (status === "awaiting_user") return "Needs input"
  return "Recent"
}

function threadCategory(thread: FooterThreadSummary) {
  return thread.archived ? "Archived" : category(thread.status)
}

function rank(status: FooterThreadSummary["status"]) {
  if (status === "running") return 0
  if (status === "awaiting_user") return 1
  return 2
}

function threadRank(thread: FooterThreadSummary) {
  return thread.archived ? 3 : rank(thread.status)
}

function status(status: FooterThreadSummary["status"]) {
  if (status === "awaiting_user") return "needs input"
  return status
}

function updatedAt(value: FooterThreadSummary["updatedAt"]) {
  if (typeof value === "number") return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function RunThreadSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  catalog: Accessor<FooterThreadCatalog>
  onClose: () => void
  onSelect: (threadID: string) => void | Promise<void>
  onNew: () => void | Promise<void>
  onArchive: (threadID: string, archived: boolean) => boolean | void | Promise<boolean | void>
}) {
  let field: InputRenderable | undefined
  const [query, setQuery] = createSignal("")
  const entries = createMemo<ThreadEntry[]>(() =>
    props
      .catalog()
      .threads.map((thread) => ({
        category: threadCategory(thread),
        display: thread.title.replace(/\s+/g, " ").trim() || thread.threadID,
        description: thread.threadID,
        footer: `${thread.archived ? "archived" : status(thread.status)}${props.catalog().currentThreadID === thread.threadID ? " · current" : ""}`,
        thread,
      }))
      .sort(
        (a, b) =>
          threadRank(a.thread) - threadRank(b.thread) ||
          updatedAt(b.thread.updatedAt) - updatedAt(a.thread.updatedAt) ||
          a.display.localeCompare(b.display),
      ),
  )
  const items = createMemo<ThreadEntry[]>(() => {
    const text = query().trim()
    if (!text) return entries()
    return fuzzysort
      .go(text, entries(), { keys: ["display", "description", "category", "footer"] })
      .map((item) => item.obj)
  })
  const menu = createFooterMenuState({ count: () => items().length + 1, limit: THREAD_LIST_ROWS })
  const selectingNew = createMemo(() => menu.selected() === items().length)
  const selectedThread = createMemo(() => (selectingNew() ? undefined : items()[menu.selected()]))

  const select = () => {
    const thread = selectedThread()
    if (thread) {
      void props.onSelect(thread.thread.threadID)
      return
    }

    void props.onNew()
  }

  createEffect(() => {
    query()
    menu.reset()
  })

  createEffect(() => {
    if (query().trim()) return
    const index = items().findIndex((item) => item.thread.threadID === props.catalog().currentThreadID)
    if (index !== -1) menu.reveal(index)
  })

  useKeyboard((event) => {
    if (event.defaultPrevented) return
    const name = event.name.toLowerCase()
    const ctrl = event.ctrl && !event.meta && !event.shift && !event.super

    if (name === "escape" || (ctrl && name === "c")) {
      event.preventDefault()
      props.onClose()
      return
    }

    if (name === "up" || (ctrl && name === "p")) {
      event.preventDefault()
      menu.move(-1)
      return
    }

    if (name === "down" || (ctrl && name === "n")) {
      event.preventDefault()
      menu.move(1)
      return
    }

    if (name === "pageup") {
      event.preventDefault()
      menu.reveal(menu.selected() - THREAD_LIST_ROWS + 1)
      return
    }

    if (name === "pagedown") {
      event.preventDefault()
      menu.reveal(menu.selected() + THREAD_LIST_ROWS - 1)
      return
    }

    if (name === "home") {
      event.preventDefault()
      menu.reveal(0)
      return
    }

    if (name === "end") {
      event.preventDefault()
      menu.reveal(Number.POSITIVE_INFINITY)
      return
    }

    if (name === "return") {
      event.preventDefault()
      select()
      return
    }

    if (ctrl && name === "x") {
      const thread = selectedThread()?.thread
      if (!thread) return
      event.preventDefault()
      void props.onArchive(thread.threadID, !thread.archived)
      return
    }

    if (ctrl && name === "u") {
      event.preventDefault()
      setQuery("")
      field?.setText("")
    }
  })

  return (
    <box width="100%" flexDirection="column" border={false} backgroundColor="transparent" flexShrink={0}>
      <box height={1} flexShrink={0} backgroundColor={props.theme().shade} />
      <box
        width="100%"
        height={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        gap={1}
        flexShrink={0}
        backgroundColor={props.theme().shade}
      >
        <text fg={props.theme().text} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
          Resume session
        </text>
        <text fg={props.theme().muted} wrapMode="none" flexShrink={0}>
          {items().length}/{entries().length}
        </text>
        <box flexGrow={1} flexShrink={1} backgroundColor="transparent" />
        <text fg={props.theme().muted} wrapMode="none" truncate flexShrink={0}>
          ctrl+x archive · esc
        </text>
      </box>
      <box height={1} flexShrink={0} backgroundColor={props.theme().shade} />
      <box width="100%" height={1} paddingLeft={2} paddingRight={2} flexShrink={0} backgroundColor={props.theme().shade}>
        <input
          width="100%"
          focusedBackgroundColor={props.theme().shade}
          focusedTextColor={props.theme().text}
          placeholder="Search sessions"
          placeholderColor={props.theme().muted}
          cursorColor={props.theme().highlight}
          onInput={setQuery}
          ref={(input) => {
            field = input
            input.traits = { status: "FILTER" }
            queueMicrotask(() => {
              if (!input.isDestroyed) input.focus()
            })
          }}
        />
      </box>
      <box height={1} flexShrink={0} backgroundColor={props.theme().shade} />
      <RunFooterMenu
        theme={props.theme}
        items={items}
        selected={menu.selected}
        offset={menu.offset}
        rows={() => THREAD_LIST_ROWS}
        limit={THREAD_LIST_ROWS}
        empty={props.catalog().loading ? "Loading sessions" : "No matching sessions"}
        border={false}
        paddingLeft={2}
        paddingRight={2}
        grouped={!query().trim()}
        background
        headerColor={props.theme().muted}
      />
      <box
        width="100%"
        height={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        justifyContent="space-between"
        backgroundColor={selectingNew() ? props.theme().selected : props.theme().shade}
      >
        <text fg={selectingNew() ? props.theme().text : props.theme().highlight} wrapMode="none">
          + New session
        </text>
        <text fg={props.theme().muted} wrapMode="none">
          /new
        </text>
      </box>
      <box width="100%" height={1} border={false} backgroundColor="transparent" flexShrink={0}>
        <box
          width="100%"
          height={1}
          border={["bottom"]}
          borderColor={props.theme().shade}
          backgroundColor="transparent"
          customBorderChars={HALF_BLOCK_BORDER}
        />
      </box>
    </box>
  )
}
