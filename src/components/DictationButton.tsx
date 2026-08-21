import { formatKeyboardShortcut } from "../keyboardShortcuts";
import type { KeyboardShortcutBinding } from "../keyboardShortcuts";
import type { Dictation } from "../voice/useDictation";
import { IconButton } from "./ui/icon-button";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Spinner } from "./ui/spinner";
import { Button } from "./ui/button";
import { MicIcon, XIcon } from "lucide-react";
import { cn } from "../lib/utils";

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
    <IconButton
      label={label}
      tooltip={`${label} (${formatKeyboardShortcut(shortcut)})`}
      className={cn("rounded-full", dictation.state === "listening" && "text-destructive aria-pressed:bg-destructive/10")}
      aria-pressed={dictation.isActive}
      disabled={disabled}
      onClick={dictation.toggle}
    >
      <MicIcon />
    </IconButton>
  );
}

/** Inline status line: what dictation is doing, or why it stopped. */
export function DictationStatus({ dictation }: { dictation: Dictation }) {
  if (dictation.error) {
    return (
      <Alert variant="destructive" className="flex items-center justify-between gap-2 py-1.5" role="alert">
        <AlertDescription className="text-xs text-destructive">{dictation.error}</AlertDescription>
        <Button type="button" variant="ghost" size="icon-xs" onClick={dictation.dismissError} aria-label="Dismiss">
          <XIcon />
        </Button>
      </Alert>
    );
  }
  if (dictation.state === "starting") {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Spinner />Starting dictation…</div>;
  }
  if (dictation.state === "listening") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
        <Badge variant="secondary" className="gap-1.5"><span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />Listening</Badge>
        <span>Press the microphone again to stop, Esc to discard.</span>
      </div>
    );
  }
  return null;
}
