import type { ChatProvider, ProviderHealth, ProviderProfile } from "./contract/types";
import type { ProviderModelOption } from "./runtime/modelCatalog";

export interface ProviderInstallGuide {
  url: string;
  executable: string;
}

export const PROVIDER_INSTALL_GUIDES: Record<ChatProvider, ProviderInstallGuide> = {
  codex: {
    url: "https://developers.openai.com/codex/cli/",
    executable: "codex",
  },
  claude: {
    url: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
    executable: "claude",
  },
  grok: {
    url: "https://x.ai/cli",
    executable: "grok",
  },
  cursor: {
    url: "https://docs.cursor.com/en/cli/installation",
    executable: "cursor-agent",
  },
  opencode: {
    url: "https://opencode.ai/docs/",
    executable: "opencode",
  },
  pi: {
    url: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
    executable: "pi",
  },
  omp: {
    url: "https://github.com/can1357/oh-my-pi",
    executable: "omp",
  },
  hermes: {
    url: "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
    executable: "hermes",
  },
};

export function visibleProviderModels(
  profile: Pick<ProviderProfile, "hiddenModels"> | undefined,
  models: readonly ProviderModelOption[],
): ProviderModelOption[] {
  const hidden = new Set(profile?.hiddenModels ?? []);
  return models.filter((model) => !hidden.has(model.model));
}

export function filterProviderModels(
  models: readonly ProviderModelOption[],
  query: string,
): ProviderModelOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter((model) => [model.displayName, model.model, model.description]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(needle)));
}

export function setModelVisibility(
  profile: ProviderProfile,
  model: string,
  visible: boolean,
): ProviderProfile {
  const hidden = new Set(profile.hiddenModels ?? []);
  if (visible) hidden.delete(model);
  else hidden.add(model);
  return { ...profile, hiddenModels: [...hidden].sort() };
}

export function providerCanBeEnabled(health: ProviderHealth | undefined): boolean {
  return health?.state === "ready";
}

export function disableUnavailableProfiles(
  profiles: readonly ProviderProfile[],
  health: readonly ProviderHealth[],
): ProviderProfile[] {
  const unavailable = new Set(health
    .filter((result) => result.state === "missing")
    .map((result) => result.profileID));
  return profiles.map((profile) => profile.isEnabled && unavailable.has(profile.id)
    ? { ...profile, isEnabled: false }
    : profile);
}
