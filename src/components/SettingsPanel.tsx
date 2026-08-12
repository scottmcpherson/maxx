import { useEffect, useState } from "react";
import { ipc } from "../ipc";
import { providerDisplayName } from "../contract/types";
import type { ProviderHealth, ProviderProfile } from "../contract/types";
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
import { DEFAULT_VOICE_SETTINGS, VOICE_LANGUAGES } from "../voice/types";
import type { VoiceCredentialStatus, VoiceSettings } from "../voice/types";
import { beginWindowDrag } from "../windowDrag";
import { Icons } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";
import { RuntimePicker } from "./RuntimePicker";

type SettingsSection = "providers" | "voice" | "keyboardShortcuts";

export function SettingsPanel() {
  const workspace = useAppStore((state) => state.workspace);
  const selectedProjectID = useAppStore((state) => state.selectedProjectID);
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

  // The enable switch is the only control, and it persists immediately.
  const toggleEnabled = (id: string, isEnabled: boolean) => {
    const next = drafts.map((profile) => profile.id === id ? { ...profile, isEnabled } : profile);
    setDrafts(next);
    void saveProfiles(next);
  };

  const probe = async (id: string) => {
    try {
      const result = await ipc.providerHealth(id);
      setHealth((current) => ({ ...current, [id]: result }));
    } catch (error) {
      setHealth((current) => ({
        ...current,
        [id]: { profileID: id, state: "missing", message: String(error) },
      }));
    }
  };

  // Probe every profile once so rows can show the installed CLI version.
  useEffect(() => {
    for (const profile of workspace?.providerProfiles ?? []) {
      void probe(profile.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

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
  const modelCatalogWorkingDirectory = workspace?.projects.find(
    (project) => project.id === selectedProjectID,
  )?.folderPath ?? workspace?.projects[0]?.folderPath;
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
                    workingDirectory={modelCatalogWorkingDirectory}
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
                    workingDirectory={modelCatalogWorkingDirectory}
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
                  <div key={profile.id} className="provider-settings-row">
                    <div className="provider-settings-summary">
                      <ProviderIcon provider={profile.provider} size={20} />
                      <span className="provider-settings-name">
                        <strong>{profile.displayName}</strong>
                        <small>{subtitle(profile)}</small>
                      </span>
                      {result && <span className={`health-badge health-${result.state}`}>{result.state}</span>}
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={profile.isEnabled}
                          aria-label={`Enable ${profile.displayName}`}
                          onChange={(event) => toggleEnabled(profile.id, event.target.checked)}
                        />
                        <span />
                      </label>
                    </div>
                  </div>
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
            className={section === "keyboardShortcuts" ? "selected" : ""}
            aria-current={section === "keyboardShortcuts" ? "page" : undefined}
            onClick={() => selectSection("keyboardShortcuts")}
          >
            <Icons.keyboard size={15} />Keyboard Shortcuts
          </button>
        </nav>
      </aside>

      <main className="settings-content">
        {sectionBody()}
      </main>
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
  const saveVoiceSettings = useAppStore((state) => state.saveVoiceSettings);
  const [status, setStatus] = useState<VoiceCredentialStatus | null>(null);
  const settings: VoiceSettings = stored ?? DEFAULT_VOICE_SETTINGS;

  // Re-probed after every change: turning the opt-in on should immediately
  // show whose sign-in was found, not wait for the next dictation attempt.
  useEffect(() => {
    let current = true;
    void ipc
      .voiceStatus()
      .then((result) => {
        if (current) setStatus(result);
      })
      .catch(() => {
        if (current) setStatus(null);
      });
    return () => {
      current = false;
    };
  }, [stored]);

  const update = (patch: Partial<VoiceSettings>) => {
    void saveVoiceSettings({ ...settings, ...patch });
  };

  return (
    <>
      <header className="settings-content-header" onMouseDown={beginWindowDrag}>
        <div>
          <h1>Voice</h1>
          <p>
            Dictate into the message box. Audio streams to xAI’s transcription service while
            you have the microphone on, and the text always lands in the composer for you to
            review — nothing is sent on your behalf.
          </p>
        </div>
      </header>

      <section className="settings-card voice-settings" aria-label="Voice settings">
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
        </div>

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

        {status && (
          <div className={`voice-credential-status ${status.available ? "is-ready" : "is-missing"}`}>
            {status.available ? <Icons.check size={13} /> : <Icons.close size={13} />}
            <span>{status.detail}</span>
          </div>
        )}
      </section>
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
