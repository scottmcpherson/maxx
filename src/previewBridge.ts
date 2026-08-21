import type {
  AgentDefinition,
  ChatProject,
  ChatProvider,
  ChatThread,
  ProviderProfile,
  WorkspaceDocument,
} from "./contract/types";
import { DEFAULT_COMPUTER_USE_SETTINGS } from "./contract/types";
import type { HostStatus, RemoteHostStatus, TailscaleDiscovery } from "./host/types";
import { DEFAULT_VOICE_SETTINGS } from "./voice/types";

const APPLE_EPOCH_OFFSET = 978_307_200;
const now = () => Date.now() / 1_000 - APPLE_EPOCH_OFFSET;
const clone = <T,>(value: T): T => structuredClone(value);

const profiles: ProviderProfile[] = [
  {
    id: "codex-default",
    provider: "codex",
    displayName: "Codex",
    environment: {},
    colorHex: "#3b82f6",
    isEnabled: true,
    hiddenModels: [],
  },
  {
    id: "claude-default",
    provider: "claude",
    displayName: "Claude",
    environment: {},
    colorHex: "#d97757",
    isEnabled: true,
    hiddenModels: [],
  },
  {
    id: "hermes-default",
    provider: "hermes",
    displayName: "Hermes",
    serverURL: "http://sparky.local:8000/v1",
    environment: {},
    colorHex: "#8a93a5",
    isEnabled: true,
    hiddenModels: [],
  },
];

const agents: AgentDefinition[] = [
  {
    id: "reviewer",
    name: "Reviewer",
    instructions: "Review changes for correctness and clarity.",
    provider: "codex",
    model: "gpt-5.6-codex",
    effort: "high",
    colorHex: "#3b82f6",
    emoji: "✦",
    createdAt: now() - 86_400,
    updatedAt: now() - 3_600,
  },
];

function sampleThread(
  id: string,
  title: string,
  provider: ChatProvider,
  model: string,
  minutesAgo: number,
): ChatThread {
  const updatedAt = now() - minutesAgo * 60;
  return {
    id,
    title,
    provider,
    model,
    effort: provider === "codex" ? "high" : null,
    messages: [
      {
        id: `${id}-user`,
        role: "user",
        content: "Can you tighten up this interaction and keep it feeling native?",
        createdAt: updatedAt - 90,
      },
      {
        id: `${id}-assistant`,
        role: "assistant",
        content:
          "Absolutely. I’ll keep the structure quiet, make the primary action clearer, and preserve the desktop rhythm.",
        createdAt: updatedAt,
      },
    ],
    runtimeEvents: [],
    interactionRequests: [],
    createdAt: updatedAt - 3_600,
    updatedAt,
  };
}

let localWorkspace: WorkspaceDocument = {
  schemaVersion: 7,
  projects: [
    {
      id: "maxx-project",
      folderPath: "/Users/scott/Developer/maxx-tauri",
      threads: [
        sampleThread("pairing-review", "Review host pairing", "codex", "gpt-5.6-codex", 4),
        sampleThread("desktop-polish", "Desktop polish", "claude", "claude-opus-4.1", 38),
      ],
    },
    {
      id: "iris-project",
      folderPath: "/Users/scott/Developer/iris",
      threads: [sampleThread("connection-notes", "Connection architecture", "hermes", "qwen3.5", 180)],
    },
  ],
  providerProfiles: profiles,
  agents,
  computerUse: DEFAULT_COMPUTER_USE_SETTINGS,
  voice: DEFAULT_VOICE_SETTINGS,
};

const remoteWorkspace: WorkspaceDocument = {
  ...clone(localWorkspace),
  projects: [
    {
      id: "studio-project",
      folderPath: "/Users/scott/Developer/model-lab",
      threads: [sampleThread("model-evaluation", "Evaluate local model", "hermes", "qwen3.5", 12)],
    },
  ],
};

const remoteHost: RemoteHostStatus = {
  id: "studio",
  name: "Studio Mac",
  address: "studio.tailnet.ts.net:7422",
  capabilities: ["workspace-read", "workspace-write", "agent-run", "terminal-control", "browser-control"],
  connected: true,
  lastEventCursor: 42,
  error: "",
};

