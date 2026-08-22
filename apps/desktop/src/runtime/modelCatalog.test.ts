import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  MAX_RECENTS,
  encodeLaunchHints,
  filterRuntimeCatalog,
  filterUnavailableProvidersForQuery,
  formatTriggerText,
  loadRecents,
  normalizeEffort,
  preferredModel,
  pushRecent,
  resolveModels,
  selectionKey,
  type ProviderModelOption,
  type SearchableProviderRow,
} from "./modelCatalog";

const grokModels: ProviderModelOption[] = [
  { model: "grok-4.5", displayName: "Grok 4.5", isDefault: true },
  { model: "grok-composer", displayName: "Composer" },
];

const claudeModels: ProviderModelOption[] = [
  {
    model: "sonnet",
    displayName: "Sonnet",
    isDefault: true,
    effortLevels: ["brief", "deep"],
  },
  { model: "haiku", displayName: "Haiku" },
];

describe("discovered model catalog and preferred model", () => {

  it("prefers the marked default, else first entry", () => {
    const models: ProviderModelOption[] = [
      { model: "a", displayName: "A" },
      { model: "b", displayName: "B", isDefault: true },
      { model: "c", displayName: "C" },
    ];
    expect(preferredModel(models)).toBe("b");
    expect(preferredModel([{ model: "only", displayName: "Only" }])).toBe("only");
    expect(preferredModel([])).toBe("Default");
  });

  it("returns only discovered models and stays empty on discovery failure", () => {
    const discovered: ProviderModelOption[] = [
      { model: "grok-4.5", displayName: "Grok 4.5", isDefault: true },
    ];
    expect(resolveModels("grok", discovered)).toEqual(discovered);
    expect(resolveModels("grok", [])).toEqual([]);
    expect(resolveModels("grok", null)).toEqual([]);
  });
});

describe("model effort capabilities", () => {
  it("accepts only effort values discovered for the selected model", () => {
    expect(normalizeEffort("claude", "deep", claudeModels[0])).toBe("deep");
    expect(normalizeEffort("claude", "high", claudeModels[0])).toBeNull();
    expect(normalizeEffort("claude", "deep", claudeModels[1])).toBeNull();
    expect(normalizeEffort("grok", "deep", grokModels[0])).toBeNull();
  });
});

describe("encodeLaunchHints", () => {
  it("serializes Claude effort into --effort flags", () => {
    const hints = encodeLaunchHints(
      { provider: "claude", model: "sonnet", effort: "deep" },
      claudeModels[0],
    );
    expect(hints.model).toBe("sonnet");
    expect(hints.flags).toEqual(["--model", "sonnet", "--effort", "deep"]);
    expect(hints.params.effort).toBe("deep");
  });

  it("serializes Grok reasoning-effort", () => {
    const hints = encodeLaunchHints(
      { provider: "grok", model: "grok-4.5", effort: "unreported" },
      grokModels[0],
    );
    expect(hints.flags).not.toContain("--reasoning-effort");
    expect(hints.params.reasoningEffort).toBeUndefined();
  });

  it("serializes Codex model_reasoning_effort params", () => {
    const model = { model: "o3", displayName: "O3", effortLevels: ["deliberate"] };
    const hints = encodeLaunchHints(
      { provider: "codex", model: "o3", effort: "deliberate" },
      model,
    );
    expect(hints.params.model).toBe("o3");
    expect(hints.params.model_reasoning_effort).toBe("deliberate");
  });

  it("serializes Pi thinking flags", () => {
    const model = {
      model: "openai/gpt-4o",
      displayName: "GPT-4o",
      effortLevels: ["focused"],
    };
    const hints = encodeLaunchHints(
      { provider: "pi", model: "openai/gpt-4o", effort: "focused" },
      model,
    );
    expect(hints.flags).toEqual(["--model", "openai/gpt-4o", "--thinking", "focused"]);
  });

  it("treats Default model as null (provider default)", () => {
    const hints = encodeLaunchHints({ provider: "claude", model: "Default" });
    expect(hints.model).toBeNull();
    expect(hints.flags).not.toContain("--model");
  });
});

