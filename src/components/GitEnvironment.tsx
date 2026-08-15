import { useCallback, useEffect, useRef, useState } from "react";
import {
  gitCanPush,
  gitFileStatusLabel,
  gitHasStagedChanges,
  shouldRefreshGitAfterTurn,
  type GitRepositoryStatus,
} from "../git";
import { ipc } from "../ipc";
import { useAppStore } from "../store/appStore";
import { GitCommitDialog } from "./GitCommitDialog";
import { Icons } from "./Icons";

const REFRESH_INTERVAL_MS = 2_500;

export function GitEnvironment({
  projectID,
  hostID,
  threadID,
}: {
  projectID: string;
  hostID?: string | null;
  threadID?: string | null;
}) {
  const [status, setStatus] = useState<GitRepositoryStatus | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [includeUnstagedChanges, setIncludeUnstagedChanges] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const busyRef = useRef(false);
  const activeTurnID = useAppStore((state) => threadID ? state.activeTurnByThread[threadID] : undefined);
  const previousActiveTurnID = useRef(activeTurnID);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const next = await ipc.gitStatus(projectID, hostID, threadID);
      if (generation === refreshGeneration.current) {
        setStatus(next);
      }
    } catch (refreshError) {
      if (generation === refreshGeneration.current) {
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      }
    }
  }, [hostID, projectID, threadID]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    setStatus(null);
    setFilesOpen(false);
    setActionOpen(false);
    setMessage("");
    setIncludeUnstagedChanges(true);
    setError(null);
    setNotice(null);
    let cancelled = false;
    let timer: number | undefined;
    const schedulePoll = () => {
      timer = window.setTimeout(async () => {
        if (!busyRef.current && document.visibilityState === "visible") await refresh();
        if (!cancelled) schedulePoll();
      }, REFRESH_INTERVAL_MS);
    };
    void refresh().finally(() => {
      if (!cancelled) schedulePoll();
    });
    const onFocus = () => { if (!busyRef.current) void refresh(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !busyRef.current) void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const finishedCurrentTurn = shouldRefreshGitAfterTurn(previousActiveTurnID.current, activeTurnID);
    previousActiveTurnID.current = activeTurnID;
    if (finishedCurrentTurn && !busyRef.current) void refresh();
  }, [activeTurnID, refresh]);

  if (!status) return null;

  const canPushAfterCommit = gitCanPush(status);
  const canPushNow = canPushAfterCommit && (status.ahead > 0 || status.upstream === null) && !status.detached;
  const canCommit = includeUnstagedChanges
    ? status.files.length > 0
    : gitHasStagedChanges(status);
  const remoteLabel = hostID && hostID !== "local" ? "Remote" : "Local";
  const branchDetail = [
    status.ahead > 0 ? `↑${status.ahead}` : "",
    status.behind > 0 ? `↓${status.behind}` : "",
  ].filter(Boolean).join(" ");

  const openActions = () => {
    setActionOpen(true);
    setIncludeUnstagedChanges(true);
    setError(null);
    setNotice(null);
  };

  const performCommit = async (pushAfter: boolean) => {
    if (!canCommit || busy) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    setNotice(null);
    try {
      const result = await ipc.gitCommit(
        projectID,
        message,
        includeUnstagedChanges,
        hostID,
        threadID,
      );
      let next = result.status;
      setStatus(result.status);
      setMessage("");
      setNotice(`Committed: ${result.message}`);
      if (pushAfter) {
        next = await ipc.gitPush(projectID, hostID, threadID);
        setStatus(next);
        setNotice("Committed and pushed");
      }
      setActionOpen(false);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : String(operationError));
      await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const push = async () => {
    if (busy) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    setNotice(null);
    try {
      const next = await ipc.gitPush(projectID, hostID, threadID);
      setStatus(next);
      setNotice("Branch pushed");
      setActionOpen(false);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : String(operationError));
      await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="context-section git-environment-section" aria-label="Git environment">
      <h3>Environment</h3>

      <button
        type="button"
        className="git-environment-row"
        aria-expanded={filesOpen}
        onClick={() => setFilesOpen((current) => !current)}
      >
        <Icons.files size={14} />
        <span>Changes</span>
        <span className="git-change-counts" aria-label={`${status.additions} additions, ${status.deletions} deletions`}>
          <b>+{status.additions}</b><i>-{status.deletions}</i>
        </span>
        <Icons.chevronDown size={11} className={filesOpen ? "is-expanded" : ""} />
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
        <Icons.computer size={14} />
        <span>{remoteLabel}</span>
      </div>
      <div className="git-environment-row static">
        <Icons.branch size={14} />
        <span className="git-branch-name" title={status.upstream ?? status.branch}>{status.branch}</span>
        {branchDetail && <small className="git-branch-detail">{branchDetail}</small>}
      </div>

      <button
        type="button"
        className="git-environment-row git-primary-row"
        disabled={busy}
        onClick={openActions}
      >
        <Icons.commit size={14} />
        <span>Commit or push</span>
        {busy && <span className="mini-spinner" />}
      </button>

      {notice && <p className="git-action-notice" role="status">{notice}</p>}
      {!actionOpen && error && <p className="git-action-error" role="alert">{error}</p>}
      {actionOpen && (
        <GitCommitDialog
          status={status}
          message={message}
          includeUnstagedChanges={includeUnstagedChanges}
          busy={busy}
          error={error}
          canCommit={canCommit}
          canCommitAndPush={canCommit && canPushAfterCommit}
          canPush={canPushNow}
          onMessageChange={setMessage}
          onIncludeUnstagedChangesChange={setIncludeUnstagedChanges}
          onCommit={(pushAfter) => void performCommit(pushAfter)}
          onPush={() => void push()}
          onClose={() => setActionOpen(false)}
        />
      )}
    </section>
  );
}
