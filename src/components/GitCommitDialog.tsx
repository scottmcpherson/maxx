import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { GitRepositoryStatus } from "../git";
import { Icons } from "./Icons";

interface GitCommitDialogProps {
  status: GitRepositoryStatus;
  message: string;
  includeUnstagedChanges: boolean;
  busy: boolean;
  error: string | null;
  canCommit: boolean;
  canCommitAndPush: boolean;
  canPush: boolean;
  onMessageChange: (message: string) => void;
  onIncludeUnstagedChangesChange: (include: boolean) => void;
  onCommit: (pushAfter: boolean) => void;
  onPush: () => void;
  onClose: () => void;
}

export function GitCommitDialog({
  status,
  message,
  includeUnstagedChanges,
  busy,
  error,
  canCommit,
  canCommitAndPush,
  canPush,
  onMessageChange,
  onIncludeUnstagedChangesChange,
  onCommit,
  onPush,
  onClose,
}: GitCommitDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    messageRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), textarea:not(:disabled), input:not(:disabled)",
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const submitFromTextarea = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.metaKey && event.key === "Enter" && canCommit && !busy) {
      event.preventDefault();
      onCommit(false);
    }
  };

  return createPortal(
    <div
      className="git-commit-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="git-commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-commit-dialog-title"
        aria-busy={busy}
      >
        <header className="git-commit-dialog-header">
          <div id="git-commit-dialog-title" title={status.upstream ?? status.branch}>
            <Icons.branch size={16} />
            <span>{status.branch}</span>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close commit dialog"
            title="Close"
            disabled={busy}
            onClick={onClose}
          >
            <Icons.close size={14} />
          </button>
        </header>

        <label className="sr-only" htmlFor="git-commit-message">Commit message</label>
        <textarea
          ref={messageRef}
          id="git-commit-message"
          rows={4}
          value={message}
          disabled={busy}
          placeholder="Commit message (leave blank to generate)…"
          onKeyDown={submitFromTextarea}
          onChange={(event) => onMessageChange(event.target.value)}
        />

        <label className="git-include-changes-row">
          <input
            type="checkbox"
            checked={includeUnstagedChanges}
            disabled={busy || status.files.length === 0}
            onChange={(event) => onIncludeUnstagedChangesChange(event.target.checked)}
          />
          <span>Include unstaged changes</span>
          <span className="git-change-counts" aria-label={`${status.additions} additions, ${status.deletions} deletions`}>
            <b>+{status.additions}</b><i>-{status.deletions}</i>
          </span>
        </label>

        <div className="git-commit-dialog-actions">
          <button type="button" disabled={busy || !canCommit} onClick={() => onCommit(false)}>
            <Icons.commit size={16} />
            <span>{busy ? (message.trim() ? "Committing…" : "Generating and committing…") : "Commit"}</span>
            {!busy && <kbd>⌘↩</kbd>}
          </button>
          <button type="button" disabled={busy || !canCommitAndPush} onClick={() => onCommit(true)}>
            <Icons.arrowUp size={16} />
            <span>Commit and push</span>
          </button>
          <button type="button" disabled={busy || !canPush} onClick={onPush}>
            <Icons.arrowUp size={16} />
            <span>Push</span>
          </button>
        </div>

        {error && <p className="git-action-error" role="alert">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}
