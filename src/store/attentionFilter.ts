// Bell-toggled attention filter for the existing projects tree.
//
// A thread needs attention when it is waiting for input (pending approval /
// user-input request) or finished while the user was away (unseen dot). The
// selector carries the owning project while preserving workspace order so the
// sidebar can keep its normal hierarchy.

import { ChatProject, ChatThread, WorkspaceDocument } from "../contract/types";
import { threadActivity } from "./threadActivity";
import { UnseenThreadMap } from "./unseenThreads";

const ATTENTION_FILTER_STORAGE_KEY = "maxx.sidebar.attention-filter-open";

interface AttentionFilterStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function browserStorage(): AttentionFilterStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadAttentionFilterOpen(
  storage: AttentionFilterStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  return storage.getItem(ATTENTION_FILTER_STORAGE_KEY) === "true";
}

export function persistAttentionFilterOpen(
  open: boolean,
  storage: AttentionFilterStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(ATTENTION_FILTER_STORAGE_KEY, String(open));
  } catch {
    // The filter still toggles for the current session when storage is unavailable.
  }
}

export type AttentionReason = "waiting" | "unseen";

export interface AttentionItem {
  project: ChatProject;
  thread: ChatThread;
  reason: AttentionReason;
}

export interface StickyAttentionRef {
  threadID: string;
  reason: AttentionReason;
}

export function attentionThreads(
  workspace: WorkspaceDocument | null,
  activeTurnByThread: Record<string, string>,
  unseenThreadIDs: UnseenThreadMap,
  selectedThreadID: string | null,
): AttentionItem[] {
  if (!workspace) return [];
  const items: AttentionItem[] = [];
  for (const project of workspace.projects) {
    for (const thread of project.threads) {
      if (thread.parentThreadID || thread.id === selectedThreadID) continue;
      if (threadActivity(thread, activeTurnByThread).status === "waiting") {
        items.push({ project, thread, reason: "waiting" });
      } else if (unseenThreadIDs[thread.id]) {
        items.push({ project, thread, reason: "unseen" });
      }
    }
  }
  return items;
}

/**
 * Selecting an unseen thread clears its dot. Keep that row in the filtered
 * tree while it is being read, then release it when selection moves elsewhere.
 */
export function withStickyAttention(
  items: AttentionItem[],
  workspace: WorkspaceDocument | null,
  sticky: StickyAttentionRef | null,
  selectedThreadID: string | null,
): AttentionItem[] {
  if (!sticky || sticky.threadID !== selectedThreadID) return items;
  if (items.some((item) => item.thread.id === sticky.threadID)) return items;
  for (const project of workspace?.projects ?? []) {
    const thread = project.threads.find((candidate) => candidate.id === sticky.threadID);
    if (thread) return [...items, { project, thread, reason: sticky.reason }];
  }
  return items;
}
