import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatProvider, ProviderModelCatalog, ProviderProfile } from "../contract/types";
import { ipc } from "../ipc";
import {
  providerCatalogContextKey,
  resetModelCatalogStoreForTests,
  useModelCatalogStore,
} from "./modelCatalogStore";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function profile(provider: ChatProvider, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: `${provider}-profile`,
    provider,
    displayName: provider,
    environment: {},
    colorHex: "#888888",
    isEnabled: true,
    ...overrides,
  };
}

function liveCatalog(model: string, effortLevels: string[] = []): ProviderModelCatalog {
  return {
    source: "live",
    models: [{
      model,
      displayName: model.toUpperCase(),
      isDefault: true,
      effortLevels,
    }],
  };
}

describe("shared provider catalog cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("localStorage", new MemoryStorage());
    resetModelCatalogStoreForTests();
  });

  it("uses a stable context key without exposing runtime configuration", () => {
    const first = profile("codex", {
      executablePath: "/opt/bin/codex",
      environment: { TOKEN: "secret", REGION: "local" },
    });
    const reordered = { ...first, environment: { REGION: "local", TOKEN: "secret" } };
    const key = providerCatalogContextKey([first], "/tmp/project");

    expect(providerCatalogContextKey([reordered], "/tmp/project")).toBe(key);
    expect(providerCatalogContextKey([first], "/tmp/other-project")).not.toBe(key);
    expect(providerCatalogContextKey([{ ...first, executablePath: "/other/codex" }], "/tmp/project"))
      .not.toBe(key);
    // Enable/disable must not invalidate catalog identity — otherwise the
    // default-harness label loses display names and falls back to humanized IDs.
    expect(providerCatalogContextKey([{ ...first, isEnabled: false }], "/tmp/project")).toBe(key);
    expect(key).not.toContain("secret");
    expect(key).not.toContain("/tmp/project");
  });

  it("prefetches every enabled provider once per context", async () => {
    const profiles = [profile("codex"), profile("claude")];
    const contextKey = providerCatalogContextKey(profiles, "/tmp/project");
    const listModels = vi.spyOn(ipc, "listProviderModels")
      .mockImplementation(async (provider) => liveCatalog(`${provider}-model`, ["low", "high"]));

    await useModelCatalogStore.getState().prefetch({
      contextKey,
      providers: ["codex", "claude"],
      profiles,
      workingDirectory: "/tmp/project",
    });
    await useModelCatalogStore.getState().prefetch({
      contextKey,
      providers: ["codex", "claude"],
      profiles,
      workingDirectory: "/tmp/project",
    });

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(useModelCatalogStore.getState().contexts[contextKey]?.entries.codex).toMatchObject({
      status: "live",
      models: [{ effortLevels: ["low", "high"] }],
    });
    expect(useModelCatalogStore.getState().contexts[contextKey]?.entries.claude?.status)
      .toBe("live");
  });

  it("hydrates only successful live catalogs after a store reset", async () => {
    const profiles = [profile("codex")];
    const contextKey = providerCatalogContextKey(profiles, "/tmp/project");
    vi.spyOn(ipc, "listProviderModels").mockResolvedValue(liveCatalog("gpt-live", ["medium"]));

    await useModelCatalogStore.getState().ensureModels({
      contextKey,
      provider: "codex",
      profiles,
      workingDirectory: "/tmp/project",
    });
    resetModelCatalogStoreForTests();
    useModelCatalogStore.getState().hydrateContext(contextKey);

    expect(useModelCatalogStore.getState().contexts[contextKey]?.entries.codex).toMatchObject({
      status: "cached",
      models: [{ model: "gpt-live", effortLevels: ["medium"] }],
    });
  });

  it("never persists fabricated fallback data after discovery failure", async () => {
    const profiles = [profile("grok")];
    const contextKey = providerCatalogContextKey(profiles, "/tmp/project");
    vi.spyOn(ipc, "listProviderModels").mockResolvedValue({
      source: "unavailable",
      models: [],
      error: "CLI unavailable",
    });

    await useModelCatalogStore.getState().ensureModels({
      contextKey,
      provider: "grok",
      profiles,
      workingDirectory: "/tmp/project",
    });
    expect(useModelCatalogStore.getState().contexts[contextKey]?.entries.grok).toMatchObject({
      status: "unavailable",
      models: [],
    });

    resetModelCatalogStoreForTests();
    useModelCatalogStore.getState().hydrateContext(contextKey);
    expect(useModelCatalogStore.getState().contexts[contextKey]?.entries.grok).toBeUndefined();
  });

  it("keeps the last live catalog stable when background revalidation fails", async () => {
    const profiles = [profile("claude")];
    const contextKey = providerCatalogContextKey(profiles, "/tmp/project");
    const listModels = vi.spyOn(ipc, "listProviderModels")
      .mockResolvedValueOnce(liveCatalog("opus", ["high"]));

    await useModelCatalogStore.getState().ensureModels({
      contextKey,
      provider: "claude",
      profiles,
      workingDirectory: "/tmp/project",
    });
    resetModelCatalogStoreForTests();
    useModelCatalogStore.getState().hydrateContext(contextKey);
    listModels.mockRejectedValueOnce(new Error("temporary probe failure"));

    await useModelCatalogStore.getState().ensureModels({
      contextKey,
      provider: "claude",
      profiles,
      workingDirectory: "/tmp/project",
      force: true,
    });

    expect(useModelCatalogStore.getState().contexts[contextKey]?.entries.claude).toMatchObject({
      status: "cached",
      models: [{ model: "opus", effortLevels: ["high"] }],
      error: "temporary probe failure",
    });
  });
});
