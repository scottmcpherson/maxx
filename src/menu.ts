// Native-menu contract. The menu itself is built in `src-tauri/src/menu.rs`;
// custom items carry no behaviour there and arrive here as `menu://action`, so
// the zustand store stays the single implementation of every command.
//
// The second job of this module is deduplication. An `NSMenuItem` key
// equivalent is consumed by AppKit before the event ever reaches the
// `WKWebView`, so in practice the in-app `keydown` handler never sees a
// combination the menu claims. Rather than depend on that silently, the
// handler asks `isNativeMenuShortcut` first and defers — one owner per
// combination, by construction rather than by platform behaviour.

import type {
  KeyboardShortcutBinding,
  KeyboardShortcutModifier,
} from "./keyboardShortcuts";

/** Ids emitted by `MENU_EVENT`; mirrors `FORWARDED_IDS` in menu.rs. */
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

/** Named keys muda's parser accepts, keyed by `KeyboardEvent.key`. */
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

/** Single characters muda maps to a `Code`; anything else has no accelerator. */
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
 * Renders a user binding as a muda accelerator string, or `null` when muda has
 * no `Code` for the key.
 *
 * This is what makes a remappable shortcut survive the browser pane: an
 * `NSMenuItem` key equivalent is matched by AppKit before the event reaches any
 * webview, so it fires even while the pane's child `WKWebView` — a sibling
 * `NSView` with its own first responder — owns the keyboard. A `keydown`
 * listener in the app's own webview never sees that event at all.
 */
export function menuAcceleratorFor(binding: KeyboardShortcutBinding): string | null {
  const key = acceleratorKey(binding.key);
  if (!key) return null;
  const modifiers = (["control", "alt", "shift", "meta"] as const)
    .filter((modifier) => binding.modifiers.includes(modifier))
    .map((modifier) => ACCELERATOR_MODIFIERS[modifier]);
  // muda needs at least one modifier for a menu key equivalent to be sane.
  if (modifiers.length === 0) return null;
  return [...modifiers, key].join("+");
}
