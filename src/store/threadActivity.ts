// Shared turn-activity helpers for sidebar loading indicators.
// Backend inventory is authoritative on a successful fetch.
// Waiting is derived from pending interaction records on an active turn.

import {
  ActiveTurnRecord,
  ChatThread,
  EventKind,
  ProviderRuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeInteractionRecord,
  WorkspaceDocument,
} from "../contract/types";

export type { ActiveTurnRecord };

export type ThreadActivityStatus = "idle" | "running" | "waiting";

export type ThreadActivity =
  | { status: "idle" }
  | { status: "running" | "waiting"; turnID: string };

/** Convert backend inventory into threadID → turnID map. */
export function mapFromActiveTurns(inventory: ActiveTurnRecord[]): Record<string, string> {
  const next: Record<string, string> = {};
  for (const entry of inventory) {
    next[entry.threadID] = entry.turnID;
  }
  return next;
}

/**
 * Replace local activity with backend inventory.
 * A successful inventory fetch is fully authoritative — do not resurrect
 * optimistic-only turns that are no longer live.
 */
export function hydrateActiveTurns(inventory: ActiveTurnRecord[]): Record<string, string> {
  return mapFromActiveTurns(inventory);
}

/** Clear a finished turn only when the map still points at that turn. */
export function clearFinishedTurn(
  activeTurnByThread: Record<string, string>,
  threadID: string,
  turnID: string,
): Record<string, string> {
  if (activeTurnByThread[threadID] !== turnID) return activeTurnByThread;
  const next = { ...activeTurnByThread };
  delete next[threadID];
  return next;
}

/** Optimistically mark a thread busy after sendPrompt returns a turn id. */
export function setActiveTurn(
  activeTurnByThread: Record<string, string>,
  threadID: string,
  turnID: string,
): Record<string, string> {
  return { ...activeTurnByThread, [threadID]: turnID };
}

function hasPendingInteractionForTurn(
  requests: RuntimeInteractionRecord[],
  turnID: string,
): boolean {
  return requests.some(
    (request) => request.turnID === turnID && request.status === "pending",
  );
}

/**
 * Derive presentation status for one thread from the shared active-turn map
 * and pending interaction records. Provider-agnostic.
 */
export function threadActivity(
  thread: Pick<ChatThread, "id" | "interactionRequests">,
  activeTurnByThread: Record<string, string>,
): ThreadActivity {
  const turnID = activeTurnByThread[thread.id];
  if (!turnID) return { status: "idle" };
  if (hasPendingInteractionForTurn(thread.interactionRequests, turnID)) {
    return { status: "waiting", turnID };
  }
  return { status: "running", turnID };
}

export function isThreadBusy(activity: ThreadActivity): boolean {
  return activity.status === "running" || activity.status === "waiting";
}

/**
 * Mirror of Rust `RuntimeInteractionRecord::from_event`: only approval /
 * user-input request events with a request ID produce a pending record.
 */
export function interactionRecordFromEvent(
  event: ProviderRuntimeEvent,
): RuntimeInteractionRecord | null {
  if (
    event.kind !== EventKind.approvalRequest &&
    event.kind !== EventKind.userInputRequest
  ) {
    return null;
  }
  if (!event.requestID) return null;
  const expiresAt =
    event.payload.approval?.expiresAt ?? event.payload.userInput?.expiresAt;
  return {
    id: event.requestID,
    requestEventID: event.id,
    providerInstanceID: event.providerInstanceID,
    threadID: event.threadID,
    turnID: event.turnID,
    createdAt: event.occurredAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    status: "pending",
  };
}

export interface ActivityStoreSlice {
  workspace: WorkspaceDocument | null;
  activeTurnByThread: Record<string, string>;
}

/**
 * Pure reducer for live runtime events. Shipped path used by appStore —
 * appends events, mirrors interaction records, clears on terminal.
 */
export function reduceRuntimeEvent(
  state: ActivityStoreSlice,
  envelope: RuntimeEventEnvelope,
): ActivityStoreSlice {
  if (!state.workspace) return state;

  let activeTurnByThread = state.activeTurnByThread;
  if (envelope.event.kind === EventKind.turnTerminal) {
    activeTurnByThread = clearFinishedTurn(
      activeTurnByThread,
      envelope.threadID,
      envelope.event.turnID,
    );
  } else if (activeTurnByThread[envelope.threadID] !== envelope.event.turnID) {
    // A live event proves its turn is running. Backend-initiated turns (the
    // follow-up responders of a multi-mention chain) never pass through
    // sendPrompt, so this is how the stop button learns about them.
    activeTurnByThread = setActiveTurn(activeTurnByThread, envelope.threadID, envelope.event.turnID);
  }

  const workspace: WorkspaceDocument = {
    ...state.workspace,
    projects: state.workspace.projects.map((project) => {
      if (project.id !== envelope.projectID) return project;
      return {
        ...project,
        threads: project.threads.map((thread) => {
          if (thread.id !== envelope.threadID) return thread;
          if (thread.runtimeEvents.some((e) => e.id === envelope.event.id)) return thread;

          let next: ChatThread = {
            ...thread,
            runtimeEvents: [...thread.runtimeEvents, envelope.event],
          };
          if (envelope.event.kind === EventKind.sessionBinding) {
            next = {
              ...next,
              providerSessionID:
                envelope.event.payload.sessionBinding ?? next.providerSessionID,
            };
          }
          const interaction = interactionRecordFromEvent(envelope.event);
          if (
            interaction &&
            !next.interactionRequests.some((record) => record.id === interaction.id)
          ) {
            next = {
              ...next,
              interactionRequests: [...next.interactionRequests, interaction],
            };
          }
          return next;
        }),
      };
    }),
  };

  return { workspace, activeTurnByThread };
}
