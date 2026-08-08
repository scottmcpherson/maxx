import {
  type CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ALL_PROVIDERS,
  ChatProvider,
  ProviderProfile,
  providerDisplayName,
} from "../contract/types";
import {
  EffortLevel,
  ProviderModelOption,
  RuntimeRecentSelection,
  RuntimeRecentSource,
  RuntimeSelection,
  SpeedLevel,
  filterRuntimeCatalog,
  formatEffortLabel,
  formatTriggerLabel,
  formatTriggerText,
  loadRecents,
  normalizeEffort,
  normalizeSpeed,
  preferredModel,
  pushRecent,
  resolveModels,
  selectionKey,
  type SearchableProviderRow,
} from "../runtime/modelCatalog";
import {
  providerCatalogContextKey,
  readCachedCatalog,
  useModelCatalogStore,
} from "../store/modelCatalogStore";
import { Icons } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";

export type RuntimePickerChange = RuntimeSelection;

interface RuntimePickerProps {
  provider: ChatProvider;
  model: string;
  effort?: string | null;
  speed?: string | null;
  profiles: ProviderProfile[];
  workingDirectory?: string | null;
  disabled?: boolean;
  placement?: "top" | "bottom";
  /** Prefix the trigger with the provider name (settings-style contexts). */
  triggerShowsProvider?: boolean;
  onChange: (next: RuntimePickerChange) => void;
}

interface DraftRuntimeSelection extends RuntimeSelection {
  source: RuntimeRecentSource;
}

interface PopoverLayout {
  placement: "top" | "bottom";
  left: number;
  maxHeight: number;
  overlap: number;
}

interface SearchResult {
  provider: ChatProvider;
  providerLabel: string;
  option: ProviderModelOption;
}

type RuntimeRailSelection = ChatProvider | "recents";

const PROVIDER_RAIL_BASE_HEIGHT = 52;
const PROVIDER_RAIL_ROW_HEIGHT = 33;
const POPOVER_FIXED_CHROME_HEIGHT = 145;

function selectionDisplayText(
  selection: RuntimeSelection,
  options?: ProviderModelOption[],
): string {
  const { model, knobs } = formatTriggerLabel(selection, options);
  return [model, ...knobs].join(" · ");
}

