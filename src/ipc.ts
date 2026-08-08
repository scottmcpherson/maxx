// Thin typed wrapper over the Tauri command surface.

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type {
  BrowserArtifactContent,
  BrowserFrameSubscription,
  BrowserHumanInput,
  BrowserRenderedFrame,
  BrowserTabSummary,
  BrowserUiReveal,
} from "./browser";
import { isMenuActionID, type MenuActionID, type MenuActionPayload } from "./menu";
import type { UpdateStatus } from "./updates";
import type { VoiceCredentialStatus, VoiceEvent, VoiceSettings } from "./voice/types";
import {
  ActiveTurnRecord,
  AgentDefinition,
  ChatProvider,
  ChatProject,
  ChatThread,
  ProviderHealth,
  ProviderModelCatalog,
  ProviderProfile,
  RuntimeEventEnvelope,
  RuntimeInteractionDecision,
  TurnFinishedEnvelope,
  WorkspaceDocument,
} from "./contract/types";

export interface ResolvedMediaSource {
  path: string;
  kind: "image" | "video" | "audio";
  mimeType: string;
  displayName: string;
}

export const ipc = {
  workspaceSnapshot: () => invoke<WorkspaceDocument>("workspace_snapshot"),
  activeTurns: () => invoke<ActiveTurnRecord[]>("active_turns"),
  addProject: (folderPath: string) => invoke<ChatProject>("add_project", { folderPath }),
  removeProject: (projectId: string) => invoke<void>("remove_project", { projectId }),
  addThread: (projectId: string, provider: ChatProvider, model: string, title: string) =>
    invoke<ChatThread>("add_thread", { projectId, provider, model, title }),
  addThreadWithRuntime: (
    projectId: string,
    provider: ChatProvider,
    model: string,
    title: string,
    effort?: string | null,
    speed?: string | null,
  ) =>
    invoke<ChatThread>("add_thread_with_runtime", {
      projectId,
      provider,
      model,
      title,
      effort: effort || null,
      speed: speed || null,
    }),
  removeThread: (projectId: string, threadId: string) =>
    invoke<void>("remove_thread", { projectId, threadId }),
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
  ) => invoke<void>("update_thread", { projectId, threadId, ...updates }),
  updateProfiles: (profiles: ProviderProfile[]) =>
    invoke<ProviderProfile[]>("update_profiles", { profiles }),
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
  ) => invoke<ChatThread>("start_side_thread", { projectId, parentThreadId, agentIds, prompt, imagePaths }),
  sendAgentPrompt: (projectId: string, threadId: string, agentIds: string[], prompt: string, imagePaths: string[]) =>
    invoke<string>("send_agent_prompt", { projectId, threadId, agentIds, prompt, imagePaths }),
  sendPrompt: (projectId: string, threadId: string, prompt: string, imagePaths: string[]) =>
    invoke<string>("send_prompt", { projectId, threadId, prompt, imagePaths }),
  cancelTurn: (turnId: string) => invoke<void>("cancel_turn", { turnId }),
  resolveRequest: (
    projectId: string,
    threadId: string,
    requestId: string,
    decision: RuntimeInteractionDecision,
  ) => invoke<void>("resolve_request", { projectId, threadId, requestId, decision }),
  providerHealth: (profileId: string) => invoke<ProviderHealth>("provider_health", { profileId }),
  listProviderModels: (
    provider: ChatProvider,
    profileId?: string,
    workingDirectory?: string,
  ) =>
    invoke<ProviderModelCatalog>("list_provider_models", {
      provider,
      profileId: profileId ?? null,
      workingDirectory: workingDirectory ?? null,
    }),
  resolveMediaSource: (projectId: string, threadId: string, destination: string) =>
    invoke<ResolvedMediaSource>("resolve_media_source", { projectId, threadId, destination }),

  // Shared browser surface. Rust owns the Chromium targets and the control
  // broker; React renders compressed frames and forwards explicit human input.
  browserUiTabs: (threadId: string) =>
    invoke<BrowserTabSummary[]>("browser_ui_tabs", { threadId }),
  browserUiOpenTab: (threadId: string, url: string | null) =>
    invoke<string>("browser_ui_open_tab", { threadId, url }),
  browserUiSelectTab: (tabId: string) => invoke<void>("browser_ui_select_tab", { tabId }),
  browserUiCloseTab: (tabId: string) => invoke<void>("browser_ui_close_tab", { tabId }),
  browserUiNavigate: (tabId: string, url: string) =>
    invoke<void>("browser_ui_navigate", { tabId, url }),
  browserUiBack: (tabId: string) => invoke<void>("browser_ui_back", { tabId }),
  browserUiForward: (tabId: string) => invoke<void>("browser_ui_forward", { tabId }),
  browserUiReload: (tabId: string) => invoke<void>("browser_ui_reload", { tabId }),
  browserUiStartFrameStream: (tabId: string) =>
    invoke<BrowserFrameSubscription>("browser_ui_start_frame_stream", { tabId }),
  browserUiStopFrameStream: (tabId: string, streamId: string) =>
    invoke<void>("browser_ui_stop_frame_stream", { tabId, streamId }),
  browserUiArtifact: (threadId: string, artifactId: string) =>
    invoke<BrowserArtifactContent>("browser_ui_artifact", { threadId, artifactId }),
  browserUiInput: (tabId: string, input: BrowserHumanInput) =>
    invoke<number>("browser_ui_input", { tabId, input }),

  // Voice dictation. Rust owns the credential and the socket; the webview only
  // captures audio and renders what comes back.
  voiceStatus: () => invoke<VoiceCredentialStatus>("voice_status"),
  updateVoiceSettings: (settings: VoiceSettings) =>
    invoke<VoiceSettings>("update_voice_settings", { settings }),
  /** Resolves as soon as the session exists — the socket is still connecting. */
  voiceStart: () => invoke<number>("voice_start"),
  voiceSendAudio: (session: number, chunk: string) =>
    invoke<void>("voice_send_audio", { session, chunk }),
  /** Drains: the last utterance still lands before the session ends. */
  voiceStop: (session: number) => invoke<void>("voice_stop", { session }),

  /** Same check the "Check for Updates…" menu item runs. */
  checkForUpdates: () => invoke<UpdateStatus>("check_for_updates"),

  /**
   * Rebinds the key equivalents of the two remappable View items. AppKit owns
   * them from then on, which is the only way they still fire while the browser
   * pane's child webview holds first responder. `null` clears the accelerator.
   */
  setShortcutAccelerators: (toggleSidebar: string | null, toggleBrowser: string | null) =>
    invoke<void>("set_shortcut_accelerators", { toggleSidebar, toggleBrowser }),

  /** Native menu / tray activations. Unknown ids are dropped, not thrown on. */
  onMenuAction: (handler: (id: MenuActionID) => void): Promise<UnlistenFn> =>
    listen<MenuActionPayload>("menu://action", (event) => {
      if (isMenuActionID(event.payload.id)) handler(event.payload.id);
    }),
  onUpdateStatus: (handler: (status: UpdateStatus) => void): Promise<UnlistenFn> =>
    listen<UpdateStatus>("updater://status", (event) => handler(event.payload)),

  onVoiceEvent: (handler: (event: VoiceEvent) => void): Promise<UnlistenFn> =>
    listen<VoiceEvent>("voice://event", (event) => handler(event.payload)),

  onBrowserReveal: (handler: (event: BrowserUiReveal) => void): Promise<UnlistenFn> =>
    listen<BrowserUiReveal>("browser://reveal", (event) => handler(event.payload)),
  onBrowserFrame: (handler: (frame: BrowserRenderedFrame) => void): Promise<UnlistenFn> =>
    listen<BrowserRenderedFrame>("browser://frame", (event) => handler(event.payload)),

  onRuntimeEvent: (handler: (envelope: RuntimeEventEnvelope) => void): Promise<UnlistenFn> =>
    listen<RuntimeEventEnvelope>("runtime://event", (event) => handler(event.payload)),
  onTurnFinished: (handler: (envelope: TurnFinishedEnvelope) => void): Promise<UnlistenFn> =>
    listen<TurnFinishedEnvelope>("turn://finished", (event) => handler(event.payload)),
};
