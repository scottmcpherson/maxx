import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "./contract/types";
import {
  PROVIDER_INSTALL_GUIDES,
  disableUnavailableProfiles,
  filterProviderModels,
  providerCanBeEnabled,
  setModelVisibility,
  visibleProviderModels,
} from "./providerSettings";

const profile: ProviderProfile = {
  id: "provider-id",
  provider: "codex",
  displayName: "Codex",
  environment: {},
  colorHex: "#888888",
  isEnabled: true,
  hiddenModels: ["gpt-hidden"],
};

describe("provider settings", () => {
  it("defines an HTTPS installation guide and executable for every provider", () => {
    expect(Object.keys(PROVIDER_INSTALL_GUIDES)).toHaveLength(8);
    for (const guide of Object.values(PROVIDER_INSTALL_GUIDES)) {
      expect(guide.url).toMatch(/^https:\/\//);
      expect(guide.executable).not.toBe("");
    }
  });

  it("removes hidden models from picker-visible catalogs", () => {
    const models = [
      { model: "gpt-visible", displayName: "Visible" },
      { model: "gpt-hidden", displayName: "Hidden" },
    ];
    expect(visibleProviderModels(profile, models)).toEqual([models[0]]);
  });

  it("searches provider models by name, ID, and description", () => {
    const models = [
      { model: "openrouter/anthropic/claude-sonnet", displayName: "Claude Sonnet", description: "Balanced reasoning" },
      { model: "openai/gpt-fast", displayName: "GPT Fast", description: "Low latency" },
    ];
    expect(filterProviderModels(models, "  SONNET ")).toEqual([models[0]]);
    expect(filterProviderModels(models, "openai/")).toEqual([models[1]]);
    expect(filterProviderModels(models, "latency")).toEqual([models[1]]);
    expect(filterProviderModels(models, "")).toEqual(models);
  });

  it("persists model visibility without duplicates and in stable order", () => {
    const hidden = setModelVisibility(profile, "gpt-alpha", false);
    expect(hidden.hiddenModels).toEqual(["gpt-alpha", "gpt-hidden"]);
    expect(setModelVisibility(hidden, "gpt-hidden", true).hiddenModels).toEqual(["gpt-alpha"]);
  });

  it("allows enablement only after a ready probe", () => {
    expect(providerCanBeEnabled({
      profileID: profile.id,
      state: "ready",
      message: "found",
    })).toBe(true);
    expect(providerCanBeEnabled({
      profileID: profile.id,
      state: "missing",
      message: "not found",
    })).toBe(false);
  });

  it("turns off unavailable inherited defaults without changing ready profiles", () => {
    const ready = { ...profile, id: "ready", provider: "claude" as const };
    const next = disableUnavailableProfiles([profile, ready], [
      { profileID: profile.id, state: "missing", message: "not found" },
      { profileID: ready.id, state: "ready", message: "found" },
    ]);
    expect(next.map((item) => item.isEnabled)).toEqual([false, true]);
  });
});
