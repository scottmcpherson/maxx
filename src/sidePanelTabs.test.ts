import { describe, expect, it } from "vitest";
import {
  loadSidePanelTabState,
  persistSidePanelTabState,
  reconcileSidePanelTabs,
  reorderSidePanelTabs,
  type SidePanelTab,
} from "./sidePanelTabs";

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    value: () => value,
  };
}

describe("side panel tabs", () => {
  it("starts empty instead of inventing a browser tab", () => {
    expect(loadSidePanelTabState("thread", memoryStorage())).toEqual({
      tabs: [],
      selectedTabID: null,
    });
  });

  it("persists mixed tab order and selection", () => {
    const storage = memoryStorage();
    const state = {
      tabs: [
        { id: "browser-1", type: "browser" as const },
        { id: "terminal-1", type: "terminal" as const, title: "maxx" },
        { id: "chat-1", type: "side-chat" as const, title: "Side chat", pendingSelections: [
          { id: "selection-1", text: "Selected context" },
        ] },
      ],
      selectedTabID: "chat-1",
    };
    persistSidePanelTabState("thread", state, storage);
    expect(loadSidePanelTabState("thread", storage)).toEqual(state);
  });

  it("reconciles native browser and side-chat lifecycles without dropping terminal tabs", () => {
    const state = {
      tabs: [
        { id: "closed-browser", type: "browser" as const },
        { id: "terminal-1", type: "terminal" as const, title: "maxx" },
        { id: "closed-chat", type: "side-chat" as const, title: "Old", pendingSelections: [] },
      ],
      selectedTabID: "closed-browser",
    };
    expect(reconcileSidePanelTabs(state, ["browser-2"], ["chat-2"], "browser-2")).toEqual({
      tabs: [
        { id: "terminal-1", type: "terminal", title: "maxx" },
        { id: "browser-2", type: "browser" },
        { id: "chat-2", type: "side-chat", title: "Side chat", pendingSelections: [] },
      ],
      selectedTabID: "browser-2",
    });
  });

  it("reorders browser and terminal tabs as one strip", () => {
    const tabs: SidePanelTab[] = [
      { id: "browser-1", type: "browser" },
      { id: "terminal-1", type: "terminal", title: "maxx" },
      { id: "chat-1", type: "side-chat", title: "Side chat", pendingSelections: [] },
      { id: "browser-2", type: "browser" },
    ];
    expect(reorderSidePanelTabs(tabs, "chat-1", "browser-2", "after").map((tab) => tab.id))
      .toEqual(["browser-1", "terminal-1", "browser-2", "chat-1"]);
  });

  it("ignores malformed stored records", () => {
    const storage = memoryStorage(JSON.stringify({
      tabs: [null, { id: "", type: "browser" }, { id: "terminal", type: "terminal" }],
      selectedTabID: "terminal",
    }));
    expect(loadSidePanelTabState("thread", storage)).toEqual({ tabs: [], selectedTabID: null });
  });
});
