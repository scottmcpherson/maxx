import { ALL_PROVIDERS, type ChatProvider, type ProviderProfile } from "./contract/types";
import type { RuntimeSelection } from "./runtime/modelCatalog";

const DEFAULT_RUNTIME_STORAGE_KEY = "maxx.default-runtime.v1";

export const DEFAULT_NEW_CHAT_RUNTIME: RuntimeSelection = {
  provider: "codex",
  model: "Default",
  effort: null,
  speed: null,
};

/**
 * Keep the default harness on an enabled provider.
 *
 * When the stored default's provider is toggled off, pick the first still-
 * enabled profile (in profile list order, which matches Settings). Model and
 * effort reset to provider defaults — we no longer have that provider's
 * catalog selection to honor. If every provider is disabled, leave the
 * preference alone so re-enabling restores the previous choice.
 */
export function reconcileDefaultRuntime(
  selection: RuntimeSelection,
  profiles: readonly ProviderProfile[],
): RuntimeSelection {
  const providerEnabled = profiles.some(
    (profile) => profile.provider === selection.provider && profile.isEnabled,
  );
  if (providerEnabled) return selection;

  const fallback = profiles.find((profile) => profile.isEnabled);
  if (!fallback) return selection;

  return {
    provider: fallback.provider,
    model: "Default",
    effort: null,
    speed: null,
  };
}

interface RuntimePreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function browserStorage(): RuntimePreferenceStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function fallbackRuntime(): RuntimeSelection {
  return { ...DEFAULT_NEW_CHAT_RUNTIME };
}

/** Keep the stored preference narrow and reject values from an unknown schema. */
export function normalizeDefaultRuntime(value: unknown): RuntimeSelection | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RuntimeSelection>;
  if (!ALL_PROVIDERS.includes(candidate.provider as ChatProvider)) return null;
  if (typeof candidate.model !== "string") return null;
  if (candidate.effort != null && typeof candidate.effort !== "string") return null;
  if (
    candidate.speed != null
    && candidate.speed !== "normal"
    && candidate.speed !== "fast"
  ) return null;

  return {
    provider: candidate.provider as ChatProvider,
    model: candidate.model.trim() || "Default",
    effort: candidate.effort?.trim() || null,
    speed: candidate.speed === "fast" ? "fast" : null,
  };
}

export function loadDefaultRuntime(
  storage: RuntimePreferenceStorage | undefined = browserStorage(),
): RuntimeSelection {
  if (!storage) return fallbackRuntime();
  try {
    const raw = storage.getItem(DEFAULT_RUNTIME_STORAGE_KEY);
    if (!raw) return fallbackRuntime();
    return normalizeDefaultRuntime(JSON.parse(raw)) ?? fallbackRuntime();
  } catch {
    return fallbackRuntime();
  }
}

/** Returns the normalized value so in-memory state always matches persistence. */
export function persistDefaultRuntime(
  selection: RuntimeSelection,
  storage: RuntimePreferenceStorage | undefined = browserStorage(),
): RuntimeSelection {
  const normalized = normalizeDefaultRuntime(selection) ?? fallbackRuntime();
  if (!storage) return normalized;
  try {
    storage.setItem(DEFAULT_RUNTIME_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // The preference remains effective for this session when storage is unavailable.
  }
  return normalized;
}