export function RuntimePicker({
  provider,
  model,
  effort = null,
  speed = null,
  profiles,
  workingDirectory = null,
  disabled = false,
  placement = "top",
  triggerShowsProvider = false,
  onChange,
}: RuntimePickerProps) {
  const committedSelection = useMemo<RuntimeSelection>(() => ({
    provider,
    model: model || "Default",
    effort: (effort as EffortLevel | null) || null,
    speed: (speed as SpeedLevel | null) || null,
  }), [effort, model, provider, speed]);

  const recentsContextKey = useMemo(() => JSON.stringify({
    workingDirectory: workingDirectory ?? "",
    profiles: profiles.map((profile) => ({
      id: profile.id,
      provider: profile.provider,
    })),
  }), [profiles, workingDirectory]);

  const catalogContextKey = useMemo(
    () => providerCatalogContextKey(profiles, workingDirectory),
    [profiles, workingDirectory],
  );
  const cachedCatalogEntries = useMemo(
    () => readCachedCatalog(catalogContextKey),
    [catalogContextKey],
  );
  const catalogContext = useModelCatalogStore((state) => state.contexts[catalogContextKey]);
  const ensureCatalogModels = useModelCatalogStore((state) => state.ensureModels);
  const prefetchCatalogs = useModelCatalogStore((state) => state.prefetch);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<DraftRuntimeSelection>({
    ...committedSelection,
    source: "catalog",
  });
  const [recents, setRecents] = useState<RuntimeRecentSelection[]>(() =>
    loadRecents(recentsContextKey));
  const [railSelection, setRailSelection] = useState<RuntimeRailSelection>(provider);
  const [popoverLayout, setPopoverLayout] = useState<PopoverLayout>({
    placement,
    left: 0,
    maxHeight: 680,
    overlap: 0,
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogEntries = catalogContext?.entries ?? cachedCatalogEntries;

  useEffect(() => {
    setRecents(loadRecents(recentsContextKey));
  }, [recentsContextKey]);

  const ensureModels = useCallback((target: ChatProvider, force = false): Promise<void> =>
    ensureCatalogModels({
      contextKey: catalogContextKey,
      provider: target,
      profiles,
      workingDirectory,
      force,
    }), [catalogContextKey, ensureCatalogModels, profiles, workingDirectory]);

  const profileRows: SearchableProviderRow[] = useMemo(() => {
    return ALL_PROVIDERS.map((candidate) => {
      const profile = profiles.find((item) => item.provider === candidate);
      return {
        provider: candidate,
        label: profile?.displayName || providerDisplayName(candidate),
        enabled: profile?.isEnabled ?? true,
        color: profile?.colorHex ?? "#8b8b8b",
        models: resolveModels(candidate, catalogEntries[candidate]?.models),
      };
    });
  }, [catalogEntries, profiles]);

  const activeDraftModels = resolveModels(draft.provider, catalogEntries[draft.provider]?.models);
  const triggerModels = resolveModels(provider, catalogEntries[provider]?.models);
  const triggerText = formatTriggerText(committedSelection, triggerModels);
  const providerTriggerLabel = triggerShowsProvider
    ? profiles.find((profile) => profile.provider === provider)?.displayName
      || providerDisplayName(provider)
    : null;
  const triggerDisplayText = providerTriggerLabel
    ? `${providerTriggerLabel} · ${selectionDisplayText(committedSelection, triggerModels)}`
    : selectionDisplayText(committedSelection, triggerModels);
  const draftText = formatTriggerText(draft, activeDraftModels);
  const draftDisplayText = selectionDisplayText(draft, activeDraftModels);
  const activeDraftModel = activeDraftModels.find((option) => option.model === draft.model);
  const draftEffortLevels = activeDraftModel?.effortLevels?.length
    ? activeDraftModel.effortLevels
    : null;

  const filtered = useMemo(
    () => filterRuntimeCatalog(profileRows, draft.provider, query),
    [draft.provider, profileRows, query],
  );
  const providerRailHeight = PROVIDER_RAIL_BASE_HEIGHT
    + Math.max(filtered.providers.length, 1) * PROVIDER_RAIL_ROW_HEIGHT;
  const desiredPopoverHeight = POPOVER_FIXED_CHROME_HEIGHT + providerRailHeight;

  const searchResults = useMemo<SearchResult[]>(() => {
    if (!query.trim()) return [];
    const activeProfile = profileRows.find((row) => row.provider === draft.provider);
    const activeHits = filtered.models.map((option) => ({
      provider: draft.provider,
      providerLabel: activeProfile?.label ?? providerDisplayName(draft.provider),
      option,
    }));
    return [...activeHits, ...filtered.modelHitsAcrossProviders];
  }, [draft.provider, filtered.modelHitsAcrossProviders, filtered.models, profileRows, query]);

  const visibleRecents = useMemo(() => recents.filter((recent) => {
    const row = profileRows.find((candidate) => candidate.provider === recent.provider);
    if (!row?.enabled) return false;
    if (recent.source === "custom") return true;
    const entry = catalogEntries[recent.provider];
    if (entry?.status !== "live" && entry?.status !== "cached") return false;
    return entry.models?.some((option) => option.model === recent.model) ?? false;
  }), [catalogEntries, profileRows, recents]);

  const enabledProviders = useMemo(
    () => profileRows.filter((row) => row.enabled).map((row) => row.provider),
    [profileRows],
  );
  const queryLoading = !!query.trim() && enabledProviders.some((candidate) => {
    const status = catalogEntries[candidate]?.status ?? "idle";
    return status === "idle" || status === "loading";
  });
  const unavailableProviders = enabledProviders.filter((candidate) =>
    catalogEntries[candidate]?.status === "unavailable");

  useEffect(() => {
    void prefetchCatalogs({
      contextKey: catalogContextKey,
      providers: enabledProviders,
      profiles,
      workingDirectory,
    });
  }, [catalogContextKey, enabledProviders, prefetchCatalogs, profiles, workingDirectory]);

  useEffect(() => {
    if (!open) return;
    const entry = catalogEntries[draft.provider];
    if ((entry?.status !== "live" && entry?.status !== "cached") || !entry.models.length) return;
    const selectedModel = entry.models.find((option) => option.model === draft.model);
    if (selectedModel) {
      setDraft((current) => current.provider === draft.provider
        ? {
            ...current,
            source: "catalog",
            effort: normalizeEffort(current.provider, current.effort, selectedModel),
          }
        : current);
      return;
    }
    if (draft.source !== "catalog") return;
    const nextModel = preferredModel(entry.models);
    const nextOption = entry.models.find((option) => option.model === nextModel);
    setDraft((current) => current.provider === draft.provider && current.source === "catalog"
      ? {
          ...current,
          model: nextModel,
          effort: normalizeEffort(current.provider, current.effort, nextOption),
        }
      : current);
  }, [catalogEntries, draft.model, draft.provider, draft.source, open]);

  useEffect(() => {
    if (!disabled || !open) return;
    setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updateLayout = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportPadding = 12;
      const anchorGap = 7;
      const above = Math.max(0, rect.top - viewportPadding - anchorGap);
      const below = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - anchorGap);
      const preferredSpace = placement === "top" ? above : below;
      const alternateSpace = placement === "top" ? below : above;
      const effectivePlacement = preferredSpace >= desiredPopoverHeight || preferredSpace >= alternateSpace
        ? placement
        : placement === "top" ? "bottom" : "top";
      const availableHeight = effectivePlacement === "top" ? above : below;
      // When the anchored side is too short but the viewport itself can fit
      // the popover, slide it over the anchor instead of clipping rows.
      const viewportCap = window.innerHeight - viewportPadding * 2;
      const overlap = Math.max(
        0,
        Math.min(desiredPopoverHeight, viewportCap, 680) - availableHeight,
      );
      const width = Math.min(420, window.innerWidth - viewportPadding * 2);
      const minimumLeft = viewportPadding - rect.left;
      const maximumLeft = window.innerWidth - viewportPadding - width - rect.left;
      setPopoverLayout({
        placement: effectivePlacement,
        left: Math.min(Math.max(0, minimumLeft), maximumLeft),
        maxHeight: Math.max(0, Math.min(680, availableHeight + overlap)),
        overlap,
      });
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, [desiredPopoverHeight, open, placement, query]);

  const restoreTriggerFocus = () => {
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const closeAndRestoreFocus = () => {
    setOpen(false);
    setQuery("");
    restoreTriggerFocus();
  };

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery("");
      restoreTriggerFocus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const openPicker = () => {
    const knownModels = resolveModels(provider, catalogEntries[provider]?.models);
    const source = committedSelection.model.toLowerCase() === "default"
      || knownModels.some((option) => option.model === committedSelection.model)
      ? "catalog"
      : "custom";
    setDraft({ ...committedSelection, source });
    setQuery("");
    setRailSelection(provider);
    setOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const togglePicker = () => {
    if (open) {
      setOpen(false);
      return;
    }
    openPicker();
  };

  const chooseProvider = (nextProvider: ChatProvider) => {
    const row = profileRows.find((candidate) => candidate.provider === nextProvider);
    if (!row?.enabled) return;
    const models = resolveModels(nextProvider, catalogEntries[nextProvider]?.models);
    const nextModel = preferredModel(models);
    setDraft({
      provider: nextProvider,
      model: nextModel,
      effort: null,
      speed: null,
      source: "catalog",
    });
    setQuery("");
    setRailSelection(nextProvider);
    void ensureModels(nextProvider);
  };

  const chooseModel = (nextProvider: ChatProvider, nextModel: string) => {
    const providerChanged = nextProvider !== draft.provider;
    const nextOption = catalogEntries[nextProvider]?.models?.find(
      (option) => option.model === nextModel,
    );
    setDraft((current) => ({
      provider: nextProvider,
      model: nextModel,
      effort: providerChanged
        ? null
        : normalizeEffort(nextProvider, current.effort, nextOption),
      speed: providerChanged ? null : normalizeSpeed(nextProvider, current.speed),
      source: "catalog",
    }));
    setQuery("");
    setRailSelection(nextProvider);
    void ensureModels(nextProvider);
  };

  const chooseRecent = (recent: RuntimeRecentSelection) => {
    const row = profileRows.find((candidate) => candidate.provider === recent.provider);
    if (!row?.enabled) return;
    const entry = catalogEntries[recent.provider];
    if (recent.source !== "custom") {
      if (entry?.status !== "live" && entry?.status !== "cached") return;
      if (!entry.models?.some((option) => option.model === recent.model)) return;
    }
    setDraft({
      provider: recent.provider,
      model: recent.model,
      effort: normalizeEffort(
        recent.provider,
        recent.effort,
        entry?.models?.find((option) => option.model === recent.model),
      ),
      speed: normalizeSpeed(recent.provider, recent.speed),
      source: recent.source ?? "catalog",
    });
    setQuery("");
    void ensureModels(recent.provider);
  };

  const setEffort = (value: EffortLevel | null) => {
    setDraft((current) => ({ ...current, effort: value }));
  };

  const applyDraft = () => {
    const selectedModel = catalogEntries[draft.provider]?.models?.find(
      (option) => option.model === draft.model,
    );
    const cleaned: RuntimePickerChange = {
      provider: draft.provider,
      model: draft.model || "Default",
      effort: normalizeEffort(draft.provider, draft.effort, selectedModel),
      speed: normalizeSpeed(draft.provider, draft.speed),
    };
    onChange(cleaned);
    setRecents(pushRecent(
      cleaned as RuntimeSelection,
      recentsContextKey,
      recents,
      draft.source,
    ));
    closeAndRestoreFocus();
  };

  const handlePopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" && target !== searchRef.current) return;
    const navigable = Array.from(
      popoverRef.current?.querySelectorAll<HTMLElement>("[data-runtime-navigable]:not(:disabled)") ?? [],
    );
    if (navigable.length === 0) return;
    event.preventDefault();
    const currentIndex = navigable.indexOf(target);
    const nextIndex = event.key === "ArrowDown"
      ? currentIndex < 0 || currentIndex === navigable.length - 1 ? 0 : currentIndex + 1
      : currentIndex <= 0 ? navigable.length - 1 : currentIndex - 1;
    navigable[nextIndex]?.focus();
  };

  const hasChanges = selectionKey(draft) !== selectionKey(committedSelection);
  const selectedProviderEnabled = profileRows.find((row) => row.provider === draft.provider)?.enabled ?? false;
  const selectedCatalogEntry = catalogEntries[draft.provider];
  const selectedCatalogPending = draft.source === "catalog"
    && selectedCatalogEntry?.status !== "live"
    && selectedCatalogEntry?.status !== "cached";
  const showingRecents = !query.trim() && railSelection === "recents";

  return (
    <div className="runtime-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="runtime-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Provider and model selection: ${triggerText}`}
        disabled={disabled}
        onClick={togglePicker}
      >
        <ProviderIcon provider={provider} size={15} />
        <span className="runtime-trigger-text">{triggerDisplayText}</span>
        <Icons.chevronDown size={12} />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className={`runtime-popover placement-${popoverLayout.placement}`}
          role="dialog"
          aria-modal="false"
          aria-label="Provider and model selection"
          style={{
            left: popoverLayout.left,
            maxHeight: popoverLayout.maxHeight,
            "--runtime-popover-height": `${desiredPopoverHeight}px`,
            "--runtime-provider-rail-height": `${providerRailHeight}px`,
            "--runtime-popover-overlap": `${popoverLayout.overlap}px`,
          } as CSSProperties}
          onKeyDown={handlePopoverKeyDown}
          onMouseDown={(event) => {
            // Buttons must not take focus on click: focusing a partially
            // clipped rail button auto-scrolls the rail (icons visibly jump),
            // and it steals focus from the search field. Keyboard navigation
            // still focuses buttons explicitly via handlePopoverKeyDown.
            if ((event.target as HTMLElement).closest("button")) event.preventDefault();
          }}
        >
          <label className="runtime-search">
            <Icons.search size={13} />
            <input
              ref={searchRef}
              value={query}
              aria-label="Search models and providers"
              placeholder="Search models, providers…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="runtime-columns">
            <div className="runtime-col providers">
              <div
                className="runtime-options runtime-provider-rail"
                role="group"
                aria-label="Recent selections and providers"
              >
                <button
                  type="button"
                  className={`runtime-option ${showingRecents ? "selected" : ""}`}
                  disabled={visibleRecents.length === 0}
                  aria-pressed={showingRecents}
                  aria-label="Recent selections"
                  data-tooltip={visibleRecents.length > 0 ? "Recent selections" : "No recent selections"}
                  data-runtime-navigable
                  onClick={() => {
                    setRailSelection("recents");
                    setQuery("");
                  }}
                >
                  <Icons.history size={19} />
                </button>
                <div className="runtime-provider-rail-divider" aria-hidden="true" />
                {filtered.providers.map((item) => {
                  const selected = !query.trim() && railSelection === item.provider;
                  return (
                    <button
                      type="button"
                      key={item.provider}
                      className={`runtime-option ${selected ? "selected" : ""}`}
                      disabled={!item.enabled}
                      aria-pressed={selected}
                      aria-label={`${item.label}${item.enabled ? "" : " (disabled)"}`}
                      data-tooltip={`${item.label}${item.enabled ? "" : " — Disabled"}`}
                      data-runtime-navigable
                      onClick={() => chooseProvider(item.provider)}
                    >
                      <ProviderIcon provider={item.provider} size={20} />
                    </button>
                  );
                })}
                {filtered.providers.length === 0 && (
                  <div className="runtime-empty">No providers match.</div>
                )}
              </div>
            </div>

            <div className="runtime-col models">
              <div className="runtime-section-label">
                {query.trim() ? "Results" : showingRecents ? "Recent" : "Models"}
              </div>
              <div className={`runtime-options runtime-model-list ${showingRecents ? "runtime-recent-list" : ""}`}>
                {query.trim() ? searchResults.map((result) => {
                  const selected = result.provider === draft.provider && result.option.model === draft.model;
                  return (
                    <button
                      type="button"
                      key={`${result.provider}:${result.option.model}`}
                      className={`runtime-option ${selected ? "selected" : ""}`}
                      aria-pressed={selected}
                      aria-label={`${result.providerLabel} · ${result.option.displayName}`}
                      data-runtime-navigable
                      title={[result.providerLabel, result.option.description]
                        .filter(Boolean).join(" · ")}
                      onClick={() => chooseModel(result.provider, result.option.model)}
                    >
                      <ProviderIcon provider={result.provider} size={15} />
                      <span className="runtime-option-main">
                        <span>{result.option.displayName}</span>
                        {result.option.description && (
                          <span className="runtime-option-desc">{result.option.description}</span>
                        )}
                      </span>
                      {selected && <Icons.check size={14} />}
                    </button>
                  );
                }) : showingRecents ? visibleRecents.map((recent) => {
                  const recentModels = resolveModels(
                    recent.provider,
                    catalogEntries[recent.provider]?.models,
                  );
                  const label = selectionDisplayText(recent, recentModels);
                  const selected = selectionKey(recent) === selectionKey(draft);
                  return (
                    <button
                      type="button"
                      key={`${recent.provider}-${recent.model}-${recent.effort ?? ""}-${recent.speed ?? ""}`}
                      className={`runtime-option ${selected ? "selected" : ""}`}
                      aria-pressed={selected}
                      aria-label={`${providerDisplayName(recent.provider)} · ${label}`}
                      data-runtime-navigable
                      onClick={() => chooseRecent(recent)}
                    >
                      <ProviderIcon provider={recent.provider} size={15} />
                      <span className="runtime-option-main">{label}</span>
                      {selected && <Icons.check size={14} />}
                    </button>
                  );
                }) : activeDraftModels.map((option) => {
                  const selected = option.model === draft.model
                    || (draft.model.toLowerCase() === "default"
                      && option.model.toLowerCase() === "default");
                  return (
                    <button
                      type="button"
                      key={option.model}
                      className={`runtime-option ${selected ? "selected" : ""}`}
                      aria-pressed={selected}
                      data-runtime-navigable
                      title={option.description}
                      onClick={() => chooseModel(draft.provider, option.model)}
                    >
                      <span className="runtime-option-main">
                        <span>{option.displayName}</span>
                        {option.description && (
                          <span className="runtime-option-desc">{option.description}</span>
                        )}
                      </span>
                      {selected && <Icons.check size={14} />}
                    </button>
                  );
                })}

                {query.trim() && searchResults.length === 0 && !queryLoading && (
                  <div className="runtime-empty">No models or providers match “{query}”.</div>
                )}
              </div>

              {!query.trim() && !showingRecents && selectedCatalogEntry?.status === "unavailable" && (
                <div className="runtime-status error" role="status">
                  <span>
                    Model discovery failed. No substitute models are being shown.
                    {selectedCatalogEntry.error ? ` ${selectedCatalogEntry.error}` : ""}
                  </span>
                  <button
                    type="button"
                    className="runtime-status-retry"
                    data-runtime-navigable
                    onClick={() => void ensureModels(draft.provider, true)}
                  >
                    Retry
                  </button>
                </div>
              )}
              {!!query.trim() && unavailableProviders.length > 0 && !queryLoading && (
                <div className="runtime-status error" role="status">
                  Some provider catalogs could not be loaded; no substitute models are included.
                </div>
              )}
            </div>
          </div>

          <div className="runtime-effort-slot">
            <div className="runtime-knobs">
              <div className="runtime-knob-row" role="group" aria-label="Effort">
                <span className="runtime-section-label">Effort</span>
                {draftEffortLevels ? (
                  <div className="runtime-segmented">
                    <button
                      type="button"
                      className={`runtime-seg ${!draft.effort ? "selected" : ""}`}
                      aria-pressed={!draft.effort}
                      title="Use the provider's default effort"
                      data-runtime-navigable
                      onClick={() => setEffort(null)}
                    >
                      Auto
                    </button>
                    {draftEffortLevels.map((level) => (
                      <button
                        type="button"
                        key={level}
                        className={`runtime-seg ${draft.effort === level ? "selected" : ""}`}
                        aria-pressed={draft.effort === level}
                        data-runtime-navigable
                        onClick={() => setEffort(level)}
                      >
                        {formatEffortLabel(level)}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="runtime-effort-empty">
                    {selectedCatalogEntry?.status === "live"
                      || selectedCatalogEntry?.status === "cached"
                      ? "No configurable effort"
                      : ""}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="runtime-footer">
            <span
              key={`${draft.provider}:${draft.model}:${draft.effort ?? "auto"}:${draft.speed ?? "normal"}`}
              className="runtime-footer-summary"
              title={draftText}
              aria-live="polite"
            >
              <ProviderIcon provider={draft.provider} size={14} />
              <span>{draftDisplayText}</span>
            </span>
            <div className="runtime-footer-actions">
              <button
                type="button"
                className="runtime-footer-button"
                data-runtime-navigable
                onClick={closeAndRestoreFocus}
              >
                Cancel
              </button>
              <button
                type="button"
                className="runtime-footer-button primary"
                disabled={!hasChanges || !selectedProviderEnabled || selectedCatalogPending}
                data-runtime-navigable
                onClick={applyDraft}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
