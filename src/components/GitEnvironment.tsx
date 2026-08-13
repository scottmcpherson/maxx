import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { gitCanPush, gitFileStatusLabel, gitPrimaryAction, type GitRepositoryStatus } from "../git";
import { ipc } from "../ipc";
import { Icons } from "./Icons";

const REFRESH_INTERVAL_MS = 2_500;

export function GitEnvironment({
  projectID,
  hostID,
}: {
  projectID: string;
  hostID?: string | null;
}) {
  const [status, setStatus] = useState<GitRepositoryStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const refreshGeneration = useRef(0);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const next = await ipc.gitStatus(projectID, hostID);
      if (generation === refreshGeneration.current) {
        setStatus(next);
      }
    } catch (refreshError) {
      if (generation === refreshGeneration.current) {
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      }
    }
  }, [hostID, projectID]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    setStatus(null);
    setOpen(false);
    setFilesOpen(false);
    setActionOpen(false);
    setMessage("");
    setError(null);
    setNotice(null);
    void refresh();
    const timer = window.setInterval(() => {
      if (!busyRef.current) void refresh();
    }, REFRESH_INTERVAL_MS);
    const onFocus = () => { if (!busyRef.current) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!status) return null;

  const primaryAction = gitPrimaryAction(status);
  const canPushAfterCommit = gitCanPush(status);
  const remoteLabel = hostID && hostID !== "local" ? "Remote" : "Local";
  const branchDetail = [
    status.ahead > 0 ? `↑${status.ahead}` : "",
    status.behind > 0 ? `↓${status.behind}` : "",
  ].filter(Boolean).join(" ");

  const openActions = () => {
    setActionOpen(true);
    setError(null);
    setNotice(null);
  };

  const performCommit = async (pushAfter: boolean) => {
    if (!message.trim() || busy) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    setNotice(null);
    try {
      let next = await ipc.gitCommit(projectID, message, hostID);
      setStatus(next);
      setMessage("");
      setNotice("Commit created");
      if (pushAfter) {
        next = await ipc.gitPush(projectID, hostID);
        setStatus(next);
        setNotice("Committed and pushed");
      }
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : String(operationError));
      await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submitCommit = (event: FormEvent) => {
    event.preventDefault();
    void performCommit(false);
  };

  const push = async () => {
    if (busy) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    setNotice(null);
    try {
      const next = await ipc.gitPush(projectID, hostID);
      setStatus(next);
      setNotice("Branch pushed");
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : String(operationError));
      await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="git-environment" ref={rootRef}>
      <button
        type="button"
        className={`icon-button git-environment-trigger${open ? " is-active" : ""}`}
        title="Environment and Git changes"
        aria-label="Environment and Git changes"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icons.environment size={15} />
      </button>
      {open && (
        <section
          className="git-environment-popover"
          aria-label="Git environment"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="git-environment-header">
            <span>Environment</span>
            <button
              type="button"
              className="icon-button"
              title="Refresh Git status"
              aria-label="Refresh Git status"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <Icons.reload size={14} />
            </button>
          </header>

          <button
            type="button"
            className="git-environment-row"
            aria-expanded={filesOpen}
            onClick={() => setFilesOpen((current) => !current)}
          >
            <Icons.files size={15} />
            <span>Changes</span>
            <span className="git-change-counts" aria-label={`${status.additions} additions, ${status.deletions} deletions`}>
              <b>+{status.additions}</b><i>-{status.deletions}</i>
            </span>
            <Icons.chevronDown size={12} className={filesOpen ? "is-expanded" : ""} />
          </button>
          {filesOpen && (
            <div className="git-file-list" aria-label="Changed files">
              {status.files.length === 0 ? (
                <span className="git-file-empty">No uncommitted changes</span>
              ) : status.files.map((file) => (
                <div className="git-file-row" key={file.path} title={file.path}>
                  <span>{file.path}</span>
                  <small>{gitFileStatusLabel(file)}</small>
                </div>
              ))}
            </div>
          )}

          <div className="git-environment-row static">
            <Icons.computer size={15} />
            <span>{remoteLabel}</span>
          </div>
          <div className="git-environment-row static">
            <Icons.branch size={15} />
            <span className="git-branch-name" title={status.upstream ?? status.branch}>{status.branch}</span>
            {branchDetail && <small className="git-branch-detail">{branchDetail}</small>}
          </div>

          <button
            type="button"
            className="git-environment-row git-primary-row"
            disabled={primaryAction === "none" || busy}
            onClick={openActions}
          >
            <Icons.commit size={15} />
            <span>Commit or push</span>
            {busy && <span className="mini-spinner" />}
          </button>

          {actionOpen && (
            <div className="git-action-panel">
              {primaryAction === "commit" ? (
                <form onSubmit={submitCommit}>
                  <label htmlFor="git-commit-message">Commit message</label>
                  <textarea
                    id="git-commit-message"
                    rows={3}
                    value={message}
                    disabled={busy}
                    autoFocus
                    placeholder="Describe these changes"
                    onChange={(event) => setMessage(event.target.value)}
                  />
                  <div className="git-action-buttons">
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => setActionOpen(false)}>Cancel</button>
                    <button type="submit" className="secondary-button" disabled={busy || !message.trim()}>Commit</button>
                    <button
                      type="button"
                      className="git-confirm-button"
                      disabled={busy || !message.trim() || !canPushAfterCommit}
                      title={!canPushAfterCommit ? (status.detached ? "Check out a branch before pushing" : "Configure a Git remote before pushing") : undefined}
                      onClick={() => void performCommit(true)}
                    >Commit &amp; push</button>
                  </div>
                </form>
              ) : primaryAction === "push" ? (
                <div className="git-push-confirmation">
                  <p>{status.upstream ? `Push ${status.ahead} commit${status.ahead === 1 ? "" : "s"} to ${status.upstream}?` : `Publish ${status.branch} to ${status.remotes[0]}?`}</p>
                  <div className="git-action-buttons">
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => setActionOpen(false)}>Cancel</button>
                    <button type="button" className="git-confirm-button" disabled={busy} onClick={() => void push()}>Push</button>
                  </div>
                </div>
              ) : (
                <p className="git-up-to-date">Working tree clean · branch up to date</p>
              )}
              {notice && <p className="git-action-notice" role="status">{notice}</p>}
              {error && <p className="git-action-error" role="alert">{error}</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
