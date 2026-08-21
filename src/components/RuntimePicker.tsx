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
import { createPortal } from "react-dom";
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
  filterUnavailableProvidersForQuery,
  formatEffortLabel,
  formatTriggerLabel,
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
import { visibleProviderModels } from "../providerSettings";
import { Icons } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export type RuntimePickerChange = RuntimeSelection;

interface RuntimePickerProps {
  provider: ChatProvider;
  model: string;
  effort?: string | null;
  speed?: string | null;
  profiles: ProviderProfile[];
  workingDirectory?: string | null;
  hostId?: string | null;
  disabled?: boolean;
  placement?: "top" | "bottom";
  triggerVariant?: "control" | "ghost";
  /** Prefix the trigger with the provider name (settings-style contexts). */
  triggerShowsProvider?: boolean;
  /** Optional picker state that delegates selection to a surrounding context. */
  inheritLabel?: string;
  inheritDescription?: string;
  inherited?: boolean;
  onUseInherited?: () => void;
  onChange: (next: RuntimePickerChange) => void;
}

interface DraftRuntimeSelection extends RuntimeSelection {
  source: RuntimeRecentSource;
}

interface PopoverLayout {
  left: number;
  top: number;
  maxHeight: number;
}

interface SearchResult {
  provider: ChatProvider;
  providerLabel: string;
  option: ProviderModelOption;
}

type RuntimeRailSelection = ChatProvider | "recents";

