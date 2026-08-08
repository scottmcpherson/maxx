export type KeyboardShortcutCommand = "toggleSidebar" | "toggleBrowser" | "toggleDictation";

export type KeyboardShortcutModifier = "control" | "alt" | "shift" | "meta";

export interface KeyboardShortcutBinding {
  key: string;
  modifiers: KeyboardShortcutModifier[];
}

export interface KeyboardShortcutDefinition {
  id: KeyboardShortcutCommand;
  label: string;
  description: string;
  defaultBinding: KeyboardShortcutBinding;
}

export interface KeyboardShortcutConflict {
  label: string;
}

export type KeyboardShortcutBindings = Record<KeyboardShortcutCommand, KeyboardShortcutBinding>;

interface KeyboardEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface ShortcutStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const SHORTCUT_STORAGE_KEY = "maxx.keyboard-shortcuts.v1";
const MODIFIER_ORDER: readonly KeyboardShortcutModifier[] = ["control", "alt", "shift", "meta"];
const MODIFIER_KEYS = new Set(["alt", "control", "meta", "shift"]);
const MODIFIER_GLYPHS: Record<KeyboardShortcutModifier, string> = {
  control: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
};
const MODIFIER_NAMES: Record<KeyboardShortcutModifier, string> = {
  control: "Control",
  alt: "Option",
  shift: "Shift",
  meta: "Command",
};
const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Backspace: "Delete",
  Escape: "Esc",
};

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutDefinition[] = [
  {
    id: "toggleSidebar",
    label: "Toggle Sidebar",
    description: "Show or hide the main sidebar.",
    defaultBinding: { key: "b", modifiers: ["meta"] },
  },
  {
    id: "toggleBrowser",
    label: "Toggle Right Sidebar",
    description: "Show or hide the right sidebar, where the browser lives.",
    // Shift rather than Option: matching is done on `event.key`, and Option+E
    // on a macOS layout is a dead key that never reports "e". Shift+letter
    // reports the uppercase letter, which `normalizeKey` folds back down.
    defaultBinding: { key: "e", modifiers: ["meta", "shift"] },
  },
  {
    id: "toggleDictation",
    label: "Toggle Dictation",
    description: "Start or stop transcribing your voice into the message box.",
    defaultBinding: { key: "d", modifiers: ["meta", "shift"] },
  },
];

function defaultBindingFor(command: KeyboardShortcutCommand): KeyboardShortcutBinding {
  const definition = KEYBOARD_SHORTCUTS.find((entry) => entry.id === command);
  if (!definition) throw new Error(`unknown keyboard shortcut: ${command}`);
  return cloneBinding(definition.defaultBinding);
}

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutBindings = {
  toggleSidebar: defaultBindingFor("toggleSidebar"),
  toggleBrowser: defaultBindingFor("toggleBrowser"),
  toggleDictation: defaultBindingFor("toggleDictation"),
};

const RESERVED_KEYBOARD_SHORTCUTS: readonly (KeyboardShortcutConflict & {
  binding: KeyboardShortcutBinding;
})[] = [
  { label: "New Chat", binding: { key: "n", modifiers: ["meta"] } },
  { label: "Search", binding: { key: "k", modifiers: ["meta"] } },
  { label: "Show Unread and Waiting", binding: { key: "u", modifiers: ["alt", "meta"] } },
  { label: "Settings", binding: { key: ",", modifiers: ["meta"] } },
  { label: "Zoom In", binding: { key: "=", modifiers: ["meta"] } },
  { label: "Zoom Out", binding: { key: "-", modifiers: ["meta"] } },
  { label: "Reset Zoom", binding: { key: "0", modifiers: ["meta"] } },
];

function cloneBinding(binding: KeyboardShortcutBinding): KeyboardShortcutBinding {
  return { key: binding.key, modifiers: [...binding.modifiers] };
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function orderedModifiers(event: KeyboardEventLike): KeyboardShortcutModifier[] {
  return MODIFIER_ORDER.filter((modifier) => {
    if (modifier === "control") return event.ctrlKey;
    if (modifier === "alt") return event.altKey;
    if (modifier === "shift") return event.shiftKey;
    return event.metaKey;
  });
}

function isKeyboardShortcutModifier(value: unknown): value is KeyboardShortcutModifier {
  return typeof value === "string" && MODIFIER_ORDER.includes(value as KeyboardShortcutModifier);
}

function isStoredBinding(value: unknown): value is KeyboardShortcutBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<KeyboardShortcutBinding>;
  if (typeof candidate.key !== "string" || !candidate.key || !Array.isArray(candidate.modifiers)) return false;
  if (!candidate.modifiers.every(isKeyboardShortcutModifier)) return false;
  if (new Set(candidate.modifiers).size !== candidate.modifiers.length) return false;
  return isAllowedKeyboardShortcut(candidate as KeyboardShortcutBinding);
}

