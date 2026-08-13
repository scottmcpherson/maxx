// Port of the view-facing responsibilities of `AppStore.swift`: workspace
// snapshot, selection, live turn state, and mutations via the Rust backend.

import { create } from "zustand";
import {
  loadDefaultRuntime,
  normalizeDefaultRuntime,
  persistDefaultRuntime,
  reconcileDefaultRuntime,
} from "../defaultRuntime";
import { ipc } from "../ipc";
import { loadAttentionFilterOpen, persistAttentionFilterOpen } from "./attentionFilter";
import { loadSummaryPinned, persistSummaryPinned } from "../summary";
import type { UpdateStatus } from "../updates";
import type { VoiceSettings } from "../voice/types";
import {
  loadShowProviderDiagnostics,
  persistShowProviderDiagnostics,
} from "../providerDiagnostics";
import {
  loadTerminalModeEnabled,
  persistTerminalModeEnabled,
} from "../terminalModePreference";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  loadKeyboardShortcuts,
  persistKeyboardShortcuts,
} from "../keyboardShortcuts";
import type {
  KeyboardShortcutBinding,
  KeyboardShortcutBindings,
  KeyboardShortcutCommand,
} from "../keyboardShortcuts";
import {
  AgentDefinition,
  ChatProvider,
  ChatSurface,
  ChatThread,
  ProviderProfile,
  RuntimeEventEnvelope,
  RuntimeInteractionDecision,
  ThreadTitleUpdatedEnvelope,
  TitleGenerationRuntime,
  TurnFinishedEnvelope,
  WorkspaceDocument,
} from "../contract/types";
import {
  clearFinishedTurn,
  hydrateActiveTurns,
  reduceRuntimeEvent,
  setActiveTurn,
} from "./threadActivity";
import {
  clearThreadUnseen,
  loadUnseenThreadIDs,
  markThreadUnseen,
  persistUnseenThreadIDs,
  pruneUnseenThreads,
  unseenTargetForFinishedTurn,
} from "./unseenThreads";
import type { UnseenThreadMap } from "./unseenThreads";
import type { RuntimeSelection } from "../runtime/modelCatalog";
import type { BrowserUiReveal } from "../browser";
import type { BrowserAnnotation } from "../browser";
import { annotationKey, MAX_BROWSER_ANNOTATIONS } from "../browserAnnotations";
import type { HostStatus } from "../host/types";
import type { RemoteSession } from "../host/session";
import {
  attachRemote,
  detachRemote,
  emptyCatalog,
  findHostedProject,
  isLocalHost,
  LOCAL_HOST_ID,
  mergedWorkspace,
  replaceWorkspace,
  routeHostId,
} from "../host/session";
import { uploadImagesForHost } from "../host/mediaUpload";

let listenersStarted = false;
const initialDefaultRuntime = loadDefaultRuntime();

