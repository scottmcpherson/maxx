import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  findKeyboardShortcutConflict,
  formatKeyboardShortcut,
  keyboardShortcutFromEvent,
  loadKeyboardShortcuts,
  matchesKeyboardShortcut,
  persistKeyboardShortcuts,
} from "./keyboardShortcuts";

function keyboardEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {},
) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("keyboard shortcuts", () => {
  it("defines Toggle Sidebar as Command+B", () => {
    expect(DEFAULT_KEYBOARD_SHORTCUTS.toggleSidebar).toEqual({ key: "b", modifiers: ["meta"] });
    expect(formatKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS.toggleSidebar)).toBe("⌘B");
  });

  it("matches the key and exact modifiers case-insensitively", () => {
    const binding = DEFAULT_KEYBOARD_SHORTCUTS.toggleSidebar;

    expect(matchesKeyboardShortcut(keyboardEvent("B", { metaKey: true }), binding)).toBe(true);
    expect(matchesKeyboardShortcut(keyboardEvent("b", { metaKey: true, shiftKey: true }), binding)).toBe(false);
    expect(matchesKeyboardShortcut(keyboardEvent("b", { ctrlKey: true }), binding)).toBe(false);
  });

  it("ignores modifier-only events while recording", () => {
    expect(keyboardShortcutFromEvent(keyboardEvent("Meta", { metaKey: true }))).toBeNull();
    expect(keyboardShortcutFromEvent(keyboardEvent("k", { altKey: true }))).toEqual({
      key: "k",
      modifiers: ["alt"],
    });
  });

  it("persists a customized binding and restores it", () => {
    const storage = memoryStorage();
    persistKeyboardShortcuts(
      {
        ...DEFAULT_KEYBOARD_SHORTCUTS,
        toggleSidebar: { key: "s", modifiers: ["control", "meta"] },
      },
      storage,
    );

    expect(loadKeyboardShortcuts(storage).toggleSidebar).toEqual({
      key: "s",
      modifiers: ["control", "meta"],
    });
  });

  it("defines Toggle Browser as Command+Shift+E", () => {
    expect(DEFAULT_KEYBOARD_SHORTCUTS.toggleBrowser).toEqual({
      key: "e",
      modifiers: ["meta", "shift"],
    });
    expect(formatKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS.toggleBrowser)).toBe("⇧⌘E");
  });

  // Regression: the default used Option+E, which never fires on macOS because
  // Option+E is a dead key and `event.key` is "Dead", not "e".
  it("matches Toggle Browser from the uppercase key a shifted press reports", () => {
    expect(
      matchesKeyboardShortcut(
        keyboardEvent("E", { metaKey: true, shiftKey: true }),
        DEFAULT_KEYBOARD_SHORTCUTS.toggleBrowser,
      ),
    ).toBe(true);
  });

  it("reports a conflict between the two customizable commands", () => {
    const conflict = findKeyboardShortcutConflict(
      DEFAULT_KEYBOARD_SHORTCUTS,
      "toggleBrowser",
      DEFAULT_KEYBOARD_SHORTCUTS.toggleSidebar,
    );

    expect(conflict?.label).toBe("Toggle Sidebar");
  });

  it("keeps customizable bindings from shadowing existing app commands", () => {
    const conflict = findKeyboardShortcutConflict(
      DEFAULT_KEYBOARD_SHORTCUTS,
      "toggleSidebar",
      { key: "k", modifiers: ["meta"] },
    );

    expect(conflict?.label).toBe("Search");
  });

  it("falls back to defaults for malformed or unsafe stored shortcuts", () => {
    const storage = memoryStorage();
    storage.setItem("maxx.keyboard-shortcuts.v1", JSON.stringify({
      version: 1,
      bindings: { toggleSidebar: { key: "b", modifiers: [] } },
    }));

    expect(loadKeyboardShortcuts(storage)).toEqual(DEFAULT_KEYBOARD_SHORTCUTS);
  });
});
