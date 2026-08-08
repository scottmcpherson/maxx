import { describe, expect, it } from "vitest";
import {
  attentionThreads,
  loadAttentionFilterOpen,
  persistAttentionFilterOpen,
  withStickyAttention,
} from "./attentionFilter";
import {
  ChatThread,
  RuntimeInteractionRecord,
  WorkspaceDocument,
} from "../contract/types";
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

function pendingRequest(threadID: string, turnID: string): RuntimeInteractionRecord {
  return {
    id: `req-${threadID}`,
    requestEventID: `event-${threadID}`,
    providerInstanceID: "provider-1",
    threadID,
    turnID,
    createdAt: 1,
    status: "pending",
  };
}

function workspace(threadsByProject: Record<string, ChatThread[]>): WorkspaceDocument {
  return {
    schemaVersion: 1,
    providerProfiles: [],
    agents: [],
    voice: DEFAULT_VOICE_SETTINGS,
    projects: Object.entries(threadsByProject).map(([id, threads]) => ({
      id,
      folderPath: `/tmp/${id}`,
      threads,
    })),
  };
}

class MemoryStorage {
  private values = new Map<string, string>();
  getItem = (key: string) => this.values.get(key) ?? null;
  setItem = (key: string, value: string) => void this.values.set(key, value);
}

describe("attentionThreads", () => {
  it("returns only waiting and unseen top-level threads in project order", () => {
    const ws = workspace({
      p1: [
        thread({ id: "read" }),
        thread({ id: "unseen" }),
        thread({
          id: "waiting",
          interactionRequests: [pendingRequest("waiting", "turn-a")],
        }),
        thread({ id: "side", parentThreadID: "unseen" }),
      ],
      p2: [thread({ id: "running" })],
    });

    const items = attentionThreads(
      ws,
      { waiting: "turn-a", running: "turn-b" },
      { unseen: true, side: true },
      null,
    );

    expect(items.map((item) => item.thread.id)).toEqual(["unseen", "waiting"]);
    expect(items.map((item) => item.reason)).toEqual(["unseen", "waiting"]);
    expect(items.map((item) => item.project.id)).toEqual(["p1", "p1"]);
  });

  it("excludes the selected thread because it is already being viewed", () => {
    const ws = workspace({ p1: [thread({ id: "selected" }), thread({ id: "other" })] });
    const items = attentionThreads(
      ws,
      {},
      { selected: true, other: true },
      "selected",
    );
    expect(items.map((item) => item.thread.id)).toEqual(["other"]);
  });

  it("lists a waiting and unseen thread once, with waiting taking precedence", () => {
    const ws = workspace({
      p1: [
        thread({
          id: "both",
          interactionRequests: [pendingRequest("both", "turn-a")],
        }),
      ],
    });
    const items = attentionThreads(ws, { both: "turn-a" }, { both: true }, null);
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe("waiting");
  });

  it("returns empty for missing workspaces and running chats without requests", () => {
    expect(attentionThreads(null, {}, {}, null)).toEqual([]);
    const ws = workspace({ p1: [thread({ id: "running" })] });
    expect(attentionThreads(ws, { running: "turn-a" }, {}, null)).toEqual([]);
  });
});

describe("withStickyAttention", () => {
  it("keeps a just-opened chat in its original project while it is selected", () => {
    const ws = workspace({
      p1: [thread({ id: "reading" }), thread({ id: "other" })],
    });
    const items = attentionThreads(ws, {}, { other: true }, "reading");
    const display = withStickyAttention(
      items,
      ws,
      { threadID: "reading", reason: "unseen" },
      "reading",
    );
    expect(display.map((item) => item.thread.id)).toEqual(["other", "reading"]);
    expect(display[1].project.id).toBe("p1");
  });

  it("does not retain a sticky chat after selection moves", () => {
    const ws = workspace({ p1: [thread({ id: "reading" })] });
    const items = attentionThreads(ws, {}, {}, "other");
    expect(
      withStickyAttention(
        items,
        ws,
        { threadID: "reading", reason: "unseen" },
        "other",
      ),
    ).toBe(items);
  });
});

describe("attention filter persistence", () => {
  it("defaults closed and round-trips through storage", () => {
    const storage = new MemoryStorage();
    expect(loadAttentionFilterOpen(storage)).toBe(false);
    persistAttentionFilterOpen(true, storage);
    expect(loadAttentionFilterOpen(storage)).toBe(true);
    persistAttentionFilterOpen(false, storage);
    expect(loadAttentionFilterOpen(storage)).toBe(false);
  });

  it("defaults closed without storage", () => {
    expect(loadAttentionFilterOpen(undefined)).toBe(false);
  });
});
