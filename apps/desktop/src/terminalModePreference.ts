const TERMINAL_MODE_STORAGE_KEY = "maxx.experimental.terminal-mode.enabled";

interface TerminalModeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function browserStorage(): TerminalModeStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadTerminalModeEnabled(
  storage: TerminalModeStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  return storage.getItem(TERMINAL_MODE_STORAGE_KEY) === "true";
}

export function persistTerminalModeEnabled(
  enabled: boolean,
  storage: TerminalModeStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(TERMINAL_MODE_STORAGE_KEY, String(enabled));
  } catch {
    // The preference remains effective for this session when storage is unavailable.
  }
}
