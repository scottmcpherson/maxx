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

let listenersStarted = false;
const initialDefaultRuntime = loadDefaultRuntime();

interface AppStoreState {
  workspace: WorkspaceDocument | null;
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
  /** Latest result of an update check; `null` once dismissed. */
  updateStatus: UpdateStatus | null;
  /** Persisted runtime used to seed each new-chat composer. */
  defaultRuntime: RuntimeSelection;
  /** Ephemeral runtime for the currently open new-chat composer. */
  newThreadRuntime: RuntimeSelection;
  keyboardShortcuts: KeyboardShortcutBindings;
  /** Non-fatal notices emitted by provider runtimes, hidden from chat by default. */
  showProviderDiagnostics: boolean;
  error: string | null;

  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  selectThread: (projectID: string, threadID: string) => void;
  addProject: (folderPath: string) => Promise<void>;
  removeProject: (projectID: string) => Promise<void>;
  startNewThread: (projectID?: string) => void;
  addThread: (
    projectID: string,
    provider: ChatProvider,
    model: string,
    title?: string,
    effort?: string | null,
    speed?: string | null,
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
  ) => Promise<boolean>;
  sendPrompt: (prompt: string, imagePaths: string[]) => Promise<void>;
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
  ) => Promise<void>;
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
  setUpdateStatus: (status: UpdateStatus | null) => void;
  checkForUpdates: () => Promise<void>;
  setDefaultRuntime: (selection: RuntimeSelection) => void;
  setNewThreadRuntime: (selection: RuntimeSelection) => void;
  setKeyboardShortcut: (command: KeyboardShortcutCommand, binding: KeyboardShortcutBinding) => void;
  resetKeyboardShortcut: (command: KeyboardShortcutCommand) => void;
  setShowProviderDiagnostics: (visible: boolean) => void;
  applyRuntimeEvent: (envelope: RuntimeEventEnvelope) => void;
  applyThreadTitleUpdated: (envelope: ThreadTitleUpdatedEnvelope) => void;
  applyTurnFinished: (envelope: TurnFinishedEnvelope) => void;
}

/** Persist the unseen map only when the instance actually changed. */
function persistIfChanged(previous: UnseenThreadMap, next: UnseenThreadMap): UnseenThreadMap {
  if (next !== previous) persistUnseenThreadIDs(next);
  return next;
}

