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
import { DEFAULT_VOICE_SETTINGS } from "../voice/types";
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
  CHATS_PROJECT_ID,
  ChatProvider,
  ChatTextSelection,
  ChatSurface,
  ChatThread,
  ProviderProfile,
  RuntimeEventEnvelope,
  RuntimeInteractionDecision,
  ThreadTitleUpdatedEnvelope,
  TitleGenerationRuntime,
  TurnFinishedEnvelope,
  WorkspaceDocument,
  isChatsProject,
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
import { isHostConnectionError } from "../host/errors";
import {
  attachRemote,
  detachRemote,
  emptyCatalog,
  isLocalHost,
  LOCAL_HOST_ID,
  mergedWorkspace,
  replaceWorkspace,
  routeHostId,
} from "../host/session";
import { uploadImagesForHost } from "../host/mediaUpload";
import type { QueuedMessage } from "../messageQueue";
import type { GitEnvironmentMode } from "../git";
import type { SideChatRequest } from "../sideChat";

let listenersStarted = false;
let hostStatusRefreshSequence = 0;
const initialDefaultRuntime = loadDefaultRuntime();

interface AppStoreState {
  workspace: WorkspaceDocument | null;
  selectedHostID: string;
  remoteSessions: RemoteSession[];
  hostStatus: HostStatus | null;
  selectedProjectID: string | null;
  selectedThreadID: string | null;
  activeTurnByThread: Record<string, string>;
  queuedMessagesByThread: Record<string, QueuedMessage[]>;
  sendingMessageByThread: Record<string, boolean>;
  /** Threads that finished a turn while the user was not viewing them. */
  unseenThreadIDs: UnseenThreadMap;
  settingsOpen: boolean;
  agentsOpen: boolean;
  automationsOpen: boolean;
  /** Side thread shown in the reply panel next to the main thread. */
  openSideThreadID: string | null;
  searchOpen: boolean;
  renamingThread: { hostID: string; projectID: string; threadID: string } | null;
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
  pendingSideChatRequest: SideChatRequest | null;
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
  /** Repository environment selected for the next chat. */
  newThreadEnvironment: GitEnvironmentMode;
  keyboardShortcuts: KeyboardShortcutBindings;
  /** Non-fatal notices emitted by provider runtimes, hidden from chat by default. */
  showProviderDiagnostics: boolean;
  /** Experimental access to native provider terminal surfaces. */
  terminalModeEnabled: boolean;
  error: string | null;
  /** Identifies an offline error so only that host's reconnect clears it. */
  errorHostID: string | null;

  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshHost: (hostID: string) => Promise<void>;
  selectThread: (projectID: string, threadID: string, hostID?: string) => void;
  addProject: (folderPath: string, hostID?: string) => Promise<void>;
  removeProject: (projectID: string, hostID?: string) => Promise<void>;
  /** Undefined keeps the current project; null explicitly starts without one. */
  startNewThread: (projectID?: string | null, hostID?: string) => void;
  setNewThreadProject: (projectID: string | null, hostID?: string) => void;
  connectHost: (address: string, code: string) => Promise<void>;
  disconnectHost: (hostID: string) => Promise<void>;
  revokePairedDevice: (peerID: string) => Promise<void>;
  markHostDisconnected: (hostID: string) => void;
  markHostRevoked: (hostID: string) => void;
  clearHostConnectionError: (hostID: string) => void;
  startHostListen: (bindAddress?: string) => Promise<void>;
  stopHostListen: () => Promise<void>;
  refreshHostStatus: () => Promise<void>;
  addThread: (
    projectID: string | null,
    provider: ChatProvider,
    model: string,
    title?: string,
    effort?: string | null,
    speed?: string | null,
    surface?: ChatSurface,
    environment?: GitEnvironmentMode,
  ) => Promise<ChatThread | null>;
  removeThread: (projectID: string, threadID: string) => Promise<void>;
  renameThread: (
    hostID: string,
    projectID: string,
    threadID: string,
    title: string,
  ) => Promise<boolean>;
  updateThreadRuntime: (
    projectID: string,
    threadID: string,
    provider: ChatProvider,
    model: string,
    effort?: string | null,
    speed?: string | null,
  ) => Promise<void>;
  createThreadAndSend: (
    projectID: string | null,
    provider: ChatProvider,
    model: string,
    prompt: string,
    imagePaths: string[],
    effort?: string | null,
    speed?: string | null,
    surface?: ChatSurface,
    environment?: GitEnvironmentMode,
    hostID?: string,
  ) => Promise<boolean>;
  sendPrompt: (prompt: string, imagePaths: string[], annotations?: BrowserAnnotation[]) => Promise<boolean>;
  createSideChat: (projectID: string, parentThreadID: string) => Promise<ChatThread | null>;
  sendSideChatPrompt: (
    projectID: string,
    threadID: string,
    prompt: string,
    imagePaths: string[],
    textSelections?: ChatTextSelection[],
  ) => Promise<boolean>;
  drainPromptQueue: (threadID: string) => Promise<boolean>;
  steerQueuedMessage: (threadID: string, messageID: string) => Promise<boolean>;
  retryQueuedMessage: (threadID: string, messageID: string) => Promise<boolean>;
  removeQueuedMessage: (threadID: string, messageID: string) => void;
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
  ) => Promise<boolean>;
  setSettingsOpen: (open: boolean) => void;
  setAgentsOpen: (open: boolean) => void;
  setAutomationsOpen: (open: boolean) => void;
  setOpenSideThreadID: (threadID: string | null) => void;
  setSearchOpen: (open: boolean) => void;
  setRenamingThread: (
    target: { hostID: string; projectID: string; threadID: string } | null,
  ) => void;
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
  requestSideChat: (request: SideChatRequest) => void;
  consumeSideChatRequest: (requestID: string) => void;
  applyBrowserAnnotation: (threadID: string, annotation: BrowserAnnotation, selected: boolean) => void;
  replaceBrowserAnnotations: (threadID: string, annotations: BrowserAnnotation[]) => void;
  removeBrowserAnnotation: (threadID: string, annotationID: string) => void;
  clearBrowserAnnotations: (threadID: string) => void;
  setUpdateStatus: (status: UpdateStatus | null) => void;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  restartToInstallUpdate: () => Promise<void>;
  setDefaultRuntime: (selection: RuntimeSelection) => void;
  setNewThreadRuntime: (selection: RuntimeSelection) => void;
  setNewThreadSurface: (surface: ChatSurface) => void;
  setNewThreadEnvironment: (environment: GitEnvironmentMode) => void;
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
    voice: DEFAULT_VOICE_SETTINGS,
  };
  let catalog = emptyCatalog(local, state.hostStatus?.name ?? "This computer");
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

