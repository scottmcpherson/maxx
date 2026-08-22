import { describe, expect, it } from "vitest";
import {
  clearFinishedTurn,
  hydrateActiveTurns,
  interactionRecordFromEvent,
  isThreadBusy,
  mapFromActiveTurns,
  reduceRuntimeEvent,
  setActiveTurn,
  threadActivity,
} from "./threadActivity";
import {
  DEFAULT_COMPUTER_USE_SETTINGS,
  EventKind,
  ProviderRuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeInteractionRecord,
  WorkspaceDocument,
} from "../contract/types";
import { DEFAULT_VOICE_SETTINGS } from "../voice/types";

function interaction(
  overrides: Partial<RuntimeInteractionRecord> &
    Pick<RuntimeInteractionRecord, "id" | "turnID" | "status">,
): RuntimeInteractionRecord {
  return {
    requestEventID: "event",
    providerInstanceID: "instance",
    threadID: "thread-1",
    createdAt: 1,
    ...overrides,
  };
}

function runtimeEvent(overrides: Partial<ProviderRuntimeEvent> = {}): ProviderRuntimeEvent {
  return {
    schemaVersion: 1,
    id: "event-1",
    providerInstanceID: "instance",
    threadID: "thread-1",
    turnID: "turn-1",
    sequence: 1,
    occurredAt: 10,
    kind: EventKind.assistantTextDelta,
    payload: {},
    ...overrides,
  };
}

