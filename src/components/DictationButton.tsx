import { Icons } from "./Icons";
import { formatKeyboardShortcut } from "../keyboardShortcuts";
import type { KeyboardShortcutBinding } from "../keyboardShortcuts";
import type { Dictation } from "../voice/useDictation";

/**
 * Microphone toggle for a composer. Hidden entirely when dictation is off in
 * Settings — an always-visible control that only ever errors is worse than no
 * control, and Settings is where the feature is explained.
 */
export function DictationButton({
  dictation,
  visible,
  disabled = false,
  shortcut,
}: {
  dictation: Dictation;
  visible: boolean;
  disabled?: boolean;
  shortcut: KeyboardShortcutBinding;
}) {
  if (!visible) return null;

  const label =
    dictation.state === "listening"
      ? "Stop dictation"
      : dictation.state === "starting"
        ? "Starting dictation…"
        : "Dictate a message";

  return (
    <button
      type="button"
      className={`icon-button dictation-button state-${dictation.state}`}
      title={`${label} (${formatKeyboardShortcut(shortcut)})`}
      aria-label={label}
      aria-pressed={dictation.isActive}
      disabled={disabled}
      onClick={dictation.toggle}
    >
      <Icons.microphone size={15} />
    </button>
  );
}

/** Inline status line: what dictation is doing, or why it stopped. */
export function DictationStatus({ dictation }: { dictation: Dictation }) {
  if (dictation.error) {
    return (
      <div className="dictation-status is-error" role="alert">
        <span>{dictation.error}</span>
        <button type="button" onClick={dictation.dismissError} aria-label="Dismiss">
          <Icons.close size={11} />
        </button>
      </div>
    );
  }
  if (dictation.state === "starting") {
    return <div className="dictation-status">Starting dictation…</div>;
  }
  if (dictation.state === "listening") {
    return (
      <div className="dictation-status is-live">
        <span className="dictation-dot" aria-hidden="true" />
        Listening — press the microphone again to stop, Esc to discard.
      </div>
    );
  }
  return null;
}
