import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBOARD_SHORTCUTS, matchesKeyboardShortcut } from "./keyboardShortcuts";
import {
  MENU_ACTION_IDS,
  isMenuActionID,
  isNativeMenuShortcut,
  menuAcceleratorFor,
} from "./menu";

function keyEvent(
  key: string,
  modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
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

describe("menu action ids", () => {
  it("accepts every id the Rust side forwards", () => {
    for (const id of MENU_ACTION_IDS) expect(isMenuActionID(id)).toBe(true);
  });

  it("rejects ids handled natively or unknown", () => {
    expect(isMenuActionID("check_updates")).toBe(false);
    expect(isMenuActionID("tray_quit")).toBe(false);
    expect(isMenuActionID(undefined)).toBe(false);
  });
});

describe("native menu shortcut ownership", () => {
  it("claims the accelerators declared in menu.rs", () => {
    for (const key of [",", "n", "k", "=", "-", "0"]) {
      expect(isNativeMenuShortcut(keyEvent(key, { metaKey: true }))).toBe(true);
    }
  });

  it("folds shifted letters down like the accelerator parser does", () => {
    expect(isNativeMenuShortcut(keyEvent("N", { metaKey: true }))).toBe(true);
  });

  it("treats CmdOrCtrl as Control off macOS", () => {
    expect(isNativeMenuShortcut(keyEvent("k", { ctrlKey: true }))).toBe(true);
  });

  it("leaves ⌘⇧= to the in-app zoom handler", () => {
    // A US-layout "zoom in" press; muda matches modifier flags exactly, so the
    // ⌘= accelerator does not fire and the keydown handler must still run.
    expect(isNativeMenuShortcut(keyEvent("+", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isNativeMenuShortcut(keyEvent("=", { metaKey: true, shiftKey: true }))).toBe(false);
  });

  it("ignores combinations with extra modifiers", () => {
    expect(isNativeMenuShortcut(keyEvent("n", { metaKey: true, altKey: true }))).toBe(false);
    expect(isNativeMenuShortcut(keyEvent("n", { metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isNativeMenuShortcut(keyEvent("n"))).toBe(false);
  });

  /**
   * The regression this whole module exists to prevent: a user-remappable
   * binding must never collide with an accelerator, or one of the two owners
   * silently wins.
   */
  it("never statically claims a remappable default binding", () => {
    for (const binding of Object.values(DEFAULT_KEYBOARD_SHORTCUTS)) {
      const modifiers = {
        metaKey: binding.modifiers.includes("meta"),
        ctrlKey: binding.modifiers.includes("control"),
        altKey: binding.modifiers.includes("alt"),
        shiftKey: binding.modifiers.includes("shift"),
      };
      const event = keyEvent(binding.key, modifiers);
      expect(matchesKeyboardShortcut(event, binding)).toBe(true);
      expect(isNativeMenuShortcut(event)).toBe(false);
    }
  });
});

describe("remappable accelerators", () => {
  it("renders the default bindings in muda's syntax", () => {
    expect(menuAcceleratorFor(DEFAULT_KEYBOARD_SHORTCUTS.toggleSidebar)).toBe("Command+B");
    expect(menuAcceleratorFor(DEFAULT_KEYBOARD_SHORTCUTS.toggleBrowser)).toBe("Shift+Command+E");
  });

  it("orders modifiers the way the parser expects", () => {
    expect(
      menuAcceleratorFor({ key: "j", modifiers: ["meta", "shift", "alt", "control"] }),
    ).toBe("Control+Alt+Shift+Command+J");
  });

  it("maps the keys muda has a Code for", () => {
    expect(menuAcceleratorFor({ key: ",", modifiers: ["meta"] })).toBe("Command+,");
    expect(menuAcceleratorFor({ key: "1", modifiers: ["control"] })).toBe("Control+1");
    expect(menuAcceleratorFor({ key: " ", modifiers: ["alt"] })).toBe("Alt+Space");
    expect(menuAcceleratorFor({ key: "ArrowLeft", modifiers: ["meta"] })).toBe(
      "Command+ArrowLeft",
    );
    expect(menuAcceleratorFor({ key: "F7", modifiers: ["meta"] })).toBe("Command+F7");
  });

  /** An unmappable binding leaves the item bare; the keydown handler covers it. */
  it("returns null when muda has no code for the key", () => {
    expect(menuAcceleratorFor({ key: "€", modifiers: ["meta"] })).toBeNull();
    expect(menuAcceleratorFor({ key: "F25", modifiers: ["meta"] })).toBeNull();
    expect(menuAcceleratorFor({ key: "ContextMenu", modifiers: ["meta"] })).toBeNull();
    // A bare key is never a menu key equivalent.
    expect(menuAcceleratorFor({ key: "b", modifiers: [] })).toBeNull();
  });
});