interface AppStoreState {
  workspace: WorkspaceDocument | null;
  selectedHostID: string;
  remoteSessions: RemoteSession[];
  hostStatus: HostStatus | null;
  selectedProjectID: string | null;
  selectedThreadID: string | null;
  activeTurnByThread: Record<string, string>;
  /** Threads that finished a turn while the user was not viewing them. */
  unseenThreadIDs: UnseenThreadMap;
  settingsOpen: boolean;
  agentsOpen: boolean;
  /** Side thread shown in the reply panel next to the main thread. */
  openSideThreadID: string | null;
  searchOpen: boolean;
  renamingThread: { projectID: string; threadID: string } | null;
  sidebarOpen: boolean;
  /** Bell-toggled filter that keeps only chats needing attention in the projects tree. */
  attentionFilterOpen: boolean;
  /**
   * The user's pin for the thread summary rail. Independent of whether the
   * window is currently wide enough to seat it (see `src/summary.ts`).
   */
  summaryPinned: boolean;
  /** Summary shown as a popover because the rail has nowhere to sit. */
  summaryPopoverOpen: boolean;
  /** Browser pane visibility for the selected thread. */
  browserOpen: boolean;
  pendingBrowserReveal: BrowserUiReveal | null;
  /** Draft DOM selections collected from the browser, scoped to each chat composer. */
  browserAnnotationsByThread: Record<string, BrowserAnnotation[]>;
  /** Latest result of an update check; `null` once dismissed. */
  updateStatus: UpdateStatus | null;
  /** Persisted runtime used to seed each new-chat composer. */
  defaultRuntime: RuntimeSelection;
  /** Ephemeral runtime for the currently open new-chat composer. */
  newThreadRuntime: RuntimeSelection;
  /** Surface selected for the next chat. Reset after leaving the composer. */
  newThreadSurface: ChatSurface;
  keyboardShortcuts: KeyboardShortcutBindings;
  /** Non-fatal notices emitted by provider runtimes, hidden from chat by default. */
  showProviderDiagnostics: boolean;
  /** Experimental access to native provider terminal surfaces. */
  terminalModeEnabled: boolean;
  error: string | null;

  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshHost: (hostID: string) => Promise<void>;
  selectThread: (projectID: string, threadID: string, hostID?: string) => void;
  addProject: (folderPath: string, hostID?: string) => Promise<void>;
  removeProject: (projectID: string, hostID?: string) => Promise<void>;
  startNewThread: (projectID?: string, hostID?: string) => void;
  connectHost: (address: string, code: string) => Promise<void>;
  disconnectHost: (hostID: string) => Promise<void>;
  markHostDisconnected: (hostID: string) => void;
  startHostListen: (bindAddress?: string) => Promise<void>;
  stopHostListen: () => Promise<void>;
  refreshHostStatus: () => Promise<void>;
  addThread: (
    projectID: string,
    provider: ChatProvider,
    model: string,
    title?: string,
    effort?: string | null,
    speed?: string | null,
    surface?: ChatSurface,
  ) => Promise<ChatThread | null>;
  removeThread: (projectID: string, threadID: string) => Promise<void>;
  renameThread: (projectID: string, threadID: string, title: string) => Promise<boolean>;
  updateThreadRuntime: (
    projectID: string,
    threadID: string,
    provider: ChatProvider,
    model: string,
    effort?: string | null,
    speed?: string | null,
  ) => Promise<void>;
  createThreadAndSend: (
    projectID: string,
    provider: ChatProvider,
    model: string,
    prompt: string,
    imagePaths: string[],
    effort?: string | null,
    speed?: string | null,
    surface?: ChatSurface,
  ) => Promise<boolean>;
  sendPrompt: (prompt: string, imagePaths: string[], annotations?: BrowserAnnotation[]) => Promise<boolean>;
  cancelActiveTurn: (threadID: string) => Promise<void>;
  resolveRequest: (
    projectID: string,
    threadID: string,
    requestID: string,
    decision: RuntimeInteractionDecision,
  ) => Promise<void>;
  saveProfiles: (profiles: ProviderProfile[]) => Promise<void>;
  saveTitleGenerationRuntime: (runtime: TitleGenerationRuntime | null) => Promise<void>;
  saveAgents: (agents: AgentDefinition[]) => Promise<void>;
  saveVoiceSettings: (settings: VoiceSettings) => Promise<void>;
  startSideThread: (
    projectID: string,
    parentThreadID: string,
    agentIDs: string[],
    prompt: string,
    imagePaths: string[],
    annotations?: BrowserAnnotation[],
  ) => Promise<boolean>;
  sendAgentPrompt: (
    projectID: string,
    threadID: string,
    agentIDs: string[],
    prompt: string,
    imagePaths: string[],
  ) => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  setAgentsOpen: (open: boolean) => void;
  setOpenSideThreadID: (threadID: string | null) => void;
  setSearchOpen: (open: boolean) => void;
  setRenamingThread: (target: { projectID: string; threadID: string } | null) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setAttentionFilterOpen: (open: boolean) => void;
  toggleAttentionFilter: () => void;
  setSummaryPinned: (pinned: boolean) => void;
  toggleSummaryPinned: () => void;
  setSummaryPopoverOpen: (open: boolean) => void;
  setBrowserOpen: (open: boolean) => void;
  toggleBrowser: () => void;
  revealBrowserTab: (reveal: BrowserUiReveal) => void;
  consumeBrowserReveal: (tabID: string) => void;
  applyBrowserAnnotation: (threadID: string, annotation: BrowserAnnotation, selected: boolean) => void;
  replaceBrowserAnnotations: (threadID: string, annotations: BrowserAnnotation[]) => void;
  removeBrowserAnnotation: (threadID: string, annotationID: string) => void;
  clearBrowserAnnotations: (threadID: string) => void;
  setUpdateStatus: (status: UpdateStatus | null) => void;
  checkForUpdates: () => Promise<void>;
  setDefaultRuntime: (selection: RuntimeSelection) => void;
  setNewThreadRuntime: (selection: RuntimeSelection) => void;
  setNewThreadSurface: (surface: ChatSurface) => void;
  setKeyboardShortcut: (command: KeyboardShortcutCommand, binding: KeyboardShortcutBinding) => void;
  resetKeyboardShortcut: (command: KeyboardShortcutCommand) => void;
  setShowProviderDiagnostics: (visible: boolean) => void;
  setTerminalModeEnabled: (enabled: boolean) => void;
  applyRuntimeEvent: (envelope: RuntimeEventEnvelope, hostID?: string) => void;
  applyThreadTitleUpdated: (envelope: ThreadTitleUpdatedEnvelope, hostID?: string) => void;
  applyTurnFinished: (envelope: TurnFinishedEnvelope, hostID?: string) => void;
}

