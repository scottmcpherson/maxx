import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDocument } from "../contract/types";
import type { BrowserAnnotation } from "../browser";
import { LOCAL_HOST_ID } from "../host/session";
import { ipc } from "../ipc";
import { useAppStore } from "./appStore";

const originalRefresh = useAppStore.getState().refresh;

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
    browserAnnotationsByThread: {},
    error: null,
    refresh: originalRefresh,
    defaultRuntime: { provider: "codex", model: "Default", effort: null, speed: null },
    newThreadRuntime: { provider: "codex", model: "Default", effort: null, speed: null },
    newThreadSurface: "gui",
    terminalModeEnabled: false,
  });
  vi.restoreAllMocks();
});

describe("terminal chat creation", () => {
  it("resets the new-chat surface when terminal mode is disabled", () => {
    useAppStore.setState({ newThreadSurface: "terminal", terminalModeEnabled: true });

    useAppStore.getState().setTerminalModeEnabled(false);

    expect(useAppStore.getState().terminalModeEnabled).toBe(false);
    expect(useAppStore.getState().newThreadSurface).toBe("gui");
  });

  it("creates the first turn on the terminal surface without GUI-only attachments", async () => {
    const workspace = sampleWorkspace("/tmp/project");
    useAppStore.setState({
      workspace,
      remoteSessions: [],
      selectedHostID: LOCAL_HOST_ID,
      selectedProjectID: "project",
      selectedThreadID: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    const thread = { ...workspace.projects[0].threads[0], id: "terminal-thread", surface: "terminal" as const };
    const add = vi.spyOn(ipc, "addThreadWithRuntime").mockResolvedValue(thread);
    const send = vi.spyOn(ipc, "sendPrompt").mockResolvedValue("turn-terminal");
    const upload = vi.spyOn(ipc, "uploadMedia");

    await expect(useAppStore.getState().createThreadAndSend(
      "project",
      "codex",
      "Default",
      "Continue in the terminal",
      ["/tmp/not-sent.png"],
      null,
      null,
      "terminal",
    )).resolves.toBe(true);

    expect(add).toHaveBeenCalledWith(
      "project", "codex", "Default", "Continue in the terminal", null, null, "terminal", LOCAL_HOST_ID,
    );
    expect(upload).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "project", "terminal-thread", "Continue in the terminal", [], LOCAL_HOST_ID, [],
    );
  });

  it("requires a typed first prompt for terminal mode", async () => {
    await expect(useAppStore.getState().createThreadAndSend(
      "project", "codex", "Default", "", ["/tmp/image.png"], null, null, "terminal",
    )).resolves.toBe(false);
  });
});

function annotation(id: string, selector: string): BrowserAnnotation {
  return {
    id,
    tabId: "tab-a",
    url: "https://example.com/",
    selector,
    tagName: "DIV",
    role: null,
    name: id,
    text: id,
    instruction: `Update ${id}`,
    previewDataUrl: "",
    rect: { x: 1, y: 2, width: 3, height: 4 },
    createdAt: 1,
  };
}

function sampleWorkspace(folderPath: string, projectID = "project"): WorkspaceDocument {
  return {
    schemaVersion: 7,
    projects: [{
      id: projectID,
      folderPath,
      threads: [{
        id: "thread-a",
        title: "Local chat",
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
}

describe("additive remote hosts", () => {
  it("keeps the local workspace byte-for-byte when a remote host is detached", async () => {
    const local = sampleWorkspace("/Users/scott/macbook", "local-project");
    const before = JSON.stringify(local);
    useAppStore.setState({
      workspace: local,
      selectedHostID: "mini",
      selectedProjectID: "remote-project",
      selectedThreadID: "remote-thread",
      remoteSessions: [{
        host: { id: "mini", name: "Mac mini", kind: "remote", address: "127.0.0.1:7422" },
        workspace: sampleWorkspace("/Users/scott/mini", "remote-project"),
      }],
    });
    vi.spyOn(ipc, "hostDisconnect").mockResolvedValue(undefined);
    vi.spyOn(ipc, "hostStatus").mockResolvedValue({
      id: "local-id",
      name: "This Mac",
      protocolVersion: 2,
      listening: false,
      bindAddress: null,
      shareAddress: null,
      pairing: null,
      remotes: [],
      pairedDevices: [],
    });

    await useAppStore.getState().disconnectHost("mini");

    expect(JSON.stringify(useAppStore.getState().workspace)).toBe(before);
    expect(useAppStore.getState().remoteSessions).toEqual([]);
    expect(useAppStore.getState().selectedHostID).toBe(LOCAL_HOST_ID);
    vi.restoreAllMocks();
  });

  it("does not apply a remote mutation to the local workspace", () => {
    const local = sampleWorkspace("/tmp/local", "project");
    useAppStore.setState({
      workspace: local,
      remoteSessions: [{
        host: { id: "mini", name: "Mac mini", kind: "remote", address: "100.64.0.2:7422" },
        workspace: sampleWorkspace("/tmp/mini", "mini-project"),
      }],
    });

    useAppStore.getState().applyThreadTitleUpdated({
      projectID: "mini-project",
      threadID: "thread-a",
      title: "Changed on the mini",
    }, "mini");

    expect(useAppStore.getState().workspace?.projects[0]?.threads[0]?.title).toBe("Local chat");
    expect(useAppStore.getState().remoteSessions[0]?.workspace.projects[0]?.threads[0]?.title)
      .toBe("Changed on the mini");
  });

  it("connects through the shipped host_connect pairing path", async () => {
    const local = sampleWorkspace("/Users/scott/macbook", "local-project");
    useAppStore.setState({ workspace: local, remoteSessions: [] });
    const connect = vi.spyOn(ipc, "hostConnect").mockResolvedValue({
      id: "mini",
      name: "Mac mini",
      address: "100.64.0.2:7422",
      capabilities: ["workspace-read", "workspace-write", "agent-run", "terminal-control", "browser-control"],
      connected: true,
      lastEventCursor: 0,
      error: "",
    });
    vi.spyOn(ipc, "workspaceSnapshot").mockImplementation(async (hostId) => {
      if (hostId === "mini") return sampleWorkspace("/Users/scott/mini", "remote-project");
      return local;
    });
    vi.spyOn(ipc, "hostStatus").mockResolvedValue({
      id: "local-id",
      name: "This Mac",
      protocolVersion: 2,
      listening: true,
      bindAddress: "100.64.0.2:7422",
      shareAddress: "100.64.0.2:7422",
      pairing: null,
      remotes: [{
        id: "mini",
        name: "Mac mini",
        address: "100.64.0.2:7422",
        capabilities: ["workspace-read", "workspace-write", "agent-run", "terminal-control", "browser-control"],
        connected: true,
        lastEventCursor: 0,
        error: "",
      }],
      pairedDevices: [],
    });
    vi.spyOn(ipc, "activeTurns").mockResolvedValue([]);

    await useAppStore.getState().connectHost("100.64.0.2:7422", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(connect).toHaveBeenCalledWith("100.64.0.2:7422", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(useAppStore.getState().remoteSessions[0]?.host.id).toBe("mini");
    expect(useAppStore.getState().workspace?.projects[0]?.folderPath).toBe("/Users/scott/macbook");
    vi.restoreAllMocks();
  });

  it("hydrates a remembered remote reported by the runtime after restart", async () => {
    const local = sampleWorkspace("/Users/scott/macbook", "local-project");
    const remote = sampleWorkspace("/Users/scott/mini", "remote-project");
    useAppStore.setState({ workspace: local, remoteSessions: [], hostStatus: null });
    vi.spyOn(ipc, "hostStatus").mockResolvedValue({
      id: "local-id",
      name: "This Mac",
      protocolVersion: 2,
      listening: true,
      bindAddress: "100.64.0.1:7422",
      shareAddress: "100.64.0.1:7422",
      pairing: null,
      remotes: [{
        id: "mini",
        name: "Mac mini",
        address: "100.64.0.2:7422",
        capabilities: ["workspace-read", "workspace-write", "agent-run", "terminal-control", "browser-control"],
        connected: true,
        lastEventCursor: 0,
        error: "",
      }],
      pairedDevices: [],
    });
    vi.spyOn(ipc, "workspaceSnapshot").mockResolvedValue(remote);

    await useAppStore.getState().refreshHostStatus();

    expect(useAppStore.getState().remoteSessions).toEqual([{
      host: { id: "mini", name: "Mac mini", kind: "remote", address: "100.64.0.2:7422" },
      workspace: remote,
    }]);
    expect(useAppStore.getState().workspace).toBe(local);
    vi.restoreAllMocks();
  });

  it("removes a remote session immediately when its socket closes", () => {
    const local = sampleWorkspace("/Users/scott/macbook", "local-project");
    useAppStore.setState({
      workspace: local,
      selectedHostID: "mini",
      selectedProjectID: "remote-project",
      selectedThreadID: "thread-a",
      remoteSessions: [{
        host: { id: "mini", name: "Mac mini", kind: "remote", address: "100.64.0.2:7422" },
        workspace: sampleWorkspace("/Users/scott/mini", "remote-project"),
      }],
    });

    useAppStore.getState().markHostDisconnected("mini");

    expect(useAppStore.getState().remoteSessions).toEqual([]);
    expect(useAppStore.getState().selectedHostID).toBe(LOCAL_HOST_ID);
    expect(useAppStore.getState().selectedProjectID).toBeNull();
    expect(useAppStore.getState().workspace).toBe(local);
  });
});

describe("generated thread titles", () => {
  it("applies a backend title event without waiting for a workspace refresh", () => {
    const workspace: WorkspaceDocument = {
      schemaVersion: 7,
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

describe("browser annotations", () => {
  it("keeps ordered, thread-scoped selections and toggles a target by tab and selector", () => {
    const first = annotation("first", "#first");
    const second = annotation("second", "#second");

    useAppStore.getState().applyBrowserAnnotation("thread-a", first, true);
    useAppStore.getState().applyBrowserAnnotation("thread-a", second, true);
    useAppStore.getState().applyBrowserAnnotation("thread-b", annotation("other", "#other"), true);
    expect(useAppStore.getState().browserAnnotationsByThread["thread-a"]?.map(({ id }) => id))
      .toEqual(["first", "second"]);

    useAppStore.getState().applyBrowserAnnotation("thread-a", annotation("replacement", "#first"), false);
    expect(useAppStore.getState().browserAnnotationsByThread["thread-a"]?.map(({ id }) => id))
      .toEqual(["second"]);
    expect(useAppStore.getState().browserAnnotationsByThread["thread-b"]).toHaveLength(1);
  });

  it("removes one pill without disturbing the rest and clears after submission", () => {
    useAppStore.getState().applyBrowserAnnotation("thread-a", annotation("first", "#first"), true);
    useAppStore.getState().applyBrowserAnnotation("thread-a", annotation("second", "#second"), true);

    useAppStore.getState().removeBrowserAnnotation("thread-a", "first");
    expect(useAppStore.getState().browserAnnotationsByThread["thread-a"]?.map(({ id }) => id))
      .toEqual(["second"]);

    useAppStore.getState().clearBrowserAnnotations("thread-a");
    expect(useAppStore.getState().browserAnnotationsByThread["thread-a"]).toEqual([]);
  });

  it("restores the annotation set when a browser annotation session is cancelled", () => {
    const original = annotation("first", "#first");
    useAppStore.getState().applyBrowserAnnotation("thread-a", original, true);
    useAppStore.getState().applyBrowserAnnotation("thread-a", annotation("second", "#second"), true);

    useAppStore.getState().replaceBrowserAnnotations("thread-a", [original]);

    expect(useAppStore.getState().browserAnnotationsByThread["thread-a"]).toEqual([original]);
  });

  it("submits an annotation-only message and reports backend acceptance", async () => {
    const selected = annotation("first", "#first");
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      workspace: sampleWorkspace("/tmp/project"),
      remoteSessions: [],
      selectedHostID: LOCAL_HOST_ID,
      selectedProjectID: "project",
      selectedThreadID: "thread-a",
      refresh,
    });
    const send = vi.spyOn(ipc, "sendPrompt").mockResolvedValue("turn-a");

    await expect(useAppStore.getState().sendPrompt("", [], [selected])).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith("project", "thread-a", "", [], LOCAL_HOST_ID, [], [selected]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("routes a local project's annotated prompt locally when the selected host is stale", async () => {
    const selected = annotation("first", "#first");
    useAppStore.setState({
      workspace: sampleWorkspace("/tmp/local", "local-project"),
      remoteSessions: [{
        host: { id: "mini", name: "Mac mini", kind: "remote", address: "127.0.0.1:7422" },
        workspace: sampleWorkspace("/tmp/remote", "remote-project"),
      }],
      selectedHostID: "mini",
      selectedProjectID: "local-project",
      selectedThreadID: "thread-a",
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    const send = vi.spyOn(ipc, "sendPrompt").mockResolvedValue("turn-local");

    await expect(useAppStore.getState().sendPrompt("change this", [], [selected])).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      "local-project", "thread-a", "change this", [], LOCAL_HOST_ID, [], [selected],
    );
  });

  it("reports rejection so the composer can retain its draft and pills", async () => {
    useAppStore.setState({
      workspace: sampleWorkspace("/tmp/project"),
      remoteSessions: [],
      selectedHostID: LOCAL_HOST_ID,
      selectedProjectID: "project",
      selectedThreadID: "thread-a",
    });
    vi.spyOn(ipc, "sendPrompt").mockRejectedValue(new Error("backend rejected"));

    await expect(useAppStore.getState().sendPrompt("change this", [], [annotation("first", "#first")]))
      .resolves.toBe(false);
    expect(useAppStore.getState().error).toContain("backend rejected");
  });
});
