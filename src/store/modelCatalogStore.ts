import { create } from "zustand";
import {
  ChatProvider,
  ProviderModelCatalog,
  ProviderModelOption,
  ProviderProfile,
} from "../contract/types";
import { ipc } from "../ipc";

const CACHE_STORAGE_KEY = "maxx.provider-catalog-cache.v1";
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_CACHED_CONTEXTS = 8;

export type CatalogStatus = "idle" | "loading" | "cached" | "live" | "unavailable";

export interface CatalogEntry {
  models: ProviderModelOption[];
  status: CatalogStatus;
  error?: string;
  fetchedAt?: number;
}

export type CatalogEntries = Partial<Record<ChatProvider, CatalogEntry>>;

interface CatalogContextState {
  entries: CatalogEntries;
}

interface EnsureCatalogOptions {
  contextKey: string;
  provider: ChatProvider;
  profiles: ProviderProfile[];
  workingDirectory?: string | null;
  force?: boolean;
}

interface PrefetchCatalogOptions {
  contextKey: string;
  providers: ChatProvider[];
  profiles: ProviderProfile[];
  workingDirectory?: string | null;
}

interface ModelCatalogState {
  contexts: Record<string, CatalogContextState>;
  hydrateContext: (contextKey: string) => void;
  ensureModels: (options: EnsureCatalogOptions) => Promise<void>;
  prefetch: (options: PrefetchCatalogOptions) => Promise<void>;
}

interface PersistedCatalogEntry {
  models: ProviderModelOption[];
  fetchedAt: number;
}

interface PersistedCatalogContext {
  updatedAt: number;
  entries: Partial<Record<ChatProvider, PersistedCatalogEntry>>;
}

interface PersistedCatalogCache {
  version: number;
  contexts: Record<string, PersistedCatalogContext>;
}

const inFlightRequests = new Map<string, Promise<void>>();
const prefetchedContexts = new Set<string>();

function availableStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModel(value: unknown): ProviderModelOption | null {
  if (!isRecord(value) || typeof value.model !== "string" || typeof value.displayName !== "string") {
    return null;
  }
  const effortLevels = Array.isArray(value.effortLevels)
    ? value.effortLevels.filter((level): level is string => typeof level === "string")
    : undefined;
  return {
    model: value.model,
    displayName: value.displayName,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.isDefault === "boolean" ? { isDefault: value.isDefault } : {}),
    ...(effortLevels?.length ? { effortLevels } : {}),
  };
}

function emptyPersistedCache(): PersistedCatalogCache {
  return { version: CACHE_VERSION, contexts: {} };
}

function readPersistedCache(): PersistedCatalogCache {
  const storage = availableStorage();
  if (!storage) return emptyPersistedCache();
  try {
    const raw = storage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return emptyPersistedCache();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.contexts)) {
      return emptyPersistedCache();
    }
    return parsed as unknown as PersistedCatalogCache;
  } catch {
    return emptyPersistedCache();
  }
}

function writePersistedCache(cache: PersistedCatalogCache): void {
  const storage = availableStorage();
  if (!storage) return;
  try {
    storage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Cache persistence is an optimization. Discovery remains authoritative.
  }
}

/** Read only previously successful live discovery results. */
export function readCachedCatalog(contextKey: string, now = Date.now()): CatalogEntries {
  const context: unknown = readPersistedCache().contexts[contextKey];
  if (!isRecord(context) || typeof context.updatedAt !== "number"
    || !Number.isFinite(context.updatedAt) || now - context.updatedAt > CACHE_MAX_AGE_MS
    || !isRecord(context.entries)) {
    return {};
  }
  const entries: CatalogEntries = {};
  for (const [provider, rawEntry] of Object.entries(context.entries)) {
    if (!isRecord(rawEntry) || !Array.isArray(rawEntry.models)
      || typeof rawEntry.fetchedAt !== "number"
      || now - rawEntry.fetchedAt > CACHE_MAX_AGE_MS) {
      continue;
    }
    const models = rawEntry.models.map(parseModel).filter((model): model is ProviderModelOption => !!model);
    if (!models.length) continue;
    entries[provider as ChatProvider] = {
      models,
      status: "cached",
      fetchedAt: rawEntry.fetchedAt,
    };
  }
  return entries;
}

function persistLiveCatalog(
  contextKey: string,
  provider: ChatProvider,
  models: ProviderModelOption[],
  fetchedAt: number,
): void {
  if (!models.length) return;
  const cache = readPersistedCache();
  const previous = cache.contexts[contextKey];
  cache.contexts[contextKey] = {
    updatedAt: fetchedAt,
    entries: {
      ...previous?.entries,
      [provider]: { models, fetchedAt },
    },
  };
  const retained = Object.entries(cache.contexts)
    .filter(([, context]) => fetchedAt - context.updatedAt <= CACHE_MAX_AGE_MS)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_CACHED_CONTEXTS);
  cache.contexts = Object.fromEntries(retained);
  writePersistedCache(cache);
}

