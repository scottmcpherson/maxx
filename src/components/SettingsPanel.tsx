import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../ipc";
import { ALL_PROVIDERS, DEFAULT_COMPUTER_USE_SETTINGS, providerDisplayName } from "../contract/types";
import type { ComputerUseSettings, ComputerUseStatus, ProviderHealth, ProviderProfile } from "../contract/types";
import {
  disableUnavailableProfiles,
  providerCanBeEnabled,
} from "../providerSettings";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUTS,
  findKeyboardShortcutConflict,
  formatKeyboardShortcut,
  isAllowedKeyboardShortcut,
  keyboardShortcutAriaLabel,
  keyboardShortcutFromEvent,
  keyboardShortcutsEqual,
} from "../keyboardShortcuts";
import type {
  KeyboardShortcutBinding,
  KeyboardShortcutBindings,
  KeyboardShortcutCommand,
} from "../keyboardShortcuts";
import { useAppStore } from "../store/appStore";
import type { AccessPreset, TailscaleDiscovery } from "../host/types";
import { enumerateVoiceDevices } from "../voice/devices";
import type { VoiceAudioDevices } from "../voice/devices";
import { resolveVoiceSelection } from "../voice/catalog";
import { DEFAULT_VOICE_SETTINGS, VOICE_LANGUAGES } from "../voice/types";
import type {
  VoiceCredentialStatus,
  VoiceModel,
  VoiceProfile,
  VoiceProviderTestResult,
  VoiceSettings,
} from "../voice/types";
import { VoiceTtsPlayer } from "../voice/tts";
import { beginWindowDrag } from "../windowDrag";
import { Icons } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderSettingsRow } from "./ProviderSettingsRow";
import { RuntimePicker } from "./RuntimePicker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "./SettingsNavigation";

// Settings rows are a two-column form on desktop and a single-column form on
// narrow windows. The control column has a bounded width so labels retain
// readable space and inputs never force the copy into a sliver.
const settingsRowClass = "grid grid-cols-1 gap-3 border-b border-border/50 p-3 last:border-b-0 @2xl:grid-cols-[minmax(0,1fr)_minmax(12rem,16rem)] @2xl:items-center @2xl:gap-5";
const settingsCompactControlRowClass = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 p-3 last:border-b-0";
const settingsPickerRowClass = "grid grid-cols-1 items-center gap-3 border-b border-border/50 p-3 last:border-b-0 @2xl:grid-cols-[minmax(0,1fr)_auto] @2xl:gap-5";
const settingsCardClass = "block shrink-0 py-0";
const settingsInlineAlertClass = "rounded-none border-0";
const settingsRowCopyClass = "flex min-w-0 flex-1 flex-col gap-1 [&_strong]:font-medium [&_small]:text-xs [&_small]:leading-relaxed [&_small]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5";
const settingsPageTitleClass = "text-xl font-semibold tracking-tight";
const settingsPageDescriptionClass = "max-w-2xl text-sm leading-relaxed text-muted-foreground";
const settingsPageHeaderClass = "flex items-start justify-between gap-4";

