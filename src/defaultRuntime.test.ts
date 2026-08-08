import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "./contract/types";
import {
  DEFAULT_NEW_CHAT_RUNTIME,
  loadDefaultRuntime,
  persistDefaultRuntime,
  reconcileDefaultRuntime,
} from "./defaultRuntime";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("maxx.default-runtime.v1", initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

function profile(
  provider: ProviderProfile["provider"],
  isEnabled: boolean,
): ProviderProfile {
  return {
    id: `${provider}-id`,
    provider,
    displayName: provider,
    environment: {},
    colorHex: "#888888",
    isEnabled,
  };
}

describe("default new-chat runtime", () => {
  it("defaults to Codex with provider defaults", () => {
    expect(loadDefaultRuntime(memoryStorage())).toEqual(DEFAULT_NEW_CHAT_RUNTIME);
  });

  it("round-trips the selected provider, model, and effort", () => {
    const storage = memoryStorage();
    const selected = {
      provider: "claude" as const,
      model: "claude-opus-4-1",
      effort: "high",
      speed: null,
    };

    expect(persistDefaultRuntime(selected, storage)).toEqual(selected);
    expect(loadDefaultRuntime(storage)).toEqual(selected);
  });

  it("normalizes empty knobs and rejects malformed preferences", () => {
    const normalized = memoryStorage(JSON.stringify({
      provider: "grok",
      model: "  grok-4.5  ",
      effort: "  ",
      speed: "normal",
    }));
    expect(loadDefaultRuntime(normalized)).toEqual({
      provider: "grok",
      model: "grok-4.5",
      effort: null,
      speed: null,
    });

    const malformed = memoryStorage(JSON.stringify({ provider: "unknown", model: "x" }));
    expect(loadDefaultRuntime(malformed)).toEqual(DEFAULT_NEW_CHAT_RUNTIME);
    expect(loadDefaultRuntime(memoryStorage("not json"))).toEqual(DEFAULT_NEW_CHAT_RUNTIME);
  });
});

describe("reconcileDefaultRuntime", () => {
  const codexSelection = {
    provider: "codex" as const,
    model: "gpt-5.6-terra",
    effort: "medium",
    speed: null,
  };

  it("keeps the selection when its provider is still enabled", () => {
    const profiles = [profile("codex", true), profile("claude", true)];
    expect(reconcileDefaultRuntime(codexSelection, profiles)).toBe(codexSelection);
  });

  it("moves to the first enabled provider when the default is disabled", () => {
    const profiles = [
      profile("codex", false),
      profile("claude", false),
      profile("grok", true),
      profile("cursor", true),
    ];
    expect(reconcileDefaultRuntime(codexSelection, profiles)).toEqual({
      provider: "grok",
      model: "Default",
      effort: null,
      speed: null,
    });
  });

  it("leaves the preference alone when every provider is disabled", () => {
    const profiles = [profile("codex", false), profile("claude", false)];
    expect(reconcileDefaultRuntime(codexSelection, profiles)).toBe(codexSelection);
  });
});
