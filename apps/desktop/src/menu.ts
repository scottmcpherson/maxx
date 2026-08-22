// Native-menu contract. The menu itself is built in `electron/main.ts`;
// custom items arrive here as `menu://action`, so
// the zustand store stays the single implementation of every command.
//
// The second job of this module is deduplication. An `NSMenuItem` key
// equivalent is consumed by AppKit before the event ever reaches Chromium, so
// in practice the in-app `keydown` handler never sees a
// combination the menu claims. Rather than depend on that silently, the
// handler asks `isNativeMenuShortcut` first and defers — one owner per
// combination, by construction rather than by platform behaviour.

import type {
  KeyboardShortcutBinding,
  KeyboardShortcutModifier,
} from "./keyboardShortcuts";

/** Ids emitted by the Electron main process. */
export const MENU_ACTION_IDS = [
  "settings",
  "new_thread",
  "search",
  "toggle_sidebar",
  "toggle_browser",
  "zoom_in",
  "zoom_out",
  "zoom_reset",
] as const;

export type MenuActionID = (typeof MENU_ACTION_IDS)[number];

export interface MenuActionPayload {
  id: MenuActionID;
}

export function isMenuActionID(value: unknown): value is MenuActionID {
  return (MENU_ACTION_IDS as readonly string[]).includes(value as string);
}

/** Context actions are rendered by Electron's native Menu.popup. */
export const NATIVE_CONTEXT_MENU_KINDS = ["thread", "project"] as const;
export type NativeContextMenuKind = (typeof NATIVE_CONTEXT_MENU_KINDS)[number];

export const NATIVE_CONTEXT_MENU_ACTIONS = ["pin", "rename", "delete", "remove_project"] as const;
export type NativeContextMenuAction = (typeof NATIVE_CONTEXT_MENU_ACTIONS)[number];

export interface NativeContextMenuRequest {
  kind: NativeContextMenuKind;
  x: number;
  y: number;
  hostID?: string;
  projectID: string;
  threadID?: string;
  pinned?: boolean;
}

export interface NativeContextMenuPayload {
  kind: NativeContextMenuKind;
  action: NativeContextMenuAction;
  hostID?: string;
  projectID: string;
  threadID?: string;
  pinned?: boolean;
}

export function isNativeContextMenuKind(value: unknown): value is NativeContextMenuKind {
  return (NATIVE_CONTEXT_MENU_KINDS as readonly string[]).includes(value as string);
}

export function isNativeContextMenuAction(value: unknown): value is NativeContextMenuAction {
  return (NATIVE_CONTEXT_MENU_ACTIONS as readonly string[]).includes(value as string);
}

/**
 * Keys the native menu binds as *static* `CmdOrCtrl+<key>` accelerators.
 *
 * Toggle Sidebar and Toggle Right Sidebar are absent because their accelerators
 * are not static: they follow the user's binding and are installed at runtime
 * with [`menuAcceleratorFor`] + `set_shortcut_accelerators`. The `keydown`
 * handler stays as the fallback for a binding no accelerator can express.
 */
export const NATIVE_MENU_SHORTCUT_KEYS: readonly string[] = [",", "n", "k", "=", "-", "0"];

interface ShortcutEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * True when the native menu owns this exact combination.
 *
 * `CmdOrCtrl` resolves to Command on macOS and Control elsewhere, and muda
 * matches modifier flags exactly — so any extra modifier means the accelerator
 * did *not* match and the in-app handler is still responsible. That is what
 * keeps ⌘⇧= (zoom in on a US layout) working: the menu binds only ⌘=.
 */
export function isNativeMenuShortcut(event: ShortcutEventLike): boolean {
  if (event.altKey || event.shiftKey) return false;
  // Exactly one primary modifier: ⌃⌘= is not the accelerator ⌘=.
  if (event.metaKey === event.ctrlKey) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return NATIVE_MENU_SHORTCUT_KEYS.includes(key);
}

/* -------------------------------------------------------------------------- */
/* Remappable accelerators                                                     */
/* -------------------------------------------------------------------------- */

const ACCELERATOR_MODIFIERS: Record<KeyboardShortcutModifier, string> = {
  control: "Control",
  alt: "Alt",
  shift: "Shift",
  meta: "Command",
};

/** Named keys Electron accepts, keyed by `KeyboardEvent.key`. */
const ACCELERATOR_NAMED_KEYS: Record<string, string> = {
  " ": "Space",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  Backspace: "Backspace",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Escape: "Escape",
  Home: "Home",
  Insert: "Insert",
  PageDown: "PageDown",
  PageUp: "PageUp",
  Tab: "Tab",
};

/** Single characters Electron maps to a key; anything else has no accelerator. */
const ACCELERATOR_PUNCTUATION = new Set(["`", "\\", "[", "]", ",", "=", "-", ".", "'", ";", "/"]);

function acceleratorKey(key: string): string | null {
  const named = ACCELERATOR_NAMED_KEYS[key];
  if (named) return named;
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
    return ACCELERATOR_PUNCTUATION.has(key) ? key : null;
  }
  return /^F([1-9]|1\d|2[0-4])$/.test(key) ? key : null;
}

/**
 * Renders a user binding as an Electron accelerator string, or `null` when the
 * key has no native accelerator form.
 *
 * This is what makes a remappable shortcut survive the browser pane: an
 * `NSMenuItem` key equivalent is matched by AppKit before the event reaches any
 * renderer, so it fires even while the browser `WebContentsView` owns the
 * keyboard. A `keydown` listener in the app renderer never sees that event.
 */
export function menuAcceleratorFor(binding: KeyboardShortcutBinding): string | null {
  const key = acceleratorKey(binding.key);
  if (!key) return null;
  const modifiers = (["control", "alt", "shift", "meta"] as const)
    .filter((modifier) => binding.modifiers.includes(modifier))
    .map((modifier) => ACCELERATOR_MODIFIERS[modifier]);
  // Native menu shortcuts need at least one modifier to avoid stealing text.
  if (modifiers.length === 0) return null;
  return [...modifiers, key].join("+");
}
