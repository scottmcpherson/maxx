import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../ipc";
import { providerDisplayName } from "../contract/types";
import type { ProviderHealth, ProviderProfile } from "../contract/types";
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
import { DEFAULT_VOICE_SETTINGS, VOICE_LANGUAGES } from "../voice/types";
import type {
  VoiceCredentialStatus,
  VoiceProfile,
  VoiceProviderTestResult,
  VoiceSettings,
} from "../voice/types";
import { VoiceTtsPlayer } from "../voice/tts";
import { beginWindowDrag } from "../windowDrag";
import { Icons } from "./Icons";
import { ProviderSettingsRow } from "./ProviderSettingsRow";
import { RuntimePicker } from "./RuntimePicker";

type SettingsSection = "providers" | "voice" | "keyboardShortcuts" | "connections" | "experimental";

export function SettingsPanel() {
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
  const [section, setSection] = useState<SettingsSection>("providers");
  const [drafts, setDrafts] = useState<ProviderProfile[]>([]);
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [query, setQuery] = useState("");
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

  const selectSection = (nextSection: SettingsSection) => {
    setSection(nextSection);
    setQuery("");
  };

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

  const sectionBody = () => {
    switch (section) {
      case "providers":
        return (
          <>
            <header className="settings-content-header" onMouseDown={beginWindowDrag}>
              <div>
                <h1>Providers</h1>
                <p>Choose the command-line agents Maxx can run in a thread. Changes apply immediately.</p>
              </div>
            </header>

            <section
              className="settings-card default-runtime-settings"
              aria-label="Default model"
            >
              <div className="settings-row">
                <span className="settings-row-copy">
                  <strong>Default model</strong>
                  <small>
                    Choose the provider, model, and effort used when you start a new chat.
                    You can still change it in the composer before sending.
                  </small>
                </span>
                <div className="runtime-picker-field settings-runtime-picker">
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
              <div className="settings-row">
                <span className="settings-row-copy">
                  <strong>Title generation</strong>
                  <small>
                    Choose a global harness for short chat titles. If it is unset or unavailable,
                    Maxx uses the harness and model selected for the chat.
                  </small>
                </span>
                <div className="runtime-picker-field settings-runtime-picker">
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
            </section>

            <section className="provider-settings-list" aria-label="Provider settings">
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
              {visibleProfiles.length === 0 && <p className="settings-empty">No providers match “{query}”.</p>}
            </section>

            <section className="settings-card provider-diagnostics-settings" aria-label="Provider diagnostics settings">
              <div className="settings-row">
                <span className="settings-row-copy">
                  <strong>Show provider diagnostics</strong>
                  <small>
                    Show non-fatal notices reported by provider command-line runtimes in chat.
                    Errors and warnings that require action remain visible.
                  </small>
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={showProviderDiagnostics}
                    aria-label="Show provider diagnostics"
                    onChange={(event) => setShowProviderDiagnostics(event.target.checked)}
                  />
                  <span />
                </label>
              </div>
            </section>
          </>
        );
      case "voice":
        return <VoiceSettingsSection />;
      case "connections":
        return <ConnectionsSettingsSection />;
      case "experimental":
        return <ExperimentalSettingsSection />;
      case "keyboardShortcuts":
        return (
          <>
            <header className="settings-content-header" onMouseDown={beginWindowDrag}>
              <div>
                <h1>Keyboard Shortcuts</h1>
                <p>Customize how you move around Maxx.</p>
              </div>
            </header>

            <section className="keyboard-shortcut-list" aria-label="Keyboard shortcuts">
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
              {visibleShortcuts.length === 0 && <p className="settings-empty">No shortcuts match “{query}”.</p>}
            </section>
            <p className="keyboard-shortcut-note">Click a shortcut, then press a new key combination. Changes save automatically.</p>
          </>
        );
    }
  };

  return (
    <div className="settings-screen">
      <aside className="settings-sidebar">
        <div className="settings-titlebar" onMouseDown={beginWindowDrag}>
          <span className="traffic-light-spacer" aria-hidden="true" />
        </div>
        <button type="button" className="settings-back" onClick={() => setSettingsOpen(false)}>
          <Icons.chevronRight size={13} className="back-chevron" />
          Back
        </button>
        <label className="settings-search">
          <Icons.search size={13} />
          <input
            value={query}
            aria-label="Search settings"
            placeholder="Search Settings"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <nav className="settings-nav" aria-label="Settings sections">
          <button
            type="button"
            className={section === "providers" ? "selected" : ""}
            aria-current={section === "providers" ? "page" : undefined}
            onClick={() => selectSection("providers")}
          >
            <Icons.activity size={15} />Providers
          </button>
          <button
            type="button"
            className={section === "voice" ? "selected" : ""}
            aria-current={section === "voice" ? "page" : undefined}
            onClick={() => selectSection("voice")}
          >
            <Icons.microphone size={15} />Voice
          </button>
          <button
            type="button"
            className={section === "connections" ? "selected" : ""}
            aria-current={section === "connections" ? "page" : undefined}
            onClick={() => selectSection("connections")}
          >
            <Icons.computer size={15} />Connections
          </button>
          <button
            type="button"
            className={section === "keyboardShortcuts" ? "selected" : ""}
            aria-current={section === "keyboardShortcuts" ? "page" : undefined}
            onClick={() => selectSection("keyboardShortcuts")}
          >
            <Icons.keyboard size={15} />Keyboard Shortcuts
          </button>
          <button
            type="button"
            className={section === "experimental" ? "selected" : ""}
            aria-current={section === "experimental" ? "page" : undefined}
            onClick={() => selectSection("experimental")}
          >
            <Icons.flask size={15} />Experimental
          </button>
        </nav>
      </aside>

      <main className="settings-content">
        {sectionBody()}
      </main>
    </div>
  );
}

