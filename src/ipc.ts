// Thin typed wrapper over the Electron preload boundary. Remote web content
// lives in separate sandboxed WebContentsViews and never receives this API.

type UnlistenFn = () => void;
import type {
  BrowserArtifactContent,
  BrowserAnnotation,
  BrowserAnnotationEvent,
  BrowserAnnotationSelection,
  ChromeImportStatus,
  BrowserNativeState,
  BrowserTabSummary,
  BrowserUiReveal,
} from "./browser";
import {
  isMenuActionID,
  isNativeContextMenuAction,
  isNativeContextMenuKind,
  type MenuActionID,
  type MenuActionPayload,
  type NativeContextMenuPayload,
  type NativeContextMenuRequest,
} from "./menu";
import type { UpdateStatus } from "./updates";
import type {
  VoiceCredentialStatus,
  VoiceEvent,
  VoiceProviderTestResult,
  VoiceModel,
  VoiceMicrophoneAccess,
  VoiceSettings,
  VoiceProfile,
  VoiceTtsReadResult,
  VoiceTtsStartResult,
} from "./voice/types";
import type { GitBranchList, GitCommitResult, GitRepositoryStatus } from "./git";
import {
  ActiveTurnRecord,
  AgentDefinition,
  Automation,
  AutomationChangedEnvelope,
  AutomationCreateRequest,
  AutomationRun,
  AutomationUpdateRequest,
  ChatProvider,
  ChatProject,
  ChatTextSelection,
  ChatThread,
  ChatSurface,
  ProviderHealth,
  ProviderCommandCatalog,
  ProviderModelCatalog,
  ProviderProfile,
  RuntimeEventEnvelope,
  RuntimeInteractionDecision,
  ThreadTitleUpdatedEnvelope,
  TitleGenerationRuntime,
  TerminalRead,
  TerminalStatus,
  TerminalSupport,
  TurnFinishedEnvelope,
  WorkspaceDocument,
} from "./contract/types";

import { isLocalHost } from "./host/session";
import type {
  AccessPreset,
  FolderEntry,
  HostStatus,
  MediaBytes,
  PairingInvitation,
  RemoteHostStatus,
  TailscaleDiscovery,
} from "./host/types";

function invoke<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return window.maxx.invoke<T>(method, params);
}

function invokeOnHost<T>(
  hostId: string | null | undefined,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (isLocalHost(hostId)) return invoke<T>(method, params);
  return invoke<T>(method, { ...params, hostId });
}

function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return Promise.resolve(window.maxx.listen<T>(event, handler));
}

/** Validate the untrusted event payload before it reaches a composer. */
export function normalizeVoiceEvent(value: unknown): VoiceEvent | null {
  let candidate = value;
  if (candidate && typeof candidate === "object" && "payload" in candidate) {
    candidate = (candidate as { payload?: unknown }).payload;
  }
  if (!candidate || typeof candidate !== "object") return null;
  const event = candidate as Record<string, unknown>;
  if (typeof event.kind !== "string" || typeof event.session !== "number") return null;
  switch (event.kind) {
    case "state":
      return event.state === "connecting" || event.state === "listening" || event.state === "stopped"
        ? { kind: "state", session: event.session, state: event.state }
        : null;
    case "interim":
    case "final":
      return typeof event.text === "string"
        ? { kind: event.kind, session: event.session, text: event.text }
        : null;
    case "error":
      return typeof event.message === "string"
        ? {
            kind: "error",
            session: event.session,
            message: event.message,
            hint: typeof event.hint === "string" ? event.hint : null,
            ...(typeof event.code === "string" ? { code: event.code } : {}),
          }
        : null;
    case "telemetry":
      return typeof event.metric === "string" && typeof event.value === "number"
        ? { kind: "telemetry", session: event.session, metric: event.metric, value: event.value }
        : null;
    default:
      return null;
  }
}

export interface ResolvedMediaSource {
  path: string;
  kind: "image" | "video" | "audio";
  mimeType: string;
  displayName: string;
}

