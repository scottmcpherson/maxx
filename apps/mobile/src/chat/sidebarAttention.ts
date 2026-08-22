import type { ChatProject, ChatThread, TurnFinishedEnvelope, WorkspaceDocument } from "../types";

export type AttentionReason = "waiting" | "unseen";

export type AttentionItem = {
  project: ChatProject;
  thread: ChatThread;
  reason: AttentionReason;
};

export type StickyAttention = {
  threadID: string;
  reason: AttentionReason;
};

export function attentionThreads(
  projects: ChatProject[],
  activeTurnByThread: Record<string, string>,
  unseenThreadIDs: Set<string>,
  selectedThreadID: string | null,
) {
  const items: AttentionItem[] = [];
  for (const project of projects) {
    for (const thread of project.threads) {
      if (thread.parentThreadID || thread.id === selectedThreadID) continue;
      const activeTurnID = activeTurnByThread[thread.id];
      const waiting = activeTurnID && thread.interactionRequests?.some(
        (request) => request.turnID === activeTurnID && request.status === "pending",
      );
      if (waiting) items.push({ project, thread, reason: "waiting" });
      else if (unseenThreadIDs.has(thread.id)) items.push({ project, thread, reason: "unseen" });
    }
  }
  return items;
}

export function withStickyAttention(
  items: AttentionItem[],
  projects: ChatProject[],
  sticky: StickyAttention | null,
  selectedThreadID: string | null,
) {
  if (!sticky || sticky.threadID !== selectedThreadID) return items;
  if (items.some((item) => item.thread.id === sticky.threadID)) return items;
  for (const project of projects) {
    const thread = project.threads.find((candidate) => candidate.id === sticky.threadID);
    if (thread) return [...items, { project, thread, reason: sticky.reason }];
  }
  return items;
}

export function unseenTargetForFinishedTurn(
  workspace: WorkspaceDocument | null,
  envelope: TurnFinishedEnvelope,
  selectedThreadID: string | null,
) {
  if (envelope.terminalState === "cancelled" || envelope.terminalState === "interrupted") return null;
  const project = workspace?.projects.find((candidate) => candidate.id === envelope.projectID);
  const thread = project?.threads.find((candidate) => candidate.id === envelope.threadID);
  const targetID = thread?.parentThreadID ?? envelope.threadID;
  return targetID === selectedThreadID ? null : targetID;
}
