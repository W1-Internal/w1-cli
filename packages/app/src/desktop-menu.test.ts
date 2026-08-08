import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"

describe("desktop menu", () => {
  test("navigates between tabs", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) =>
        item.type === "item" &&
        (item.labelKey === "desktop.menu.previousTab" || item.labelKey === "desktop.menu.nextTab"),
    )

    expect(items).toEqual([
      {
        type: "item",
        labelKey: "desktop.menu.previousTab",
        command: "tab.prev",
        accelerator: { macos: "Option+Up" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.nextTab",
        command: "tab.next",
        accelerator: { macos: "Option+Down" },
      },
    ])
  })

  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.labelKey === "desktop.menu.exportLogs",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("provides translated labels for role-backed entries", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.role === "windowMenu")
    const roleItems = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.role && item.labelKey,
    )

    expect(windowMenu?.labelKey).toBe("desktop.menu.window")
    expect(roleItems.length).toBeGreaterThan(0)
  })
})
