import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import {
  gitCanPush,
  gitFileStatusLabel,
  gitHasStagedChanges,
  shouldRefreshGitAfterTurn,
  type GitRepositoryStatus,
} from "../git";
import { isHostConnectionError } from "../host/errors";
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
        setError((current) => current && isHostConnectionError(current) ? null : current);
      }
    } catch (refreshError) {
      if (generation === refreshGeneration.current && !isHostConnectionError(refreshError)) {
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
    <section data-slot="git-environment" className="py-2.5 [-webkit-app-region:no-drag]" aria-label="Git environment">
      <h3 className="mb-1.5 text-[0.6875rem] font-medium text-muted-foreground">Environment</h3>

      <Collapsible open={filesOpen} onOpenChange={setFilesOpen}>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="grid h-7 w-full grid-cols-[1rem_minmax(0,1fr)_auto_auto] justify-start gap-2 px-0.5! text-left text-xs text-muted-foreground" />}>
          <Icons.files data-icon="inline-start" />
          <span>Changes</span>
          <span data-slot="git-change-counts" className="flex items-center gap-1 font-mono text-[0.65rem]" aria-label={`${status.additions} additions, ${status.deletions} deletions`}>
            <b className="font-medium text-success">+{status.additions}</b><i className="not-italic text-destructive">-{status.deletions}</i>
          </span>
          <Icons.chevronDown data-icon="inline-end" className={filesOpen ? "rotate-180" : ""} />
        </CollapsibleTrigger>
        <CollapsibleContent className="mb-1 max-h-45 overflow-y-auto rounded-lg bg-black/15 p-1" aria-label="Changed files">
          {status.files.length === 0 ? (
            <span className="block p-2 text-xs text-muted-foreground">No uncommitted changes</span>
          ) : status.files.map((file) => (
            <div className="flex min-h-7 min-w-0 items-center gap-2 rounded-md px-1.5 font-mono text-xs" key={file.path} title={file.path}>
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              <small className="shrink-0 text-muted-foreground">{gitFileStatusLabel(file)}</small>
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>

      <div className="grid min-h-7 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 px-0.5 text-xs text-muted-foreground">
        <Icons.computer size={14} />
        <span>{remoteLabel}</span>
      </div>
      <div className="grid min-h-7 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 px-0.5 text-xs text-muted-foreground">
        <Icons.branch size={14} />
        <span className="truncate" title={status.upstream ?? status.branch}>{status.branch}</span>
        {branchDetail && <small className="font-mono text-[0.65rem] text-muted-foreground">{branchDetail}</small>}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-full justify-start gap-2 px-0.5! text-xs text-muted-foreground"
        disabled={busy}
        onClick={openActions}
      >
        <Icons.commit data-icon="inline-start" />
        <span>Commit or push</span>
        {busy && <Spinner data-icon="inline-end" />}
      </Button>

      {notice && <p className="mt-2 text-xs text-success select-text" role="status">{notice}</p>}
      {!actionOpen && error && <p className="mt-2 text-xs text-destructive select-text" role="alert">{error}</p>}
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
