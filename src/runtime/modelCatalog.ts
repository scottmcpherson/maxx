// Pure runtime model catalog: discovered capabilities, search, trigger labels, recents.
// Keep side-effect free except optional localStorage helpers for recents.

import { ALL_PROVIDERS, ChatProvider, providerDisplayName } from "../contract/types";

export interface ProviderModelOption {
  model: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  /** Effort values reported by the provider for this specific model. */
  effortLevels?: string[];
}

export type EffortLevel = string;
export type SpeedLevel = "normal" | "fast";

export interface RuntimeSelection {
  provider: ChatProvider;
  model: string;
  effort?: EffortLevel | null;
  speed?: SpeedLevel | null;
}

export type RuntimeRecentSource = "catalog" | "custom";

/** A persisted selection. `source` is absent on recents written by older builds. */
export interface RuntimeRecentSelection extends RuntimeSelection {
  source?: RuntimeRecentSource;
}

export function preferredModel(models: ProviderModelOption[]): string {
  if (models.length === 0) return "Default";
  const marked = models.find((m) => m.isDefault);
  if (marked) return marked.model;
  return models[0].model;
}

export function resolveModels(
  _provider: ChatProvider,
  discovered: ProviderModelOption[] | null | undefined,
): ProviderModelOption[] {
  return discovered && discovered.length > 0 ? discovered : [];
}

export function displayNameForModel(
  _provider: ChatProvider,
  model: string,
  options?: ProviderModelOption[],
): string {
  const list = options ?? [];
  const hit = list.find((m) => m.model === model);
  if (hit) return hit.displayName;
  if (!model || model.toLowerCase() === "default") return "Default";
  return humanizeModelId(model);
}

export function humanizeModelId(model: string): string {
  if (!model) return "Default";
  // OpenCode / Pi: provider/model
  const slash = model.includes("/") ? model.split("/").pop()! : model;
  // Drop trailing bracket params like default[]
  const cleaned = slash.replace(/\[[^\]]*\]$/g, "");
  return cleaned
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) || part.length <= 2 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

export function formatEffortLabel(effort: EffortLevel | null | undefined): string | null {
  if (!effort) return null;
  return effort
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatSpeedLabel(speed: SpeedLevel | null | undefined): string | null {
  if (!speed || speed === "normal") return null;
  return "Fast";
}

/** Closed trigger: "Grok · 4.5 · High" */
export function formatTriggerLabel(
  selection: RuntimeSelection,
  options?: ProviderModelOption[],
): { provider: string; model: string; knobs: string[] } {
  const provider = providerDisplayName(selection.provider);
  const model = displayNameForModel(selection.provider, selection.model, options);
  const knobs: string[] = [];
  const effort = formatEffortLabel(selection.effort ?? null);
  if (effort) knobs.push(effort);
  const speed = formatSpeedLabel(selection.speed ?? null);
  if (speed) knobs.push(speed);
  return { provider, model, knobs };
}

export function formatTriggerText(
  selection: RuntimeSelection,
  options?: ProviderModelOption[],
): string {
  const { provider, model, knobs } = formatTriggerLabel(selection, options);
  return [provider, model, ...knobs].join(" · ");
}

export interface SearchableProviderRow {
  provider: ChatProvider;
  label: string;
  enabled: boolean;
  color: string;
  models: ProviderModelOption[];
}

export interface FilteredRuntimeCatalog {
  providers: SearchableProviderRow[];
  /** Models for the currently highlighted/selected provider after filter. */
  models: ProviderModelOption[];
  /** Provider-labelled matches outside the active provider. Disabled providers are excluded. */
  modelHitsAcrossProviders: Array<{
    provider: ChatProvider;
    providerLabel: string;
    providerColor: string;
    option: ProviderModelOption;
  }>;
}

/** True when every query token appears in haystack (order-independent). */
export function textMatchesQuery(haystack: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const hay = haystack.toLowerCase();
  if (hay.includes(normalized)) return true;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.every((token) => hay.includes(token));
}

function modelMatchesQuery(option: ProviderModelOption, query: string): boolean {
  const blob = [option.displayName, option.model, option.description ?? ""].join(" ");
  return textMatchesQuery(blob, query);
}

/** Search filters providers and models together (case-insensitive; multi-token AND).
 * Disabled providers are excluded everywhere: toggling a provider off in
 * settings removes it from the rail and from search hits. */
export function filterRuntimeCatalog(
  profiles: SearchableProviderRow[],
  activeProvider: ChatProvider,
  query: string,
): FilteredRuntimeCatalog {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    const active = profiles.find((p) => p.provider === activeProvider);
    return {
      providers: profiles.filter((p) => p.enabled),
      models: active?.enabled ? active.models : [],
      modelHitsAcrossProviders: [],
    };
  }

  const providers = profiles.filter((p) => {
    if (!p.enabled) return false;
    if (textMatchesQuery(p.label, normalized)) return true;
    return p.models.some((m) => modelMatchesQuery(m, normalized));
  });

  // Never substitute another provider for the active provider. Doing so makes a
  // model row look active-provider-scoped even though its model ID belongs to a
  // different runtime.
  const active = profiles.find((p) => p.provider === activeProvider);
  const providerNameMatched = active ? textMatchesQuery(active.label, normalized) : false;
  const models = active?.enabled
    ? active.models.filter((m) => modelMatchesQuery(m, normalized) || providerNameMatched)
    : [];

  const modelHitsAcrossProviders: FilteredRuntimeCatalog["modelHitsAcrossProviders"] = [];
  for (const p of profiles) {
    if (!p.enabled || p.provider === activeProvider) continue;
    const otherProviderNameMatched = textMatchesQuery(p.label, normalized);
    for (const m of p.models) {
      if (modelMatchesQuery(m, normalized) || otherProviderNameMatched) {
        modelHitsAcrossProviders.push({
          provider: p.provider,
          providerLabel: p.label,
          providerColor: p.color,
          option: m,
        });
      }
    }
  }

  return { providers, models, modelHitsAcrossProviders };
}