/** Successful inventory fetch replaces activity; fetch failure leaves state alone. */
async function loadActiveTurns(): Promise<Record<string, string> | null> {
  try {
    const inventory = await ipc.activeTurns();
    return hydrateActiveTurns(inventory);
  } catch {
    return null;
  }
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  workspace: null,
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
  updateStatus: null,
  defaultRuntime: { ...initialDefaultRuntime },
  newThreadRuntime: { ...initialDefaultRuntime },
  keyboardShortcuts: loadKeyboardShortcuts(),
  showProviderDiagnostics: loadShowProviderDiagnostics(),
  error: null,

  bootstrap: async () => {
    await get().refresh();
    if (!listenersStarted) {
      listenersStarted = true;
      try {
        await ipc.onRuntimeEvent((envelope) => get().applyRuntimeEvent(envelope));
        await ipc.onTurnFinished((envelope) => get().applyTurnFinished(envelope));
        await ipc.onThreadTitleUpdated((envelope) => get().applyThreadTitleUpdated(envelope));
        await ipc.onUpdateStatus((status) => get().setUpdateStatus(status));
        await ipc.onBrowserReveal((event) => get().revealBrowserTab(event));
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
      const activeTurnByThread = await loadActiveTurns();
      set((state) => ({
        workspace,
        ...(activeTurnByThread !== null ? { activeTurnByThread } : {}),
        unseenThreadIDs: persistIfChanged(
          state.unseenThreadIDs,
          pruneUnseenThreads(state.unseenThreadIDs, workspace),
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

  selectThread: (projectID, threadID) =>
    set((state) => ({
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

  startNewThread: (projectID) => {
    const workspace = get().workspace;
    const resolvedProjectID =
      projectID ?? get().selectedProjectID ?? workspace?.projects[0]?.id ?? null;
    set({
      selectedProjectID: resolvedProjectID,
      selectedThreadID: null,
      newThreadRuntime: { ...get().defaultRuntime },
      settingsOpen: false,
      agentsOpen: false,
      renamingThread: null,
      openSideThreadID: null,
      browserOpen: false,
      summaryPopoverOpen: false,
    });
  },

  addProject: async (folderPath) => {
    try {
      const project = await ipc.addProject(folderPath);
      await get().refresh();
      set({
        selectedProjectID: project.id,
        selectedThreadID: null,
        newThreadRuntime: { ...get().defaultRuntime },
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  removeProject: async (projectID) => {
    await ipc.removeProject(projectID);
    await get().refresh();
    if (get().selectedProjectID === projectID) {
      set({
        selectedProjectID: null,
        selectedThreadID: null,
        newThreadRuntime: { ...get().defaultRuntime },
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
      });
    }
  },

  addThread: async (projectID, provider, model, title = "New thread", effort = null, speed = null) => {
    try {
      const thread =
        effort || speed
          ? await ipc.addThreadWithRuntime(projectID, provider, model, title, effort, speed)
          : await ipc.addThread(projectID, provider, model, title);
      await get().refresh();
      set({
        selectedProjectID: projectID,
        selectedThreadID: thread.id,
        openSideThreadID: null,
        browserOpen: false,
        summaryPopoverOpen: false,
      });
      return thread;
    } catch (error) {
      set({ error: String(error) });
      return null;
    }
  },

  removeThread: async (projectID, threadID) => {
    await ipc.removeThread(projectID, threadID);
    await get().refresh();
    if (get().selectedThreadID === threadID) {
      set({
        selectedThreadID: null,
        newThreadRuntime: { ...get().defaultRuntime },
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
      await ipc.updateThread(projectID, threadID, { title: trimmedTitle });
      await get().refresh();
      return true;
    } catch (error) {
      set({ error: String(error) });
      return false;
    }
  },

  updateThreadRuntime: async (projectID, threadID, provider, model, effort = null, speed = null) => {
    try {
      await ipc.updateThread(projectID, threadID, {
        provider,
        model,
        effort: effort ?? "",
        speed: speed ?? "",
        updateRuntimeKnobs: true,
      });
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  createThreadAndSend: async (projectID, provider, model, prompt, imagePaths, effort = null, speed = null) => {
    if (!prompt.trim() && imagePaths.length === 0) return false;
    const title = prompt.trim().split("\n")[0].slice(0, 64) || "Image attachment";
    const thread = await get().addThread(projectID, provider, model, title, effort, speed);
    if (!thread) return false;
    try {
      const turnID = await ipc.sendPrompt(projectID, thread.id, prompt.trim(), imagePaths);
      set((state) => ({
        activeTurnByThread: setActiveTurn(state.activeTurnByThread, thread.id, turnID),
      }));
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
    return true;
  },

  sendPrompt: async (prompt, imagePaths) => {
    const { selectedProjectID, selectedThreadID } = get();
    if (!selectedProjectID || !selectedThreadID || (!prompt.trim() && imagePaths.length === 0)) return;
    try {
      const turnID = await ipc.sendPrompt(selectedProjectID, selectedThreadID, prompt, imagePaths);
      set((state) => ({
        activeTurnByThread: setActiveTurn(state.activeTurnByThread, selectedThreadID, turnID),
      }));
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  cancelActiveTurn: async (threadID) => {
    const turnID = get().activeTurnByThread[threadID];
    if (turnID) await ipc.cancelTurn(turnID);
  },

  resolveRequest: async (projectID, threadID, requestID, decision) => {
    try {
      await ipc.resolveRequest(projectID, threadID, requestID, decision);
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

  startSideThread: async (projectID, parentThreadID, agentIDs, prompt, imagePaths) => {
    if ((!prompt.trim() && imagePaths.length === 0) || agentIDs.length === 0) return;
    try {
      const thread = await ipc.startSideThread(projectID, parentThreadID, agentIDs, prompt.trim(), imagePaths);
      set((state) => ({
        openSideThreadID: thread.id,
        activeTurnByThread: thread.lastTurnID
          ? setActiveTurn(state.activeTurnByThread, thread.id, thread.lastTurnID)
          : state.activeTurnByThread,
      }));
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  sendAgentPrompt: async (projectID, threadID, agentIDs, prompt, imagePaths) => {
    if ((!prompt.trim() && imagePaths.length === 0) || agentIDs.length === 0) return;
    try {
      const turnID = await ipc.sendAgentPrompt(projectID, threadID, agentIDs, prompt.trim(), imagePaths);
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

  applyRuntimeEvent: (envelope) => {
    set((state) => {
      const reduced = reduceRuntimeEvent(
        { workspace: state.workspace, activeTurnByThread: state.activeTurnByThread },
        envelope,
      );
      return {
        ...state,
        workspace: reduced.workspace,
        activeTurnByThread: reduced.activeTurnByThread,
      };
    });
  },

  applyThreadTitleUpdated: (envelope) => {
    set((state) => {
      if (!state.workspace) return {};
      return {
        workspace: {
          ...state.workspace,
          projects: state.workspace.projects.map((project) =>
            project.id !== envelope.projectID
              ? project
              : {
                  ...project,
                  threads: project.threads.map((thread) =>
                    thread.id === envelope.threadID
                      ? { ...thread, title: envelope.title }
                      : thread),
                }),
        },
      };
    });
  },

  applyTurnFinished: (envelope) => {
    set((state) => {
      const unseenTarget = unseenTargetForFinishedTurn(
        state.workspace,
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
