export type ChatProvider = "codex" | "claude" | "grok" | "cursor" | "opencode" | "pi" | "hermes";

export type ChatAttachment = {
  id: string;
  path: string;
  mimeType: string;
  displayName: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: ChatAttachment[];
  createdAt: number;
  sourceEventID?: string;
};

export type RuntimeItemState =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "cancelled"
  | "failed";

export type RuntimeFileChange = {
  path: string;
  changeType: string;
  summary?: string;
  diff?: string;
};

export type RuntimeToolCall = {
  name: string;
  input?: string;
  output?: string;
  state: RuntimeItemState;
};

export type RuntimePlanStep = {
  id: string;
  title: string;
  detail?: string;
  state: RuntimeItemState;
};

export type RuntimeEvent = {
  id: string;
  threadID: string;
  turnID: string;
  itemID?: string;
  sequence?: number;
  kind: string;
  occurredAt: number;
  payload: {
    text?: string;
    title?: string;
    detail?: string;
    state?: RuntimeItemState;
    output?: string;
    command?: string;
    workingDirectory?: string;
    exitCode?: number;
    files?: RuntimeFileChange[];
    diff?: string;
    tool?: RuntimeToolCall;
    plan?: RuntimePlanStep[];
    terminalState?: "completed" | "cancelled" | "interrupted" | "failed";
    error?: {
      code: string;
      message: string;
      detail?: string;
      isRecoverable: boolean;
      suggestedAction?: string;
    };
    [key: string]: unknown;
  };
  nativeReference?: {
    protocolName?: string;
    eventType?: string;
  };
};

export type ChatInteractionRequest = {
  turnID: string;
  status: string;
};

export type ChatThread = {
  id: string;
  title: string;
  provider: ChatProvider;
  model: string;
  effort?: string | null;
  speed?: string | null;
  messages: ChatMessage[];
  runtimeEvents: RuntimeEvent[];
  interactionRequests?: ChatInteractionRequest[];
  parentThreadID?: string;
  createdAt: number;
  updatedAt: number;
};

export type ActiveTurnRecord = {
  projectID: string;
  threadID: string;
  turnID: string;
};

export type RuntimeEventEnvelope = {
  projectID: string;
  threadID: string;
  event: RuntimeEvent;
};

export type TurnFinishedEnvelope = {
  projectID: string;
  threadID: string;
  turnID: string;
  terminalState?: "completed" | "cancelled" | "interrupted" | "failed";
};

export type ChatProject = {
  id: string;
  folderPath: string;
  threads: ChatThread[];
};

export type ProviderProfile = {
  id: string;
  provider: ChatProvider;
  displayName: string;
  colorHex: string;
  isEnabled: boolean;
};

export type VoiceSettings = {
  isEnabled: boolean;
  useGrokSignIn: boolean;
  sttProvider: "xai" | "openai-compatible";
  sttApiBase: string;
  sttModel: string;
  language: string;
  ttsProvider: "openai-compatible";
  ttsApiBase: string;
  ttsModel: string;
  voiceID: string;
  inputDeviceID: string | null;
  outputDeviceID: string | null;
  speechHostID: string;
  turnDetection: "manual" | "automatic";
  allowInterruption: boolean;
};

export type WorkspaceDocument = {
  schemaVersion: number;
  projects: ChatProject[];
  providerProfiles: ProviderProfile[];
  voice: VoiceSettings;
  [key: string]: unknown;
};

export type ProviderModelCatalog = {
  models: Array<{
    model: string;
    displayName: string;
    description?: string;
    isDefault?: boolean;
    effortLevels?: string[];
  }>;
  source: "live" | "unavailable";
  error?: string;
};

export type VoiceEvent =
  | { kind: "state"; session: number; state: "connecting" | "listening" | "stopped" }
  | { kind: "interim" | "final"; session: number; text: string }
  | { kind: "error"; session: number; message: string; hint?: string | null; code?: string };

export const CHATS_PROJECT_ID = "00000000-0000-0000-0000-000000000001";

export function projectName(project: ChatProject) {
  if (project.id === CHATS_PROJECT_ID) return "Chats";
  const parts = project.folderPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || project.folderPath || "Project";
}