/** Persist the unseen map only when the instance actually changed. */
function persistIfChanged(previous: UnseenThreadMap, next: UnseenThreadMap): UnseenThreadMap {
  if (next !== previous) persistUnseenThreadIDs(next);
  return next;
}

/** Successful inventory fetch replaces activity; fetch failure leaves state alone. */
async function loadActiveTurns(hostID?: string | null): Promise<Record<string, string> | null> {
  try {
    const inventory = await ipc.activeTurns(hostID);
    return hydrateActiveTurns(inventory);
  } catch {
    return null;
  }
}

async function loadAllActiveTurns(
  remotes: RemoteSession[],
): Promise<Record<string, string> | null> {
  const local = await loadActiveTurns();
  if (remotes.length === 0) return local;
  const remoteMaps = await Promise.all(remotes.map((session) => loadActiveTurns(session.host.id)));
  const merged: Record<string, string> = { ...(local ?? {}) };
  for (const map of remoteMaps) {
    if (map) Object.assign(merged, map);
  }
  return Object.keys(merged).length > 0 || local !== null ? merged : null;
}

function catalogFromState(state: {
  workspace: WorkspaceDocument | null;
  remoteSessions: RemoteSession[];
  hostStatus: HostStatus | null;
}) {
  const local = state.workspace ?? {
    schemaVersion: 7,
    projects: [],
    providerProfiles: [],
    agents: [],
    voice: {
      isEnabled: false,
      useGrokSignIn: false,
      language: "en",
      apiBase: "https://api.x.ai",
    },
  };
  let catalog = emptyCatalog(local, state.hostStatus?.name ?? "This Mac");
  for (const session of state.remoteSessions) {
    catalog = attachRemote(catalog, session.host, session.workspace);
  }
  return catalog;
}

