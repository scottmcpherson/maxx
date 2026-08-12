import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceDocument } from "../contract/types";
import { useAppStore } from "./appStore";

function seedThreadPanels(threadID: string | null = "thread-a") {
  useAppStore.setState({
    workspace: null,
    selectedProjectID: "project",
    selectedThreadID: threadID,
    browserOpen: true,
    pendingBrowserReveal: null,
    openSideThreadID: "side-thread",
    summaryPopoverOpen: true,
  });
}

afterEach(() => {
  useAppStore.setState({
    selectedProjectID: null,
    selectedThreadID: null,
    browserOpen: false,
    pendingBrowserReveal: null,
    openSideThreadID: null,
    summaryPopoverOpen: false,
    defaultRuntime: { provider: "codex", model: "Default", effort: null, speed: null },
    newThreadRuntime: { provider: "codex", model: "Default", effort: null, speed: null },
  });
});

describe("generated thread titles", () => {
  it("applies a backend title event without waiting for a workspace refresh", () => {
    const workspace: WorkspaceDocument = {
      schemaVersion: 6,
      projects: [{
        id: "project",
        folderPath: "/tmp/project",
        threads: [{
          id: "thread-a",
          title: "Explain why the sidebar title should be generated",
          provider: "codex",
          model: "Default",
          messages: [],
          runtimeEvents: [],
          interactionRequests: [],
          createdAt: 1,
          updatedAt: 1,
        }],
      }],
      providerProfiles: [],
      agents: [],
      voice: {
        isEnabled: false,
        useGrokSignIn: false,
        language: "en",
        apiBase: "https://api.x.ai",
      },
    };
    useAppStore.setState({ workspace });

    useAppStore.getState().applyThreadTitleUpdated({
      projectID: "project",
      threadID: "thread-a",
      title: "Generate Short Chat Titles",
    });

    expect(useAppStore.getState().workspace?.projects[0]?.threads[0]?.title)
      .toBe("Generate Short Chat Titles");
  });
});

describe("thread-scoped panels", () => {
  it("seeds each new chat from the saved default runtime", () => {
    useAppStore.setState({
      selectedThreadID: "thread-a",
      defaultRuntime: {
        provider: "claude",
        model: "claude-opus-4-1",
        effort: "high",
        speed: null,
      },
      newThreadRuntime: {
        provider: "grok",
        model: "grok-4.5",
        effort: null,
        speed: null,
      },
    });

    useAppStore.getState().startNewThread("project");

    expect(useAppStore.getState().newThreadRuntime).toEqual({
      provider: "claude",
      model: "claude-opus-4-1",
      effort: "high",
      speed: null,
    });
  });

  it("closes every right-side panel when the selected thread changes", () => {
    seedThreadPanels();

    useAppStore.getState().selectThread("project", "thread-b");

    expect(useAppStore.getState()).toMatchObject({
      selectedThreadID: "thread-b",
      browserOpen: false,
      openSideThreadID: null,
      summaryPopoverOpen: false,
    });
  });

  it("does not close the browser when the current thread is selected again", () => {
    seedThreadPanels();

    useAppStore.getState().selectThread("project", "thread-a");

    expect(useAppStore.getState().browserOpen).toBe(true);
  });

  it("cannot open the browser without a selected thread", () => {
    seedThreadPanels(null);

    useAppStore.getState().setBrowserOpen(true);

    expect(useAppStore.getState().browserOpen).toBe(false);
  });

  it("reveals an agent-opened tab only in the thread that owns it", () => {
    seedThreadPanels();
    useAppStore.setState({ browserOpen: false });

    useAppStore.getState().revealBrowserTab({ threadId: "thread-b", tabId: "tab-b" });
    expect(useAppStore.getState().browserOpen).toBe(false);
    expect(useAppStore.getState().pendingBrowserReveal).toBeNull();

    useAppStore.getState().revealBrowserTab({ threadId: "thread-a", tabId: "tab-a" });
    expect(useAppStore.getState().browserOpen).toBe(true);
    expect(useAppStore.getState().pendingBrowserReveal).toEqual({
      threadId: "thread-a",
      tabId: "tab-a",
    });

    useAppStore.getState().consumeBrowserReveal("tab-a");
    expect(useAppStore.getState().pendingBrowserReveal).toBeNull();
  });
});
