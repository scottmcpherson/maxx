import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
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
  const submitFromTextarea = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.metaKey && event.key === "Enter" && canCommit && !busy) {
      event.preventDefault();
      onCommit(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent data-smoke="git-commit-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" title={status.upstream ?? status.branch}>
            <Icons.branch data-icon="inline-start" />
            <span>{status.branch}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">Create a commit from the current Git changes.</DialogDescription>
        </DialogHeader>

        <Textarea
          autoFocus
          id="git-commit-message"
          rows={4}
          value={message}
          disabled={busy}
          placeholder="Commit message (leave blank to generate)…"
          onKeyDown={submitFromTextarea}
          onChange={(event) => onMessageChange(event.target.value)}
        />

        <Field orientation="horizontal" className="min-w-0" data-disabled={busy || status.files.length === 0}>
          <Checkbox
            id="git-include-changes"
            checked={includeUnstagedChanges}
            disabled={busy || status.files.length === 0}
            onCheckedChange={(checked) => onIncludeUnstagedChangesChange(checked === true)}
          />
          <FieldLabel htmlFor="git-include-changes" className="min-w-0">Include unstaged changes</FieldLabel>
          <span className="ms-auto flex shrink-0 items-center gap-1 font-mono text-xs" aria-label={`${status.additions} additions, ${status.deletions} deletions`}>
            <b className="font-medium text-success">+{status.additions}</b><i className="not-italic text-destructive">-{status.deletions}</i>
          </span>
        </Field>

        <DialogFooter className="flex-col sm:flex-col">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={busy || !canCommit}
            onClick={() => onCommit(false)}
          >
            <Icons.commit data-icon="inline-start" />
            <span>{busy ? (message.trim() ? "Committing…" : "Generating and committing…") : "Commit"}</span>
            {!busy && <Kbd>⌘↩</Kbd>}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={busy || !canCommitAndPush}
            onClick={() => onCommit(true)}
          >
            <Icons.arrowUp data-icon="inline-start" />
            <span>Commit and push</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={busy || !canPush}
            onClick={onPush}
          >
            <Icons.arrowUp data-icon="inline-start" />
            <span>Push</span>
          </Button>
        </DialogFooter>

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