/** Normalize effort for storage; empty/default → null. */
export function normalizeEffort(
  _provider: ChatProvider,
  effort: string | null | undefined,
  model?: ProviderModelOption,
): EffortLevel | null {
  if (!effort) return null;
  const levels = model?.effortLevels ?? [];
  const matched = levels.find((level) => level.localeCompare(effort, undefined, {
    sensitivity: "accent",
  }) === 0);
  return matched ?? null;
}

export function normalizeSpeed(
  _provider: ChatProvider,
  _speed: string | null | undefined,
): SpeedLevel | null {
  // No provider currently reports a separate speed capability through Maxx's
  // catalog contract. Cursor encodes speed in its discovered model IDs.
  return null;
}

/**
 * Pure serialization of selection into launch-oriented flags/params.
 * Used by tests and as documentation of the contract; engines mirror this.
 */
export function encodeLaunchHints(
  selection: RuntimeSelection,
  discoveredModel?: ProviderModelOption,
): {
  model: string | null;
  flags: string[];
  params: Record<string, string>;
} {
  const model =
    !selection.model || selection.model.toLowerCase() === "default"
      ? null
      : selection.model;
  const flags: string[] = [];
  const params: Record<string, string> = {};
  const effort = normalizeEffort(
    selection.provider,
    selection.effort ?? null,
    discoveredModel,
  );
  const speed = normalizeSpeed(selection.provider, selection.speed ?? null);

  switch (selection.provider) {
    case "claude":
      if (model) {
        flags.push("--model", model);
      }
      if (effort) {
        flags.push("--effort", effort);
        params.effort = effort;
      }
      break;
    case "grok":
      if (model) {
        flags.push("--model", model);
      }
      if (effort) {
        flags.push("--reasoning-effort", effort);
        params.reasoningEffort = effort;
      }
      break;
    case "codex":
      if (model) {
        params.model = model;
      }
      if (effort) {
        params.model_reasoning_effort = effort;
      }
      break;
    case "pi":
      if (model) {
        flags.push("--model", model);
      }
      if (effort) {
        flags.push("--thinking", effort);
        params.thinking = effort;
      }
      break;
    case "cursor":
      if (model) {
        flags.push("--model", model);
        params.model = model;
      }
      break;
    case "opencode":
      if (model) {
        params.model = model;
      }
      break;
    case "hermes":
      // Hermes picks its model in its own config (`hermes model`); the ACP
      // server accepts no model or effort flags.
      break;
  }

  if (speed) {
    params.speed = speed;
  }

  return { model, flags, params };
}

export function selectionKey(selection: RuntimeSelection): string {
  return [
    selection.provider,
    selection.model || "Default",
    selection.effort || "",
    selection.speed || "",
  ].join("|");
}

const LEGACY_RECENTS_STORAGE_KEY = "maxx.runtime.recents.v1";
const RECENTS_STORAGE_KEY = "maxx.runtime.recents.v2";
const DEFAULT_RECENTS_CONTEXT = "__legacy_global__";
export const MAX_RECENTS = 3;

interface StoredRecentContexts {
  version: 2;
  contexts: Record<string, RuntimeRecentSelection[]>;
}