function hashContext(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return [first, second]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/**
 * Catalogs can vary by project and runtime configuration. The persisted key is
 * a hash so executable environment values are never written into localStorage.
 *
 * Enable/disable is intentionally excluded: toggling a provider off must not
 * invalidate an already-loaded catalog (or the display names derived from it).
 */
export function providerCatalogContextKey(
  profiles: ProviderProfile[],
  workingDirectory?: string | null,
): string {
  const runtimeProfiles = profiles
    .map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      executablePath: profile.executablePath ?? "",
      serverURL: profile.serverURL ?? "",
      homeDirectory: profile.homeDirectory ?? "",
      environment: Object.entries(profile.environment).sort(([left], [right]) =>
        left.localeCompare(right)),
    }))
    .sort((left, right) => `${left.provider}:${left.id}`.localeCompare(`${right.provider}:${right.id}`));
  return `catalog-v1-${hashContext(JSON.stringify({
    workingDirectory: workingDirectory ?? "",
    profiles: runtimeProfiles,
  }))}`;
}

function providerProfile(profiles: ProviderProfile[], provider: ChatProvider): ProviderProfile | undefined {
  return profiles.find((profile) => profile.provider === provider && profile.isEnabled)
    ?? profiles.find((profile) => profile.provider === provider);
}

function normalizedCatalog(response: ProviderModelCatalog): ProviderModelCatalog {
  const models = response.models.map((model) => ({
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    isDefault: model.isDefault,
    effortLevels: model.effortLevels,
  }));
  return { ...response, models };
}

export const useModelCatalogStore = create<ModelCatalogState>((set, get) => ({
  contexts: {},

  hydrateContext: (contextKey) => {
    if (get().contexts[contextKey]) return;
    set((state) => ({
      contexts: {
        ...state.contexts,
        [contextKey]: { entries: readCachedCatalog(contextKey) },
      },
    }));
  },

  ensureModels: async ({
    contextKey,
    provider,
    profiles,
    workingDirectory,
    force = false,
  }) => {
    get().hydrateContext(contextKey);
    const currentEntry = get().contexts[contextKey]?.entries[provider];
    if (!force && currentEntry
      && ["cached", "live", "unavailable"].includes(currentEntry.status)) {
      return;
    }
    const requestKey = `${contextKey}:${provider}`;
    const existingRequest = inFlightRequests.get(requestKey);
    if (existingRequest) return existingRequest;

    set((state) => {
      const context = state.contexts[contextKey] ?? { entries: {} };
      const existing = context.entries[provider];
      const hasModels = !!existing?.models.length;
      return {
        contexts: {
          ...state.contexts,
          [contextKey]: {
            entries: {
              ...context.entries,
              [provider]: {
                models: existing?.models ?? [],
                status: hasModels ? existing?.status ?? "cached" : "loading",
                fetchedAt: existing?.fetchedAt,
              },
            },
          },
        },
      };
    });

    const request = (async () => {
      try {
        const profile = providerProfile(profiles, provider);
        const response = normalizedCatalog(await ipc.listProviderModels(
          provider,
          profile?.id,
          workingDirectory ?? undefined,
        ));
        if (response.source !== "live" || !response.models.length) {
          throw new Error(response.error || "Provider model discovery returned no models.");
        }
        const fetchedAt = Date.now();
        set((state) => ({
          contexts: {
            ...state.contexts,
            [contextKey]: {
              entries: {
                ...(state.contexts[contextKey]?.entries ?? {}),
                [provider]: {
                  models: response.models,
                  status: "live",
                  fetchedAt,
                },
              },
            },
          },
        }));
        persistLiveCatalog(contextKey, provider, response.models, fetchedAt);
      } catch (error) {
        set((state) => {
          const context = state.contexts[contextKey] ?? { entries: {} };
          const existing = context.entries[provider];
          const hasModels = !!existing?.models.length;
          return {
            contexts: {
              ...state.contexts,
              [contextKey]: {
                entries: {
                  ...context.entries,
                  [provider]: {
                    models: existing?.models ?? [],
                    status: hasModels ? "cached" : "unavailable",
                    error: error instanceof Error ? error.message : String(error),
                    fetchedAt: existing?.fetchedAt,
                  },
                },
              },
            },
          };
        });
      } finally {
        inFlightRequests.delete(requestKey);
      }
    })();
    inFlightRequests.set(requestKey, request);
    return request;
  },

  prefetch: async ({ contextKey, providers, profiles, workingDirectory }) => {
    get().hydrateContext(contextKey);
    if (prefetchedContexts.has(contextKey)) return;
    prefetchedContexts.add(contextKey);
    const uniqueProviders = [...new Set(providers)];
    await Promise.allSettled(uniqueProviders.map((provider) => get().ensureModels({
      contextKey,
      provider,
      profiles,
      workingDirectory,
      force: true,
    })));
  },
}));

export function resetModelCatalogStoreForTests(): void {
  inFlightRequests.clear();
  prefetchedContexts.clear();
  useModelCatalogStore.setState({ contexts: {} });
}