function workspaceWithThread(
  threadOverrides: {
    id?: string;
    interactionRequests?: RuntimeInteractionRecord[];
    runtimeEvents?: ProviderRuntimeEvent[];
  } = {},
): WorkspaceDocument {
  return {
    schemaVersion: 1,
    providerProfiles: [],
    agents: [],
    voice: DEFAULT_VOICE_SETTINGS,
    computerUse: DEFAULT_COMPUTER_USE_SETTINGS,
    projects: [
      {
        id: "project-1",
        folderPath: "/tmp/proj",
        threads: [
          {
            id: threadOverrides.id ?? "thread-1",
            title: "Thread",
            provider: "claude",
            model: "default",
            messages: [],
            runtimeEvents: threadOverrides.runtimeEvents ?? [],
            interactionRequests: threadOverrides.interactionRequests ?? [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    ],
  };
}

describe("mapFromActiveTurns / hydrateActiveTurns", () => {
  it("maps backend inventory to thread → turn", () => {
    const map = mapFromActiveTurns([
      { projectID: "p1", threadID: "t1", turnID: "turn-a" },
      { projectID: "p1", threadID: "t2", turnID: "turn-b" },
    ]);
    expect(map).toEqual({ t1: "turn-a", t2: "turn-b" });
  });

  it("treats successful inventory fetch as fully authoritative", () => {
    // Finished turn no longer in inventory must not be resurrected by optimistic state.
    const hydrated = hydrateActiveTurns([
      { projectID: "p1", threadID: "still-live", turnID: "turn-live" },
    ]);
    expect(hydrated).toEqual({ "still-live": "turn-live" });
    expect(hydrated["finished-thread"]).toBeUndefined();
  });

  it("empty inventory clears all busy state (no optimistic merge)", () => {
    expect(hydrateActiveTurns([])).toEqual({});
  });

  it("restores busy state from inventory alone after remount", () => {
    const hydrated = hydrateActiveTurns([
      { projectID: "p", threadID: "thread-live", turnID: "turn-live" },
    ]);
    expect(hydrated["thread-live"]).toBe("turn-live");
    expect(
      threadActivity({ id: "thread-live", interactionRequests: [] }, hydrated).status,
    ).toBe("running");
  });
});

describe("setActiveTurn / clearFinishedTurn", () => {
  it("marks a thread busy after send", () => {
    const next = setActiveTurn({}, "thread-1", "turn-1");
    expect(next).toEqual({ "thread-1": "turn-1" });
    expect(
      threadActivity({ id: "thread-1", interactionRequests: [] }, next).status,
    ).toBe("running");
  });

  it("clears busy only when the finished turn matches", () => {
    const active = { "thread-1": "turn-1", "thread-2": "turn-2" };
    expect(clearFinishedTurn(active, "thread-1", "turn-1")).toEqual({
      "thread-2": "turn-2",
    });
    expect(clearFinishedTurn(active, "thread-1", "old-turn")).toEqual(active);
  });

  it("clears on cancelled and failed terminal the same as completed", () => {
    for (const _ of ["completed", "cancelled", "failed", "interrupted"] as const) {
      const cleared = clearFinishedTurn({ t: "turn-x" }, "t", "turn-x");
      expect(cleared).toEqual({});
    }
  });

  it("does not re-busy after clear when hydrate sees empty inventory", () => {
    let active = setActiveTurn({}, "thread-1", "turn-1");
    active = clearFinishedTurn(active, "thread-1", "turn-1");
    // Concurrent refresh after finish: inventory empty → stays idle.
    active = hydrateActiveTurns([]);
    expect(active).toEqual({});
    expect(threadActivity({ id: "thread-1", interactionRequests: [] }, active).status).toBe(
      "idle",
    );
  });
});

describe("threadActivity waiting vs running", () => {
  it("is running when turn is active and no pending interaction", () => {
    const activity = threadActivity(
      { id: "thread-1", interactionRequests: [] },
      { "thread-1": "turn-1" },
    );
    expect(activity).toEqual({ status: "running", turnID: "turn-1" });
    expect(isThreadBusy(activity)).toBe(true);
  });

  it("is waiting when active turn has a pending approval or user-input request", () => {
    const activity = threadActivity(
      {
        id: "thread-1",
        interactionRequests: [
          interaction({ id: "req-1", turnID: "turn-1", status: "pending" }),
        ],
      },
      { "thread-1": "turn-1" },
    );
    expect(activity).toEqual({ status: "waiting", turnID: "turn-1" });
    expect(isThreadBusy(activity)).toBe(true);
  });

  it("stays running when pending interactions belong to a different turn", () => {
    const activity = threadActivity(
      {
        id: "thread-1",
        interactionRequests: [
          interaction({ id: "req-old", turnID: "other-turn", status: "pending" }),
        ],
      },
      { "thread-1": "turn-1" },
    );
    expect(activity.status).toBe("running");
  });

  it("is idle when no active turn even if old interactions exist", () => {
    const activity = threadActivity(
      {
        id: "thread-1",
        interactionRequests: [
          interaction({ id: "req", turnID: "turn-1", status: "pending" }),
        ],
      },
      {},
    );
    expect(activity).toEqual({ status: "idle" });
    expect(isThreadBusy(activity)).toBe(false);
  });

  it("treats resolved interactions as not waiting", () => {
    const activity = threadActivity(
      {
        id: "thread-1",
        interactionRequests: [
          interaction({ id: "req", turnID: "turn-1", status: "approved" }),
        ],
      },
      { "thread-1": "turn-1" },
    );
    expect(activity.status).toBe("running");
  });
});

describe("interactionRecordFromEvent", () => {
  it("builds a pending record for approval requests with requestID", () => {
    const record = interactionRecordFromEvent(
      runtimeEvent({
        kind: EventKind.approvalRequest,
        requestID: "req-approval",
        payload: {
          approval: {
            kind: "command",
            title: "Run?",
            paths: [],
            options: [],
            expiresAt: 99,
          },
        },
      }),
    );
    expect(record).toEqual({
      id: "req-approval",
      requestEventID: "event-1",
      providerInstanceID: "instance",
      threadID: "thread-1",
      turnID: "turn-1",
      createdAt: 10,
      expiresAt: 99,
      status: "pending",
    });
  });

  it("builds a pending record for user-input requests", () => {
    const record = interactionRecordFromEvent(
      runtimeEvent({
        kind: EventKind.userInputRequest,
        requestID: "req-input",
        payload: {
          userInput: {
            questions: [],
            expiresAt: 42,
          },
        },
      }),
    );
    expect(record?.id).toBe("req-input");
    expect(record?.status).toBe("pending");
    expect(record?.expiresAt).toBe(42);
  });

  it("returns null for non-interactive kinds or missing requestID", () => {
    expect(interactionRecordFromEvent(runtimeEvent())).toBeNull();
    expect(
      interactionRecordFromEvent(
        runtimeEvent({ kind: EventKind.approvalRequest, requestID: undefined }),
      ),
    ).toBeNull();
  });
});

describe("reduceRuntimeEvent (shipped store path)", () => {
  it("appends approval events into interactionRequests so waiting presents mid-turn", () => {
    const envelope: RuntimeEventEnvelope = {
      projectID: "project-1",
      threadID: "thread-1",
      event: runtimeEvent({
        id: "evt-approval",
        kind: EventKind.approvalRequest,
        requestID: "req-1",
        turnID: "turn-1",
        payload: {
          approval: { kind: "command", title: "Allow?", paths: [], options: [] },
        },
      }),
    };

    const reduced = reduceRuntimeEvent(
      {
        workspace: workspaceWithThread(),
        activeTurnByThread: { "thread-1": "turn-1" },
      },
      envelope,
    );

    const thread = reduced.workspace!.projects[0].threads[0];
    expect(thread.interactionRequests).toHaveLength(1);
    expect(thread.interactionRequests[0].id).toBe("req-1");
    expect(thread.interactionRequests[0].status).toBe("pending");
    expect(thread.runtimeEvents).toHaveLength(1);
    expect(threadActivity(thread, reduced.activeTurnByThread).status).toBe("waiting");
  });

  it("appends user-input requests the same way (waiting, not running)", () => {
    const reduced = reduceRuntimeEvent(
      {
        workspace: workspaceWithThread(),
        activeTurnByThread: { "thread-1": "turn-1" },
      },
      {
        projectID: "project-1",
        threadID: "thread-1",
        event: runtimeEvent({
          id: "evt-q",
          kind: EventKind.userInputRequest,
          requestID: "req-q",
          payload: { userInput: { questions: [] } },
        }),
      },
    );
    const thread = reduced.workspace!.projects[0].threads[0];
    expect(threadActivity(thread, reduced.activeTurnByThread)).toEqual({
      status: "waiting",
      turnID: "turn-1",
    });
  });

  it("does not duplicate interaction records on replay of the same event id", () => {
    const event = runtimeEvent({
      id: "same",
      kind: EventKind.approvalRequest,
      requestID: "req-1",
      payload: { approval: { kind: "x", title: "t", paths: [], options: [] } },
    });
    const first = reduceRuntimeEvent(
      {
        workspace: workspaceWithThread(),
        activeTurnByThread: { "thread-1": "turn-1" },
      },
      { projectID: "project-1", threadID: "thread-1", event },
    );
    const second = reduceRuntimeEvent(first, {
      projectID: "project-1",
      threadID: "thread-1",
      event,
    });
    expect(second.workspace!.projects[0].threads[0].interactionRequests).toHaveLength(1);
    expect(second.workspace!.projects[0].threads[0].runtimeEvents).toHaveLength(1);
  });

  it("keeps busy through turn.terminal until the persisted finish event arrives", () => {
    const reduced = reduceRuntimeEvent(
      {
        workspace: workspaceWithThread(),
        activeTurnByThread: { "thread-1": "turn-1", "thread-2": "turn-2" },
      },
      {
        projectID: "project-1",
        threadID: "thread-1",
        event: runtimeEvent({
          id: "term",
          kind: EventKind.turnTerminal,
          turnID: "turn-1",
          payload: { terminalState: "completed" },
        }),
      },
    );
    expect(reduced.activeTurnByThread).toEqual({
      "thread-1": "turn-1",
      "thread-2": "turn-2",
    });
  });

  it("marks a thread busy from a live event for an unknown turn", () => {
    // The follow-up responders of a multi-mention chain are started by the
    // backend, so the first the store hears of them is their event stream.
    const reduced = reduceRuntimeEvent(
      { workspace: workspaceWithThread(), activeTurnByThread: {} },
      {
        projectID: "project-1",
        threadID: "thread-1",
        event: runtimeEvent({ id: "delta", turnID: "turn-2", payload: { text: "hi" } }),
      },
    );
    expect(reduced.activeTurnByThread).toEqual({ "thread-1": "turn-2" });
  });

  it("moves busy state to a chained turn as its events arrive", () => {
    const reduced = reduceRuntimeEvent(
      {
        workspace: workspaceWithThread(),
        activeTurnByThread: { "thread-1": "turn-1" },
      },
      {
        projectID: "project-1",
        threadID: "thread-1",
        event: runtimeEvent({ id: "delta", turnID: "turn-2", payload: { text: "hi" } }),
      },
    );
    expect(reduced.activeTurnByThread).toEqual({ "thread-1": "turn-2" });
  });

  it("keeps running (not waiting) for plain streaming deltas", () => {
    const reduced = reduceRuntimeEvent(
      {
        workspace: workspaceWithThread(),
        activeTurnByThread: { "thread-1": "turn-1" },
      },
      {
        projectID: "project-1",
        threadID: "thread-1",
        event: runtimeEvent({
          id: "delta",
          kind: EventKind.assistantTextDelta,
          payload: { text: "hi" },
        }),
      },
    );
    const thread = reduced.workspace!.projects[0].threads[0];
    expect(thread.interactionRequests).toHaveLength(0);
    expect(threadActivity(thread, reduced.activeTurnByThread).status).toBe("running");
  });
});