function browserStorage(): ShortcutStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function keyboardShortcutFromEvent(event: KeyboardEventLike): KeyboardShortcutBinding | null {
  const key = normalizeKey(event.key);
  if (MODIFIER_KEYS.has(key.toLowerCase())) return null;
  return { key, modifiers: orderedModifiers(event) };
}

export function isAllowedKeyboardShortcut(binding: KeyboardShortcutBinding): boolean {
  return binding.modifiers.some((modifier) => modifier === "meta" || modifier === "control" || modifier === "alt");
}

export function matchesKeyboardShortcut(
  event: KeyboardEventLike,
  binding: KeyboardShortcutBinding,
): boolean {
  const eventBinding = keyboardShortcutFromEvent(event);
  return eventBinding !== null && keyboardShortcutsEqual(eventBinding, binding);
}

export function keyboardShortcutsEqual(
  first: KeyboardShortcutBinding,
  second: KeyboardShortcutBinding,
): boolean {
  if (normalizeKey(first.key) !== normalizeKey(second.key)) return false;
  return MODIFIER_ORDER.every(
    (modifier) => first.modifiers.includes(modifier) === second.modifiers.includes(modifier),
  );
}

export function formatKeyboardShortcut(binding: KeyboardShortcutBinding): string {
  const modifiers = MODIFIER_ORDER.filter((modifier) => binding.modifiers.includes(modifier))
    .map((modifier) => MODIFIER_GLYPHS[modifier])
    .join("");
  const key = KEY_LABELS[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return `${modifiers}${key}`;
}

export function keyboardShortcutAriaLabel(binding: KeyboardShortcutBinding): string {
  const modifiers = MODIFIER_ORDER.filter((modifier) => binding.modifiers.includes(modifier))
    .map((modifier) => MODIFIER_NAMES[modifier]);
  const key = KEY_LABELS[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return [...modifiers, key].join("+");
}

export function findKeyboardShortcutConflict(
  bindings: KeyboardShortcutBindings,
  command: KeyboardShortcutCommand,
  candidate: KeyboardShortcutBinding,
): KeyboardShortcutConflict | null {
  const configurableConflict = KEYBOARD_SHORTCUTS.find(
    (definition) => definition.id !== command && keyboardShortcutsEqual(bindings[definition.id], candidate),
  );
  if (configurableConflict) return configurableConflict;
  return RESERVED_KEYBOARD_SHORTCUTS.find(
    (shortcut) => keyboardShortcutsEqual(shortcut.binding, candidate),
  ) ?? null;
}

export function loadKeyboardShortcuts(storage: ShortcutStorage | undefined = browserStorage()): KeyboardShortcutBindings {
  const defaults: KeyboardShortcutBindings = {
    toggleSidebar: cloneBinding(DEFAULT_KEYBOARD_SHORTCUTS.toggleSidebar),
    toggleBrowser: cloneBinding(DEFAULT_KEYBOARD_SHORTCUTS.toggleBrowser),
    toggleDictation: cloneBinding(DEFAULT_KEYBOARD_SHORTCUTS.toggleDictation),
  };
  if (!storage) return defaults;

  try {
    const raw = storage.getItem(SHORTCUT_STORAGE_KEY);
    if (!raw) return defaults;
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object") return defaults;
    const bindings = (stored as { bindings?: unknown }).bindings;
    if (!bindings || typeof bindings !== "object") return defaults;

    for (const definition of KEYBOARD_SHORTCUTS) {
      const binding = (bindings as Record<string, unknown>)[definition.id];
      if (isStoredBinding(binding) && !findKeyboardShortcutConflict(defaults, definition.id, binding)) {
        defaults[definition.id] = cloneBinding(binding);
      }
    }
    return defaults;
  } catch {
    return defaults;
  }
}

export function persistKeyboardShortcuts(
  bindings: KeyboardShortcutBindings,
  storage: ShortcutStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify({ version: 1, bindings }));
  } catch {
    // The updated binding remains active for this session when storage is unavailable.
  }
}