const PROVIDER_RAIL_BASE_HEIGHT = 51;
const PROVIDER_RAIL_ROW_HEIGHT = 35;
const POPOVER_FIXED_CHROME_HEIGHT = 110;

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
  hostId = null,
  disabled = false,
  placement = "top",
  triggerVariant = "control",
  triggerShowsProvider = false,
  inheritLabel,
  inheritDescription,
  inherited = false,
  onUseInherited,
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
    () => providerCatalogContextKey(profiles, workingDirectory, hostId),
    [profiles, workingDirectory, hostId],
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
    left: 0,
    top: 0,
    maxHeight: 680,
  });
  const [popoverChromeHeight, setPopoverChromeHeight] = useState(POPOVER_FIXED_CHROME_HEIGHT);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const inheritRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
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
      hostId,
      force,
    }), [catalogContextKey, ensureCatalogModels, hostId, profiles, workingDirectory]);

  const profileRows: SearchableProviderRow[] = useMemo(() => {
    return ALL_PROVIDERS.map((candidate) => {
      const profile = profiles.find((item) => item.provider === candidate);
      return {
        provider: candidate,
        label: profile?.displayName || providerDisplayName(candidate),
        enabled: profile?.isEnabled ?? true,
        color: profile?.colorHex ?? "var(--muted-foreground)",
        models: visibleProviderModels(
          profile,
          resolveModels(candidate, catalogEntries[candidate]?.models),
        ),
      };
    });
  }, [catalogEntries, profiles]);

  const activeDraftModels = profileRows.find((row) => row.provider === draft.provider)?.models ?? [];
  const triggerModels = resolveModels(provider, catalogEntries[provider]?.models);
  const providerTriggerLabel = triggerShowsProvider
    ? profiles.find((profile) => profile.provider === provider)?.displayName
      || providerDisplayName(provider)
    : null;
  const triggerDisplayText = inherited && inheritLabel
    ? inheritLabel
    : providerTriggerLabel
      ? `${providerTriggerLabel} · ${selectionDisplayText(committedSelection, triggerModels)}`
      : selectionDisplayText(committedSelection, triggerModels);
  const activeDraftModel = activeDraftModels.find((option) => option.model === draft.model);
  const draftEffortLevels = activeDraftModel?.effortLevels?.length
    ? activeDraftModel.effortLevels
    : null;

  const enabledProviders = useMemo(
    () => profileRows.filter((row) => row.enabled).map((row) => row.provider),
    [profileRows],
  );
  const filtered = useMemo(
    () => filterRuntimeCatalog(profileRows, draft.provider, query),
    [draft.provider, profileRows, query],
  );
  // Size the results viewport from the unfiltered provider rail so searching
  // only changes its contents, never the popover frame or anchor placement.
  const providerRailHeight = PROVIDER_RAIL_BASE_HEIGHT
    + Math.max(enabledProviders.length, 1) * PROVIDER_RAIL_ROW_HEIGHT;
  const canInherit = !!inheritLabel && !!onUseInherited;
  const desiredPopoverHeight = popoverChromeHeight + providerRailHeight;

  const searchResults = useMemo<SearchResult[]>(() => {
    if (!query.trim()) return [];
    const activeProfile = profileRows.find((row) => row.provider === draft.provider);
    const activeHits = filtered.models.map((option) => ({
      provider: draft.provider,
      providerLabel: activeProfile?.label ?? providerDisplayName(draft.provider),
      option,
    }));
    const hits = [...activeHits, ...filtered.modelHitsAcrossProviders];
    // Selection changes the active provider. Keep search results in catalog
    // order so the selected row gains its checkmark without jumping position.
    return profileRows.flatMap((row) =>
      hits.filter((result) => result.provider === row.provider));
  }, [draft.provider, filtered.modelHitsAcrossProviders, filtered.models, profileRows, query]);

  const visibleRecents = useMemo(() => recents.filter((recent) => {
    const row = profileRows.find((candidate) => candidate.provider === recent.provider);
    if (!row?.enabled) return false;
    if (recent.source === "custom") return true;
    const entry = catalogEntries[recent.provider];
    if (entry?.status !== "live" && entry?.status !== "cached") return false;
    return row.models.some((option) => option.model === recent.model);
  }), [catalogEntries, profileRows, recents]);

  const queryLoading = !!query.trim() && enabledProviders.some((candidate) => {
    const status = catalogEntries[candidate]?.status ?? "idle";
    return status === "idle" || status === "loading";
  });
  const unavailableProviders = enabledProviders.filter((candidate) =>
    catalogEntries[candidate]?.status === "unavailable");
  const searchUnavailableProviders = filterUnavailableProvidersForQuery(
    profileRows,
    unavailableProviders,
    query,
  );

  useEffect(() => {
    void prefetchCatalogs({
      contextKey: catalogContextKey,
      providers: enabledProviders,
      profiles,
      workingDirectory,
      hostId,
    });
  }, [catalogContextKey, enabledProviders, hostId, prefetchCatalogs, profiles, workingDirectory]);

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
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const measureChrome = () => {
      const popover = popoverRef.current;
      const header = headerRef.current;
      const footer = footerRef.current;
      if (!popover || !header || !footer) return;

      const style = window.getComputedStyle(popover);
      const outerChrome = [
        style.paddingTop,
        style.paddingBottom,
        style.borderTopWidth,
        style.borderBottomWidth,
      ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
      const measured = Math.ceil(
        outerChrome
        + header.getBoundingClientRect().height
        + (inheritRef.current?.getBoundingClientRect().height ?? 0)
        + footer.getBoundingClientRect().height,
      );
      setPopoverChromeHeight((current) => current === measured ? current : measured);
    };

    measureChrome();
    const observer = new ResizeObserver(measureChrome);
    if (headerRef.current) observer.observe(headerRef.current);
    if (inheritRef.current) observer.observe(inheritRef.current);
    if (footerRef.current) observer.observe(footerRef.current);
    return () => observer.disconnect();
  }, [canInherit, draftEffortLevels, open]);

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
      const maxHeight = Math.max(0, Math.min(680, availableHeight + overlap));
      const popoverHeight = Math.min(desiredPopoverHeight, maxHeight);
      const left = Math.min(
        Math.max(rect.left, viewportPadding),
        window.innerWidth - viewportPadding - width,
      );
      const top = effectivePlacement === "top"
        ? rect.top - anchorGap + overlap - popoverHeight
        : rect.bottom + anchorGap - overlap;
      setPopoverLayout({
        left,
        top: Math.min(
          Math.max(top, viewportPadding),
          window.innerHeight - viewportPadding - popoverHeight,
        ),
        maxHeight,
      });
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    window.addEventListener("scroll", updateLayout, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("scroll", updateLayout, true);
    };
  }, [desiredPopoverHeight, open, placement]);

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
    const nextModel = preferredModel(row.models);
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
    const nextDraft: DraftRuntimeSelection = {
      provider: nextProvider,
      model: nextModel,
      effort: providerChanged
        ? null
        : normalizeEffort(nextProvider, draft.effort, nextOption),
      speed: providerChanged ? null : normalizeSpeed(nextProvider, draft.speed),
      source: "catalog",
    };
    setDraft(nextDraft);
    setRailSelection(nextProvider);
    void ensureModels(nextProvider);
    commitSelection(nextDraft);
  };

  const chooseRecent = (recent: RuntimeRecentSelection) => {
    const row = profileRows.find((candidate) => candidate.provider === recent.provider);
    if (!row?.enabled) return;
    const entry = catalogEntries[recent.provider];
    if (recent.source !== "custom") {
      if (entry?.status !== "live" && entry?.status !== "cached") return;
      if (!entry.models?.some((option) => option.model === recent.model)) return;
    }
    const nextDraft: DraftRuntimeSelection = {
      provider: recent.provider,
      model: recent.model,
      effort: normalizeEffort(
        recent.provider,
        recent.effort,
        entry?.models?.find((option) => option.model === recent.model),
      ),
      speed: normalizeSpeed(recent.provider, recent.speed),
      source: recent.source ?? "catalog",
    };
    setDraft(nextDraft);
    setQuery("");
    void ensureModels(recent.provider);
    commitSelection(nextDraft);
  };

  const setEffort = (value: EffortLevel | null) => {
    const nextDraft = { ...draft, effort: value };
    setDraft(nextDraft);
    commitSelection(nextDraft);
  };

  const commitSelection = (selection: DraftRuntimeSelection) => {
    const selectedModel = catalogEntries[selection.provider]?.models?.find(
      (option) => option.model === selection.model,
    );
    const cleaned: RuntimePickerChange = {
      provider: selection.provider,
      model: selection.model || "Default",
      effort: normalizeEffort(selection.provider, selection.effort, selectedModel),
      speed: normalizeSpeed(selection.provider, selection.speed),
    };
    onChange(cleaned);
    setRecents(pushRecent(
      cleaned,
      recentsContextKey,
      recents,
      selection.source,
    ));
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

  const selectedCatalogEntry = catalogEntries[draft.provider];
  const showingRecents = !query.trim() && railSelection === "recents";

  return (
    <div className="runtime-picker" ref={rootRef}>
      <Button
        ref={triggerRef}
        type="button"
        variant={triggerVariant}
        className="w-full justify-start"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Provider and model selection: ${triggerDisplayText}`}
        disabled={disabled}
        onClick={togglePicker}
      >
        {inherited ? <Icons.shuffle data-icon="inline-start" /> : <ProviderIcon provider={provider} size={15} />}
        <span className="min-w-0 flex-1 truncate text-left">{triggerDisplayText}</span>
        <Icons.chevronDown data-icon="inline-end" />
      </Button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className="runtime-popover"
          role="dialog"
          aria-modal="false"
          aria-label="Provider and model selection"
          style={{
            left: popoverLayout.left,
            top: popoverLayout.top,
            maxHeight: popoverLayout.maxHeight,
            "--runtime-popover-height": `${desiredPopoverHeight}px`,
            "--runtime-provider-rail-height": `${providerRailHeight}px`,
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
          <div ref={headerRef}>
            <Field>
              <FieldLabel htmlFor="runtime-search" className="sr-only">Search models and providers</FieldLabel>
              <div className="relative">
                <Icons.search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="runtime-search"
                  variant="ghost"
                  className="pl-8"
                  ref={searchRef}
                  value={query}
                  aria-label="Search models and providers"
                  placeholder="Search models, providers…"
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </Field>
          </div>

          {canInherit && (
            <div ref={inheritRef} className="runtime-inherit-option">
              <Button
                type="button"
                variant={inherited ? "secondary" : "ghost"}
                className="h-auto w-full justify-start text-left"
                aria-pressed={inherited}
                data-runtime-navigable
                onClick={() => {
                  onUseInherited();
                }}
              >
                <Icons.shuffle data-icon="inline-start" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span>{inheritLabel}</span>
                  {inheritDescription && (
                    <span className="text-xs text-muted-foreground">{inheritDescription}</span>
                  )}
                </span>
                {inherited && <Icons.check aria-hidden="true" />}
              </Button>
            </div>
          )}

          <div className="runtime-columns">
            <div className="runtime-col providers">
              <div
                className="runtime-options runtime-provider-rail"
                role="group"
                aria-label="Recent selections and providers"
              >
                <Button
                  type="button"
                  variant={showingRecents ? "secondary" : "ghost"}
                  className="h-auto min-h-8 w-full justify-center"
                  disabled={visibleRecents.length === 0}
                  aria-pressed={showingRecents}
                  aria-label="Recent selections"
                  title={visibleRecents.length > 0 ? "Recent selections" : "No recent selections"}
                  data-runtime-navigable
                  onClick={() => {
                    setRailSelection("recents");
                    setQuery("");
                  }}
                >
                  <Icons.history />
                </Button>
                <div className="runtime-provider-rail-divider" aria-hidden="true" />
                {filtered.providers.map((item) => {
                  const selected = !query.trim() && railSelection === item.provider;
                  return (
                    <Button
                      type="button"
                      key={item.provider}
                      variant={selected ? "secondary" : "ghost"}
                      className="h-auto min-h-8 w-full justify-center"
                      disabled={!item.enabled}
                      aria-pressed={selected}
                      aria-label={`${item.label}${item.enabled ? "" : " (disabled)"}`}
                      title={`${item.label}${item.enabled ? "" : " — Disabled"}`}
                      data-runtime-navigable
                      onClick={() => chooseProvider(item.provider)}
                    >
                      <ProviderIcon provider={item.provider} size={20} />
                    </Button>
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
                    <Button
                      type="button"
                      key={`${result.provider}:${result.option.model}`}
                      variant={selected ? "secondary" : "ghost"}
                      className="h-auto min-h-8 w-full min-w-0 justify-start overflow-hidden text-left"
                      aria-pressed={selected}
                      aria-label={`${result.providerLabel} · ${result.option.displayName}`}
                      data-runtime-navigable
                      title={[result.providerLabel, result.option.description]
                        .filter(Boolean).join(" · ")}
                      onClick={() => chooseModel(result.provider, result.option.model)}
                    >
                      <ProviderIcon provider={result.provider} size={15} />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
                        <span className="truncate">{result.option.displayName}</span>
                        {result.option.description && (
                          <span className="truncate text-xs text-muted-foreground">{result.option.description}</span>
                        )}
                      </span>
                      {selected && <Icons.check aria-hidden="true" />}
                    </Button>
                  );
                }) : showingRecents ? visibleRecents.map((recent) => {
                  const recentModels = resolveModels(
                    recent.provider,
                    catalogEntries[recent.provider]?.models,
                  );
                  const label = selectionDisplayText(recent, recentModels);
                  const selected = selectionKey(recent) === selectionKey(draft);
                  return (
                    <Button
                      type="button"
                      key={`${recent.provider}-${recent.model}-${recent.effort ?? ""}-${recent.speed ?? ""}`}
                      variant={selected ? "secondary" : "ghost"}
                      className="h-auto min-h-8 w-full min-w-0 justify-start overflow-hidden text-left"
                      aria-pressed={selected}
                      aria-label={`${providerDisplayName(recent.provider)} · ${label}`}
                      data-runtime-navigable
                      onClick={() => chooseRecent(recent)}
                    >
                      <ProviderIcon provider={recent.provider} size={15} />
                      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                      {selected && <Icons.check aria-hidden="true" />}
                    </Button>
                  );
                }) : activeDraftModels.map((option) => {
                  const selected = option.model === draft.model
                    || (draft.model.toLowerCase() === "default"
                      && option.model.toLowerCase() === "default");
                  return (
                    <Button
                      type="button"
                      key={option.model}
                      variant={selected ? "secondary" : "ghost"}
                      className="h-auto min-h-8 w-full min-w-0 justify-start overflow-hidden text-left"
                      aria-pressed={selected}
                      data-runtime-navigable
                      title={option.description}
                      onClick={() => chooseModel(draft.provider, option.model)}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
                        <span className="truncate">{option.displayName}</span>
                        {option.description && (
                          <span className="truncate text-xs text-muted-foreground">{option.description}</span>
                        )}
                      </span>
                      {selected && <Icons.check aria-hidden="true" />}
                    </Button>
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
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-runtime-navigable
                    onClick={() => void ensureModels(draft.provider, true)}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {!!query.trim() && searchUnavailableProviders.length > 0 && !queryLoading && (
                <div className="runtime-status error" role="status">
                  <span>
                    {searchUnavailableProviders.map((item) => {
                      const error = catalogEntries[item.provider]?.error;
                      return `${item.label}: ${error || "Model discovery failed."}`;
                    }).join(" ")}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div ref={footerRef} className="runtime-effort-slot h-16 min-h-16 shrink-0">
            <div className="runtime-knobs">
              <div className="runtime-knob-row" role="group" aria-label="Effort">
                <span className="runtime-section-label">Effort</span>
                {draftEffortLevels ? (
                  <div className="runtime-segmented">
                    <Button
                      type="button"
                      variant={!draft.effort ? "secondary" : "ghost"}
                      size="sm"
                      className="min-w-0 flex-1 px-1.5"
                      aria-pressed={!draft.effort}
                      title="Use the provider's default effort"
                      data-runtime-navigable
                      onClick={() => setEffort(null)}
                    >
                      Auto
                    </Button>
                    {draftEffortLevels.map((level) => (
                      <Button
                        type="button"
                        key={level}
                        variant={draft.effort === level ? "secondary" : "ghost"}
                        size="sm"
                        className="min-w-0 flex-1 px-1.5"
                        aria-pressed={draft.effort === level}
                        data-runtime-navigable
                        onClick={() => setEffort(level)}
                      >
                        {formatEffortLabel(level)}
                      </Button>
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

        </div>,
        document.body,
      )}
    </div>
  );
}