function ExperimentalSettingsSection() {
  const terminalModeEnabled = useAppStore((state) => state.terminalModeEnabled);
  const setTerminalModeEnabled = useAppStore((state) => state.setTerminalModeEnabled);

  return (
    <>
      <header className="settings-content-header" onMouseDown={beginWindowDrag}>
        <div>
          <h1>Experimental</h1>
          <p>Try features that are still being refined. They may change in future builds.</p>
        </div>
      </header>

      <section className="settings-card experimental-settings" aria-label="Experimental settings">
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Terminal mode</strong>
            <small>
              Show controls for starting chats in a provider’s native terminal interface
              and switching existing chats between terminal and GUI modes.
            </small>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={terminalModeEnabled}
              aria-label="Enable terminal mode"
              onChange={(event) => setTerminalModeEnabled(event.target.checked)}
            />
            <span />
          </label>
        </div>
      </section>
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
      <header className="settings-content-header" onMouseDown={beginWindowDrag}>
        <div>
          <h1>Connections</h1>
          <p>
            This computer keeps its own projects and chats. Another Maxx can connect over Tailscale
            and work in this workspace without merging the two.
          </p>
        </div>
      </header>

      <section className="settings-card" aria-label="Allow connections">
        <div className="settings-row host-listening-row">
          <span className="settings-row-copy">
            <strong>Allow connections</strong>
            <small>
              Other Maxx apps can pair with {hostStatus?.name ?? "this computer"}. Leave this on
              while you want to be reachable.
            </small>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={listening}
              disabled={busy}
              aria-label="Allow connections from other Maxx apps"
              onChange={(event) => void toggleListening(event.target.checked)}
            />
            <span />
          </label>
        </div>
        <div
          className={`host-listening-details${listening ? " is-open" : ""}`}
          aria-hidden={!listening}
          inert={!listening}
        >
          <div className="host-listening-details-inner">
            <div className="settings-row host-action-row">
              <span className="settings-row-copy">
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
                <span className="host-muted-value">port 7422</span>
              )}
            </div>
            <div className="settings-row host-pairing-row">
              <span className="settings-row-copy">
                <strong>Pairing code</strong>
                <small>
                  Generate a one-time code when the other computer is ready. It expires after five minutes.
                </small>
              </span>
              {hostStatus?.pairing ? (
                <div className="host-pairing-controls">
                  <CopyableValue value={hostStatus.pairing.code} label="Pairing code" />
                  <button type="button" className="host-disconnect-button" onClick={() => void cancelPairing()}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="host-pairing-controls">
                  <select
                    className="host-access-select"
                    value={preset}
                    aria-label="Pairing access"
                    onChange={(event) => setPreset(event.target.value as AccessPreset)}
                  >
                    <option value="standard">Standard access</option>
                    <option value="full">Full access</option>
                  </select>
                  <button
                    type="button"
                    className="host-connect-button"
                    disabled={busy}
                    onClick={() => void createPairing()}
                  >
                    Generate code
                  </button>
                </div>
              )}
            </div>
            {hostStatus?.pairing && (
              <div className="host-access-summary">
                Expires {new Date(hostStatus.pairing.expiresAt * 1000).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}. Access: {hostStatus.pairing.capabilities.join(", ")}.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="settings-card host-connect-card" aria-label="Connect to another Maxx">
        <div className={`settings-row host-connect-intro-row${discovery?.peers.length ? " has-discovery" : ""}`}>
          <span className="settings-row-copy">
            <strong>Connect to another Maxx</strong>
            <small>Use the address and one-time pairing code shown on that computer.</small>
          </span>
        </div>
        {discovery?.peers.length ? (
          <div className="host-discovery-list" aria-label="Tailscale devices">
            {discovery.peers.map((peer) => {
              const peerAddress = peer.dnsName || peer.addresses[0] || "";
              return (
                <button
                  key={peer.dnsName || peer.name}
                  type="button"
                  className={`host-discovery-device${address.trim() === peerAddress ? " is-selected" : ""}`}
                  aria-pressed={address.trim() === peerAddress}
                  disabled={!peer.online || !peerAddress}
                  onClick={() => setAddress(peerAddress)}
                >
                  <span>{peer.name}</span>
                  <small>{peer.online ? peerAddress : "Offline"}</small>
                </button>
              );
            })}
          </div>
        ) : discovery && !discovery.running ? (
          <div className="host-access-summary">{discovery.error}</div>
        ) : null}
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Address</strong>
          </span>
          <input
            className="host-text-input"
            value={address}
            aria-label="Remote host address"
            placeholder="other-computer.tailnet.ts.net"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Pairing code</strong>
          </span>
          <input
            className="host-text-input"
            value={code}
            aria-label="Pairing code"
            placeholder="ABCD-1234"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="settings-row host-connect-row">
          <span className="settings-row-copy">
            <small>Your local projects stay on this computer after you connect.</small>
          </span>
          <button
            type="button"
            className="host-connect-button"
            disabled={!canConnect}
            onClick={() => void connect()}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
        {hostStatus?.remotes.map((remote) => (
          <div key={remote.id} className="settings-row host-action-row">
            <span className="settings-row-copy">
              <strong>{remote.name}</strong>
              <small>
                {remote.address} · {remote.connected ? "Connected" : remote.error || "Reconnecting…"}
              </small>
            </span>
            <button
              type="button"
              className="host-disconnect-button"
              onClick={() => void disconnectHost(remote.id)}
            >
              Forget
            </button>
          </div>
        ))}
        {(actionError || error) && (
          <div className="voice-credential-status is-missing" role="status">
            <Icons.close size={13} />
            <span>{actionError || error}</span>
          </div>
        )}
      </section>

      <section className="settings-card host-connect-card" aria-label="Paired devices">
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Paired devices</strong>
            <small>Devices allowed to reconnect to this computer. Revoking takes effect immediately.</small>
          </span>
        </div>
        {hostStatus?.pairedDevices.length ? hostStatus.pairedDevices.map((device) => (
          <div key={device.id} className="settings-row host-action-row">
            <span className="settings-row-copy">
              <strong>{device.name}</strong>
              <small>{device.capabilities.join(", ")}</small>
            </span>
            <button
              type="button"
              className="host-disconnect-button"
              disabled={busy}
              onClick={() => void revokeDevice(device.id)}
            >
              Revoke
            </button>
          </div>
        )) : (
          <div className="host-access-summary host-empty-state">
            No devices are paired with this computer.
          </div>
        )}
      </section>
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
    <div className="host-copy-field">
      <code aria-label={label}>{value}</code>
      <button
        type="button"
        className={copied ? "is-copied" : undefined}
        onClick={() => void copy()}
        aria-label={`${copied ? "Copied" : "Copy"} ${label}`}
      >
        <span key={copied ? "copied" : "copy"} className="host-copy-icon" aria-hidden="true">
          {copied ? <Icons.check size={13} /> : <Icons.copy size={13} />}
        </span>
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
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
  const [devices, setDevices] = useState<VoiceAudioDevices>({ inputs: [], outputs: [] });
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceProfile[]>([]);
  const [voiceCatalogLoading, setVoiceCatalogLoading] = useState(false);
  const [voiceCatalogError, setVoiceCatalogError] = useState<string | null>(null);
  const [ttsEndpointDraft, setTtsEndpointDraft] = useState(settings.ttsApiBase);
  const [ttsModelDraft, setTtsModelDraft] = useState(settings.ttsModel);
  const [ttsTestText, setTtsTestText] = useState("This is a Maxx voice test.");
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsTestMessage, setTtsTestMessage] = useState<string | null>(null);
  const ttsPlayerRef = useRef<VoiceTtsPlayer | null>(null);

  // Re-probed after every change: turning the opt-in on should immediately
  // show whose sign-in was found, not wait for the next dictation attempt.
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
  }, [settings.ttsApiBase, settings.ttsModel]);

  useEffect(() => {
    let current = true;
    const endpoint = settings.ttsApiBase.trim();
    if (!endpoint) {
      setVoiceCatalog([]);
      setVoiceCatalogLoading(false);
      setVoiceCatalogError("Configure a TTS endpoint to load named voices.");
      return () => { current = false; };
    }

    setVoiceCatalogLoading(true);
    setVoiceCatalogError(null);
    void ipc.voiceListVoices(settings, settings.speechHostID)
      .then((voices) => {
        if (!current) return;
        setVoiceCatalog(voices);
        if (voices.length === 0) setVoiceCatalogError("The selected speech host returned no voices.");
      })
      .catch((reason) => {
        if (!current) return;
        setVoiceCatalog([]);
        setVoiceCatalogError(`Could not load voices from ${settings.speechHostID === "local" ? "this computer" : "the remote speech host"}: ${String(reason)}`);
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
    const ttsModel = ttsModelDraft.trim();
    if (ttsApiBase === settings.ttsApiBase && ttsModel === settings.ttsModel) return;
    update({ ttsApiBase, ttsModel });
  };

  const selectedVoice = voiceCatalog.find((voice) => voice.id === settings.voiceID);
  const voiceIsSelected = Boolean(selectedVoice);

  const testVoice = () => {
    if (!settings.ttsApiBase.trim() || !settings.ttsModel.trim()) {
      setTtsTestMessage("Configure a TTS endpoint and model before testing voice.");
      return;
    }
    if (!voiceIsSelected) {
      setTtsTestMessage("Select a named catalog voice before testing voice.");
      return;
    }
    if (!ttsTestText.trim()) {
      setTtsTestMessage("Enter a short phrase to test voice playback.");
      return;
    }
    const player = ttsPlayerRef.current ?? (ttsPlayerRef.current = new VoiceTtsPlayer(ipc));
    setTtsTesting(true);
    setTtsTestMessage(null);
    void player
      .play(settings, ttsTestText.trim(), settings.voiceID || null, settings.speechHostID)
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
      <header className="settings-content-header" onMouseDown={beginWindowDrag}>
        <div>
          <h1>Voice</h1>
          <p>
            Keep capture and playback on this computer while speech processing runs on the selected
            provider and host. Dictation is reviewed in the composer; Conversation sends turns
            to the currently selected GUI thread.
          </p>
        </div>

      </header>

      <div className="voice-settings-stack" aria-label="Voice settings">
        <div className="voice-settings-group">
          <header className="voice-settings-group-header">
            <h2>Basics</h2>
            <p>Choose where voice begins and whether speech is reviewed before sending.</p>
          </header>
          <section className="settings-card voice-settings" aria-label="Voice basics">
            <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Voice input</strong>
            <small>Show a microphone button in the composer.</small>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.isEnabled}
              aria-label="Enable voice input"
              onChange={(event) => update({ isEnabled: event.target.checked })}
            />
            <span />
          </label>
            </div>

            <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Voice mode</strong>
            <small>Dictation stays in the composer for review. Conversation uses this selected GUI thread and streams replies to local playback.</small>
          </span>
          <select
            aria-label="Voice mode"
            value={settings.mode}
            onChange={(event) => update({ mode: event.target.value as VoiceSettings["mode"] })}
          >
            <option value="dictation">Dictation</option>
            <option value="conversation">Conversation</option>
          </select>
            </div>
          </section>
        </div>

        <div className="voice-settings-group">
          <header className="voice-settings-group-header">
            <h2>Transcription</h2>
            <p>Configure the service that turns speech into text.</p>
          </header>
          <section className="settings-card voice-settings" aria-label="Transcription settings">
            <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Speech-to-text provider</strong>
            <small>Choose xAI streaming STT or an OpenAI-compatible streaming endpoint.</small>
          </span>
          <select
            aria-label="Speech-to-text provider"
            value={settings.sttProvider}
            onChange={(event) => update({ sttProvider: event.target.value as VoiceSettings["sttProvider"] })}
          >
            <option value="xai">xAI</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </div>

        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>STT endpoint</strong>
            <small>API root used by the selected speech host.</small>
          </span>
          <input
            aria-label="Speech-to-text endpoint"
            type="url"
            defaultValue={settings.sttApiBase}
            placeholder="https://api.x.ai"
            onBlur={(event) => update({ sttApiBase: event.target.value.trim() })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>STT model</strong>
            <small>Optional for xAI; required for OpenAI-compatible services.</small>
          </span>
          <input
            aria-label="Speech-to-text model"
            type="text"
            defaultValue={settings.sttModel}
            placeholder={settings.sttProvider === "xai" ? "Provider default" : "whisper-1"}
            onBlur={(event) => update({ sttModel: event.target.value.trim() })}
          />
        </div>

        {settings.sttProvider === "xai" && <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Use my Grok sign-in</strong>
            <small>
              Transcription runs on the same xAI account the Grok CLI is signed in to, so
              there is no separate API key to manage. Maxx reads the token from
              <code> ~/.grok/auth.json</code> each time it connects, and never copies or
              stores it. Leave this off to use <code>XAI_API_KEY</code> instead.
            </small>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.useGrokSignIn}
              aria-label="Use my Grok sign-in for transcription"
              onChange={(event) => update({ useGrokSignIn: event.target.checked })}
            />
            <span />
          </label>
        </div>}

        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Language</strong>
            <small>What the transcriber should expect to hear.</small>
          </span>
          <select
            aria-label="Dictation language"
            value={settings.language}
            onChange={(event) => update({ language: event.target.value })}
          >
            {VOICE_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>{language.label}</option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Test transcription</strong>
            <small>{testResult?.message ?? "Open and close the selected provider's streaming connection."}</small>
          </span>
          <button className="secondary-button" type="button" disabled={testing} onClick={testConnection}>
            {testing ? "Testing…" : "Test connection"}
          </button>
        </div>

        {status && (
          <div className={`voice-credential-status ${status.available ? "is-ready" : "is-missing"}`}>
            {status.available ? <Icons.check size={13} /> : <Icons.close size={13} />}
            <span>{status.detail}</span>
          </div>
        )}
          </section>
        </div>

        <div className="voice-settings-group">
          <header className="voice-settings-group-header">
            <h2>Audio &amp; routing</h2>
            <p>Choose where speech is processed while capture and playback remain on this computer.</p>
          </header>
          <section className="settings-card voice-settings" aria-label="Audio and routing settings">

        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Processing host</strong>
            <small>Only speech processing is routed. Microphone capture stays on this computer.</small>
          </span>
          <select
            aria-label="Speech processing host"
            value={settings.speechHostID}
            onChange={(event) => update({ speechHostID: event.target.value })}
          >
            <option value="local">{hostStatus?.name ?? "This computer"} (local)</option>
            {remoteHosts.map((remote) => (
              <option key={remote.id} value={remote.id} disabled={!remote.connected}>
                {remote.name}{remote.connected ? "" : " (offline)"}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Microphone</strong>
            <small>Capture is always performed locally in the renderer.</small>
          </span>
          <select
            aria-label="Voice input device"
            value={settings.inputDeviceID ?? "default"}
            onChange={(event) => update({ inputDeviceID: event.target.value === "default" ? null : event.target.value })}
          >
            <option value="default">Default microphone</option>
            {devices.inputs.filter((device) => device.id !== "default").map((device) => (
              <option key={device.id} value={device.id}>{device.label}</option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Output device</strong>
            <small>Playback stays local; device routing is applied when conversation audio is enabled.</small>
          </span>
          <select
            aria-label="Voice output device"
            value={settings.outputDeviceID ?? "default"}
            onChange={(event) => update({ outputDeviceID: event.target.value === "default" ? null : event.target.value })}
          >
            <option value="default">System Default</option>
            {devices.outputs.filter((device) => device.id !== "default").map((device) => (
              <option key={device.id} value={device.id}>{device.label}</option>
            ))}
          </select>
        </div>

        {deviceError && <div className="voice-credential-status is-missing" role="status">{deviceError}</div>}
          </section>
        </div>

        <div className="voice-settings-group">
          <header className="voice-settings-group-header">
            <h2>Conversation behavior</h2>
            <p>Control how Conversation mode ends turns and handles speech over a reply.</p>
          </header>
          <section className="settings-card voice-settings" aria-label="Conversation behavior settings">

        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Turn detection</strong>
            <small>Automatic ends an utterance after a quiet period. Manual mode waits for Finish utterance.</small>
          </span>
          <select
            aria-label="Voice turn detection"
            value={settings.turnDetection}
            onChange={(event) => update({ turnDetection: event.target.value as VoiceSettings["turnDetection"] })}
          >
            <option value="automatic">Automatic</option>
            <option value="manual">Manual</option>
          </select>
        </div>

        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Allow interruption</strong>
            <small>When enabled, speech starts a new turn while the assistant is speaking and cancels unplayed audio.</small>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.allowInterruption}
              aria-label="Allow voice interruption"
              onChange={(event) => update({ allowInterruption: event.target.checked })}
            />
            <span />
          </label>
        </div>
          </section>
        </div>

        <div className="voice-settings-group">
          <header className="voice-settings-group-header">
            <h2>Speech output</h2>
            <p>Stream synthesized replies from {speechHostLabel} to local playback.</p>
          </header>
          <section className="settings-card voice-settings" aria-label="Speech output settings">
        <div className="settings-row">
          <span className="settings-row-copy"><strong>TTS provider</strong><small>The current synthesis adapter uses the OpenAI-compatible streaming contract.</small></span>
          <select aria-label="Text-to-speech provider" value={settings.ttsProvider} disabled>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-row-copy"><strong>TTS endpoint</strong><small>API root used by the selected speech host.</small></span>
          <input
            aria-label="Text-to-speech endpoint"
            type="url"
            value={ttsEndpointDraft}
            placeholder="http://localhost:8000/v1"
            onChange={(event) => setTtsEndpointDraft(event.target.value)}
            onBlur={commitTtsSettings}
          />
        </div>
        <div className="settings-row">
          <span className="settings-row-copy"><strong>TTS model</strong><small>Selected automatically from the named voice catalog; edit only when your provider requires it.</small></span>
          <input
            aria-label="Text-to-speech model"
            type="text"
            value={ttsModelDraft}
            placeholder="tts-1"
            onChange={(event) => setTtsModelDraft(event.target.value)}
            onBlur={commitTtsSettings}
          />
        </div>
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Voice</strong>
            <small>Catalog from {speechHostLabel}. {voiceCatalogLoading ? "Loading voices…" : voiceCatalogError ?? "Choose a named provider voice."}</small>
          </span>
          <select
            aria-label="Text-to-speech voice"
            value={settings.voiceID}
            disabled={voiceCatalogLoading || voiceCatalog.length === 0}
            onChange={(event) => {
              const voice = voiceCatalog.find((candidate) => candidate.id === event.target.value);
              if (voice) update({ voiceID: voice.id, ttsModel: voice.model });
            }}
          >
            <option value="">Select a named voice</option>
            {settings.voiceID && !voiceCatalog.some((voice) => voice.id === settings.voiceID) && (
              <option value={settings.voiceID} disabled>Unavailable selection ({settings.voiceID})</option>
            )}
            {voiceCatalog.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} · {voice.model} · {voice.language}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Test voice</strong>
            <small>Streams a short phrase, starts playback on its first PCM chunk, and can be canceled at any time.</small>
          </span>
          <div className="settings-voice-test-actions">
            <input
              aria-label="Voice test text"
              type="text"
              value={ttsTestText}
              onChange={(event) => setTtsTestText(event.target.value)}
              disabled={ttsTesting}
            />
            {ttsTesting ? (
              <button className="secondary-button" type="button" onClick={stopVoiceTest}>Stop</button>
            ) : (
              <button
                className="secondary-button"
                type="button"
                disabled={!settings.ttsApiBase.trim() || !settings.ttsModel.trim() || !voiceIsSelected}
                onClick={testVoice}
              >
                Test voice
              </button>
            )}
          </div>
        </div>

        {ttsTestMessage && <div className={`voice-credential-status ${ttsTestMessage === "Voice test finished." ? "is-ready" : "is-missing"}`} role="status">{ttsTestMessage}</div>}
          </section>
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
    <div className="keyboard-shortcut-row">
      <div className="keyboard-shortcut-copy">
        <strong>{label}</strong>
        <small id={helpID}>{description}</small>
        {error && <span className="keyboard-shortcut-error" role="alert">{error}</span>}
      </div>
      <div className="keyboard-shortcut-actions">
        <button
          type="button"
          className={`shortcut-recorder ${recording ? "is-recording" : ""}`}
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
          {recording ? <span>Press keys…</span> : <kbd aria-hidden="true">{formatKeyboardShortcut(binding)}</kbd>}
        </button>
        {!isDefault && (
          <button type="button" className="shortcut-reset" onClick={onReset}>Reset</button>
        )}
      </div>
    </div>
  );
}
