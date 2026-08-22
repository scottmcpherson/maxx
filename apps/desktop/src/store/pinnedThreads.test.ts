import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COMPUTER_USE_SETTINGS, type ChatThread, type WorkspaceDocument } from "../contract/types";
import { DEFAULT_VOICE_SETTINGS } from "../voice/types";
import {
  loadPinnedThreadIDs,
  persistPinnedThreadIDs,
  pinnedThreads,
  prunePinnedThreadIDs,
  setThreadPinned,
} from "./pinnedThreads";

function thread(id: string, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    title: id,
    provider: "codex",
    model: "default",
    messages: [],
    runtimeEvents: [],
    interactionRequests: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function workspace(): WorkspaceDocument {
  return {
    schemaVersion: 1,
    providerProfiles: [],
    agents: [],
    voice: DEFAULT_VOICE_SETTINGS,
    computerUse: DEFAULT_COMPUTER_USE_SETTINGS,
    projects: [
      {
        id: "project-1",
        folderPath: "/tmp/one",
        threads: [thread("one"), thread("side", { parentThreadID: "one" })],
      },
      {
        id: "project-2",
        folderPath: "/tmp/two",
        threads: [thread("two")],
      },
    ],
  };
}

describe("setThreadPinned", () => {
  it("places newly pinned threads first and removes unpinned threads", () => {
    const original = ["one"];
    const pinned = setThreadPinned(original, "two", true);
    expect(pinned).toEqual(["two", "one"]);
    expect(original).toEqual(["one"]);
    expect(setThreadPinned(pinned, "one", false)).toEqual(["two"]);
  });

  it("returns the same instance when the requested state is already set", () => {
    const pinned = ["one"];
    expect(setThreadPinned(pinned, "one", true)).toBe(pinned);
    expect(setThreadPinned(pinned, "two", false)).toBe(pinned);
  });
});

describe("pinnedThreads", () => {
  it("resolves pins in saved order with their owning projects", () => {
    const items = pinnedThreads(workspace(), ["two", "one"]);
    expect(items.map((item) => [item.thread.id, item.project.id])).toEqual([
      ["two", "project-2"],
      ["one", "project-1"],
    ]);
  });

  it("ignores deleted IDs and side threads", () => {
    expect(pinnedThreads(workspace(), ["deleted", "side", "one"]).map((item) => item.thread.id))
      .toEqual(["one"]);
  });
});

describe("prunePinnedThreadIDs", () => {
  it("drops deleted IDs and side-thread IDs", () => {
    expect(prunePinnedThreadIDs(["one", "side", "deleted", "two"], workspace()))
      .toEqual(["one", "two"]);
  });

  it("keeps the same instance when no IDs are stale", () => {
    const pinned = ["one", "two"];
    expect(prunePinnedThreadIDs(pinned, workspace())).toBe(pinned);
    expect(prunePinnedThreadIDs(pinned, null)).toBe(pinned);
  });
});

describe("pin persistence", () => {
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

  it("round-trips ordered unique IDs and rejects malformed state", () => {
    persistPinnedThreadIDs(["two", "one"]);
    expect(loadPinnedThreadIDs()).toEqual(["two", "one"]);

    window.localStorage.setItem("maxx.sidebar.pinned-threads", JSON.stringify(["one", "one", 7]));
    expect(loadPinnedThreadIDs()).toEqual(["one"]);

    window.localStorage.setItem("maxx.sidebar.pinned-threads", "not json");
    expect(loadPinnedThreadIDs()).toEqual([]);
  });
});