let hostStatus: HostStatus = {
  id: "browser-preview",
  name: "This computer",
  protocolVersion: 7,
  listening: true,
  bindAddress: "127.0.0.1:7422",
  shareAddress: "this-mac.tailnet.ts.net:7422",
  pairing: null,
  remotes: [remoteHost],
  pairedDevices: [
    {
      id: "studio",
      name: "Studio Mac",
      capabilities: remoteHost.capabilities,
      createdAt: now() - 604_800,
      lastSeenAt: now() - 45,
    },
  ],
};
let previewTtsSession = 0;
const previewTtsSessions = new Set<number>();

function previewPcmChunk(): string {
  const bytes = new Uint8Array(320);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const discovery: TailscaleDiscovery = {
  installed: true,
  running: true,
  selfNode: {
    name: "This computer",
    dnsName: "this-mac.tailnet.ts.net",
    addresses: ["100.64.0.10"],
    online: true,
  },
  peers: [
    {
      name: "Studio Mac",
      dnsName: "studio.tailnet.ts.net",
      addresses: ["100.64.0.11"],
      online: true,
    },
  ],
  error: "",
};

const listeners = new Map<string, Set<(payload: unknown) => void>>();

function projectWithID(projectID: string): ChatProject | undefined {
  return localWorkspace.projects.find((project) => project.id === projectID);
}

function updateThread(params: Record<string, unknown>): void {
  const project = projectWithID(String(params.projectId));
  const thread = project?.threads.find((candidate) => candidate.id === params.threadId);
  if (!thread) return;
  if (typeof params.title === "string") thread.title = params.title;
  if (typeof params.provider === "string") thread.provider = params.provider as ChatProvider;
  if (typeof params.model === "string") thread.model = params.model;
  if ("effort" in params) thread.effort = params.effort as string | null;
  if ("speed" in params) thread.speed = params.speed as string | null;
  thread.updatedAt = now();
}

function addThread(params: Record<string, unknown>): ChatThread {
  const thread = sampleThread(
    crypto.randomUUID(),
    String(params.title || "New chat"),
    (params.provider as ChatProvider) || "codex",
    String(params.model || "Default"),
    0,
  );
  thread.messages = [];
  thread.effort = (params.effort as string | null | undefined) ?? null;
  thread.speed = (params.speed as string | null | undefined) ?? null;
  projectWithID(String(params.projectId))?.threads.unshift(thread);
  return thread;
}

function modelsFor(provider: ChatProvider) {
  const models = {
    codex: [
      { model: "gpt-5.6-codex", displayName: "GPT-5.6 Codex", isDefault: true, effortLevels: ["medium", "high", "xhigh"] },
    ],
    claude: [
      { model: "claude-opus-4.1", displayName: "Claude Opus 4.1", isDefault: true, effortLevels: ["medium", "high"] },
    ],
    hermes: [{ model: "qwen3.5", displayName: "Qwen 3.5", isDefault: true }],
    grok: [{ model: "grok-4", displayName: "Grok 4", isDefault: true }],
    cursor: [],
    opencode: [],
    pi: [],
  } satisfies Record<ChatProvider, Array<Record<string, unknown>>>;
  return { models: models[provider], source: "live" };
}

async function invoke<T>(method: string, rawParams: unknown = {}): Promise<T> {
  const params = (rawParams ?? {}) as Record<string, unknown>;
  let result: unknown;

  switch (method) {
    case "workspace_snapshot":
      result = params.hostId === remoteHost.id ? remoteWorkspace : localWorkspace;
      break;
    case "active_turns":
      result = [];
      break;
    case "git_status":
      result = {
        repositoryRoot: "/Users/scott/Developer/maxx-tauri",
        branch: "main",
        detached: false,
        head: "287770b",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        additions: 451,
        deletions: 63,
        files: [
          { path: "src/components/GitEnvironment.tsx", status: " M", staged: false, unstaged: true, untracked: false },
          { path: "src/git.ts", status: "??", staged: false, unstaged: false, untracked: true },
        ],
        remotes: ["origin"],
      };
      break;
    case "git_branches":
      result = { current: "main", branches: ["main", "codex/new-chat-context"] };
      break;
    case "git_checkout":
    case "git_create_branch":
      throw new Error("Git mutations require the desktop app");
    case "git_commit":
    case "git_push":
      throw new Error("Git mutations require the desktop app");
    case "host_status":
      result = hostStatus;
      break;
    case "host_discovery":
      result = discovery;
      break;
    case "list_provider_models":
      result = modelsFor(params.provider as ChatProvider);
      break;
    case "provider_health":
      result = { profileID: params.profileId, state: "ready", message: "Ready in browser preview" };
      break;
    case "voice_status":
      result = {
        source: "none",
        detail: "Unavailable in browser preview",
        available: false,
        provider: (params.settings as { sttProvider?: string } | undefined)?.sttProvider ?? "xai",
      };
      break;
    case "voice_microphone_access":
      result = { granted: true, status: "granted" };
      break;
    case "voice_test_stt":
      result = {
        provider: (params.settings as { sttProvider?: string } | undefined)?.sttProvider ?? "xai",
        endpoint: (params.settings as { sttApiBase?: string } | undefined)?.sttApiBase ?? "https://api.x.ai",
        model: (params.settings as { sttModel?: string } | undefined)?.sttModel ?? "",
        ok: false,
        code: "preview-unavailable",
        message: "Voice provider checks require the desktop app.",
      };
      break;
    case "voice_list_models":
      result = [{ id: "preview-stt" }];
      break;
    case "voice_list_voices":
      result = [{ id: "preview-voice", name: "Preview Voice", model: "preview-tts", language: "en" }];
      break;
    case "voice_tts_start": {
      const session = ++previewTtsSession;
      previewTtsSessions.add(session);
      result = { session, mimeType: "audio/pcm", sampleRate: 16_000, channels: 1 };
      break;
    }
    case "voice_tts_read": {
      const session = Number(params.session);
      if (!previewTtsSessions.has(session)) {
        result = { chunks: [], done: true, error: "Preview TTS session is no longer active." };
        break;
      }
      const afterSequence = Number(params.afterSequence);
      result = afterSequence < 0
        ? { chunks: [{ sequence: 0, chunk: previewPcmChunk() }], done: true }
        : { chunks: [], done: true };
      break;
    }
    case "voice_tts_cancel":
      previewTtsSessions.delete(Number(params.session));
      result = undefined;
      break;
    case "check_for_updates":
      result = { state: "upToDate", version: "0.1.0" };
      break;
    case "install_update":
      result = { state: "downloading", version: "0.2.0", percent: 0 };
      break;
    case "restart_to_install_update":
      result = { state: "ready", version: "0.2.0" };
      break;
    case "update_profiles":
      localWorkspace = { ...localWorkspace, providerProfiles: params.profiles as ProviderProfile[] };
      result = localWorkspace.providerProfiles;
      break;
    case "update_agents":
      localWorkspace = { ...localWorkspace, agents: params.agents as AgentDefinition[] };
      result = localWorkspace.agents;
      break;
    case "update_title_generation_runtime":
      localWorkspace = { ...localWorkspace, titleGenerationRuntime: params.runtime as WorkspaceDocument["titleGenerationRuntime"] };
      result = localWorkspace.titleGenerationRuntime ?? null;
      break;
    case "update_computer_use_settings":
      localWorkspace = { ...localWorkspace, computerUse: params.settings as WorkspaceDocument["computerUse"] };
      result = localWorkspace.computerUse;
      break;
    case "update_voice_settings":
      localWorkspace = { ...localWorkspace, voice: params.settings as WorkspaceDocument["voice"] };
      result = localWorkspace.voice;
      break;
    case "add_thread":
    case "add_thread_with_runtime":
      result = addThread(params);
      break;
    case "update_thread":
      updateThread(params);
      result = undefined;
      break;
    case "remove_thread": {
      const project = projectWithID(String(params.projectId));
      if (project) project.threads = project.threads.filter((thread) => thread.id !== params.threadId);
      result = undefined;
      break;
    }
    case "remove_project":
      localWorkspace = { ...localWorkspace, projects: localWorkspace.projects.filter((project) => project.id !== params.projectId) };
      result = undefined;
      break;
    case "add_project": {
      const folderPath = String(params.folderPath);
      const project = { id: crypto.randomUUID(), folderPath, threads: [] };
      localWorkspace = { ...localWorkspace, projects: [...localWorkspace.projects, project] };
      result = project;
      break;
    }
    case "home_folder":
      result = { path: "/Users/scott" };
      break;
    case "list_folder":
      result = [
        { name: "Developer", path: "/Users/scott/Developer", kind: "directory" },
        { name: "Documents", path: "/Users/scott/Documents", kind: "directory" },
      ];
      break;
    case "host_create_pairing":
      result = {
        code: "MAXX-4821",
        expiresAt: now() + 600,
        capabilities: params.preset === "voice"
          ? ["voice-control"]
          : params.preset === "full"
            ? ["workspace-read", "workspace-write", "agent-run", "terminal-control", "browser-control", "settings-manage", "voice-control"]
            : ["workspace-read", "workspace-write", "agent-run", "terminal-control", "browser-control"],
      };
      hostStatus = { ...hostStatus, pairing: result as HostStatus["pairing"] };
      break;
    case "host_cancel_pairing":
      hostStatus = { ...hostStatus, pairing: null };
      result = undefined;
      break;
    case "host_listen":
      hostStatus = { ...hostStatus, listening: true };
      result = hostStatus.shareAddress;
      break;
    case "host_unlisten":
      hostStatus = { ...hostStatus, listening: false, pairing: null };
      result = undefined;
      break;
    case "host_connect":
      result = remoteHost;
      break;
    case "host_disconnect":
      hostStatus = { ...hostStatus, remotes: [] };
      result = undefined;
      break;
    case "browser_ui_tabs":
    case "dialog_open_images":
      result = [];
      break;
    case "browser_chrome_import_status":
    case "browser_import_chrome":
      result = { available: false, profiles: [], importedProfileId: null, error: "Browser controls require the desktop app" };
      break;
    case "dialog_open_project":
    case "dialog_open_agent_image":
    case "resolve_media_source":
      result = null;
      break;
    case "browser_fill_saved_password":
      result = false;
      break;
    case "voice_start":
      result = 1;
      break;
    case "browser_ui_open_tab":
    case "import_agent_image":
    case "send_prompt":
    case "send_agent_prompt":
    case "start_side_thread":
      result = crypto.randomUUID();
      break;
    case "create_folder":
      result = { path: `${params.parent}/${params.name}` };
      break;
    case "upload_media":
      result = { id: crypto.randomUUID(), path: "/tmp/preview-media", mimeType: params.mimeType, displayName: params.displayName };
      break;
    case "read_media":
    case "load_media":
      result = { mimeType: "image/png", displayName: "Preview image", dataBase64: "" };
      break;
    case "authorize_image_previews":
    case "browser_annotation_mode":
    case "browser_annotation_selections":
    case "browser_ui_back":
    case "browser_ui_close_tab":
    case "browser_ui_forward":
    case "browser_ui_navigate":
    case "browser_ui_reload":
    case "browser_ui_select_tab":
    case "browser_view_bounds":
    case "browser_view_visible":
    case "cancel_turn":
    case "voice_interrupt_turn":
    case "host_revoke_peer":
    case "resolve_request":
    case "set_shortcut_accelerators":
    case "voice_send_audio":
    case "voice_stop":
      result = undefined;
      break;
    default:
      throw new Error(`Browser preview does not implement ${method}`);
  }

  return clone(result) as T;
}

export function installBrowserPreviewBridge(): void {
  if (!import.meta.env.DEV || typeof window.maxx !== "undefined") return;

  const simulatedUpdateVersion = new URLSearchParams(window.location.search).get("update");

  window.maxx = {
    invoke,
    listen: (event, callback) => {
      const callbackUnknown = callback as (payload: unknown) => void;
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(callbackUnknown);
      listeners.set(event, eventListeners);
      if (event === "updater://status" && simulatedUpdateVersion) {
        queueMicrotask(() => callbackUnknown({
          state: "available",
          version: simulatedUpdateVersion,
          notes: null,
          date: new Date().toISOString(),
        }));
      }
      return () => eventListeners.delete(callbackUnknown);
    },
    mediaURL: () => "",
  };
}