function hostForProject(
  remotes: RemoteSession[],
  workspace: WorkspaceDocument | null,
  projectID: string,
  fallback: string,
): string {
  if (workspace?.projects.some((project) => project.id === projectID)) return LOCAL_HOST_ID;
  const remote = remotes.find((session) =>
    session.workspace.projects.some((project) => project.id === projectID),
  );
  return remote?.host.id ?? fallback;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  workspace: null,
  selectedHostID: LOCAL_HOST_ID,
  remoteSessions: [],
  hostStatus: null,
  selectedProjectID: null,
  selectedThreadID: null,
  activeTurnByThread: {},
  unseenThreadIDs: loadUnseenThreadIDs(),
  settingsOpen: false,
  agentsOpen: false,
  openSideThreadID: null,
  searchOpen: false,
  renamingThread: null,
  sidebarOpen: true,
  attentionFilterOpen: loadAttentionFilterOpen(),
  summaryPinned: loadSummaryPinned(),
  summaryPopoverOpen: false,
  browserOpen: false,
  pendingBrowserReveal: null,
  browserAnnotationsByThread: {},
  updateStatus: null,
  defaultRuntime: { ...initialDefaultRuntime },
  newThreadRuntime: { ...initialDefaultRuntime },
  newThreadSurface: "gui",
  keyboardShortcuts: loadKeyboardShortcuts(),
  showProviderDiagnostics: loadShowProviderDiagnostics(),
  terminalModeEnabled: loadTerminalModeEnabled(),
  error: null,

  bootstrap: async () => {
    await get().refreshHostStatus();
    await get().refresh();
    if (!listenersStarted) {
      listenersStarted = true;
      try {
        await ipc.onRuntimeEvent((envelope) => get().applyRuntimeEvent(envelope));
        await ipc.onTurnFinished((envelope) => get().applyTurnFinished(envelope));
        await ipc.onThreadTitleUpdated((envelope) => get().applyThreadTitleUpdated(envelope));
        await ipc.onUpdateStatus((status) => get().setUpdateStatus(status));
        await ipc.onBrowserReveal((event) => get().revealBrowserTab(event));
        await ipc.onHostEvent((message) => {
          if (message.event === "runtime://event") {
            get().applyRuntimeEvent(message.payload as RuntimeEventEnvelope, message.hostId);
          } else if (message.event === "turn://finished") {
            get().applyTurnFinished(message.payload as TurnFinishedEnvelope, message.hostId);
          } else if (message.event === "thread://title-updated") {
            get().applyThreadTitleUpdated(message.payload as ThreadTitleUpdatedEnvelope, message.hostId);
          } else if (message.event === "host://disconnected") {
            get().markHostDisconnected(message.hostId);
            void get().refreshHostStatus();
          } else if (message.event === "host://connected" || message.event === "host://status-changed") {
            void get().refreshHostStatus();
          }
        });
      } catch (error) {
        listenersStarted = false;
        set({ error: String(error) });
      }
    }
    const workspace = get().workspace;
    const firstProject = workspace?.projects[0];
    if (firstProject && !get().selectedProjectID) {
      const threadID = firstProject.threads[0]?.id ?? null;
      set((state) => ({
        selectedProjectID: firstProject.id,
        selectedThreadID: threadID,
        // Auto-selecting a thread puts it on screen, so it is seen.
        unseenThreadIDs: threadID
          ? persistIfChanged(
              state.unseenThreadIDs,
              clearThreadUnseen(state.unseenThreadIDs, threadID),
            )
          : state.unseenThreadIDs,
      }));
    }
  },

  refresh: async () => {
    try {
      const workspace = await ipc.workspaceSnapshot();
      const remotes = await Promise.all(
        get().remoteSessions.map(async (session) => {
          try {
            return {
              host: session.host,
              workspace: await ipc.workspaceSnapshot(session.host.id),
            };
          } catch {
            return session;
          }
        }),
      );
      const activeTurnByThread = await loadAllActiveTurns(remotes);
      set((state) => ({
        workspace,
        remoteSessions: remotes,
        ...(activeTurnByThread !== null ? { activeTurnByThread } : {}),
        unseenThreadIDs: persistIfChanged(
          state.unseenThreadIDs,
          pruneUnseenThreads(
            state.unseenThreadIDs,
            mergedWorkspace(catalogFromState({ workspace, remoteSessions: remotes, hostStatus: state.hostStatus })),
          ),
        ),
        error: null,
      }));
      // Profiles may disable the stored default (toggle, import, older builds).
      // Reconcile after each workspace load so Settings and new chats stay valid.
      const current = get().defaultRuntime;
      const reconciled = reconcileDefaultRuntime(current, workspace.providerProfiles);
      if (reconciled !== current) {
        get().setDefaultRuntime(reconciled);
      }
    } catch (error) {
      set({ error: String(error) });
    }
  },

  refreshHost: async (hostID) => {
    if (isLocalHost(hostID)) {
      await get().refresh();
      return;
    }
    try {
      const workspace = await ipc.workspaceSnapshot(hostID);
      set((state) => ({
        remoteSessions: state.remoteSessions.map((session) =>
          session.host.id === hostID ? { ...session, workspace } : session,
        ),
        error: null,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  refreshHostStatus: async () => {
    try {
      const hostStatus = await ipc.hostStatus();
      const sessions = await Promise.all(
        hostStatus.remotes.filter((host) => host.connected).map(async (host) => {
          try {
            return {
              host: { id: host.id, name: host.name, kind: "remote" as const, address: host.address },
              workspace: await ipc.workspaceSnapshot(host.id),
            };
          } catch {
            return null;
          }
        }),
      );
      set((state) => {
        let catalog = emptyCatalog(
          state.workspace ?? catalogFromState(state).local,
          hostStatus.name,
        );
        for (const session of sessions) {
          if (session) catalog = attachRemote(catalog, session.host, session.workspace);
        }
        return { hostStatus, remoteSessions: catalog.remotes };
      });
    } catch {
      // Older runtimes without host commands still boot a local workspace.
    }
  },

  connectHost: async (address, code) => {
    try {
      const host = await ipc.hostConnect(address, code);
      const workspace = await ipc.workspaceSnapshot(host.id);
      set((state) => ({
        remoteSessions: attachRemote(
          catalogFromState(state),
          { ...host, kind: "remote" },
          workspace,
        ).remotes,
        error: null,
      }));
      await get().refreshHostStatus();
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  disconnectHost: async (hostID) => {
    const localBefore = get().workspace;
    try {
      await ipc.hostDisconnect(hostID);
    } catch (error) {
      set({ error: String(error) });
      return;
    }
    set((state) => ({
      remoteSessions: detachRemote(catalogFromState(state), hostID).remotes,
      selectedHostID: state.selectedHostID === hostID ? LOCAL_HOST_ID : state.selectedHostID,
      selectedProjectID: state.selectedHostID === hostID ? null : state.selectedProjectID,
      selectedThreadID: state.selectedHostID === hostID ? null : state.selectedThreadID,
      workspace: localBefore,
    }));
    await get().refreshHostStatus();
  },

  markHostDisconnected: (hostID) => set((state) => ({
    remoteSessions: detachRemote(catalogFromState(state), hostID).remotes,
    selectedHostID: state.selectedHostID === hostID ? LOCAL_HOST_ID : state.selectedHostID,
    selectedProjectID: state.selectedHostID === hostID ? null : state.selectedProjectID,
    selectedThreadID: state.selectedHostID === hostID ? null : state.selectedThreadID,
  })),

  startHostListen: async (bindAddress) => {
    try {
      await ipc.hostListen(bindAddress);
      await get().refreshHostStatus();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  stopHostListen: async () => {
    try {
      await ipc.hostUnlisten();
      await get().refreshHostStatus();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  selectThread: (projectID, threadID, hostID) =>
    set((state) => ({
      selectedHostID: routeHostId(
        hostID ?? hostForProject(state.remoteSessions, state.workspace, projectID, state.selectedHostID),
      ),
      selectedProjectID: projectID,
      selectedThreadID: threadID,
      settingsOpen: false,
      agentsOpen: false,
      renamingThread: null,
      openSideThreadID: null,
      browserOpen: state.selectedThreadID === threadID ? state.browserOpen : false,
      pendingBrowserReveal: state.selectedThreadID === threadID
        ? state.pendingBrowserReveal
        : null,
      summaryPopoverOpen: state.selectedThreadID === threadID
        ? state.summaryPopoverOpen
        : false,
      unseenThreadIDs: persistIfChanged(
        state.unseenThreadIDs,
        clearThreadUnseen(state.unseenThreadIDs, threadID),
      ),
    })),

  startNewThread: (projectID, hostID) => {
    const state = get();
    const resolvedHostID = routeHostId(
      hostID ?? (projectID
        ? hostForProject(state.remoteSessions, state.workspace, projectID, state.selectedHostID)
        : state.selectedHostID),
    );
    const catalog = catalogFromState(state);
    const resolvedProjectID =
      projectID
      ?? (resolvedHostID === LOCAL_HOST_ID ? state.selectedProjectID : null)
      ?? findHostedProject(catalog, resolvedHostID, state.selectedProjectID ?? "")?.id
      ?? state.workspace?.projects[0]?.id
      ?? null;
    set({
      selectedHostID: resolvedHostID,
      selectedProjectID: resolvedProjectID,
      selectedThreadID: null,
      newThreadRuntime: { ...get().defaultRuntime },
      newThreadSurface: "gui",
      settingsOpen: false,
      agentsOpen: false,
      renamingThread: null,
      openSideThreadID: null,
      browserOpen: false,
      summaryPopoverOpen: false,
    });
  },

  addProject: async (folderPath, hostID) => {
    try {
      const targetHost = routeHostId(hostID ?? get().selectedHostID);
      const project = await ipc.addProject(folderPath, targetHost);
      await get().refresh();
      set({
        selectedHostID: targetHost,
        selectedProjectID: project.id,
        selectedThreadID: null,
        newThreadRuntime: { ...get().defaultRuntime },
        newThreadSurface: "gui",
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  removeProject: async (projectID, hostID) => {
    const targetHost = routeHostId(
      hostID ?? hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID),
    );
    await ipc.removeProject(projectID, targetHost);
    await get().refresh();
    if (get().selectedProjectID === projectID) {
      set({
        selectedProjectID: null,
        selectedThreadID: null,
        newThreadRuntime: { ...get().defaultRuntime },
        newThreadSurface: "gui",
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
      });
    }
  },

  addThread: async (
    projectID,
    provider,
    model,
    title = "New thread",
    effort = null,
    speed = null,
    surface = "gui",
  ) => {
    try {
      const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
      const thread =
        effort || speed || surface === "terminal"
          ? await ipc.addThreadWithRuntime(
              projectID,
              provider,
              model,
              title,
              effort,
              speed,
              surface,
              hostID,
            )
          : await ipc.addThread(projectID, provider, model, title, hostID);
      await get().refresh();
      set({
        selectedHostID: hostID,
        selectedProjectID: projectID,
        selectedThreadID: thread.id,
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
        newThreadSurface: "gui",
      });
      return thread;
    } catch (error) {
      set({ error: String(error) });
      return null;
    }
  },

  removeThread: async (projectID, threadID) => {
    const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
    await ipc.removeThread(projectID, threadID, hostID);
    await get().refresh();
    if (get().selectedThreadID === threadID) {
      set({
        selectedThreadID: null,
        newThreadRuntime: { ...get().defaultRuntime },
        newThreadSurface: "gui",
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
      });
    }
  },

  renameThread: async (projectID, threadID, title) => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return false;
    try {
      const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
      await ipc.updateThread(projectID, threadID, { title: trimmedTitle }, hostID);
      await get().refresh();
      return true;
    } catch (error) {
      set({ error: String(error) });
      return false;
    }
  },

  updateThreadRuntime: async (projectID, threadID, provider, model, effort = null, speed = null) => {
    try {
      const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
      await ipc.updateThread(projectID, threadID, {
        provider,
        model,
        effort: effort ?? "",
        speed: speed ?? "",
        updateRuntimeKnobs: true,
      }, hostID);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  createThreadAndSend: async (
    projectID,
    provider,
    model,
    prompt,
    imagePaths,
    effort = null,
    speed = null,
    surface = "gui",
  ) => {
    if (!prompt.trim() && (surface === "terminal" || imagePaths.length === 0)) return false;
    const title = prompt.trim().split("\n")[0].slice(0, 64) || "Image attachment";
    const thread = await get().addThread(projectID, provider, model, title, effort, speed, surface);
    if (!thread) return false;
    try {
      const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
      const prepared = await uploadImagesForHost(hostID, surface === "terminal" ? [] : imagePaths);
      const turnID = await ipc.sendPrompt(
        projectID,
        thread.id,
        prompt.trim(),
        prepared.imagePaths,
        hostID,
        prepared.attachmentIds,
      );
      set((state) => ({
        activeTurnByThread: setActiveTurn(state.activeTurnByThread, thread.id, turnID),
      }));
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
      return false;
    }
    return true;
  },

  sendPrompt: async (prompt, imagePaths, annotations = []) => {
    const { selectedProjectID, selectedThreadID, selectedHostID, remoteSessions, workspace } = get();
    if (!selectedProjectID || !selectedThreadID || (!prompt.trim() && imagePaths.length === 0 && annotations.length === 0)) return false;
    try {
      const hostID = hostForProject(remoteSessions, workspace, selectedProjectID, selectedHostID);
      const prepared = await uploadImagesForHost(hostID, imagePaths);
      const turnID = await ipc.sendPrompt(
        selectedProjectID,
        selectedThreadID,
        prompt,
        prepared.imagePaths,
        hostID,
        prepared.attachmentIds,
        annotations,
      );
      set((state) => ({
        activeTurnByThread: setActiveTurn(state.activeTurnByThread, selectedThreadID, turnID),
      }));
      await get().refresh();
      return true;
    } catch (error) {
      set({ error: String(error) });
      return false;
    }
  },

  cancelActiveTurn: async (threadID) => {
    const turnID = get().activeTurnByThread[threadID];
    if (!turnID) return;
    const { selectedProjectID, selectedHostID, remoteSessions, workspace } = get();
    const hostID = selectedProjectID
      ? hostForProject(remoteSessions, workspace, selectedProjectID, selectedHostID)
      : selectedHostID;
    await ipc.cancelTurn(turnID, hostID);
  },

  resolveRequest: async (projectID, threadID, requestID, decision) => {
    try {
      const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
      await ipc.resolveRequest(projectID, threadID, requestID, decision, hostID);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  saveProfiles: async (profiles) => {
    try {
      await ipc.updateProfiles(profiles);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  saveTitleGenerationRuntime: async (runtime) => {
    try {
      await ipc.updateTitleGenerationRuntime(runtime);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  saveAgents: async (agents) => {
    try {
      await ipc.updateAgents(agents);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  saveVoiceSettings: async (settings) => {
    try {
      await ipc.updateVoiceSettings(settings);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  startSideThread: async (projectID, parentThreadID, agentIDs, prompt, imagePaths, annotations = []) => {
    if ((!prompt.trim() && imagePaths.length === 0 && annotations.length === 0) || agentIDs.length === 0) return false;
    try {
      const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
      const prepared = await uploadImagesForHost(hostID, imagePaths);
      const thread = await ipc.startSideThread(
        projectID,
        parentThreadID,
        agentIDs,
        prompt.trim(),
        prepared.imagePaths,
        hostID,
        prepared.attachmentIds,
        annotations,
      );
      set((state) => ({
        openSideThreadID: thread.id,
        activeTurnByThread: thread.lastTurnID
          ? setActiveTurn(state.activeTurnByThread, thread.id, thread.lastTurnID)
          : state.activeTurnByThread,
      }));
      await get().refresh();
      return true;
    } catch (error) {
      set({ error: String(error) });
      return false;
    }
  },

  sendAgentPrompt: async (projectID, threadID, agentIDs, prompt, imagePaths) => {
    if ((!prompt.trim() && imagePaths.length === 0) || agentIDs.length === 0) return;
    try {
      const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
      const prepared = await uploadImagesForHost(hostID, imagePaths);
      const turnID = await ipc.sendAgentPrompt(
        projectID,
        threadID,
        agentIDs,
        prompt.trim(),
        prepared.imagePaths,
        hostID,
        prepared.attachmentIds,
      );
      set((state) => ({
        activeTurnByThread: setActiveTurn(state.activeTurnByThread, threadID, turnID),
      }));
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  setSettingsOpen: (open) => set({
    settingsOpen: open,
    ...(open ? { agentsOpen: false, renamingThread: null } : {}),
  }),
  setAgentsOpen: (open) => set({
    agentsOpen: open,
    ...(open ? { settingsOpen: false, renamingThread: null } : {}),
  }),
  setOpenSideThreadID: (threadID) => set({ openSideThreadID: threadID }),
  setSearchOpen: (open) => set({ searchOpen: open, ...(open ? { renamingThread: null } : {}) }),
  setRenamingThread: (target) => set({
    renamingThread: target,
    ...(target ? { settingsOpen: false, agentsOpen: false, searchOpen: false } : {}),
  }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setAttentionFilterOpen: (open) => {
    persistAttentionFilterOpen(open);
    set({ attentionFilterOpen: open });
  },
  toggleAttentionFilter: () => get().setAttentionFilterOpen(!get().attentionFilterOpen),
  // Pinning the rail closes the stand-in popover: the summary is one surface,
  // and leaving both up would show it twice.
  setSummaryPinned: (pinned) => {
    persistSummaryPinned(pinned);
    set({ summaryPinned: pinned, summaryPopoverOpen: false });
  },
  toggleSummaryPinned: () => get().setSummaryPinned(!get().summaryPinned),
  setSummaryPopoverOpen: (open) => set({ summaryPopoverOpen: open }),
  setBrowserOpen: (open) => set((state) => ({
    browserOpen: open && state.selectedThreadID !== null,
  })),
  toggleBrowser: () => get().setBrowserOpen(!get().browserOpen),
  revealBrowserTab: (reveal) => set((state) => (
    state.selectedThreadID === reveal.threadId
      ? { browserOpen: true, pendingBrowserReveal: reveal }
      : {}
  )),
  consumeBrowserReveal: (tabID) => set((state) => (
    state.pendingBrowserReveal?.tabId === tabID ? { pendingBrowserReveal: null } : {}
  )),
  applyBrowserAnnotation: (threadID, annotation, selected) => set((state) => {
    const current = state.browserAnnotationsByThread[threadID] ?? [];
    const key = annotationKey(annotation);
    const withoutTarget = current.filter((candidate) => annotationKey(candidate) !== key);
    const next = selected ? [...withoutTarget, annotation].slice(-MAX_BROWSER_ANNOTATIONS) : withoutTarget;
    if (next.length === current.length && next.every((candidate, index) => candidate === current[index])) return {};
    return { browserAnnotationsByThread: { ...state.browserAnnotationsByThread, [threadID]: next } };
  }),
  replaceBrowserAnnotations: (threadID, annotations) => set((state) => ({
    browserAnnotationsByThread: {
      ...state.browserAnnotationsByThread,
      [threadID]: annotations.slice(-MAX_BROWSER_ANNOTATIONS),
    },
  })),
  removeBrowserAnnotation: (threadID, annotationID) => set((state) => {
    const current = state.browserAnnotationsByThread[threadID] ?? [];
    const next = current.filter((annotation) => annotation.id !== annotationID);
    if (next.length === current.length) return {};
    return { browserAnnotationsByThread: { ...state.browserAnnotationsByThread, [threadID]: next } };
  }),
  clearBrowserAnnotations: (threadID) => set((state) => {
    if (!(state.browserAnnotationsByThread[threadID]?.length)) return {};
    return { browserAnnotationsByThread: { ...state.browserAnnotationsByThread, [threadID]: [] } };
  }),
  setUpdateStatus: (status) => set({ updateStatus: status }),
  // The menu item pushes its own `updater://status` events; this is the same
  // check driven from the UI, so the result is stored directly.
  checkForUpdates: async () => {
    set({ updateStatus: { state: "checking" } });
    try {
      set({ updateStatus: await ipc.checkForUpdates() });
    } catch (error) {
      set({ updateStatus: { state: "failed", message: String(error) } });
    }
  },
  setDefaultRuntime: (selection) => {
    const defaultRuntime = persistDefaultRuntime(selection);
    set((state) => ({
      defaultRuntime,
      // Settings overlays the composer. Keep an empty new chat in sync when
      // the user changes the default before sending its first message.
      ...(state.selectedThreadID === null
        ? { newThreadRuntime: { ...defaultRuntime } }
        : {}),
    }));
  },
  setNewThreadRuntime: (selection) => {
    const newThreadRuntime = normalizeDefaultRuntime(selection) ?? { ...get().defaultRuntime };
    set({ newThreadRuntime });
  },
  setNewThreadSurface: (surface) => set({ newThreadSurface: surface }),
  setKeyboardShortcut: (command, binding) => {
    const keyboardShortcuts = {
      ...get().keyboardShortcuts,
      [command]: { key: binding.key, modifiers: [...binding.modifiers] },
    };
    persistKeyboardShortcuts(keyboardShortcuts);
    set({ keyboardShortcuts });
  },
  resetKeyboardShortcut: (command) => {
    const defaultBinding = DEFAULT_KEYBOARD_SHORTCUTS[command];
    const keyboardShortcuts = {
      ...get().keyboardShortcuts,
      [command]: { key: defaultBinding.key, modifiers: [...defaultBinding.modifiers] },
    };
    persistKeyboardShortcuts(keyboardShortcuts);
    set({ keyboardShortcuts });
  },
  setShowProviderDiagnostics: (visible) => {
    persistShowProviderDiagnostics(visible);
    set({ showProviderDiagnostics: visible });
  },
  setTerminalModeEnabled: (enabled) => {
    persistTerminalModeEnabled(enabled);
    set({
      terminalModeEnabled: enabled,
      ...(!enabled ? { newThreadSurface: "gui" as const } : {}),
    });
  },

  applyRuntimeEvent: (envelope, hostID) => {
    set((state) => {
      if (hostID && !isLocalHost(hostID)) {
        const session = state.remoteSessions.find((item) => item.host.id === hostID);
        if (!session) return {};
        const reduced = reduceRuntimeEvent(
          { workspace: session.workspace, activeTurnByThread: state.activeTurnByThread },
          envelope,
        );
        return {
          remoteSessions: replaceWorkspace(catalogFromState(state), hostID, reduced.workspace!).remotes,
          activeTurnByThread: reduced.activeTurnByThread,
        };
      }
      const reduced = reduceRuntimeEvent(
        { workspace: state.workspace, activeTurnByThread: state.activeTurnByThread },
        envelope,
      );
      return {
        workspace: reduced.workspace,
        activeTurnByThread: reduced.activeTurnByThread,
      };
    });
  },

  applyThreadTitleUpdated: (envelope, hostID) => {
    set((state) => {
      const applyTitle = (workspace: WorkspaceDocument): WorkspaceDocument => ({
        ...workspace,
        projects: workspace.projects.map((project) =>
          project.id !== envelope.projectID
            ? project
            : {
                ...project,
                threads: project.threads.map((thread) =>
                  thread.id === envelope.threadID
                    ? { ...thread, title: envelope.title }
                    : thread),
              }),
      });
      if (hostID && !isLocalHost(hostID)) {
        const session = state.remoteSessions.find((item) => item.host.id === hostID);
        if (!session) return {};
        return {
          remoteSessions: replaceWorkspace(catalogFromState(state), hostID, applyTitle(session.workspace)).remotes,
        };
      }
      if (!state.workspace) return {};
      return { workspace: applyTitle(state.workspace) };
    });
  },

  applyTurnFinished: (envelope, hostID) => {
    set((state) => {
      const catalog = catalogFromState(state);
      const workspace = hostID && !isLocalHost(hostID)
        ? catalog.remotes.find((session) => session.host.id === hostID)?.workspace ?? null
        : state.workspace;
      const unseenTarget = unseenTargetForFinishedTurn(
        workspace,
        envelope,
        state.selectedThreadID,
      );
      return {
        activeTurnByThread: clearFinishedTurn(
          state.activeTurnByThread,
          envelope.threadID,
          envelope.turnID,
        ),
        unseenThreadIDs: unseenTarget
          ? persistIfChanged(
              state.unseenThreadIDs,
              markThreadUnseen(state.unseenThreadIDs, unseenTarget),
            )
          : state.unseenThreadIDs,
      };
    });
    void get().refresh();
  },
}));