export function SettingsPanel({ section, query }: { section: SettingsSection; query: string }) {
  const scrollContainerRef = useRef<HTMLElement>(null);
  const workspace = useAppStore((state) => state.workspace);
  const saveProfiles = useAppStore((state) => state.saveProfiles);
  const saveTitleGenerationRuntime = useAppStore((state) => state.saveTitleGenerationRuntime);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const keyboardShortcuts = useAppStore((state) => state.keyboardShortcuts);
  const setKeyboardShortcut = useAppStore((state) => state.setKeyboardShortcut);
  const resetKeyboardShortcut = useAppStore((state) => state.resetKeyboardShortcut);
  const showProviderDiagnostics = useAppStore((state) => state.showProviderDiagnostics);
  const setShowProviderDiagnostics = useAppStore((state) => state.setShowProviderDiagnostics);
  const defaultRuntime = useAppStore((state) => state.defaultRuntime);
  const setDefaultRuntime = useAppStore((state) => state.setDefaultRuntime);
  const [drafts, setDrafts] = useState<ProviderProfile[]>([]);
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [expandedProfileID, setExpandedProfileID] = useState<string | null>(null);
  const [pendingProfileIDs, setPendingProfileIDs] = useState<Set<string>>(() => new Set());
  const providerHealthContext = useMemo(() => JSON.stringify(
    (workspace?.providerProfiles ?? []).map((profile) => ({
      id: profile.id,
      executablePath: profile.executablePath ?? "",
      homeDirectory: profile.homeDirectory ?? "",
      environment: Object.entries(profile.environment).sort(([left], [right]) =>
        left.localeCompare(right)),
    })),
  ), [workspace?.providerProfiles]);

  useEffect(() => {
    setDrafts(workspace?.providerProfiles.map((profile) => ({ ...profile })) ?? []);
  }, [workspace]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [setSettingsOpen]);

  const probe = async (id: string): Promise<ProviderHealth> => {
    try {
      const result = await ipc.providerHealth(id);
      setHealth((current) => ({ ...current, [id]: result }));
      return result;
    } catch (error) {
      const result: ProviderHealth = {
        profileID: id,
        state: "missing",
        message: String(error),
      };
      setHealth((current) => ({
        ...current,
        [id]: result,
      }));
      return result;
    }
  };

  // Probe every profile, including disabled ones. Existing workspaces may have
  // inherited the old all-enabled default, so unavailable profiles are
  // disabled in one atomic save instead of remaining broken picker entries.
  useEffect(() => {
    const profiles = workspace?.providerProfiles ?? [];
    if (!profiles.length) return;
    let cancelled = false;
    void Promise.all(profiles.map(async (profile) => {
      try {
        return await ipc.providerHealth(profile.id);
      } catch (error) {
        return {
          profileID: profile.id,
          state: "missing",
          message: String(error),
        } satisfies ProviderHealth;
      }
    })).then((results) => {
      if (cancelled) return;
      setHealth(Object.fromEntries(results.map((result) => [result.profileID, result])));
      const next = disableUnavailableProfiles(profiles, results);
      if (next.some((profile, index) => profile !== profiles[index])) {
        setDrafts(next);
        void saveProfiles(next);
      }
    });
    return () => { cancelled = true; };
  }, [providerHealthContext, saveProfiles]);

  const setPending = (id: string, pending: boolean) => {
    setPendingProfileIDs((current) => {
      const next = new Set(current);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const persistProfile = async (updated: ProviderProfile) => {
    const next = drafts.map((profile) => profile.id === updated.id ? updated : profile);
    setDrafts(next);
    await saveProfiles(next);
  };

  const toggleEnabled = async (profile: ProviderProfile, isEnabled: boolean) => {
    if (!isEnabled) {
      await persistProfile({ ...profile, isEnabled: false });
      return;
    }
    setPending(profile.id, true);
    const result = await probe(profile.id);
    if (providerCanBeEnabled(result)) {
      await persistProfile({ ...profile, isEnabled: true });
    } else {
      setExpandedProfileID(profile.id);
    }
    setPending(profile.id, false);
  };

  /** Row subtitle: CLI version once probed, else provider name / not-found. */
  const subtitle = (profile: ProviderProfile): string => {
    const result = health[profile.id];
    const version = result?.version?.split("\n")[0]?.trim();
    if (version) return version;
    if (result?.state === "missing") return "Not installed";
    return providerDisplayName(profile.provider);
  };

  const normalized = query.trim().toLowerCase();
  const visibleProfiles = drafts.filter((profile) =>
    !normalized || profile.displayName.toLowerCase().includes(normalized) || profile.provider.includes(normalized),
  );
  const visibleShortcuts = KEYBOARD_SHORTCUTS.filter((shortcut) =>
    !normalized
    || shortcut.label.toLowerCase().includes(normalized)
    || shortcut.description.toLowerCase().includes(normalized),
  );
  const titleGenerationRuntime = workspace?.titleGenerationRuntime ?? null;
  const titleRuntimePickerValue = titleGenerationRuntime ?? defaultRuntime;

  useLayoutEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [section]);

  const sectionBody = () => {
    switch (section) {
      case "providers":
        return (
          <>
            <header className={settingsPageHeaderClass} onMouseDown={beginWindowDrag}>
              <div>
                <h1 className={settingsPageTitleClass}>Providers</h1>
                <p className={settingsPageDescriptionClass}>Choose the command-line agents Maxx can run in a thread. Changes apply immediately.</p>
              </div>
            </header>

            <Card className={cn(settingsCardClass, "overflow-visible")} aria-label="Default model">
              <CardContent className="px-0">
                <div className={settingsPickerRowClass}>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <strong>Default model</strong>
                    <CardDescription>
                    Choose the provider, model, and effort used when you start a new chat.
                    You can still change it in the composer before sending.
                    </CardDescription>
                  </div>
                  <div className="min-w-0 @2xl:min-w-44 @2xl:justify-self-end">
                    <RuntimePicker
                      provider={defaultRuntime.provider}
                      model={defaultRuntime.model}
                      effort={defaultRuntime.effort}
                      speed={defaultRuntime.speed}
                      profiles={workspace?.providerProfiles ?? []}
                      placement="bottom"
                      triggerShowsProvider
                      onChange={setDefaultRuntime}
                    />
                  </div>
                </div>
                <div className={settingsPickerRowClass}>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <strong>Title generation</strong>
                    <CardDescription>
                    Choose a global harness for short chat titles; if it is unavailable, Maxx uses
                    the harness and model selected for the chat.
                    </CardDescription>
                  </div>
                  <div className="min-w-0 @2xl:min-w-44 @2xl:justify-self-end">
                    <RuntimePicker
                      provider={titleRuntimePickerValue.provider}
                      model={titleRuntimePickerValue.model}
                      effort={titleRuntimePickerValue.effort}
                      speed={titleRuntimePickerValue.speed}
                      profiles={workspace?.providerProfiles ?? []}
                      placement="bottom"
                      triggerShowsProvider
                      inherited={!titleGenerationRuntime}
                      inheritLabel="Use chat harness"
                      inheritDescription="Use the provider and model selected for each chat."
                      onUseInherited={() => void saveTitleGenerationRuntime(null)}
                      onChange={(next) => void saveTitleGenerationRuntime(next)}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className={cn(settingsCardClass, "divide-y divide-border/50")} aria-label="Provider settings">
              {visibleProfiles.map((profile) => {
                const result = health[profile.id];
                return (
                  <ProviderSettingsRow
                    key={profile.id}
                    profile={profile}
                    health={result}
                    subtitle={subtitle(profile)}
                    expanded={expandedProfileID === profile.id}
                    pending={pendingProfileIDs.has(profile.id)}
                    onToggleExpanded={() => setExpandedProfileID((current) =>
                      current === profile.id ? null : profile.id)}
                    onToggleEnabled={(enabled) => void toggleEnabled(profile, enabled)}
                    onSaveProfile={persistProfile}
                    onRecheck={async () => {
                      setPending(profile.id, true);
                      await probe(profile.id);
                      setPending(profile.id, false);
                    }}
                  />
                );
              })}
              {visibleProfiles.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No providers match “{query}”.</p>}
            </Card>

            <Card className={settingsCardClass} aria-label="Provider diagnostics settings">
              <CardContent className="p-3">
                <Field orientation="horizontal" className="items-center">
                  <FieldContent>
                    <FieldLabel htmlFor="show-provider-diagnostics">Show provider diagnostics</FieldLabel>
                    <FieldDescription>
                    Show non-fatal notices reported by provider command-line harnesses in chat.
                    Errors and warnings that require action remain visible.
                    </FieldDescription>
                  </FieldContent>
                  <Switch id="show-provider-diagnostics" checked={showProviderDiagnostics} aria-label="Show provider diagnostics" onCheckedChange={setShowProviderDiagnostics} />
                </Field>
              </CardContent>
            </Card>
          </>
        );
      case "voice":
        return <VoiceSettingsSection />;
      case "computerUse":
        return <ComputerUseSettingsSection />;
      case "connections":
        return <ConnectionsSettingsSection />;
      case "experimental":
        return <ExperimentalSettingsSection />;
      case "keyboardShortcuts":
        return (
          <>
            <header className={settingsPageHeaderClass} onMouseDown={beginWindowDrag}>
              <div>
                <h1 className={settingsPageTitleClass}>Keyboard Shortcuts</h1>
                <p className={settingsPageDescriptionClass}>Customize how you move around Maxx.</p>
              </div>
            </header>

            <section className="flex flex-col" aria-label="Keyboard shortcuts">
              {visibleShortcuts.map((shortcut) => (
                <KeyboardShortcutRow
                  key={shortcut.id}
                  command={shortcut.id}
                  label={shortcut.label}
                  description={shortcut.description}
                  binding={keyboardShortcuts[shortcut.id]}
                  allBindings={keyboardShortcuts}
                  onChange={(binding) => setKeyboardShortcut(shortcut.id, binding)}
                  onReset={() => resetKeyboardShortcut(shortcut.id)}
                />
              ))}
              {visibleShortcuts.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No shortcuts match “{query}”.</p>}
            </section>
            <p className="text-sm text-muted-foreground">Click a shortcut, then press a new key combination. Changes save automatically.</p>
          </>
        );
    }
  };

  return (
    <main
      ref={scrollContainerRef}
      className="@container flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain bg-background p-6 [overflow-anchor:none] *:shrink-0"
    >
      <div className="mx-auto flex w-full max-w-[var(--content-max-width)] shrink-0 flex-col gap-6">
        {sectionBody()}
      </div>
    </main>
  );
}

function ComputerUseSettingsSection() {
  const workspace = useAppStore((state) => state.workspace);
  const saveSettings = useAppStore((state) => state.saveComputerUseSettings);
  const stored = workspace?.computerUse ?? DEFAULT_COMPUTER_USE_SETTINGS;
  const [settings, setSettings] = useState<ComputerUseSettings>(stored);
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => setSettings(stored), [stored]);

  const refreshStatus = async () => {
    try {
      setStatus(await ipc.computerUseStatus());
      setActionError(null);
    } catch (error) {
      setActionError(String(error));
    }
  };

  useEffect(() => { void refreshStatus(); }, []);

  const update = async (patch: Partial<ComputerUseSettings>) => {
    const next = {
      ...settings,
      ...patch,
      ...(patch.browserAutomation === false
        ? { browserFileTransfer: false, existingBrowserProfiles: false }
        : {}),
    };
    setSettings(next);
    setBusy(true);
    setActionError(null);
    try {
      await saveSettings(next);
      await refreshStatus();
    } catch (error) {
      setSettings(settings);
      setActionError(String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleProvider = (provider: ComputerUseSettings["disabledProviders"][number], enabled: boolean) => {
    const disabledProviders = enabled
      ? settings.disabledProviders.filter((candidate) => candidate !== provider)
      : [...new Set([...settings.disabledProviders, provider])];
    void update({ disabledProviders });
  };

  const openSettings = async () => {
    setActionError(null);
    try {
      setStatus(await ipc.computerUseOpenSettings());
    } catch (error) {
      setActionError(String(error));
    }
  };

  const capabilityRows: Array<{
    key: keyof Pick<ComputerUseSettings, "launchApplications" | "foregroundControl" | "clipboard" | "browserAutomation" | "browserFileTransfer" | "trajectoryRecording" | "trajectoryReplay" | "processTermination" | "existingBrowserProfiles">;
    label: string;
    description: string;
    requiresBrowserAutomation?: boolean;
  }> = [
    { key: "launchApplications", label: "Launch applications", description: "Let agents open apps needed to complete a task." },
    { key: "foregroundControl", label: "Foreground control", description: "Let agents bring apps forward and use visible mouse and keyboard control when direct background control is unavailable." },
    { key: "clipboard", label: "Clipboard", description: "Allow agents to read from and write to the system clipboard." },
    { key: "browserAutomation", label: "Browser automation", description: "Allow typed web navigation and page interaction in a separate Cua-managed browser profile." },
    { key: "browserFileTransfer", label: "Browser file transfer", description: "Allow agents to upload local files through browser inputs and save browser downloads.", requiresBrowserAutomation: true },
    { key: "existingBrowserProfiles", label: "Existing browser profiles", description: "Allow attachment to signed-in Chromium profiles on this Mac. Cua restarts with its explicit existing-profile grant.", requiresBrowserAutomation: true },
    { key: "trajectoryRecording", label: "Trajectory recording", description: "Allow agents to save action metadata, accessibility state, screenshots, and optional video for a run." },
    { key: "trajectoryReplay", label: "Trajectory replay", description: "Allow agents to replay actions from a previously saved trajectory." },
    { key: "processTermination", label: "Terminate applications", description: "Allow agents to force an application to quit." },
  ];

  const needsPermissions = settings.enabled && status && (!status.permissions.accessibility || !status.permissions.screenRecording);

  return (
    <>
      <header className={settingsPageHeaderClass} onMouseDown={beginWindowDrag}>
        <div>
          <h1 className={settingsPageTitleClass}>Computer Use</h1>
          <p className={settingsPageDescriptionClass}>Give every enabled agent native desktop control through Maxx’s built-in Cua runtime. No per-chat setup is required.</p>
        </div>
      </header>

      {(actionError || status?.message || needsPermissions) && (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{actionError ?? status?.message ?? "Allow Accessibility and Screen Recording for Maxx to use the desktop."}</span>
            {needsPermissions && <Button type="button" variant="outline" size="sm" onClick={() => void openSettings()}>Open System Settings</Button>}
          </AlertDescription>
        </Alert>
      )}

      <Collapsible open={settings.enabled} onOpenChange={(enabled) => void update({ enabled })}>
        <Card className={settingsCardClass} aria-label="Computer Use settings">
          <CardContent className="p-0">
            <Field orientation="horizontal" className="items-center p-3">
              <FieldContent>
                <FieldLabel htmlFor="computer-use-enabled">Enable Computer Use</FieldLabel>
                <FieldDescription>Expose <code>maxx_computer</code> globally to enabled harnesses. Changes apply to existing chats automatically.</FieldDescription>
              </FieldContent>
              <CollapsibleTrigger
                nativeButton={false}
                role="switch"
                aria-checked={settings.enabled}
                render={(
                  <Switch
                    id="computer-use-enabled"
                    aria-label="Enable Computer Use"
                    checked={settings.enabled}
                    disabled={busy || status?.supported === false}
                  />
                )}
              />
            </Field>
            <CollapsibleContent
              className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden"
              aria-label="Computer Use harness settings"
            >
              <div className="border-t border-border/50">
                {ALL_PROVIDERS.map((provider) => (
                  <div className={settingsCompactControlRowClass} key={provider}>
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex shrink-0" aria-hidden="true">
                        <ProviderIcon provider={provider} size={20} />
                      </span>
                      <div className={settingsRowCopyClass}>
                        <strong>{providerDisplayName(provider)}</strong>
                        <small>Computer Use is available in every {providerDisplayName(provider)} chat.</small>
                      </div>
                    </div>
                    <Switch
                      checked={!settings.disabledProviders.includes(provider)}
                      disabled={busy}
                      aria-label={`Enable Computer Use for ${providerDisplayName(provider)}`}
                      onCheckedChange={(enabled) => toggleProvider(provider, enabled)}
                    />
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </CardContent>
        </Card>
      </Collapsible>

      {settings.enabled && (
        <div className="animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none">
          <h2 className="mb-2 text-sm font-medium">Capabilities</h2>
          <Card className={settingsCardClass} aria-label="Computer Use capabilities">
            <CardContent className="px-0">
              <Field orientation="horizontal" className={settingsCompactControlRowClass}>
                <FieldContent>
                  <FieldLabel>Core desktop control</FieldLabel>
                  <FieldDescription>
                    Inspect screens and accessibility state, click, type, scroll, move windows, and manage sessions. Included whenever Computer Use is enabled; macOS Screen Recording permission is required for live screenshots but does not save recordings.
                  </FieldDescription>
                </FieldContent>
                <Badge variant="secondary">Always on</Badge>
              </Field>
              {capabilityRows.map((row) => {
                const disabled = busy || Boolean(row.requiresBrowserAutomation && !settings.browserAutomation);
                return (
                  <Field
                    orientation="horizontal"
                    className={settingsCompactControlRowClass}
                    data-disabled={disabled || undefined}
                    key={row.key}
                  >
                    <FieldContent>
                      <FieldLabel htmlFor={`computer-use-${row.key}`}>{row.label}</FieldLabel>
                      <FieldDescription>{row.description}</FieldDescription>
                    </FieldContent>
                    <Switch
                      id={`computer-use-${row.key}`}
                      checked={settings[row.key]}
                      disabled={disabled}
                      aria-label={row.label}
                      onCheckedChange={(enabled) => void update({ [row.key]: enabled })}
                    />
                  </Field>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

function ExperimentalSettingsSection() {
  const terminalModeEnabled = useAppStore((state) => state.terminalModeEnabled);
  const setTerminalModeEnabled = useAppStore((state) => state.setTerminalModeEnabled);

  return (
    <>
      <header className={settingsPageHeaderClass} onMouseDown={beginWindowDrag}>
        <div>
          <h1 className={settingsPageTitleClass}>Experimental</h1>
          <p className={settingsPageDescriptionClass}>Try features that are still being refined. They may change in future builds.</p>
        </div>
      </header>

      <Card className={settingsCardClass} aria-label="Experimental settings">
        <CardContent className="p-3">
          <Field orientation="horizontal" className="items-center">
            <FieldContent>
              <FieldLabel htmlFor="terminal-mode">Terminal mode</FieldLabel>
              <FieldDescription>
              Show controls for starting chats in a provider’s native terminal interface
              and switching existing chats between terminal and GUI modes.
              </FieldDescription>
            </FieldContent>
            <Switch id="terminal-mode" checked={terminalModeEnabled} aria-label="Enable terminal mode" onCheckedChange={setTerminalModeEnabled} />
          </Field>
        </CardContent>
      </Card>
    </>
  );
}

function ConnectionsSettingsSection() {
  const hostStatus = useAppStore((state) => state.hostStatus);
  const startHostListen = useAppStore((state) => state.startHostListen);
  const stopHostListen = useAppStore((state) => state.stopHostListen);
  const connectHost = useAppStore((state) => state.connectHost);
  const disconnectHost = useAppStore((state) => state.disconnectHost);
  const revokePairedDevice = useAppStore((state) => state.revokePairedDevice);
  const refreshHostStatus = useAppStore((state) => state.refreshHostStatus);
  const error = useAppStore((state) => state.error);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [preset, setPreset] = useState<AccessPreset>("standard");
  const [discovery, setDiscovery] = useState<TailscaleDiscovery | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listening = hostStatus?.listening ?? false;
  const canConnect = address.trim().length > 0 && code.trim().length > 0 && !busy;
  const shareAddress = hostStatus?.shareAddress ?? null;

  useEffect(() => {
    void refreshHostStatus();
    void ipc.hostDiscovery().then(setDiscovery).catch((cause) => {
      setActionError(String(cause));
    });
  }, [refreshHostStatus]);

  useEffect(() => {
    if (!hostStatus?.pairing) return;
    const delay = Math.max(0, hostStatus.pairing.expiresAt * 1000 - Date.now() + 250);
    const timer = window.setTimeout(() => void refreshHostStatus(), delay);
    return () => window.clearTimeout(timer);
  }, [hostStatus?.pairing, refreshHostStatus]);

  const toggleListening = async (enabled: boolean) => {
    setBusy(true);
    setActionError(null);
    try {
      if (enabled) await startHostListen();
      else await stopHostListen();
    } finally {
      setBusy(false);
    }
  };

  const createPairing = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await ipc.hostCreatePairing(preset);
      await refreshHostStatus();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancelPairing = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await ipc.hostCancelPairing();
      await refreshHostStatus();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (peerId: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await revokePairedDevice(peerId);
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setActionError(null);
    await connectHost(address.trim(), code.trim());
    setBusy(false);
  };

  return (
    <>
      <header className={settingsPageHeaderClass} onMouseDown={beginWindowDrag}>
        <div>
          <h1 className={settingsPageTitleClass}>Connections</h1>
          <p className={settingsPageDescriptionClass}>
            This computer keeps its own projects and chats. Another Maxx can connect over Tailscale
            and work in this workspace without merging the two.
          </p>
        </div>
      </header>

      <Card className={settingsCardClass} aria-label="Allow connections">
        <div className={cn(settingsCompactControlRowClass, !listening && "border-b-0")}>
          <span className={settingsRowCopyClass}>
            <strong>Allow connections</strong>
            <small>
              Other Maxx apps can pair with {hostStatus?.name ?? "this computer"}. Leave this on
              while you want to be reachable.
            </small>
          </span>
          <Switch checked={listening} disabled={busy} aria-label="Allow connections from other Maxx apps" onCheckedChange={(enabled) => void toggleListening(enabled)} />
        </div>
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-150 motion-reduce:transition-none",
            listening ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
          aria-hidden={!listening}
          inert={!listening}
        >
          <div className="min-h-0 overflow-hidden">
            <div className={cn(settingsRowClass, "items-center")}>
              <span className={settingsRowCopyClass}>
                <strong>Address</strong>
                <small>
                  {shareAddress
                    ? "Give this to the other computer."
                    : "Give the other computer this computer’s Tailscale address and port 7422."}
                </small>
              </span>
              {shareAddress ? (
                <CopyableValue value={shareAddress} label="This computer’s address" />
              ) : (
                <span className="self-center text-sm text-muted-foreground">port 7422</span>
              )}
            </div>
            <div className={cn(settingsRowClass, "items-center")}>
              <span className={settingsRowCopyClass}>
                <strong>Pairing code</strong>
                <small>
                  Generate a one-time code when the other computer is ready. It expires after five minutes.
                </small>
              </span>
              {hostStatus?.pairing ? (
                <div className="flex min-w-0 flex-col items-stretch gap-2 @sm:flex-row @sm:items-center @sm:justify-end">
                  <CopyableValue value={hostStatus.pairing.code} label="Pairing code" />
                  <Button type="button" variant="outline" size="sm" onClick={() => void cancelPairing()}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex min-w-0 flex-col items-stretch gap-2 @sm:flex-row @sm:items-center @sm:justify-end">
                  <NativeSelect
                    className="w-full"
                    value={preset}
                    aria-label="Pairing access"
                    onChange={(event) => setPreset(event.target.value as AccessPreset)}
                  >
                    <NativeSelectOption value="voice">Voice processing only</NativeSelectOption>
                    <NativeSelectOption value="standard">Standard access</NativeSelectOption>
                    <NativeSelectOption value="full">Full access</NativeSelectOption>
                  </NativeSelect>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void createPairing()}
                  >
                    Generate code
                  </Button>
                </div>
              )}
            </div>
            {hostStatus?.pairing && (
              <div className="px-3.5 pb-3 text-xs leading-relaxed text-muted-foreground">
                Expires {new Date(hostStatus.pairing.expiresAt * 1000).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}. Access: {hostStatus.pairing.capabilities.join(", ")}.
              </div>
            )}
          </div>
        </div>
      </Card>

      <Card className={settingsCardClass} aria-label="Connect to another Maxx">
        <div className={cn(settingsRowClass, discovery?.peers.length && "border-b-0")}>
          <span className={settingsRowCopyClass}>
            <strong>Connect to another Maxx</strong>
            <small>Use the address and one-time pairing code shown on that computer.</small>
          </span>
        </div>
        {discovery?.peers.length ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2 px-3.5 py-3" aria-label="Tailscale devices">
            {discovery.peers.map((peer) => {
              const peerAddress = peer.dnsName || peer.addresses[0] || "";
              return (
                <Button
                  key={peer.dnsName || peer.name}
                  type="button"
                  variant={address.trim() === peerAddress ? "secondary" : "outline"}
                  className="h-auto min-w-0 flex-col items-start gap-1 overflow-hidden p-3"
                  aria-pressed={address.trim() === peerAddress}
                  disabled={!peer.online || !peerAddress}
                  onClick={() => setAddress(peerAddress)}
                >
                  <span className="max-w-full truncate">{peer.name}</span>
                  <small className="max-w-full truncate">{peer.online ? peerAddress : "Offline"}</small>
                </Button>
              );
            })}
          </div>
        ) : discovery && !discovery.running ? (
          <div className="px-3.5 pb-3 text-xs leading-relaxed text-muted-foreground">{discovery.error}</div>
        ) : null}
        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Address</strong>
          </span>
          <Input
            value={address}
            aria-label="Remote host address"
            placeholder="other-computer.tailnet.ts.net"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Pairing code</strong>
          </span>
          <Input
            value={code}
            aria-label="Pairing code"
            placeholder="ABCD-1234"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className={settingsCompactControlRowClass}>
          <span className={settingsRowCopyClass}>
            <small>Your local projects stay on this computer after you connect.</small>
          </span>
          <Button
            type="button"
            disabled={!canConnect}
            onClick={() => void connect()}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
        {hostStatus?.remotes.map((remote) => (
          <div key={remote.id} className={settingsCompactControlRowClass}>
            <span className={settingsRowCopyClass}>
              <strong>{remote.name}</strong>
              <small>
                {remote.address} · {remote.connected ? "Connected" : remote.error || "Reconnecting…"}
              </small>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void disconnectHost(remote.id)}
            >
              Forget
            </Button>
          </div>
        ))}
        {(actionError || error) && (
          <Alert className={settingsInlineAlertClass} variant="destructive"><AlertDescription className="flex items-center gap-2"><Icons.close aria-hidden="true" /><span>{actionError || error}</span></AlertDescription></Alert>
        )}
      </Card>

      <Card className={settingsCardClass} aria-label="Paired devices">
        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Paired devices</strong>
            <small>Devices allowed to reconnect to this computer. Revoking takes effect immediately.</small>
          </span>
        </div>
        {hostStatus?.pairedDevices.length ? hostStatus.pairedDevices.map((device) => (
          <div key={device.id} className={settingsCompactControlRowClass}>
            <span className={settingsRowCopyClass}>
              <strong>{device.name}</strong>
              <small>{device.capabilities.join(", ")}</small>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void revokeDevice(device.id)}
            >
              Revoke
            </Button>
          </div>
        )) : (
          <div className="px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
            No devices are paired with this computer.
          </div>
        )}
      </Card>
    </>
  );
}

function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await ipc.writeClipboardText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard can be denied; the value stays selectable.
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1">
      <code className="min-w-0 truncate text-xs" aria-label={label}>{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void copy()}
        aria-label={`${copied ? "Copied" : "Copy"} ${label}`}
      >
        {copied ? <Icons.check data-icon="inline-start" /> : <Icons.copy data-icon="inline-start" />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}

/**
 * Voice section.
 *
 * The Grok switch is the one control here that deserves explaining rather than
 * just labelling: it makes Maxx read a credential belonging to a different
 * product. The copy says so plainly, and it ships off — dictation asks for an
 * `XAI_API_KEY` until the user decides otherwise.
 */
function VoiceSettingsSection() {
  const stored = useAppStore((state) => state.workspace?.voice);
  const hostStatus = useAppStore((state) => state.hostStatus);
  const saveVoiceSettings = useAppStore((state) => state.saveVoiceSettings);
  const settings: VoiceSettings = stored ?? DEFAULT_VOICE_SETTINGS;
  const [status, setStatus] = useState<VoiceCredentialStatus | null>(null);
  const [testResult, setTestResult] = useState<VoiceProviderTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [sttModels, setSttModels] = useState<VoiceModel[]>([]);
  const [sttModelsError, setSttModelsError] = useState<string | null>(null);
  const [devices, setDevices] = useState<VoiceAudioDevices>({ inputs: [], outputs: [] });
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceProfile[]>([]);
  const [voiceCatalogLoading, setVoiceCatalogLoading] = useState(false);
  const [voiceCatalogError, setVoiceCatalogError] = useState<string | null>(null);
  const [ttsEndpointDraft, setTtsEndpointDraft] = useState(settings.ttsApiBase);
  const [ttsModelDraft, setTtsModelDraft] = useState(settings.ttsModel);
  const [voiceDraft, setVoiceDraft] = useState(settings.voiceID);
  const [ttsTestText, setTtsTestText] = useState("This is a Maxx voice test.");
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsTestMessage, setTtsTestMessage] = useState<string | null>(null);
  const ttsPlayerRef = useRef<VoiceTtsPlayer | null>(null);

  // Re-probed after every change: turning the opt-in on should immediately
  // show whose sign-in was found, not wait for the next dictation attempt.
  useEffect(() => {
    let current = true;
    if (settings.sttProvider !== "openai-compatible" || !settings.sttApiBase.trim()) {
      setSttModels([]);
      setSttModelsError(null);
      return () => { current = false; };
    }
    void ipc.voiceListModels(settings, settings.speechHostID)
      .then((models) => {
        if (!current) return;
        setSttModels(models);
        setSttModelsError(models.length === 0 ? "No models were advertised; enter the model ID manually." : null);
      })
      .catch((reason) => {
        if (!current) return;
        setSttModels([]);
        setSttModelsError(`Model discovery unavailable; enter the model ID manually. ${String(reason)}`);
      });
    return () => { current = false; };
  }, [settings.sttProvider, settings.sttApiBase, settings.speechHostID]);

  useEffect(() => {
    let current = true;
    void ipc
      .voiceStatus(settings, settings.speechHostID)
      .then((result) => {
        if (current) setStatus(result);
      })
      .catch(() => {
        if (current) setStatus(null);
      });
    return () => {
      current = false;
    };
  }, [settings, settings.speechHostID]);

  useEffect(() => {
    let current = true;
    const refreshDevices = () => {
      void enumerateVoiceDevices()
        .then((result) => {
          if (!current) return;
          setDevices(result);
          setDeviceError(null);
        })
        .catch((reason) => {
          if (current) setDeviceError(String(reason));
        });
    };
    refreshDevices();
    if (typeof navigator !== "undefined") {
      navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    }
    return () => {
      current = false;
      if (typeof navigator !== "undefined") {
        navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
      }
    };
  }, []);

  useEffect(() => {
    setTtsEndpointDraft(settings.ttsApiBase);
    setTtsModelDraft(settings.ttsModel);
    setVoiceDraft(settings.voiceID);
  }, [settings.ttsApiBase, settings.ttsModel, settings.voiceID]);

  useEffect(() => {
    const catalogVoice = voiceCatalog.find((voice) => voice.id === voiceDraft.trim());
    if (catalogVoice) setTtsModelDraft(catalogVoice.model);
  }, [voiceCatalog, voiceDraft]);

  useEffect(() => {
    let current = true;
    const endpoint = settings.ttsApiBase.trim();
    if (!endpoint) {
      setVoiceCatalog([]);
      setVoiceCatalogLoading(false);
      setVoiceCatalogError("Configure a TTS endpoint, then choose or enter a voice ID.");
      return () => { current = false; };
    }

    setVoiceCatalogLoading(true);
    setVoiceCatalogError(null);
    void ipc.voiceListVoices(settings, settings.speechHostID)
      .then((voices) => {
        if (!current) return;
        setVoiceCatalog(voices);
        if (voices.length === 0) setVoiceCatalogError("No voice catalog is available; enter the provider's voice ID manually.");
      })
      .catch((reason) => {
        if (!current) return;
        setVoiceCatalog([]);
        setVoiceCatalogError(`Voice discovery is unavailable; enter the provider's voice ID manually. ${String(reason)}`);
      })
      .finally(() => {
        if (current) setVoiceCatalogLoading(false);
      });
    return () => { current = false; };
  }, [settings, settings.speechHostID, settings.ttsApiBase, settings.ttsProvider]);

  useEffect(() => () => {
    void ttsPlayerRef.current?.dispose();
  }, []);

  const update = (patch: Partial<VoiceSettings>) => {
    void saveVoiceSettings({ ...settings, ...patch });
  };

  const testConnection = () => {
    setTesting(true);
    setTestResult(null);
    void ipc.voiceTestStt(settings, settings.speechHostID)
      .then((result) => {
        setTestResult(result);
        setStatus({
          source: result.ok ? "none" : "none",
          detail: result.message,
          available: result.ok,
          provider: result.provider,
          endpoint: result.endpoint,
          model: result.model,
        });
      })
      .catch((reason) => {
        setTestResult(null);
        setStatus({ source: "none", detail: String(reason), available: false });
      })
      .finally(() => setTesting(false));
  };

  const commitTtsSettings = () => {
    const ttsApiBase = ttsEndpointDraft.trim();
    const selection = resolveVoiceSelection(voiceCatalog, voiceDraft, ttsModelDraft);
    if (
      ttsApiBase === settings.ttsApiBase
      && selection.model === settings.ttsModel
      && selection.voiceID === settings.voiceID
    ) return;
    update({ ttsApiBase, ttsModel: selection.model, voiceID: selection.voiceID });
  };

  const draftVoiceSelection = resolveVoiceSelection(voiceCatalog, voiceDraft, ttsModelDraft);
  const voiceIsSelected = Boolean(draftVoiceSelection.voiceID);

  const testVoice = () => {
    const ttsApiBase = ttsEndpointDraft.trim();
    if (!ttsApiBase || !draftVoiceSelection.model) {
      setTtsTestMessage("Configure a TTS endpoint and model before testing voice.");
      return;
    }
    if (!voiceIsSelected) {
      setTtsTestMessage("Choose or enter a voice ID before testing voice.");
      return;
    }
    if (!ttsTestText.trim()) {
      setTtsTestMessage("Enter a short phrase to test voice playback.");
      return;
    }
    const nextSettings = {
      ...settings,
      ttsApiBase,
      ttsModel: draftVoiceSelection.model,
      voiceID: draftVoiceSelection.voiceID,
    };
    if (
      nextSettings.ttsApiBase !== settings.ttsApiBase
      || nextSettings.ttsModel !== settings.ttsModel
      || nextSettings.voiceID !== settings.voiceID
    ) void saveVoiceSettings(nextSettings);
    const player = ttsPlayerRef.current ?? (ttsPlayerRef.current = new VoiceTtsPlayer(ipc));
    setTtsTesting(true);
    setTtsTestMessage(null);
    void player
      .play(nextSettings, ttsTestText.trim(), nextSettings.voiceID, nextSettings.speechHostID)
      .then(() => setTtsTestMessage("Voice test finished."))
      .catch((reason) => setTtsTestMessage(`Voice test failed: ${String(reason)}`))
      .finally(() => setTtsTesting(false));
  };

  const stopVoiceTest = () => {
    const player = ttsPlayerRef.current;
    if (!player) return;
    void player.cancel().finally(() => {
      setTtsTesting(false);
      setTtsTestMessage("Voice test canceled.");
    });
  };

  const remoteHosts = hostStatus?.remotes ?? [];
  const speechHostLabel = settings.speechHostID === "local"
    ? `${hostStatus?.name ?? "This computer"} (local)`
    : `${remoteHosts.find((remote) => remote.id === settings.speechHostID)?.name ?? settings.speechHostID} (remote)`;

  return (
    <>
      <header className={settingsPageHeaderClass} onMouseDown={beginWindowDrag}>
        <div>
          <h1 className={settingsPageTitleClass}>Voice</h1>
          <p className={settingsPageDescriptionClass}>
            Keep capture and playback on this computer while speech processing runs on the selected
            provider and host. Dictation and hands-free Conversation are both available from every
            GUI composer when their services are configured.
          </p>
        </div>

      </header>

      <div className="flex w-full flex-col gap-6" aria-label="Voice settings">
        <div className="flex flex-col gap-2">
          <header className="flex flex-col gap-1 px-0.5">
            <h2 className="text-sm font-semibold">Basics</h2>
            <p className="text-xs leading-relaxed text-muted-foreground">Make dictation and hands-free conversation available in the composer.</p>
          </header>
          <Card className={settingsCardClass} aria-label="Voice basics">
            <div className={settingsCompactControlRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Voice input</strong>
            <small>Show dictation and conversation controls in GUI composers.</small>
          </span>
          <Switch checked={settings.isEnabled} aria-label="Enable voice input" onCheckedChange={(enabled) => update({ isEnabled: enabled })} />
            </div>

          </Card>
        </div>

        <div className="flex flex-col gap-2">
          <header className="flex flex-col gap-1 px-0.5">
            <h2 className="text-sm font-semibold">Transcription</h2>
            <p className="text-xs leading-relaxed text-muted-foreground">Configure the service that turns speech into text.</p>
          </header>
          <Card className={settingsCardClass} aria-label="Transcription settings">
            <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Speech-to-text provider</strong>
            <small>Choose xAI realtime transcription or a standard OpenAI-compatible audio API.</small>
          </span>
          <NativeSelect
            className="w-full"
            value={settings.sttProvider}
            onChange={(event) => update({ sttProvider: event.target.value as VoiceSettings["sttProvider"] })}
          >
            <NativeSelectOption value="xai">xAI</NativeSelectOption>
            <NativeSelectOption value="openai-compatible">OpenAI-compatible</NativeSelectOption>
          </NativeSelect>
        </div>

        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>STT endpoint</strong>
            <small>API root used by the selected speech host.</small>
          </span>
          <Input
            aria-label="Speech-to-text endpoint"
            type="url"
            defaultValue={settings.sttApiBase}
            placeholder="https://api.x.ai"
            onBlur={(event) => update({ sttApiBase: event.target.value.trim() })}
          />
        </div>

        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>STT model</strong>
            <small>{settings.sttProvider === "xai"
              ? "Optional; leave blank to use the provider default."
              : sttModelsError ?? (sttModels.length > 0
                ? `${sttModels.length} model${sttModels.length === 1 ? "" : "s"} discovered. Choose one or enter an exact ID.`
                : "Required for OpenAI-compatible services.")}</small>
          </span>
          <Input
            aria-label="Speech-to-text model"
            type="text"
            list={settings.sttProvider === "openai-compatible" ? "voice-stt-models" : undefined}
            defaultValue={settings.sttModel}
            placeholder={settings.sttProvider === "xai" ? "Provider default" : "whisper-1"}
            onBlur={(event) => update({ sttModel: event.target.value.trim() })}
          />
          <datalist id="voice-stt-models">
            {sttModels.map((model) => <option key={model.id} value={model.id} />)}
          </datalist>
        </div>

        {settings.sttProvider === "xai" && <div className={settingsCompactControlRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Use my Grok sign-in</strong>
            <small>
              Transcription runs on the same xAI account the Grok CLI is signed in to, so
              there is no separate API key to manage. Maxx reads the token from
              <code> ~/.grok/auth.json</code> each time it connects, and never copies or
              stores it. Leave this off to use <code>XAI_API_KEY</code> instead.
            </small>
          </span>
          <Switch checked={settings.useGrokSignIn} aria-label="Use my Grok sign-in for transcription" onCheckedChange={(enabled) => update({ useGrokSignIn: enabled })} />
        </div>}

        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Language</strong>
            <small>What the transcriber should expect to hear.</small>
          </span>
          <NativeSelect
            className="w-full"
            value={settings.language}
            onChange={(event) => update({ language: event.target.value })}
          >
            {VOICE_LANGUAGES.map((language) => (
              <NativeSelectOption key={language.code} value={language.code}>{language.label}</NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        <div className={settingsCompactControlRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Test transcription</strong>
            <small>{testResult?.message ?? (settings.sttProvider === "xai"
              ? "Open and close the selected provider's realtime connection."
              : "Upload a short silent WAV to verify the standard transcription route.")}</small>
          </span>
          <Button variant="secondary" type="button" disabled={testing} onClick={testConnection}>
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </div>

        {status && (
          <Alert className={settingsInlineAlertClass} variant={status.available ? "default" : "destructive"}><AlertDescription className="flex items-center gap-2">{status.available ? <Icons.check aria-hidden="true" /> : <Icons.close aria-hidden="true" />}<span>{status.detail}</span></AlertDescription></Alert>
        )}
          </Card>
        </div>

        <div className="flex flex-col gap-2">
          <header className="flex flex-col gap-1 px-0.5">
            <h2 className="text-sm font-semibold">Audio &amp; routing</h2>
            <p className="text-xs leading-relaxed text-muted-foreground">Choose where speech is processed while capture and playback remain on this computer.</p>
          </header>
          <Card className={settingsCardClass} aria-label="Audio and routing settings">

        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Processing host</strong>
            <small>Only speech processing is routed. Microphone capture stays on this computer.</small>
          </span>
          <NativeSelect
            className="w-full"
            value={settings.speechHostID}
            onChange={(event) => update({ speechHostID: event.target.value })}
          >
            <NativeSelectOption value="local">{hostStatus?.name ?? "This computer"} (local)</NativeSelectOption>
            {remoteHosts.map((remote) => (
              <NativeSelectOption key={remote.id} value={remote.id} disabled={!remote.connected}>
                {remote.name}{remote.connected ? "" : " (offline)"}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Microphone</strong>
            <small>Capture is always performed locally in the renderer.</small>
          </span>
          <NativeSelect
            className="w-full"
            value={settings.inputDeviceID ?? "default"}
            onChange={(event) => update({ inputDeviceID: event.target.value === "default" ? null : event.target.value })}
          >
            <NativeSelectOption value="default">Default microphone</NativeSelectOption>
            {devices.inputs.filter((device) => device.id !== "default").map((device) => (
              <NativeSelectOption key={device.id} value={device.id}>{device.label}</NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Output device</strong>
            <small>Playback stays local; device routing is applied when conversation audio is enabled.</small>
          </span>
          <NativeSelect
            className="w-full"
            value={settings.outputDeviceID ?? "default"}
            onChange={(event) => update({ outputDeviceID: event.target.value === "default" ? null : event.target.value })}
          >
            <NativeSelectOption value="default">System Default</NativeSelectOption>
            {devices.outputs.filter((device) => device.id !== "default").map((device) => (
              <NativeSelectOption key={device.id} value={device.id}>{device.label}</NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        {deviceError && <Alert className={settingsInlineAlertClass} variant="destructive"><AlertDescription>{deviceError}</AlertDescription></Alert>}
          </Card>
        </div>

        <div className="flex flex-col gap-2">
          <header className="flex flex-col gap-1 px-0.5">
            <h2 className="text-sm font-semibold">Conversation behavior</h2>
            <p className="text-xs leading-relaxed text-muted-foreground">Control how Conversation mode ends turns and handles speech over a reply.</p>
          </header>
          <Card className={settingsCardClass} aria-label="Conversation behavior settings">

        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Turn detection</strong>
            <small>Automatic ends an utterance after a quiet period. Manual mode waits for Finish utterance.</small>
          </span>
          <NativeSelect
            className="w-full"
            aria-label="Voice turn detection"
            value={settings.turnDetection}
            onChange={(event) => update({ turnDetection: event.target.value as VoiceSettings["turnDetection"] })}
          >
            <NativeSelectOption value="automatic">Automatic</NativeSelectOption>
            <NativeSelectOption value="manual">Manual</NativeSelectOption>
          </NativeSelect>
        </div>

        <div className={settingsCompactControlRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Allow interruption</strong>
            <small>When enabled, speech starts a new turn while the assistant is speaking and cancels unplayed audio.</small>
          </span>
          <Switch checked={settings.allowInterruption} aria-label="Allow voice interruption" onCheckedChange={(enabled) => update({ allowInterruption: enabled })} />
        </div>
          </Card>
        </div>

        <div className="flex flex-col gap-2">
          <header className="flex flex-col gap-1 px-0.5">
            <h2 className="text-sm font-semibold">Speech output</h2>
            <p className="text-xs leading-relaxed text-muted-foreground">Send synthesized replies from {speechHostLabel} to local playback.</p>
          </header>
          <Card className={settingsCardClass} aria-label="Speech output settings">
        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}><strong>TTS provider</strong><small>Uses the standard OpenAI-compatible speech endpoint and self-describing WAV audio.</small></span>
          <NativeSelect className="w-full" aria-label="Text-to-speech provider" value={settings.ttsProvider} disabled>
            <NativeSelectOption value="openai-compatible">OpenAI-compatible</NativeSelectOption>
          </NativeSelect>
        </div>
        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}><strong>TTS endpoint</strong><small>API root used by the selected speech host.</small></span>
          <Input
            aria-label="Text-to-speech endpoint"
            type="url"
            value={ttsEndpointDraft}
            placeholder="http://localhost:8000/v1"
            onChange={(event) => setTtsEndpointDraft(event.target.value)}
            onBlur={commitTtsSettings}
          />
        </div>
        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}><strong>TTS model</strong><small>Selected automatically from the named voice catalog; edit only when your provider requires it.</small></span>
          <Input
            aria-label="Text-to-speech model"
            type="text"
            value={ttsModelDraft}
            placeholder="tts-1"
            onChange={(event) => setTtsModelDraft(event.target.value)}
            onBlur={commitTtsSettings}
          />
        </div>
        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Voice</strong>
            <small>Catalog from {speechHostLabel}. {voiceCatalogLoading ? "Loading voices…" : voiceCatalogError ?? "Choose a discovered voice or enter the provider's voice ID."}</small>
          </span>
          <Input
            aria-label="Text-to-speech voice"
            type="text"
            list="voice-tts-voices"
            value={voiceDraft}
            placeholder="alloy"
            onChange={(event) => setVoiceDraft(event.target.value)}
            onBlur={commitTtsSettings}
          />
          <datalist id="voice-tts-voices">
            {voiceCatalog.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} · {voice.model} · {voice.language}
              </option>
            ))}
          </datalist>
        </div>
        <div className={settingsRowClass}>
          <span className={settingsRowCopyClass}>
            <strong>Test voice</strong>
            <small>Requests a short WAV phrase, validates its audio format, and plays it on this computer.</small>
          </span>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <Input
              className="min-w-0"
              aria-label="Voice test text"
              type="text"
              value={ttsTestText}
              onChange={(event) => setTtsTestText(event.target.value)}
              disabled={ttsTesting}
            />
            {ttsTesting ? (
              <Button variant="secondary" type="button" onClick={stopVoiceTest}>Stop</Button>
            ) : (
              <Button
                variant="secondary"
                type="button"
                disabled={!ttsEndpointDraft.trim() || !draftVoiceSelection.model || !voiceIsSelected}
                onClick={testVoice}
              >
                Test voice
              </Button>
            )}
          </div>
        </div>

        {ttsTestMessage && <Alert className={settingsInlineAlertClass} variant={ttsTestMessage === "Voice test finished." ? "default" : "destructive"}><AlertDescription>{ttsTestMessage}</AlertDescription></Alert>}
          </Card>
        </div>
      </div>
    </>
  );
}

function KeyboardShortcutRow({
  command,
  label,
  description,
  binding,
  allBindings,
  onChange,
  onReset,
}: {
  command: KeyboardShortcutCommand;
  label: string;
  description: string;
  binding: KeyboardShortcutBinding;
  allBindings: KeyboardShortcutBindings;
  onChange: (binding: KeyboardShortcutBinding) => void;
  onReset: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDefault = keyboardShortcutsEqual(binding, DEFAULT_KEYBOARD_SHORTCUTS[command]);
  const helpID = `shortcut-${command}-help`;

  useEffect(() => {
    if (!recording) return;

    const recordShortcut = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (event.key === "Escape") {
        setRecording(false);
        setError(null);
        return;
      }

      const candidate = keyboardShortcutFromEvent(event);
      if (!candidate) return;
      if (!isAllowedKeyboardShortcut(candidate)) {
        setError("Include Command, Option, or Control in the shortcut.");
        return;
      }

      const conflict = findKeyboardShortcutConflict(allBindings, command, candidate);
      if (conflict) {
        setError(`Already used by ${conflict.label}.`);
        return;
      }

      onChange(candidate);
      setRecording(false);
      setError(null);
    };

    window.addEventListener("keydown", recordShortcut, true);
    return () => window.removeEventListener("keydown", recordShortcut, true);
  }, [allBindings, command, onChange, recording]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <strong>{label}</strong>
        <small className="text-muted-foreground" id={helpID}>{description}</small>
        {error && <span className="text-sm text-destructive" role="alert">{error}</span>}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={recording ? "secondary" : "outline"}
          aria-pressed={recording}
          aria-describedby={helpID}
          aria-label={recording
            ? `Recording a new shortcut for ${label}. Press Escape to cancel.`
            : `${label}: ${keyboardShortcutAriaLabel(binding)}. Activate to change.`}
          onClick={() => {
            setRecording((current) => !current);
            setError(null);
          }}
          onBlur={() => setRecording(false)}
        >
          {recording ? <span>Press keys…</span> : <Kbd aria-hidden="true">{formatKeyboardShortcut(binding)}</Kbd>}
        </Button>
        {!isDefault && (
          <Button type="button" variant="ghost" size="sm" onClick={onReset}>Reset</Button>
        )}
      </div>
    </div>
  );
}