describe("formatTriggerText", () => {
  it("includes provider, display name, and non-default effort", () => {
    const text = formatTriggerText(
      { provider: "grok", model: "grok-4.5", effort: "high" },
      grokModels,
    );
    expect(text).toBe("Grok · Grok 4.5 · High");
  });

  it("omits effort when unset", () => {
    const text = formatTriggerText(
      { provider: "claude", model: "sonnet" },
      claudeModels,
    );
    expect(text).toBe("Claude · Sonnet");
  });

  it("prefers catalog display names that keep provider punctuation", () => {
    const models = [
      { model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", effortLevels: ["medium"] },
    ];
    expect(formatTriggerText(
      { provider: "codex", model: "gpt-5.6-terra", effort: "medium" },
      models,
    )).toBe("Codex · GPT-5.6-Terra · Medium");
  });
});

describe("filterRuntimeCatalog", () => {
  const catalog: SearchableProviderRow[] = [
    {
      provider: "grok",
      label: "Grok",
      enabled: true,
      color: "#0f0",
      models: grokModels,
    },
    {
      provider: "claude",
      label: "Claude",
      enabled: true,
      color: "#f80",
      models: claudeModels,
    },
    {
      provider: "cursor",
      label: "Cursor",
      enabled: true,
      color: "#a0f",
      models: [
        { model: "gpt-5.3-codex-high-fast", displayName: "Codex 5.3 High Fast" },
        { model: "Default", displayName: "Auto", isDefault: true },
      ],
    },
  ];

  it("returns full lists when query is empty", () => {
    const result = filterRuntimeCatalog(catalog, "grok", "");
    expect(result.providers).toHaveLength(3);
    expect(result.models.map((m) => m.model)).toContain("grok-4.5");
  });

  it("matches model display names across providers", () => {
    const result = filterRuntimeCatalog(catalog, "grok", "composer");
    expect(result.providers.some((p) => p.provider === "grok")).toBe(true);
    expect(result.models.some((m) => m.model.includes("composer"))).toBe(true);
    expect(result.modelHitsAcrossProviders).toEqual([]);
  });

  it("matches model ids like codex high fast", () => {
    const result = filterRuntimeCatalog(catalog, "claude", "codex high");
    expect(result.models).toEqual([]);
    expect(result.modelHitsAcrossProviders).toContainEqual({
      provider: "cursor",
      providerLabel: "Cursor",
      providerColor: "#a0f",
      option: { model: "gpt-5.3-codex-high-fast", displayName: "Codex 5.3 High Fast" },
    });
  });

  it("never presents another provider's model as an active-provider model", () => {
    const result = filterRuntimeCatalog(catalog, "claude", "composer");
    expect(result.models).toEqual([]);
    expect(result.modelHitsAcrossProviders).toEqual([
      expect.objectContaining({
        provider: "grok",
        providerLabel: "Grok",
        option: expect.objectContaining({ model: "grok-composer" }),
      }),
    ]);
  });

  it("keeps a true no-result search empty", () => {
    const result = filterRuntimeCatalog(catalog, "claude", "zzzz-no-model");
    expect(result.providers).toEqual([]);
    expect(result.models).toEqual([]);
    expect(result.modelHitsAcrossProviders).toEqual([]);
  });

  it("does not expose disabled-provider models as selectable hits", () => {
    const disabledCatalog: SearchableProviderRow[] = catalog.map((row) =>
      row.provider === "cursor" ? { ...row, enabled: false } : row,
    );
    const result = filterRuntimeCatalog(disabledCatalog, "claude", "codex high");
    expect(result.providers).toEqual([]);
    expect(result.models).toEqual([]);
    expect(result.modelHitsAcrossProviders).toEqual([]);
  });

  it("hides disabled providers from the unfiltered rail", () => {
    const disabledCatalog: SearchableProviderRow[] = catalog.map((row) =>
      row.provider === "cursor" ? { ...row, enabled: false } : row,
    );
    const result = filterRuntimeCatalog(disabledCatalog, "claude", "");
    expect(result.providers.map((p) => p.provider)).toEqual(["grok", "claude"]);
  });

  it("hides disabled providers from name-match search results", () => {
    const disabledCatalog: SearchableProviderRow[] = catalog.map((row) =>
      row.provider === "cursor" ? { ...row, enabled: false } : row,
    );
    const result = filterRuntimeCatalog(disabledCatalog, "claude", "cursor");
    expect(result.providers).toEqual([]);
    expect(result.modelHitsAcrossProviders).toEqual([]);
  });

  it("returns no models when the active provider is disabled", () => {
    const disabledCatalog: SearchableProviderRow[] = catalog.map((row) =>
      row.provider === "claude" ? { ...row, enabled: false } : row,
    );
    expect(filterRuntimeCatalog(disabledCatalog, "claude", "").models).toEqual([]);
  });

  it("reports unavailable catalogs only when the query names that provider", () => {
    expect(filterUnavailableProvidersForQuery(catalog, ["cursor"], "qwen")).toEqual([]);
    expect(filterUnavailableProvidersForQuery(catalog, ["cursor"], "cursor")).toEqual([
      expect.objectContaining({ provider: "cursor", label: "Cursor" }),
    ]);
  });
});

describe("recents", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
  });

  it("dedupes by selection key and keeps most recent first", () => {
    const a = { provider: "grok" as const, model: "grok-4.5", effort: "high" as const };
    const b = { provider: "claude" as const, model: "sonnet", effort: "medium" as const };
    let recents = pushRecent(a, "project-a", []);
    recents = pushRecent(b, "project-a", recents);
    recents = pushRecent(a, "project-a", recents);
    expect(recents[0]).toMatchObject(a);
    expect(recents).toHaveLength(2);
    expect(selectionKey(a)).toBe("grok|grok-4.5|high|");
  });

  it("isolates recents by caller-provided context", () => {
    pushRecent({ provider: "grok", model: "grok-4.5" }, "project-a");
    pushRecent({ provider: "claude", model: "sonnet" }, "project-b");

    expect(loadRecents("project-a").map((item) => item.provider)).toEqual(["grok"]);
    expect(loadRecents("project-b").map((item) => item.provider)).toEqual(["claude"]);
  });

  it("stores at most three recents per context", () => {
    let recents = pushRecent({ provider: "claude", model: "opus" }, "project-a", []);
    recents = pushRecent({ provider: "claude", model: "sonnet" }, "project-a", recents);
    recents = pushRecent({ provider: "claude", model: "haiku" }, "project-a", recents);
    recents = pushRecent({ provider: "grok", model: "grok-4.5" }, "project-a", recents);

    expect(MAX_RECENTS).toBe(3);
    expect(recents).toHaveLength(3);
    expect(recents.map((item) => item.model)).toEqual(["grok-4.5", "haiku", "sonnet"]);
    expect(loadRecents("project-a")).toEqual(recents);
  });

  it("round-trips optional source metadata", () => {
    pushRecent({ provider: "claude", model: "my-model" }, "project-a", [], "custom");
    expect(loadRecents("project-a")[0]).toMatchObject({
      provider: "claude",
      model: "my-model",
      source: "custom",
    });
  });

  it("safely migrates legacy unscoped arrays into only the first requested context", () => {
    storage.set(
      "maxx.runtime.recents.v1",
      JSON.stringify([
        { provider: "claude", model: "sonnet" },
        { provider: "not-a-provider", model: "bad" },
      ]),
    );

    expect(loadRecents("project-a")).toEqual([
      { provider: "claude", model: "sonnet", effort: null, speed: null },
    ]);
    expect(loadRecents("project-b")).toEqual([]);
    expect(storage.has("maxx.runtime.recents.v1")).toBe(false);
  });
});
