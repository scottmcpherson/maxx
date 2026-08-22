const PROVIDER_DIAGNOSTICS_STORAGE_KEY = "maxx.provider-diagnostics.visible";

interface DiagnosticsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function browserStorage(): DiagnosticsStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadShowProviderDiagnostics(
  storage: DiagnosticsStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  return storage.getItem(PROVIDER_DIAGNOSTICS_STORAGE_KEY) === "true";
}

export function persistShowProviderDiagnostics(
  visible: boolean,
  storage: DiagnosticsStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PROVIDER_DIAGNOSTICS_STORAGE_KEY, String(visible));
  } catch {
    // The preference remains effective for this session when storage is unavailable.
  }
}