function hostActionError(
  error: unknown,
  hostID: string,
  state: Pick<AppStoreState, "remoteSessions" | "hostStatus">,
): Pick<AppStoreState, "error" | "errorHostID"> {
  const message = String(error);
  if (
    !isLocalHost(hostID)
    && isHostConnectionError(error)
  ) {
    const hostName = state.remoteSessions.find((session) => session.host.id === hostID)?.host.name
      ?? state.hostStatus?.remotes.find((host) => host.id === hostID)?.name
      ?? "Remote Maxx";
    return {
      error: `${hostName} is offline. Its projects and chats remain available to read, but messages and changes require it to reconnect.`,
      errorHostID: hostID,
    };
  }
  return { error: message, errorHostID: null };
}

export const useAppStore = create<AppStoreState>((set, get) => {
  const dispatchQueuedMessage = async (message: QueuedMessage): Promise<string> => {
    const prepared = await uploadImagesForHost(message.hostID, message.imagePaths);
    if (message.kind === "agent") {
      return ipc.sendAgentPrompt(
        message.projectID,
        message.threadID,
        message.agentIDs,
        message.prompt,
        prepared.imagePaths,
        message.hostID,
        prepared.attachmentIds,
      );
    }
    return ipc.sendPrompt(
      message.projectID,
      message.threadID,
      message.prompt,
      prepared.imagePaths,
      message.hostID,
      prepared.attachmentIds,
      message.annotations,
      message.textSelections,
    );
  };

  const setMessageSending = (threadID: string, sending: boolean) => {
    set((state) => {
      const next = { ...state.sendingMessageByThread };
      if (sending) next[threadID] = true;
      else delete next[threadID];
      return { sendingMessageByThread: next };
    });
  };

  const enqueueMessage = (message: QueuedMessage) => {
    set((state) => ({
      queuedMessagesByThread: {
        ...state.queuedMessagesByThread,
        [message.threadID]: [...(state.queuedMessagesByThread[message.threadID] ?? []), message],
      },
    }));
  };

  return ({
  workspace: null,
  selectedHostID: LOCAL_HOST_ID,
  remoteSessions: [],
  hostStatus: null,
  selectedProjectID: null,
  selectedThreadID: null,
  activeTurnByThread: {},
  queuedMessagesByThread: {},
  sendingMessageByThread: {},
  unseenThreadIDs: loadUnseenThreadIDs(),
  settingsOpen: false,
  agentsOpen: false,
  automationsOpen: false,
  openSideThreadID: null,
  searchOpen: false,
  renamingThread: null,
  sidebarOpen: true,
  attentionFilterOpen: loadAttentionFilterOpen(),
  summaryPinned: loadSummaryPinned(),
  summaryPopoverOpen: false,
  browserOpen: false,
  pendingBrowserReveal: null,
  pendingSideChatRequest: null,
  browserAnnotationsByThread: {},
  updateStatus: null,
  defaultRuntime: { ...initialDefaultRuntime },
  newThreadRuntime: { ...initialDefaultRuntime },
  newThreadSurface: "gui",
  newThreadEnvironment: "current",
  keyboardShortcuts: loadKeyboardShortcuts(),
  showProviderDiagnostics: loadShowProviderDiagnostics(),
  terminalModeEnabled: loadTerminalModeEnabled(),
  error: null,
  errorHostID: null,

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
          } else if (message.event === "host://revoked") {
            get().markHostRevoked(message.hostId);
            void get().refreshHostStatus();
          } else if (message.event === "host://connected" || message.event === "host://status-changed") {
            if (message.event === "host://connected") {
              get().clearHostConnectionError(message.hostId);
            }
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
        errorHostID: null,
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
        errorHostID: null,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  refreshHostStatus: async () => {
    const refreshSequence = ++hostStatusRefreshSequence;
    try {
      const hostStatus = await ipc.hostStatus();
      const previousSessions = get().remoteSessions;
      const sessions = await Promise.all(
        hostStatus.remotes.map(async (host) => {
          try {
            return {
              host: { id: host.id, name: host.name, kind: "remote" as const, address: host.address },
              workspace: await ipc.workspaceSnapshot(host.id),
            };
          } catch {
            const previous = previousSessions.find((session) => session.host.id === host.id);
            return previous
              ? {
                  host: { id: host.id, name: host.name, kind: "remote" as const, address: host.address },
                  workspace: previous.workspace,
                }
              : null;
          }
        }),
      );
      if (refreshSequence !== hostStatusRefreshSequence) return;
      set((state) => {
        const connectedHostIDs = new Set(
          hostStatus.remotes.filter((remote) => remote.connected).map((remote) => remote.id),
        );
        let catalog = emptyCatalog(
          state.workspace ?? catalogFromState(state).local,
          hostStatus.name,
        );
        for (const session of sessions) {
          if (session) catalog = attachRemote(catalog, session.host, session.workspace);
        }
        return {
          hostStatus,
          remoteSessions: catalog.remotes,
          ...(state.errorHostID
            && connectedHostIDs.has(state.errorHostID)
            && state.error?.includes(" is offline.")
            ? { error: null, errorHostID: null }
            : {}),
        };
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
        errorHostID: null,
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

  revokePairedDevice: async (peerID) => {
    set({ error: null, errorHostID: null });
    try {
      await ipc.hostRevokePeer(peerID);
      set((state) => ({
        hostStatus: state.hostStatus
          ? {
              ...state.hostStatus,
              pairedDevices: state.hostStatus.pairedDevices.filter((device) => device.id !== peerID),
            }
          : state.hostStatus,
      }));
      await get().refreshHostStatus();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  markHostDisconnected: (hostID) => set((state) => ({
    hostStatus: state.hostStatus
      ? {
          ...state.hostStatus,
          remotes: state.hostStatus.remotes.map((remote) =>
            remote.id === hostID
              ? { ...remote, connected: false, error: "Connection lost. Retrying…" }
              : remote,
          ),
        }
      : state.hostStatus,
  })),

  markHostRevoked: (hostID) => set((state) => ({
    remoteSessions: detachRemote(catalogFromState(state), hostID).remotes,
    selectedHostID: state.selectedHostID === hostID ? LOCAL_HOST_ID : state.selectedHostID,
    selectedProjectID: state.selectedHostID === hostID ? null : state.selectedProjectID,
    selectedThreadID: state.selectedHostID === hostID ? null : state.selectedThreadID,
    hostStatus: state.hostStatus
      ? {
          ...state.hostStatus,
          remotes: state.hostStatus.remotes.filter((remote) => remote.id !== hostID),
        }
      : state.hostStatus,
    ...(state.errorHostID === hostID && state.error?.includes(" is offline.")
      ? { error: null, errorHostID: null }
      : {}),
  })),

  clearHostConnectionError: (hostID) => set((state) => (
    state.errorHostID === hostID && state.error?.includes(" is offline.")
      ? { error: null, errorHostID: null }
      : {}
  )),

  startHostListen: async (bindAddress) => {
    set({ error: null, errorHostID: null });
    try {
      await ipc.hostListen(bindAddress);
      await get().refreshHostStatus();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  stopHostListen: async () => {
    set({ error: null, errorHostID: null });
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
      automationsOpen: false,
      renamingThread: null,
      openSideThreadID: null,
      browserOpen: state.selectedThreadID === threadID ? state.browserOpen : false,
      pendingBrowserReveal: state.selectedThreadID === threadID
        ? state.pendingBrowserReveal
        : null,
      pendingSideChatRequest: state.selectedThreadID === threadID
        ? state.pendingSideChatRequest
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
    const currentProject = state.workspace?.projects.find((project) => project.id === state.selectedProjectID)
      ?? state.remoteSessions
        .find((session) => session.host.id === state.selectedHostID)
        ?.workspace.projects.find((project) => project.id === state.selectedProjectID);
    const explicitWithoutProject = projectID === null;
    const contextualProjectID = projectID === undefined && currentProject && !isChatsProject(currentProject)
      ? currentProject.id
      : null;
    const requestedProjectID = typeof projectID === "string" ? projectID : contextualProjectID;
    const resolvedHostID = routeHostId(
      hostID ?? (requestedProjectID
        ? hostForProject(state.remoteSessions, state.workspace, requestedProjectID, state.selectedHostID)
        : LOCAL_HOST_ID),
    );
    set({
      selectedHostID: resolvedHostID,
      selectedProjectID: explicitWithoutProject ? null : requestedProjectID,
      selectedThreadID: null,
      newThreadRuntime: { ...get().defaultRuntime },
      newThreadSurface: "gui",
      newThreadEnvironment: "current",
      settingsOpen: false,
      agentsOpen: false,
      automationsOpen: false,
      renamingThread: null,
      openSideThreadID: null,
      browserOpen: false,
      summaryPopoverOpen: false,
    });
  },

  setNewThreadProject: (projectID, hostID) => set({
    selectedHostID: routeHostId(hostID ?? (projectID ? get().selectedHostID : LOCAL_HOST_ID)),
    selectedProjectID: projectID,
    newThreadEnvironment: "current",
  }),

  addProject: async (folderPath, hostID) => {
    const targetHost = routeHostId(hostID ?? get().selectedHostID);
    try {
      const project = await ipc.addProject(folderPath, targetHost);
      await get().refresh();
      set({
        selectedHostID: targetHost,
        selectedProjectID: project.id,
        selectedThreadID: null,
        newThreadRuntime: { ...get().defaultRuntime },
        newThreadSurface: "gui",
        newThreadEnvironment: "current",
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
      });
    } catch (error) {
      set(hostActionError(error, targetHost, get()));
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
        newThreadEnvironment: "current",
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
    environment = "current",
  ) => {
    const hostID = projectID
      ? hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID)
      : LOCAL_HOST_ID;
    try {
      const thread = projectID
        ? effort || speed || surface === "terminal" || environment === "worktree"
          ? await ipc.addThreadWithRuntime(
            projectID,
            provider,
            model,
            title,
            effort,
            speed,
            surface,
            hostID,
            environment === "worktree",
          )
          : await ipc.addThread(projectID, provider, model, title, hostID)
        : await ipc.addChat(provider, model, title, effort, speed);
      await get().refresh();
      set({
        selectedHostID: hostID,
        selectedProjectID: projectID ?? CHATS_PROJECT_ID,
        selectedThreadID: thread.id,
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
        newThreadSurface: "gui",
        newThreadEnvironment: "current",
      });
      return thread;
    } catch (error) {
      set(hostActionError(error, hostID, get()));
      return null;
    }
  },

  removeThread: async (projectID, threadID) => {
    const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
    await ipc.removeThread(projectID, threadID, hostID);
    set((state) => {
      const queuedMessagesByThread = { ...state.queuedMessagesByThread };
      const sendingMessageByThread = { ...state.sendingMessageByThread };
      delete queuedMessagesByThread[threadID];
      delete sendingMessageByThread[threadID];
      return { queuedMessagesByThread, sendingMessageByThread };
    });
    await get().refresh();
    if (get().selectedThreadID === threadID) {
      set({
        ...(projectID === CHATS_PROJECT_ID ? { selectedProjectID: null } : {}),
        selectedThreadID: null,
        newThreadRuntime: { ...get().defaultRuntime },
        newThreadSurface: "gui",
        newThreadEnvironment: "current",
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
      });
    }
  },

  renameThread: async (hostID, projectID, threadID, title) => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return false;
    try {
      await ipc.updateThread(projectID, threadID, { title: trimmedTitle }, hostID);
      await get().refresh();
      return true;
    } catch (error) {
      set(hostActionError(error, hostID, get()));
      return false;
    }
  },

  updateThreadRuntime: async (projectID, threadID, provider, model, effort = null, speed = null) => {
    const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
    try {
      await ipc.updateThread(projectID, threadID, {
        provider,
        model,
        effort: effort ?? "",
        speed: speed ?? "",
        updateRuntimeKnobs: true,
      }, hostID);
      await get().refresh();
    } catch (error) {
      set(hostActionError(error, hostID, get()));
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
    environment = "current",
    requestedHostID,
  ) => {
    if (!prompt.trim() && (surface === "terminal" || imagePaths.length === 0)) return false;
    const title = prompt.trim().split("\n")[0].slice(0, 64) || "Image attachment";
    const thread = await get().addThread(
      projectID,
      provider,
      model,
      title,
      effort,
      speed,
      surface,
      environment,
    );
    if (!thread) return false;
    const hostID = projectID
      ? hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID)
      : routeHostId(requestedHostID ?? LOCAL_HOST_ID);
    try {
      const ownerProjectID = projectID ?? CHATS_PROJECT_ID;
      const prepared = await uploadImagesForHost(hostID, surface === "terminal" ? [] : imagePaths);
      const turnID = await ipc.sendPrompt(
        ownerProjectID,
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
      set(hostActionError(error, hostID, get()));
      return false;
    }
    return true;
  },

  sendPrompt: async (prompt, imagePaths, annotations = []) => {
    const { selectedProjectID, selectedThreadID, selectedHostID, remoteSessions, workspace } = get();
    if (!selectedProjectID || !selectedThreadID || (!prompt.trim() && imagePaths.length === 0 && annotations.length === 0)) return false;
    const hostID = hostForProject(remoteSessions, workspace, selectedProjectID, selectedHostID);
    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      kind: "prompt",
      projectID: selectedProjectID,
      threadID: selectedThreadID,
      hostID,
      prompt,
      imagePaths: [...imagePaths],
      annotations: [...annotations],
      textSelections: [],
    };
    const current = get();
    if (
      current.activeTurnByThread[selectedThreadID]
      || current.sendingMessageByThread[selectedThreadID]
      || (current.queuedMessagesByThread[selectedThreadID]?.length ?? 0) > 0
    ) {
      enqueueMessage(message);
      if (!current.activeTurnByThread[selectedThreadID] && !current.sendingMessageByThread[selectedThreadID]) {
        void get().drainPromptQueue(selectedThreadID);
      }
      return true;
    }
    setMessageSending(selectedThreadID, true);
    try {
      const turnID = await dispatchQueuedMessage(message);
      set((state) => ({
        activeTurnByThread: setActiveTurn(state.activeTurnByThread, selectedThreadID, turnID),
      }));
      await get().refresh();
      return true;
    } catch (error) {
      set(hostActionError(error, hostID, get()));
      return false;
    } finally {
      setMessageSending(selectedThreadID, false);
    }
  },

  createSideChat: async (projectID, parentThreadID) => {
    const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
    try {
      const thread = await ipc.createSideChat(projectID, parentThreadID, hostID);
      await get().refresh();
      return thread;
    } catch (error) {
      set(hostActionError(error, hostID, get()));
      return null;
    }
  },

  sendSideChatPrompt: async (projectID, threadID, prompt, imagePaths, textSelections = []) => {
    if (!prompt.trim() && imagePaths.length === 0 && textSelections.length === 0) return false;
    const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      kind: "prompt",
      projectID,
      threadID,
      hostID,
      prompt,
      imagePaths: [...imagePaths],
      annotations: [],
      textSelections: [...textSelections],
    };
    const current = get();
    if (
      current.activeTurnByThread[threadID]
      || current.sendingMessageByThread[threadID]
      || (current.queuedMessagesByThread[threadID]?.length ?? 0) > 0
    ) {
      enqueueMessage(message);
      if (!current.activeTurnByThread[threadID] && !current.sendingMessageByThread[threadID]) {
        void get().drainPromptQueue(threadID);
      }
      return true;
    }
    setMessageSending(threadID, true);
    try {
      const turnID = await dispatchQueuedMessage(message);
      set((state) => ({
        activeTurnByThread: setActiveTurn(state.activeTurnByThread, threadID, turnID),
      }));
      await get().refresh();
      return true;
    } catch (error) {
      set(hostActionError(error, hostID, get()));
      return false;
    } finally {
      setMessageSending(threadID, false);
    }
  },

  drainPromptQueue: async (threadID) => {
    const current = get();
    if (current.activeTurnByThread[threadID] || current.sendingMessageByThread[threadID]) return false;
    const message = current.queuedMessagesByThread[threadID]?.[0];
    if (!message) return false;
    setMessageSending(threadID, true);
    try {
      const turnID = await dispatchQueuedMessage(message);
      set((state) => {
        const remaining = (state.queuedMessagesByThread[threadID] ?? [])
          .filter((candidate) => candidate.id !== message.id);
        const queuedMessagesByThread = { ...state.queuedMessagesByThread };
        if (remaining.length > 0) queuedMessagesByThread[threadID] = remaining;
        else delete queuedMessagesByThread[threadID];
        return {
          activeTurnByThread: setActiveTurn(state.activeTurnByThread, threadID, turnID),
          queuedMessagesByThread,
          error: null,
          errorHostID: null,
        };
      });
      await get().refresh();
      return true;
    } catch (error) {
      set(hostActionError(error, message.hostID, get()));
      return false;
    } finally {
      setMessageSending(threadID, false);
    }
  },

  steerQueuedMessage: async (threadID, messageID) => {
    const current = get();
    const turnID = current.activeTurnByThread[threadID];
    const message = current.queuedMessagesByThread[threadID]
      ?.find((candidate) => candidate.id === messageID);
    if (!turnID || !message || message.kind !== "prompt" || current.sendingMessageByThread[threadID]) {
      return false;
    }
    setMessageSending(threadID, true);
    try {
      const prepared = await uploadImagesForHost(message.hostID, message.imagePaths);
      await ipc.steerPrompt(
        message.projectID,
        message.threadID,
        turnID,
        message.prompt,
        prepared.imagePaths,
        message.hostID,
        prepared.attachmentIds,
        message.annotations,
      );
      set((state) => {
        const remaining = (state.queuedMessagesByThread[threadID] ?? [])
          .filter((candidate) => candidate.id !== messageID);
        const queuedMessagesByThread = { ...state.queuedMessagesByThread };
        if (remaining.length > 0) queuedMessagesByThread[threadID] = remaining;
        else delete queuedMessagesByThread[threadID];
        return { queuedMessagesByThread, error: null, errorHostID: null };
      });
      await get().refresh();
      return true;
    } catch (error) {
      set(hostActionError(error, message.hostID, get()));
      return false;
    } finally {
      setMessageSending(threadID, false);
      if (!get().activeTurnByThread[threadID]) void get().drainPromptQueue(threadID);
    }
  },

  retryQueuedMessage: async (threadID, messageID) => {
    const current = get();
    if (current.activeTurnByThread[threadID] || current.sendingMessageByThread[threadID]) return false;
    const queued = current.queuedMessagesByThread[threadID] ?? [];
    const message = queued.find((candidate) => candidate.id === messageID);
    if (!message) return false;
    set((state) => ({
      queuedMessagesByThread: {
        ...state.queuedMessagesByThread,
        [threadID]: [message, ...queued.filter((candidate) => candidate.id !== messageID)],
      },
    }));
    return get().drainPromptQueue(threadID);
  },

  removeQueuedMessage: (threadID, messageID) => {
    if (get().sendingMessageByThread[threadID]) return;
    set((state) => {
      const remaining = (state.queuedMessagesByThread[threadID] ?? [])
        .filter((message) => message.id !== messageID);
      const queuedMessagesByThread = { ...state.queuedMessagesByThread };
      if (remaining.length > 0) queuedMessagesByThread[threadID] = remaining;
      else delete queuedMessagesByThread[threadID];
      return { queuedMessagesByThread };
    });
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
    const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
    try {
      await ipc.resolveRequest(projectID, threadID, requestID, decision, hostID);
      await get().refresh();
    } catch (error) {
      set(hostActionError(error, hostID, get()));
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
    const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
    try {
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
      set(hostActionError(error, hostID, get()));
      return false;
    }
  },

  sendAgentPrompt: async (projectID, threadID, agentIDs, prompt, imagePaths) => {
    if ((!prompt.trim() && imagePaths.length === 0) || agentIDs.length === 0) return false;
    const hostID = hostForProject(get().remoteSessions, get().workspace, projectID, get().selectedHostID);
    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      kind: "agent",
      projectID,
      threadID,
      hostID,
      agentIDs: [...agentIDs],
      prompt: prompt.trim(),
      imagePaths: [...imagePaths],
    };
    const current = get();
    if (
      current.activeTurnByThread[threadID]
      || current.sendingMessageByThread[threadID]
      || (current.queuedMessagesByThread[threadID]?.length ?? 0) > 0
    ) {
      enqueueMessage(message);
      if (!current.activeTurnByThread[threadID] && !current.sendingMessageByThread[threadID]) {
        void get().drainPromptQueue(threadID);
      }
      return true;
    }
    setMessageSending(threadID, true);
    try {
      const turnID = await dispatchQueuedMessage(message);
      set((state) => ({
        activeTurnByThread: setActiveTurn(state.activeTurnByThread, threadID, turnID),
      }));
      await get().refresh();
      return true;
    } catch (error) {
      set(hostActionError(error, hostID, get()));
      return false;
    } finally {
      setMessageSending(threadID, false);
    }
  },

  setSettingsOpen: (open) => set({
    settingsOpen: open,
    ...(open ? { agentsOpen: false, automationsOpen: false, renamingThread: null } : {}),
  }),
  setAgentsOpen: (open) => set({
    agentsOpen: open,
    ...(open ? { settingsOpen: false, automationsOpen: false, renamingThread: null } : {}),
  }),
  setAutomationsOpen: (open) => set({
    automationsOpen: open,
    ...(open ? { settingsOpen: false, agentsOpen: false, renamingThread: null } : {}),
  }),
  setOpenSideThreadID: (threadID) => set({ openSideThreadID: threadID }),
  setSearchOpen: (open) => set({ searchOpen: open, ...(open ? { renamingThread: null } : {}) }),
  setRenamingThread: (target) => set({
    renamingThread: target,
    ...(target ? { settingsOpen: false, agentsOpen: false, automationsOpen: false, searchOpen: false } : {}),
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
  requestSideChat: (request) => set((state) => (
    state.selectedThreadID === request.parentThreadID
      ? { browserOpen: true, pendingSideChatRequest: request }
      : {}
  )),
  consumeSideChatRequest: (requestID) => set((state) => (
    state.pendingSideChatRequest?.id === requestID ? { pendingSideChatRequest: null } : {}
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
  installUpdate: async () => {
    const status = await ipc.installUpdate();
    if (status) set({ updateStatus: status });
  },
  restartToInstallUpdate: async () => {
    set({ updateStatus: await ipc.restartToInstallUpdate() });
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
  setNewThreadEnvironment: (environment) => set({ newThreadEnvironment: environment }),
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
    void get().drainPromptQueue(envelope.threadID);
  },
  });
});
