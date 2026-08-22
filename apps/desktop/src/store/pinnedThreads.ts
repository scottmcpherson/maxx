// Persistent sidebar pinning for top-level threads.
//
// Pins are a presentation preference rather than workspace content: the
// thread stays owned by its project and is rendered in exactly one sidebar
// location. Keeping the ordered IDs in localStorage also preserves the most
// recently pinned-first order across app launches.

import type { ChatProject, ChatThread, WorkspaceDocument } from "../contract/types";

const PINNED_THREADS_STORAGE_KEY = "maxx.sidebar.pinned-threads";

export interface PinnedThread {
  project: ChatProject;
  thread: ChatThread;
}

export function loadPinnedThreadIDs(): string[] {
  try {
    const stored = window.localStorage.getItem(PINNED_THREADS_STORAGE_KEY);
    if (!stored) return [];
    const ids: unknown = JSON.parse(stored);
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  } catch {
    return [];
  }
}

export function persistPinnedThreadIDs(threadIDs: string[]): void {
  try {
    window.localStorage.setItem(PINNED_THREADS_STORAGE_KEY, JSON.stringify(threadIDs));
  } catch {
    // Pinning still works for the current session when storage is unavailable.
  }
}

/** Add a new pin at the top, or remove an existing pin, without mutating. */
export function setThreadPinned(
  threadIDs: string[],
  threadID: string,
  pinned: boolean,
): string[] {
  const alreadyPinned = threadIDs.includes(threadID);
  if (pinned === alreadyPinned) return threadIDs;
  return pinned
    ? [threadID, ...threadIDs]
    : threadIDs.filter((candidate) => candidate !== threadID);
}

/** Drop deleted threads and side threads, which never have sidebar rows. */
export function prunePinnedThreadIDs(
  threadIDs: string[],
  workspace: WorkspaceDocument | null,
): string[] {
  if (!workspace) return threadIDs;
  const topLevelThreadIDs = new Set<string>();
  for (const project of workspace.projects) {
    for (const thread of project.threads) {
      if (!thread.parentThreadID) topLevelThreadIDs.add(thread.id);
    }
  }
  const next = threadIDs.filter((threadID) => topLevelThreadIDs.has(threadID));
  return next.length === threadIDs.length ? threadIDs : next;
}

/** Resolve ordered pin IDs to their current project/thread records. */
export function pinnedThreads(
  workspace: WorkspaceDocument | null,
  threadIDs: string[],
): PinnedThread[] {
  if (!workspace || threadIDs.length === 0) return [];
  const byID = new Map<string, PinnedThread>();
  for (const project of workspace.projects) {
    for (const thread of project.threads) {
      if (!thread.parentThreadID) byID.set(thread.id, { project, thread });
    }
  }
  return threadIDs.flatMap((threadID) => {
    const item = byID.get(threadID);
    return item ? [item] : [];
  });
}
