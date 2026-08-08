import { beforeAll, describe, expect, it } from "vitest";
import {
  clearThreadUnseen,
  loadUnseenThreadIDs,
  markThreadUnseen,
  persistUnseenThreadIDs,
  pruneUnseenThreads,
  unseenTargetForFinishedTurn,
} from "./unseenThreads";
import type { UnseenThreadMap } from "./unseenThreads";
import { ChatThread, TurnFinishedEnvelope, WorkspaceDocument } from "../contract/types";
import { DEFAULT_VOICE_SETTINGS } from "../voice/types";

function thread(overrides: Partial<ChatThread> & Pick<ChatThread, "id">): ChatThread {
  return {
    title: "Thread",
    provider: "claude",
    model: "default",
    messages: [],
    runtimeEvents: [],
    interactionRequests: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function workspace(threads: ChatThread[]): WorkspaceDocument {
  return {
    schemaVersion: 1,
    providerProfiles: [],
    agents: [],
    voice: DEFAULT_VOICE_SETTINGS,
    projects: [{ id: "project-1", folderPath: "/tmp/proj", threads }],
  };
}

function finished(overrides: Partial<TurnFinishedEnvelope> = {}): TurnFinishedEnvelope {
  return {
    projectID: "project-1",
    threadID: "thread-1",
    turnID: "turn-1",
    terminalState: "completed",
    ...overrides,
  };
}

describe("markThreadUnseen / clearThreadUnseen", () => {
  it("adds and removes marks immutably", () => {
    const empty: UnseenThreadMap = {};
    const marked = markThreadUnseen(empty, "t1");
    expect(marked).toEqual({ t1: true });
    expect(empty).toEqual({});
    const cleared = clearThreadUnseen(marked, "t1");
    expect(cleared).toEqual({});
    expect(marked).toEqual({ t1: true });
  });

  it("returns the same instance when nothing changes", () => {
    const marked = markThreadUnseen({}, "t1");
    expect(markThreadUnseen(marked, "t1")).toBe(marked);
    expect(clearThreadUnseen(marked, "other")).toBe(marked);
  });
});

describe("unseenTargetForFinishedTurn", () => {
  it("marks a background thread when another thread is selected", () => {
    const ws = workspace([thread({ id: "thread-1" }), thread({ id: "thread-2" })]);
    expect(unseenTargetForFinishedTurn(ws, finished(), "thread-2")).toBe("thread-1");
  });

  it("does not mark the thread the user is viewing", () => {
    const ws = workspace([thread({ id: "thread-1" })]);
    expect(unseenTargetForFinishedTurn(ws, finished(), "thread-1")).toBeNull();
  });

  it("rolls a side-thread completion up to its parent row", () => {
    const ws = workspace([
      thread({ id: "parent" }),
      thread({ id: "side", parentThreadID: "parent", anchorMessageID: "m1" }),
    ]);
    expect(
      unseenTargetForFinishedTurn(ws, finished({ threadID: "side" }), "elsewhere"),
    ).toBe("parent");
  });

  it("skips side-thread completions while the parent is being viewed", () => {
    const ws = workspace([
      thread({ id: "parent" }),
      thread({ id: "side", parentThreadID: "parent", anchorMessageID: "m1" }),
    ]);
    expect(
      unseenTargetForFinishedTurn(ws, finished({ threadID: "side" }), "parent"),
    ).toBeNull();
  });

  it("ignores user-initiated stops", () => {
    const ws = workspace([thread({ id: "thread-1" })]);
    expect(
      unseenTargetForFinishedTurn(ws, finished({ terminalState: "cancelled" }), null),
    ).toBeNull();
    expect(
      unseenTargetForFinishedTurn(ws, finished({ terminalState: "interrupted" }), null),
    ).toBeNull();
  });

  it("still marks failed turns — a background failure is worth seeing", () => {
    const ws = workspace([thread({ id: "thread-1" })]);
    expect(
      unseenTargetForFinishedTurn(ws, finished({ terminalState: "failed" }), "other"),
    ).toBe("thread-1");
  });

  it("falls back to the envelope thread when the workspace has not caught up", () => {
    expect(unseenTargetForFinishedTurn(null, finished(), "other")).toBe("thread-1");
  });
});

describe("pruneUnseenThreads", () => {
  it("drops marks for deleted threads and keeps live ones", () => {
    const ws = workspace([thread({ id: "alive" })]);
    expect(pruneUnseenThreads({ alive: true, deleted: true }, ws)).toEqual({ alive: true });
  });

  it("returns the same instance when nothing is stale", () => {
    const ws = workspace([thread({ id: "alive" })]);
    const unseen: UnseenThreadMap = { alive: true };
    expect(pruneUnseenThreads(unseen, ws)).toBe(unseen);
    expect(pruneUnseenThreads(unseen, null)).toBe(unseen);
  });
});

describe("load / persist round trip", () => {
  // Tests run in node; the module only touches window.localStorage at call time.
  beforeAll(() => {
    const store = new Map<string, string>();
    Object.assign(globalThis, {
      window: {
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
          removeItem: (key: string) => void store.delete(key),
        },
      },
    });
  });

  it("restores what was persisted and ignores garbage", () => {
    persistUnseenThreadIDs({ t1: true, t2: true });
    expect(loadUnseenThreadIDs()).toEqual({ t1: true, t2: true });

    window.localStorage.setItem("maxx.sidebar.unseen-threads", "not json");
    expect(loadUnseenThreadIDs()).toEqual({});

    window.localStorage.setItem("maxx.sidebar.unseen-threads", JSON.stringify({ t1: true }));
    expect(loadUnseenThreadIDs()).toEqual({});

    window.localStorage.removeItem("maxx.sidebar.unseen-threads");
    expect(loadUnseenThreadIDs()).toEqual({});
  });
});