function recentContextKey(contextKey: string | undefined): string {
  const normalized = contextKey?.trim();
  return normalized || DEFAULT_RECENTS_CONTEXT;
}

function sanitizeRecents(value: unknown): RuntimeRecentSelection[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is RuntimeRecentSelection =>
        !!item &&
        typeof item === "object" &&
        ALL_PROVIDERS.includes((item as RuntimeRecentSelection).provider) &&
        typeof (item as RuntimeRecentSelection).model === "string",
    )
    .map((item) => ({
      provider: item.provider,
      model: item.model || "Default",
      effort: item.effort ?? null,
      speed: item.speed ?? null,
      ...(item.source === "catalog" || item.source === "custom" ? { source: item.source } : {}),
    }))
    .slice(0, MAX_RECENTS);
}

function readRecentContexts(): StoredRecentContexts {
  if (typeof localStorage === "undefined") return { version: 2, contexts: {} };
  const raw = localStorage.getItem(RECENTS_STORAGE_KEY);
  if (!raw) return { version: 2, contexts: {} };
  const parsed = JSON.parse(raw) as Partial<StoredRecentContexts>;
  if (parsed?.version !== 2 || !parsed.contexts || typeof parsed.contexts !== "object") {
    return { version: 2, contexts: {} };
  }
  return { version: 2, contexts: parsed.contexts };
}

function writeRecentContexts(store: StoredRecentContexts): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(store));
}

/** Load recents scoped to a working-directory/profile context. */
export function loadRecents(contextKey?: string): RuntimeRecentSelection[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const key = recentContextKey(contextKey);
    const store = readRecentContexts();
    if (Object.prototype.hasOwnProperty.call(store.contexts, key)) {
      return sanitizeRecents(store.contexts[key]);
    }

    // One-time migration: old builds stored one unscoped array. Assign it to
    // the first context that loads it, then remove the legacy key so it cannot
    // leak into every project/profile.
    const legacyRaw = localStorage.getItem(LEGACY_RECENTS_STORAGE_KEY);
    if (!legacyRaw) return [];
    const migrated = sanitizeRecents(JSON.parse(legacyRaw));
    store.contexts[key] = migrated;
    writeRecentContexts(store);
    localStorage.removeItem(LEGACY_RECENTS_STORAGE_KEY);
    return migrated;
  } catch {
    return [];
  }
}

export function pushRecent(
  selection: RuntimeSelection | RuntimeRecentSelection,
  contextKey: string,
  existing?: RuntimeRecentSelection[],
  source?: RuntimeRecentSource,
): RuntimeRecentSelection[];
/** @deprecated Pass a context key as the second argument. */
export function pushRecent(
  selection: RuntimeSelection | RuntimeRecentSelection,
  existing?: RuntimeRecentSelection[],
): RuntimeRecentSelection[];
export function pushRecent(
  selection: RuntimeSelection | RuntimeRecentSelection,
  contextKeyOrExisting?: string | RuntimeRecentSelection[],
  existing?: RuntimeRecentSelection[],
  source?: RuntimeRecentSource,
): RuntimeRecentSelection[] {
  const contextKey =
    typeof contextKeyOrExisting === "string" ? contextKeyOrExisting : DEFAULT_RECENTS_CONTEXT;
  const suppliedExisting = Array.isArray(contextKeyOrExisting) ? contextKeyOrExisting : existing;
  const key = selectionKey(selection);
  const base = suppliedExisting ?? loadRecents(contextKey);
  const selectionSource =
    source ?? ("source" in selection ? selection.source : undefined);
  const next = [
    {
      provider: selection.provider,
      model: selection.model || "Default",
      effort: selection.effort || null,
      speed: selection.speed || null,
      ...(selectionSource ? { source: selectionSource } : {}),
    },
    ...base.filter((item) => selectionKey(item) !== key),
  ].slice(0, MAX_RECENTS);
  try {
    if (typeof localStorage !== "undefined") {
      const store = readRecentContexts();
      store.contexts[recentContextKey(contextKey)] = next;
      writeRecentContexts(store);
    }
  } catch {
    // ignore quota / private mode
  }
  return next;
}

export function clearRecents(contextKey?: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(LEGACY_RECENTS_STORAGE_KEY);
      if (contextKey === undefined) {
        localStorage.removeItem(RECENTS_STORAGE_KEY);
        return;
      }
      const store = readRecentContexts();
      delete store.contexts[recentContextKey(contextKey)];
      if (Object.keys(store.contexts).length === 0) {
        localStorage.removeItem(RECENTS_STORAGE_KEY);
      } else {
        writeRecentContexts(store);
      }
    }
  } catch {
    // ignore
  }
}