export const ipc = {
  workspaceSnapshot: (hostId?: string | null) =>
    invokeOnHost<WorkspaceDocument>(hostId, "workspace_snapshot"),
  /** Maxx-owned scheduler APIs. These calls deliberately do not route through a provider host. */
  listAutomations: () => invoke<Automation[]>("list_automations"),
  createAutomation: (request: AutomationCreateRequest) =>
    invoke<Automation>("create_automation", { ...request }),
  updateAutomation: (id: string, updates: AutomationUpdateRequest) =>
    invoke<Automation>("update_automation", { id, ...updates }),
  deleteAutomation: (id: string) => invoke<void>("delete_automation", { id }),
  runAutomation: (id: string) => invoke<AutomationRun>("run_automation", { id }),
  onAutomationChanged: (handler: (event: AutomationChangedEnvelope) => void) =>
    listen<AutomationChangedEnvelope>("automation://changed", handler),
  activeTurns: (hostId?: string | null) =>
    invokeOnHost<ActiveTurnRecord[]>(hostId, "active_turns"),
  gitStatus: (projectId: string, hostId?: string | null, threadId?: string | null) =>
    invokeOnHost<GitRepositoryStatus | null>(hostId, "git_status", { projectId, threadId: threadId || null }),
  gitBranches: (projectId: string, hostId?: string | null) =>
    invokeOnHost<GitBranchList | null>(hostId, "git_branches", { projectId }),
  gitCheckout: (projectId: string, branch: string, hostId?: string | null) =>
    invokeOnHost<GitBranchList>(hostId, "git_checkout", { projectId, branch }),
  gitCreateBranch: (projectId: string, branch: string, hostId?: string | null) =>
    invokeOnHost<GitBranchList>(hostId, "git_create_branch", { projectId, branch }),
  gitCommit: (
    projectId: string,
    message: string,
    includeUnstagedChanges: boolean,
    hostId?: string | null,
    threadId?: string | null,
  ) => invokeOnHost<GitCommitResult>(hostId, "git_commit", {
    projectId,
    threadId: threadId || null,
    message,
    includeUnstagedChanges,
  }),
  gitPush: (projectId: string, hostId?: string | null, threadId?: string | null) =>
    invokeOnHost<GitRepositoryStatus>(hostId, "git_push", { projectId, threadId: threadId || null }),
  addProject: (folderPath: string, hostId?: string | null) =>
    invokeOnHost<ChatProject>(hostId, "add_project", { folderPath }),
  removeProject: (projectId: string, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "remove_project", { projectId }),
  addThread: (
    projectId: string,
    provider: ChatProvider,
    model: string,
    title: string,
    hostId?: string | null,
  ) => invokeOnHost<ChatThread>(hostId, "add_thread", { projectId, provider, model, title }),
  addChat: (
    provider: ChatProvider,
    model: string,
    title: string,
    effort?: string | null,
    speed?: string | null,
  ) => invokeOnHost<ChatThread>("local", "add_chat", {
    provider,
    model,
    title,
    effort: effort || null,
    speed: speed || null,
  }),
  addThreadWithRuntime: (
    projectId: string,
    provider: ChatProvider,
    model: string,
    title: string,
    effort?: string | null,
    speed?: string | null,
    surface: ChatSurface = "gui",
    hostId?: string | null,
    worktree = false,
  ) =>
    invokeOnHost<ChatThread>(hostId, "add_thread_with_runtime", {
      projectId,
      provider,
      model,
      title,
      effort: effort || null,
      speed: speed || null,
      surface,
      worktree,
    }),
  removeThread: (projectId: string, threadId: string, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "remove_thread", { projectId, threadId }),
  updateThread: (
    projectId: string,
    threadId: string,
    updates: {
      title?: string;
      provider?: ChatProvider;
      model?: string;
      effort?: string | null;
      speed?: string | null;
      updateRuntimeKnobs?: boolean;
    },
    hostId?: string | null,
  ) => invokeOnHost<void>(hostId, "update_thread", { projectId, threadId, ...updates }),
  terminalSupport: (provider: ChatProvider, hostId?: string | null) =>
    invokeOnHost<TerminalSupport>(hostId, "terminal_support", { provider }),
  terminalStart: (
    projectId: string,
    threadId: string,
    rows: number,
    cols: number,
    hostId?: string | null,
  ) => invokeOnHost<TerminalStatus>(hostId, "terminal_start", { projectId, threadId, rows, cols }),
  terminalStatus: (threadId: string, hostId?: string | null) =>
    invokeOnHost<TerminalStatus | null>(hostId, "terminal_status", { threadId }),
  terminalInput: (threadId: string, dataBase64: string, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "terminal_input", { threadId, dataBase64 }),
  terminalResize: (threadId: string, rows: number, cols: number, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "terminal_resize", { threadId, rows, cols }),
  terminalRead: (threadId: string, after: number, hostId?: string | null) =>
    invokeOnHost<TerminalRead>(hostId, "terminal_read", { threadId, after, maxBytes: 262_144 }),
  terminalStop: (
    projectId: string,
    threadId: string,
    archive: string | null,
    hostId?: string | null,
  ) => invokeOnHost<void>(hostId, "terminal_stop", { projectId, threadId, archive }),
  shellTerminalStart: (
    projectId: string,
    threadId: string,
    sessionId: string,
    rows: number,
    cols: number,
    hostId?: string | null,
  ) => invokeOnHost<TerminalStatus>(hostId, "shell_terminal_start", {
    projectId,
    threadId,
    sessionId,
    rows,
    cols,
  }),
  shellTerminalStatus: (sessionId: string, hostId?: string | null) =>
    invokeOnHost<TerminalStatus | null>(hostId, "shell_terminal_status", { sessionId }),
  shellTerminalInput: (sessionId: string, dataBase64: string, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "shell_terminal_input", { sessionId, dataBase64 }),
  shellTerminalResize: (
    sessionId: string,
    rows: number,
    cols: number,
    hostId?: string | null,
  ) => invokeOnHost<void>(hostId, "shell_terminal_resize", { sessionId, rows, cols }),
  shellTerminalRead: (sessionId: string, after: number, hostId?: string | null) =>
    invokeOnHost<TerminalRead>(hostId, "shell_terminal_read", { sessionId, after, maxBytes: 262_144 }),
  shellTerminalStop: (sessionId: string, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "shell_terminal_stop", { sessionId }),
  updateProfiles: (profiles: ProviderProfile[]) =>
    invoke<ProviderProfile[]>("update_profiles", { profiles }),
  updateTitleGenerationRuntime: (runtime: TitleGenerationRuntime | null) =>
    invoke<TitleGenerationRuntime | null>("update_title_generation_runtime", { runtime }),
  updateAgents: (agents: AgentDefinition[]) =>
    invoke<AgentDefinition[]>("update_agents", { agents }),
  importAgentImage: (agentId: string, sourcePath: string) =>
    invoke<string>("import_agent_image", { agentId, sourcePath }),
  authorizeImagePreviews: (imagePaths: string[]) =>
    invoke<void>("authorize_image_previews", { imagePaths }),
  startSideThread: (
    projectId: string,
    parentThreadId: string,
    agentIds: string[],
    prompt: string,
    imagePaths: string[],
    hostId?: string | null,
    attachmentIds: string[] = [],
    annotations: BrowserAnnotation[] = [],
  ) =>
    invokeOnHost<ChatThread>(hostId, "start_side_thread", {
      projectId,
      parentThreadId,
      agentIds,
      prompt,
      imagePaths,
      attachmentIds,
      annotations,
    }),
  sendAgentPrompt: (
    projectId: string,
    threadId: string,
    agentIds: string[],
    prompt: string,
    imagePaths: string[],
    hostId?: string | null,
    attachmentIds: string[] = [],
  ) =>
    invokeOnHost<string>(hostId, "send_agent_prompt", {
      projectId,
      threadId,
      agentIds,
      prompt,
      imagePaths,
      attachmentIds,
    }),
  sendPrompt: (
    projectId: string,
    threadId: string,
    prompt: string,
    imagePaths: string[],
    hostId?: string | null,
    attachmentIds: string[] = [],
    annotations: BrowserAnnotation[] = [],
    textSelections: ChatTextSelection[] = [],
  ) =>
    invokeOnHost<string>(hostId, "send_prompt", {
      projectId,
      threadId,
      prompt,
      imagePaths,
      attachmentIds,
      annotations,
      textSelections,
    }),
  createSideChat: (projectId: string, parentThreadId: string, hostId?: string | null) =>
    invokeOnHost<ChatThread>(hostId, "create_side_chat", { projectId, parentThreadId }),
  steerPrompt: (
    projectId: string,
    threadId: string,
    turnId: string,
    prompt: string,
    imagePaths: string[],
    hostId?: string | null,
    attachmentIds: string[] = [],
    annotations: BrowserAnnotation[] = [],
  ) =>
    invokeOnHost<void>(hostId, "steer_prompt", {
      projectId,
      threadId,
      turnId,
      prompt,
      imagePaths,
      attachmentIds,
      annotations,
    }),
  cancelTurn: (turnId: string, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "cancel_turn", { turnId }),
  voiceInterruptTurn: (
    projectId: string,
    threadId: string,
    turnId: string,
    spokenText: string,
    hostId?: string | null,
  ) => invokeOnHost<void>(hostId, "voice_interrupt_turn", {
    projectId,
    threadId,
    turnId,
    spokenText,
  }),
  resolveRequest: (
    projectId: string,
    threadId: string,
    requestId: string,
    decision: RuntimeInteractionDecision,
    hostId?: string | null,
  ) => invokeOnHost<void>(hostId, "resolve_request", { projectId, threadId, requestId, decision }),
  providerHealth: (profileId: string) => invoke<ProviderHealth>("provider_health", { profileId }),
  listProviderModels: (
    provider: ChatProvider,
    profileId?: string,
    workingDirectory?: string,
    hostId?: string | null,
  ) =>
    invokeOnHost<ProviderModelCatalog>(hostId, "list_provider_models", {
      provider,
      profileId: profileId ?? null,
      workingDirectory: workingDirectory ?? null,
    }),
  listProviderCommands: (
    provider: ChatProvider,
    profileId?: string,
    workingDirectory?: string,
    hostId?: string | null,
  ) =>
    invokeOnHost<ProviderCommandCatalog>(hostId, "list_provider_commands", {
      provider,
      profileId: profileId ?? null,
      workingDirectory: workingDirectory ?? null,
    }),
  resolveMediaSource: (projectId: string, threadId: string, destination: string, hostId?: string | null) =>
    invokeOnHost<ResolvedMediaSource>(hostId, "resolve_media_source", { projectId, threadId, destination }),
  hostStatus: () => invoke<HostStatus>("host_status"),
  hostDiscovery: () => invoke<TailscaleDiscovery>("host_discovery"),
  hostListen: (bindAddress?: string) =>
    invoke<string>("host_listen", { bindAddress: bindAddress ?? null }),
  hostUnlisten: () => invoke<void>("host_unlisten"),
  hostCreatePairing: (preset: AccessPreset) =>
    invoke<PairingInvitation>("host_create_pairing", { preset }),
  hostCancelPairing: () => invoke<void>("host_cancel_pairing"),
  hostConnect: (address: string, code: string) =>
    invoke<RemoteHostStatus>("host_connect", { address, code }),
  hostDisconnect: (hostId: string) => invoke<void>("host_disconnect", { hostId }),
  hostRevokePeer: (peerId: string) => invoke<void>("host_revoke_peer", { peerId }),
  writeClipboardText: (text: string) => invoke<void>("clipboard_write_text", { text }),
  listFolder: (path: string, hostId?: string | null) =>
    invokeOnHost<FolderEntry[]>(hostId, "list_folder", { path }),
  createFolder: (parent: string, name: string, hostId?: string | null) =>
    invokeOnHost<{ path: string }>(hostId, "create_folder", { parent, name }),
  homeFolder: (hostId?: string | null) =>
    invokeOnHost<{ path: string }>(hostId, "home_folder"),
  uploadMedia: (
    dataBase64: string,
    mimeType: string,
    displayName: string,
    hostId?: string | null,
  ) =>
    invokeOnHost<{ id: string; path: string; mimeType: string; displayName: string }>(
      hostId,
      "upload_media",
      { dataBase64, mimeType, displayName },
    ),
  readMedia: (attachmentId: string, hostId?: string | null) =>
    invokeOnHost<MediaBytes>(hostId, "read_media", { attachmentId }),
  loadMedia: (projectId: string, threadId: string, destination: string, hostId?: string | null) =>
    invokeOnHost<MediaBytes>(hostId, "load_media", { projectId, threadId, destination }),
  onHostEvent: (
    handler: (payload: { hostId: string; event: string; payload: unknown }) => void,
  ): Promise<UnlistenFn> => listen("host://event", handler),

  // Shared browser surface. Electron renders each tab directly and Rust keeps
  // the provider scope/control broker authoritative.
  browserUiTabs: (threadId: string) =>
    invoke<BrowserTabSummary[]>("browser_ui_tabs", { threadId }),
  browserUiOpenTab: (threadId: string, url: string | null) =>
    invoke<string>("browser_ui_open_tab", { threadId, url }),
  browserUiSelectTab: (tabId: string) => invoke<void>("browser_ui_select_tab", { tabId }),
  browserUiCloseTab: (tabId: string) => invoke<void>("browser_ui_close_tab", { tabId }),
  browserUiReorderTabs: (threadId: string, tabIds: string[]) =>
    invoke<void>("browser_ui_reorder_tabs", { threadId, tabIds }),
  browserUiNavigate: (tabId: string, url: string) =>
    invoke<void>("browser_ui_navigate", { tabId, url }),
  browserUiBack: (tabId: string) => invoke<void>("browser_ui_back", { tabId }),
  browserUiForward: (tabId: string) => invoke<void>("browser_ui_forward", { tabId }),
  browserUiReload: (tabId: string) => invoke<void>("browser_ui_reload", { tabId }),
  browserUiArtifact: (threadId: string, artifactId: string) =>
    invoke<BrowserArtifactContent>("browser_ui_artifact", { threadId, artifactId }),
  browserViewBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    invoke<void>("browser_view_bounds", { bounds }),
  browserViewVisible: (visible: boolean) => invoke<void>("browser_view_visible", { visible }),
  browserAnnotationMode: (tabId: string, enabled: boolean) =>
    invoke<void>("browser_annotation_mode", { tabId, enabled }),
  browserAnnotationSelections: (tabId: string, selections: BrowserAnnotationSelection[]) =>
    invoke<void>("browser_annotation_selections", { tabId, selections }),
  browserChromeImportStatus: () => invoke<ChromeImportStatus>("browser_chrome_import_status"),
  browserImportChrome: (profileId: string) =>
    invoke<ChromeImportStatus>("browser_import_chrome", { profileId }),
  browserFillSavedPassword: (tabId: string) =>
    invoke<boolean>("browser_fill_saved_password", { tabId }),

  openProjectDialog: () => invoke<string | null>("dialog_open_project"),
  openImagesDialog: () => invoke<string[]>("dialog_open_images"),
  openAgentImageDialog: () => invoke<string | null>("dialog_open_agent_image"),
  // Voice dictation. Rust owns the credential and the socket; the webview only
  // captures audio and renders what comes back. `hostId` routes execution;
  // settings remain client-owned and are sent as an explicit snapshot.
  voiceStatus: (settings?: VoiceSettings, hostId?: string | null) =>
    invokeOnHost<VoiceCredentialStatus>(hostId, "voice_status", settings ? { settings } : {}),
  voiceMicrophoneAccess: () => invoke<VoiceMicrophoneAccess>("voice_microphone_access"),
  updateVoiceSettings: (settings: VoiceSettings) =>
    invoke<VoiceSettings>("update_voice_settings", { settings }),
  voiceTestStt: (settings?: VoiceSettings, hostId?: string | null) =>
    invokeOnHost<VoiceProviderTestResult>(hostId, "voice_test_stt", settings ? { settings } : {}),
  voiceListVoices: (settings: VoiceSettings, hostId?: string | null) =>
    invokeOnHost<VoiceProfile[]>(hostId, "voice_list_voices", { settings }),
  voiceListModels: (settings: VoiceSettings, hostId?: string | null) =>
    invokeOnHost<VoiceModel[]>(hostId, "voice_list_models", { settings }),
  voiceTtsStart: (
    settings: VoiceSettings,
    text: string,
    voiceId?: string | null,
    hostId?: string | null,
  ) => invokeOnHost<VoiceTtsStartResult>(hostId, "voice_tts_start", {
    settings,
    text,
    voiceId: voiceId ?? null,
  }),
  voiceTtsRead: (
    session: number,
    afterSequence: number,
    maxBytes: number,
    hostId?: string | null,
  ) => invokeOnHost<VoiceTtsReadResult>(hostId, "voice_tts_read", {
    session,
    afterSequence,
    maxBytes,
  }),
  voiceTtsCancel: (session: number, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "voice_tts_cancel", { session }),
  /** Resolves as soon as the session exists — the socket is still connecting. */
  voiceStart: (settings?: VoiceSettings, hostId?: string | null) =>
    invokeOnHost<number>(hostId, "voice_start", settings ? { settings } : {}),
  voiceSendAudio: (session: number, chunk: string, sequence: number, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "voice_send_audio", { session, chunk, sequence }),
  /** Drains: the last utterance still lands before the session ends. */
  voiceStop: (session: number, hostId?: string | null) =>
    invokeOnHost<void>(hostId, "voice_stop", { session }),

  /** Same check the "Check for Updates…" menu item runs. */
  checkForUpdates: () => invoke<UpdateStatus>("check_for_updates"),
  installUpdate: () => invoke<UpdateStatus | null>("install_update"),
  restartToInstallUpdate: () => invoke<UpdateStatus>("restart_to_install_update"),

  /**
   * Rebinds the key equivalents of the two remappable View items. AppKit owns
   * them from then on, so they still fire while Chromium holds focus. `null`
   * clears the accelerator.
   */
  setShortcutAccelerators: (toggleSidebar: string | null, toggleBrowser: string | null) =>
    invoke<void>("set_shortcut_accelerators", { toggleSidebar, toggleBrowser }),

  /** Opens an OS-native context menu at renderer content coordinates. */
  openContextMenu: (request: NativeContextMenuRequest) =>
    invoke<void>("context_menu_popup", { ...request }),

  /** Native menu / tray activations. Unknown ids are dropped, not thrown on. */
  onMenuAction: (handler: (id: MenuActionID) => void): Promise<UnlistenFn> =>
    listen<MenuActionPayload>("menu://action", (payload) => {
      if (isMenuActionID(payload.id)) handler(payload.id);
    }),
  onContextMenuAction: (handler: (payload: NativeContextMenuPayload) => void): Promise<UnlistenFn> =>
    listen<unknown>("context-menu://action", (payload) => {
      if (!payload || typeof payload !== "object") return;
      const value = payload as Record<string, unknown>;
      if (!isNativeContextMenuKind(value.kind) || !isNativeContextMenuAction(value.action)) return;
      if (typeof value.projectID !== "string" || !value.projectID) return;
      if (value.hostID !== undefined && typeof value.hostID !== "string") return;
      if (value.threadID !== undefined && typeof value.threadID !== "string") return;
      if (value.pinned !== undefined && typeof value.pinned !== "boolean") return;
      handler({
        kind: value.kind,
        action: value.action,
        projectID: value.projectID,
        hostID: value.hostID,
        threadID: value.threadID,
        pinned: value.pinned,
      });
    }),
  onUpdateStatus: (handler: (status: UpdateStatus) => void): Promise<UnlistenFn> =>
    listen<UpdateStatus>("updater://status", handler),

  onVoiceEvent: (handler: (event: VoiceEvent) => void, hostId?: string | null): Promise<UnlistenFn> => {
    const remote = !isLocalHost(hostId);
    const localListener = remote
      ? Promise.resolve<UnlistenFn>(() => {})
      : listen<unknown>("voice://event", (payload) => {
          const event = normalizeVoiceEvent(payload);
          if (event) handler(event);
        });
    const remoteListener = remote
      ? listen<{ hostId: string; event: string; payload: unknown }>("host://event", (payload) => {
          if (payload.hostId !== hostId || payload.event !== "voice://event") return;
          const event = normalizeVoiceEvent(payload.payload);
          if (event) handler(event);
        })
      : Promise.resolve<UnlistenFn>(() => {});
    return Promise.all([localListener, remoteListener]).then((unlisteners) => () => {
      for (const unlisten of unlisteners) unlisten();
    });
  },

  onBrowserReveal: (handler: (event: BrowserUiReveal) => void): Promise<UnlistenFn> =>
    listen<BrowserUiReveal>("browser://reveal", handler),
  onBrowserState: (handler: (state: BrowserNativeState) => void): Promise<UnlistenFn> =>
    listen<BrowserNativeState>("browser://state", handler),
  onBrowserAnnotation: (handler: (annotation: BrowserAnnotationEvent) => void): Promise<UnlistenFn> =>
    listen<BrowserAnnotationEvent>("browser://annotation", handler),
  onBrowserError: (handler: (error: { tabId: string; code: string; message: string }) => void): Promise<UnlistenFn> =>
    listen("browser://error", handler),

  onRuntimeEvent: (handler: (envelope: RuntimeEventEnvelope) => void): Promise<UnlistenFn> =>
    listen<RuntimeEventEnvelope>("runtime://event", handler),
  onTurnFinished: (handler: (envelope: TurnFinishedEnvelope) => void): Promise<UnlistenFn> =>
    listen<TurnFinishedEnvelope>("turn://finished", handler),
  onThreadTitleUpdated: (handler: (envelope: ThreadTitleUpdatedEnvelope) => void): Promise<UnlistenFn> =>
    listen<ThreadTitleUpdatedEnvelope>("thread://title-updated", handler),
};

export function mediaURL(path: string): string {
  return window.maxx.mediaURL(path);
}
