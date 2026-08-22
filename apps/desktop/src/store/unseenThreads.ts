// Unseen-completion tracking for the sidebar indicator dot.
//
// A thread is "unseen" when a turn finished there while the user was not
// viewing it. Side-thread completions roll up to their parent's sidebar row
// (side threads have no row of their own); a completion inside the selected
// thread — including its side threads — counts as seen immediately, so no
// dot is shown. Selecting a thread clears its mark.

import { TurnFinishedEnvelope, WorkspaceDocument } from "../contract/types";

const UNSEEN_THREADS_STORAGE_KEY = "maxx.sidebar.unseen-threads";

/** threadID → true for top-level threads with an unseen completion. */
export type UnseenThreadMap = Record<string, true>;

export function loadUnseenThreadIDs(): UnseenThreadMap {
  try {
    const stored = window.localStorage.getItem(UNSEEN_THREADS_STORAGE_KEY);
    if (!stored) return {};
    const ids: unknown = JSON.parse(stored);
    if (!Array.isArray(ids)) return {};
    const map: UnseenThreadMap = {};
    for (const id of ids) {
      if (typeof id === "string") map[id] = true;
    }
    return map;
  } catch {
    return {};
  }
}

export function persistUnseenThreadIDs(unseen: UnseenThreadMap): void {
  try {
    window.localStorage.setItem(
      UNSEEN_THREADS_STORAGE_KEY,
      JSON.stringify(Object.keys(unseen)),
    );
  } catch {
    // Dots still work for the current session when storage is unavailable.
  }
}

export function markThreadUnseen(
  unseen: UnseenThreadMap,
  threadID: string,
): UnseenThreadMap {
  if (unseen[threadID]) return unseen;
  return { ...unseen, [threadID]: true };
}

export function clearThreadUnseen(
  unseen: UnseenThreadMap,
  threadID: string,
): UnseenThreadMap {
  if (!unseen[threadID]) return unseen;
  const next = { ...unseen };
  delete next[threadID];
  return next;
}

/**
 * Sidebar row to mark unseen for a finished turn, or null when no dot is
 * warranted: the user was already viewing the (parent) thread, or the stop
 * was user-initiated (cancelled/interrupted).
 */
export function unseenTargetForFinishedTurn(
  workspace: WorkspaceDocument | null,
  envelope: TurnFinishedEnvelope,
  selectedThreadID: string | null,
): string | null {
  if (
    envelope.terminalState === "cancelled" ||
    envelope.terminalState === "interrupted"
  ) {
    return null;
  }
  const project = workspace?.projects.find((p) => p.id === envelope.projectID);
  const thread = project?.threads.find((t) => t.id === envelope.threadID);
  const targetID = thread?.parentThreadID ?? envelope.threadID;
  return targetID === selectedThreadID ? null : targetID;
}

/** Drop marks for threads that no longer exist in the workspace. */
export function pruneUnseenThreads(
  unseen: UnseenThreadMap,
  workspace: WorkspaceDocument | null,
): UnseenThreadMap {
  if (!workspace) return unseen;
  const live = new Set<string>();
  for (const project of workspace.projects) {
    for (const thread of project.threads) live.add(thread.id);
  }
  const staleIDs = Object.keys(unseen).filter((threadID) => !live.has(threadID));
  if (staleIDs.length === 0) return unseen;
  const next = { ...unseen };
  for (const threadID of staleIDs) delete next[threadID];
  return next;
}
