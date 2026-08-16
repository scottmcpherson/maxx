import { afterEach, describe, expect, it, vi } from "vitest";
import { CHATS_PROJECT_ID, type WorkspaceDocument } from "../contract/types";
import type { BrowserAnnotation } from "../browser";
import { LOCAL_HOST_ID } from "../host/session";
import { ipc } from "../ipc";
import { useAppStore } from "./appStore";

const originalRefresh = useAppStore.getState().refresh;
const originalRefreshHostStatus = useAppStore.getState().refreshHostStatus;

function seedThreadPanels(threadID: string | null = "thread-a") {
  useAppStore.setState({
    workspace: null,
    remoteSessions: [],
    hostDisconnectNotice: null,
    hostStatus: null,
    selectedHostID: LOCAL_HOST_ID,
    selectedProjectID: "project",
    selectedThreadID: threadID,
    browserOpen: true,
    pendingBrowserReveal: null,
    pendingSideChatRequest: null,
    openSideThreadID: "side-thread",
    summaryPopoverOpen: true,
  });
}

afterEach(() => {
  useAppStore.setState({
    workspace: null,
    remoteSessions: [],
    hostDisconnectNotice: null,
    selectedHostID: LOCAL_HOST_ID,
    selectedProjectID: null,
    selectedThreadID: null,
    renamingThread: null,
    browserOpen: false,
    pendingBrowserReveal: null,
    pendingSideChatRequest: null,
    openSideThreadID: null,
    summaryPopoverOpen: false,
    browserAnnotationsByThread: {},
    activeTurnByThread: {},
    queuedMessagesByThread: {},
    sendingMessageByThread: {},
    error: null,
    errorHostID: null,
    refresh: originalRefresh,
    refreshHostStatus: originalRefreshHostStatus,
    defaultRuntime: { provider: "codex", model: "Default", effort: null, speed: null },
    newThreadRuntime: { provider: "codex", model: "Default", effort: null, speed: null },
    newThreadSurface: "gui",
    newThreadEnvironment: "current",
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
      "project", "codex", "Default", "Continue in the terminal", null, null, "terminal", LOCAL_HOST_ID, false,
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

describe("side chats", () => {
  it("creates a provider-backed child and refreshes the workspace", async () => {
    const workspace = sampleWorkspace("/tmp/project");
    const child = {
      ...workspace.projects[0].threads[0],
      id: "side-chat",
      title: "Side chat",
      parentThreadID: "thread-a",
    };
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      workspace,
      remoteSessions: [],
      selectedHostID: LOCAL_HOST_ID,
      refresh,
    });
    const create = vi.spyOn(ipc, "createSideChat").mockResolvedValue(child);

    await expect(useAppStore.getState().createSideChat("project", "thread-a")).resolves.toEqual(child);
    expect(create).toHaveBeenCalledWith("project", "thread-a", LOCAL_HOST_ID);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("sends attached text selections through the ordinary provider queue", async () => {
    const workspace = sampleWorkspace("/tmp/project");
    useAppStore.setState({
      workspace,
      remoteSessions: [],
      selectedHostID: LOCAL_HOST_ID,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    const send = vi.spyOn(ipc, "sendPrompt").mockResolvedValue("side-turn");
    const selections = [{ id: "selection", text: "quoted parent text" }];

    await expect(useAppStore.getState().sendSideChatPrompt(
      "project", "side-chat", "Explain this", [], selections,
    )).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      "project", "side-chat", "Explain this", [], LOCAL_HOST_ID, [], [], selections,
    );
    expect(useAppStore.getState().activeTurnByThread["side-chat"]).toBe("side-turn");
  });

  it("opens the right panel when a primary selection requests a side chat", () => {
    useAppStore.setState({ selectedThreadID: "thread-a", browserOpen: false, pendingSideChatRequest: null });
    const request = {
      id: "request",
      parentThreadID: "thread-a",
      selection: { id: "selection", text: "quoted parent text" },
    };
    useAppStore.getState().requestSideChat(request);
    expect(useAppStore.getState()).toMatchObject({ browserOpen: true, pendingSideChatRequest: request });
  });
});

describe("worktree chat creation", () => {
  it("asks the owning remote host to create the worktree before the first turn", async () => {
    const local = sampleWorkspace("/tmp/local", "local-project");
    const remote = sampleWorkspace("/srv/repo", "remote-project");
    useAppStore.setState({
      workspace: local,
      remoteSessions: [{
        host: { id: "mini", name: "Mac mini", kind: "remote", address: "100.64.0.2:7422" },
        workspace: remote,
      }],
      selectedHostID: "mini",
      selectedProjectID: "remote-project",
      selectedThreadID: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    const thread = {
      ...remote.projects[0].threads[0],
      id: "worktree-thread",
      workingDirectory: "/data/Maxx/worktrees/worktree-thread/repo",
    };
    const add = vi.spyOn(ipc, "addThreadWithRuntime").mockResolvedValue(thread);
    const send = vi.spyOn(ipc, "sendPrompt").mockResolvedValue("turn-worktree");

    await expect(useAppStore.getState().createThreadAndSend(
      "remote-project",
      "codex",
      "Default",
      "Make an isolated change",
      [],
      null,
      null,
      "gui",
      "worktree",
    )).resolves.toBe(true);

    expect(add).toHaveBeenCalledWith(
      "remote-project", "codex", "Default", "Make an isolated change", null, null, "gui", "mini", true,
    );
    expect(send).toHaveBeenCalledWith(
      "remote-project", "worktree-thread", "Make an isolated change", [], "mini", [],
    );
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
  it("clears a stale listener error before enabling connections again", async () => {
    useAppStore.setState({
      error: "Port 7422 is already being used",
      refreshHostStatus: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(ipc, "hostListen").mockResolvedValue("100.64.0.2:7422");

    await useAppStore.getState().startHostListen();

    expect(useAppStore.getState().error).toBeNull();
  });

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

  it("routes a remote chat rename to its owning host", async () => {
    const local = sampleWorkspace("/tmp/local", "local-project");
    const remote = sampleWorkspace("/tmp/mini", "remote-project");
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      workspace: local,
      remoteSessions: [{
        host: { id: "mini", name: "Mac mini", kind: "remote", address: "100.64.0.2:7422" },
        workspace: remote,
      }],
      refresh,
    });
    const update = vi.spyOn(ipc, "updateThread").mockResolvedValue(undefined);

    await expect(useAppStore.getState().renameThread(
      "mini",
      "remote-project",
      "thread-a",
      "Renamed remotely",
    )).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith(
      "remote-project",
      "thread-a",
      { title: "Renamed remotely" },
      "mini",
    );
    expect(refresh).toHaveBeenCalledOnce();
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

  it("hydrates a remembered offline remote from its cached workspace after restart", async () => {
    const local = sampleWorkspace("/Users/scott/macbook", "local-project");
    const cachedRemote = sampleWorkspace("/Users/scott/mini", "remote-project");
    useAppStore.setState({ workspace: local, remoteSessions: [], hostStatus: null });
    vi.spyOn(ipc, "hostStatus").mockResolvedValue({
      id: "local-id",
      name: "This Mac",
      protocolVersion: 2,
      listening: false,
      bindAddress: null,
      shareAddress: null,
      pairing: null,
      remotes: [{
        id: "mini",
        name: "Mac mini",
        address: "100.64.0.2:7422",
        capabilities: ["workspace-read"],
        connected: false,
        lastEventCursor: 0,
        error: "Connection lost. Retrying…",
      }],
      pairedDevices: [],
    });
    vi.spyOn(ipc, "workspaceSnapshot").mockResolvedValue(cachedRemote);

    await useAppStore.getState().refreshHostStatus();

    expect(useAppStore.getState().remoteSessions).toEqual([{
      host: { id: "mini", name: "Mac mini", kind: "remote", address: "100.64.0.2:7422" },
      workspace: cachedRemote,
    }]);
  });

  it("clears stale offline UI when refreshed host status confirms reconnection", async () => {
    const cachedRemote = sampleWorkspace("/Users/scott/mini", "remote-project");
    useAppStore.setState({
      error: "Mac mini is offline. Its projects and chats remain available to read, but messages and changes require it to reconnect.",
      errorHostID: "mini",
      hostDisconnectNotice: { hostID: "mini", hostName: "Mac mini" },
      remoteSessions: [{
        host: { id: "mini", name: "Mac mini", kind: "remote", address: "100.64.0.2:7422" },
        workspace: cachedRemote,
      }],
    });
    vi.spyOn(ipc, "hostStatus").mockResolvedValue({
      id: "local-id",
      name: "This Mac",
      protocolVersion: 2,
      listening: false,
      bindAddress: null,
      shareAddress: null,
      pairing: null,
      remotes: [{
        id: "mini",
        name: "Mac mini",
        address: "100.64.0.2:7422",
        capabilities: ["workspace-read"],
        connected: true,
        lastEventCursor: 0,
        error: "",
      }],
      pairedDevices: [],
    });
    vi.spyOn(ipc, "workspaceSnapshot").mockResolvedValue(cachedRemote);

    await useAppStore.getState().refreshHostStatus();

    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().errorHostID).toBeNull();
    expect(useAppStore.getState().hostDisconnectNotice).toBeNull();
  });

  it("keeps the in-memory remote snapshot when an offline cache read fails", async () => {
    const remote = sampleWorkspace("/Users/scott/mini", "remote-project");
    useAppStore.setState({
      remoteSessions: [{
        host: { id: "mini", name: "Old name", kind: "remote", address: "old-address" },
        workspace: remote,
      }],
    });
    vi.spyOn(ipc, "hostStatus").mockResolvedValue({
      id: "local-id",
      name: "This Mac",
      protocolVersion: 2,
      listening: false,
      bindAddress: null,
      shareAddress: null,
      pairing: null,
      remotes: [{
        id: "mini",
        name: "Mac mini",
        address: "100.64.0.2:7422",
        capabilities: ["workspace-read"],
        connected: false,
        lastEventCursor: 0,
        error: "Connection lost. Retrying…",
      }],
      pairedDevices: [],
    });
    vi.spyOn(ipc, "workspaceSnapshot").mockRejectedValue(new Error("offline"));

    await useAppStore.getState().refreshHostStatus();

    expect(useAppStore.getState().remoteSessions).toEqual([{
      host: { id: "mini", name: "Mac mini", kind: "remote", address: "100.64.0.2:7422" },
      workspace: remote,
    }]);
  });

  it("removes a revoked device from Settings immediately", async () => {
    useAppStore.setState({
      hostStatus: {
        id: "mini-id",
        name: "Mac mini",
        protocolVersion: 2,
        listening: true,
        bindAddress: "100.64.0.2:7422",
        shareAddress: "100.64.0.2:7422",
        pairing: null,
        remotes: [],
        pairedDevices: [{
          id: "macbook-id",
          name: "MacBook Pro",
          capabilities: ["workspace-read"],
          createdAt: 1,
          lastSeenAt: 2,
        }],
      },
      refreshHostStatus: vi.fn().mockResolvedValue(undefined),
    });
    const revoke = vi.spyOn(ipc, "hostRevokePeer").mockResolvedValue(undefined);

    await useAppStore.getState().revokePairedDevice("macbook-id");

    expect(revoke).toHaveBeenCalledWith("macbook-id");
    expect(useAppStore.getState().hostStatus?.pairedDevices).toEqual([]);
  });

  it("keeps a remote session and its selection when its socket closes", () => {
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

    expect(useAppStore.getState().remoteSessions[0]?.host.id).toBe("mini");
    expect(useAppStore.getState().selectedHostID).toBe("mini");
    expect(useAppStore.getState().selectedProjectID).toBe("remote-project");
    expect(useAppStore.getState().selectedThreadID).toBe("thread-a");
    expect(useAppStore.getState().workspace).toBe(local);
    expect(useAppStore.getState().hostDisconnectNotice).toEqual({
      hostID: "mini",
      hostName: "Mac mini",
    });
  });

  it("shows a named offline message and clears it when that host reconnects", async () => {
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
    vi.spyOn(ipc, "sendPrompt").mockRejectedValue(
      new Error("Error invoking remote method 'maxx:invoke': Error: Environment mini is offline"),
    );

    await expect(useAppStore.getState().sendPrompt("Hi", [])).resolves.toBe(false);

    expect(useAppStore.getState().error).toBe(
      "Mac mini is offline. Its projects and chats remain available to read, but messages and changes require it to reconnect.",
    );
    expect(useAppStore.getState().errorHostID).toBe("mini");

    useAppStore.getState().clearHostConnectionError("other-host");
    expect(useAppStore.getState().error).not.toBeNull();
    useAppStore.getState().clearHostConnectionError("mini");
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().errorHostID).toBeNull();
  });

  it("removes a remote session when the host revokes this device", () => {
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
      hostDisconnectNotice: { hostID: "mini", hostName: "Mac mini" },
    });

    useAppStore.getState().markHostRevoked("mini");

    expect(useAppStore.getState().remoteSessions).toEqual([]);
    expect(useAppStore.getState().selectedHostID).toBe(LOCAL_HOST_ID);
    expect(useAppStore.getState().selectedProjectID).toBeNull();
    expect(useAppStore.getState().selectedThreadID).toBeNull();
    expect(useAppStore.getState().hostDisconnectNotice).toBeNull();
  });

  it("clears the disconnect notice when the remote reconnects", () => {
    useAppStore.setState({
      hostDisconnectNotice: { hostID: "mini", hostName: "Mac mini" },
    });

    useAppStore.getState().clearHostDisconnectNotice("mini");

    expect(useAppStore.getState().hostDisconnectNotice).toBeNull();
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

describe("optional project chats", () => {
  it("starts without a project when explicitly requested from the top-level button", () => {
    useAppStore.setState({
      workspace: sampleWorkspace("/tmp/project"),
      selectedHostID: "mini",
      selectedProjectID: "project",
      selectedThreadID: "thread-a",
    });

    useAppStore.getState().startNewThread(null);

    expect(useAppStore.getState()).toMatchObject({
      selectedHostID: LOCAL_HOST_ID,
      selectedProjectID: null,
      selectedThreadID: null,
    });
  });

  it("keeps the current project for contextual command-n creation", () => {
    useAppStore.setState({
      workspace: sampleWorkspace("/tmp/project"),
      selectedHostID: LOCAL_HOST_ID,
      selectedProjectID: "project",
      selectedThreadID: "thread-a",
    });

    useAppStore.getState().startNewThread();

    expect(useAppStore.getState()).toMatchObject({
      selectedHostID: LOCAL_HOST_ID,
      selectedProjectID: "project",
      selectedThreadID: null,
    });
  });

  it("creates and sends a projectless chat through the Chats owner", async () => {
    const thread = {
      ...sampleWorkspace("/tmp/project").projects[0].threads[0],
      id: "chat-without-project",
    };
    useAppStore.setState({
      workspace: sampleWorkspace("/tmp/project"),
      selectedHostID: LOCAL_HOST_ID,
      selectedProjectID: null,
      selectedThreadID: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    const add = vi.spyOn(ipc, "addChat").mockResolvedValue(thread);
    const send = vi.spyOn(ipc, "sendPrompt").mockResolvedValue("turn-projectless");

    await expect(useAppStore.getState().createThreadAndSend(
      null,
      "codex",
      "Default",
      "A chat without a project",
      [],
    )).resolves.toBe(true);

    expect(add).toHaveBeenCalledWith(
      "codex", "Default", "A chat without a project", null, null,
    );
    expect(send).toHaveBeenCalledWith(
      CHATS_PROJECT_ID,
      "chat-without-project",
      "A chat without a project",
      [],
      LOCAL_HOST_ID,
      [],
    );
    expect(useAppStore.getState()).toMatchObject({
      selectedProjectID: CHATS_PROJECT_ID,
      selectedThreadID: "chat-without-project",
      activeTurnByThread: { "chat-without-project": "turn-projectless" },
    });
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
    expect(send).toHaveBeenCalledWith("project", "thread-a", "", [], LOCAL_HOST_ID, [], [selected], []);
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
      "local-project", "thread-a", "change this", [], LOCAL_HOST_ID, [], [selected], [],
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

describe("message queue", () => {
  function seedBusyThread() {
    useAppStore.setState({
      workspace: sampleWorkspace("/tmp/project"),
      remoteSessions: [],
      selectedHostID: LOCAL_HOST_ID,
      selectedProjectID: "project",
      selectedThreadID: "thread-a",
      activeTurnByThread: { "thread-a": "turn-active" },
      queuedMessagesByThread: {},
      sendingMessageByThread: {},
      refresh: vi.fn().mockResolvedValue(undefined),
    });
  }

  it("sends queued messages FIFO one turn at a time", async () => {
    seedBusyThread();
    const send = vi.spyOn(ipc, "sendPrompt")
      .mockResolvedValueOnce("turn-first")
      .mockResolvedValueOnce("turn-second")
      .mockResolvedValueOnce("turn-third");

    await expect(useAppStore.getState().sendPrompt("first queued", [])).resolves.toBe(true);
    await expect(useAppStore.getState().sendPrompt("second queued", [])).resolves.toBe(true);
    await expect(useAppStore.getState().sendPrompt("third queued", [])).resolves.toBe(true);

    expect(send).not.toHaveBeenCalled();
    expect(useAppStore.getState().queuedMessagesByThread["thread-a"].map((message) => message.prompt))
      .toEqual(["first queued", "second queued", "third queued"]);

    useAppStore.getState().applyTurnFinished({
      projectID: "project",
      threadID: "thread-a",
      turnID: "turn-active",
      terminalState: "completed",
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[2]).toBe("first queued");
    expect(useAppStore.getState().activeTurnByThread["thread-a"]).toBe("turn-first");
    expect(useAppStore.getState().queuedMessagesByThread["thread-a"].map((message) => message.prompt))
      .toEqual(["second queued", "third queued"]);

    useAppStore.getState().applyTurnFinished({
      projectID: "project",
      threadID: "thread-a",
      turnID: "turn-first",
      terminalState: "completed",
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]?.[2]).toBe("second queued");
    expect(useAppStore.getState().queuedMessagesByThread["thread-a"].map((message) => message.prompt))
      .toEqual(["third queued"]);

    useAppStore.getState().applyTurnFinished({
      projectID: "project",
      threadID: "thread-a",
      turnID: "turn-second",
      terminalState: "completed",
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]?.[2]).toBe("third queued");
    expect(useAppStore.getState().queuedMessagesByThread["thread-a"]).toBeUndefined();
  });

  it("accepts more queued input while the first send is still being admitted", async () => {
    const workspace = sampleWorkspace("/tmp/project");
    useAppStore.setState({
      workspace,
      remoteSessions: [],
      selectedHostID: LOCAL_HOST_ID,
      selectedProjectID: "project",
      selectedThreadID: "thread-a",
      activeTurnByThread: {},
      queuedMessagesByThread: {},
      sendingMessageByThread: {},
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    let admitFirst!: (turnID: string) => void;
    const firstAdmission = new Promise<string>((resolve) => { admitFirst = resolve; });
    const send = vi.spyOn(ipc, "sendPrompt").mockReturnValueOnce(firstAdmission);

    const first = useAppStore.getState().sendPrompt("first", []);
    await expect(useAppStore.getState().sendPrompt("second", [])).resolves.toBe(true);
    await expect(useAppStore.getState().sendPrompt("third", [])).resolves.toBe(true);
    expect(useAppStore.getState().queuedMessagesByThread["thread-a"].map((message) => message.prompt))
      .toEqual(["second", "third"]);

    admitFirst("turn-first");
    await expect(first).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().activeTurnByThread["thread-a"]).toBe("turn-first");
  });

  it("steers a supported active turn without disturbing the rest of the queue", async () => {
    seedBusyThread();
    vi.spyOn(ipc, "sendPrompt");
    const steer = vi.spyOn(ipc, "steerPrompt").mockResolvedValue(undefined);

    await useAppStore.getState().sendPrompt("stay FIFO", []);
    await useAppStore.getState().sendPrompt("steer this now", []);
    const queued = useAppStore.getState().queuedMessagesByThread["thread-a"];

    await expect(useAppStore.getState().steerQueuedMessage("thread-a", queued[1].id))
      .resolves.toBe(true);
    expect(steer).toHaveBeenCalledWith(
      "project", "thread-a", "turn-active", "steer this now", [], LOCAL_HOST_ID, [], [],
    );
    expect(useAppStore.getState().activeTurnByThread["thread-a"]).toBe("turn-active");
    expect(useAppStore.getState().queuedMessagesByThread["thread-a"].map((message) => message.prompt))
      .toEqual(["stay FIFO"]);
  });

  it("keeps a failed queued dispatch available for retry", async () => {
    seedBusyThread();
    const send = vi.spyOn(ipc, "sendPrompt")
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("turn-retry");
    await useAppStore.getState().sendPrompt("retry me", []);

    useAppStore.getState().applyTurnFinished({
      projectID: "project",
      threadID: "thread-a",
      turnID: "turn-active",
      terminalState: "completed",
    });
    await vi.waitFor(() => expect(useAppStore.getState().error).toContain("temporary failure"));
    const message = useAppStore.getState().queuedMessagesByThread["thread-a"][0];

    await expect(useAppStore.getState().retryQueuedMessage("thread-a", message.id)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().queuedMessagesByThread["thread-a"]).toBeUndefined();
    expect(useAppStore.getState().activeTurnByThread["thread-a"]).toBe("turn-retry");
  });
});
