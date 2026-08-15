// TypeScript mirror of the maxx-core runtime contract. Field names match the
// Swift/Rust JSON exactly (providerInstanceID, occurredAt as seconds since
// 2001-01-01, …) so payloads pass through the IPC boundary untouched.

import type { VoiceSettings } from "../voice/types";
import type { BrowserAnnotation } from "../browser";

export type ChatProvider = "codex" | "claude" | "grok" | "cursor" | "opencode" | "pi" | "hermes";

export const ALL_PROVIDERS: ChatProvider[] = [
  "codex",
  "claude",
  "grok",
  "cursor",
  "opencode",
  "pi",
  "hermes",
];

export function providerDisplayName(provider: ChatProvider): string {
  return provider === "opencode" ? "OpenCode" : provider.charAt(0).toUpperCase() + provider.slice(1);
}

export type RuntimeItemState =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "cancelled"
  | "failed";

export type ProviderTurnTerminalState = "completed" | "cancelled" | "interrupted" | "failed";

export type RuntimeEventKindValue = string;

export const EventKind = {
  sessionState: "session.state",
  sessionBinding: "session.binding",
  assistantTextDelta: "assistant.text.delta",
  assistantText: "assistant.text",
  reasoningSummary: "reasoning.summary",
  plan: "plan",
  command: "command",
  fileChange: "file.change",
  diff: "diff",
  tool: "tool",
  usage: "usage",
  approvalRequest: "request.approval",
  userInputRequest: "request.user-input",
  warning: "warning",
  error: "error",
  turnTerminal: "turn.terminal",
} as const;

export interface RuntimePlanStep {
  id: string;
  title: string;
  detail?: string;
  state: RuntimeItemState;
}

export interface RuntimeFileChange {
  path: string;
  changeType: string;
  summary?: string;
  diff?: string;
}

export interface RuntimeToolCall {
  name: string;
  input?: string;
  output?: string;
  state: RuntimeItemState;
}

export interface RuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  cost?: number;
  currency?: string;
}

export type RuntimeDecisionKind = "approve" | "approveForSession" | "deny" | "cancel";

export interface RuntimeDecisionOption {
  id: string;
  title: string;
  kind: RuntimeDecisionKind;
  isPersistent: boolean;
  nativeValue?: string;
}

export interface RuntimeApprovalRequest {
  kind: string;
  title: string;
  detail?: string;
  command?: string;
  paths: string[];
  options: RuntimeDecisionOption[];
  expiresAt?: number;
}

export type RuntimeQuestionAnswerKind = "singleSelect" | "multiSelect" | "freeText";

export interface RuntimeQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface RuntimeQuestion {
  id: string;
  header?: string;
  prompt: string;
  answerKind: RuntimeQuestionAnswerKind;
  options: RuntimeQuestionOption[];
  isRequired: boolean;
}

export interface RuntimeUserInputRequest {
  questions: RuntimeQuestion[];
  expiresAt?: number;
}

export interface RuntimeStructuredError {
  code: string;
  message: string;
  detail?: string;
  isRecoverable: boolean;
  suggestedAction?: string;
}

export interface RuntimeArtifact {
  id: string;
  uri: string;
  mimeType: string;
  byteLength: number;
  title?: string;
}

export interface RuntimeEventPayload {
  text?: string;
  title?: string;
  detail?: string;
  state?: RuntimeItemState;
  sessionState?: string;
  terminalState?: ProviderTurnTerminalState;
  command?: string;
  workingDirectory?: string;
  output?: string;
  exitCode?: number;
  files?: RuntimeFileChange[];
  diff?: string;
  plan?: RuntimePlanStep[];
  tool?: RuntimeToolCall;
  artifacts?: RuntimeArtifact[];
  usage?: RuntimeUsage;
  approval?: RuntimeApprovalRequest;
  userInput?: RuntimeUserInputRequest;
  error?: RuntimeStructuredError;
  sessionBinding?: string;
  resumeCursor?: string;
  rawType?: string;
}

export interface ProviderNativeReference {
  protocolName: string;
  protocolVersion?: string;
  sessionID?: string;
  turnID?: string;
  itemID?: string;
  requestID?: string;
  eventType?: string;
}

export interface ProviderRuntimeEvent {
  schemaVersion: number;
  id: string;
  providerInstanceID: string;
  threadID: string;
  turnID: string;
  itemID?: string;
  requestID?: string;
  sequence: number;
  occurredAt: number;
  kind: RuntimeEventKindValue;
  payload: RuntimeEventPayload;
  nativeReference?: ProviderNativeReference;
}

export type RuntimeInteractionStatus =
  | "pending"
  | "resolving"
  | "approved"
  | "answered"
  | "denied"
  | "cancelled"
  | "expired"
  | "invalidated"
  | "unsupported";

export interface RuntimeInteractionRecord {
  id: string;
  requestEventID: string;
  providerInstanceID: string;
  threadID: string;
  turnID: string;
  createdAt: number;
  expiresAt?: number;
  status: RuntimeInteractionStatus;
  resolvedAt?: number;
  statusDetail?: string;
}

export interface RuntimeInteractionDecision {
  kind?: RuntimeDecisionKind;
  selectedOptionIDs: string[];
  textAnswers: Record<string, string>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: ChatImageAttachment[];
  annotations?: BrowserAnnotation[];
  createdAt: number;
  /** First runtime event that contributed to an assistant message. */
  sourceEventID?: string;
  /** Agent that produced this message (assistant messages in agent threads). */
  agentID?: string;
}

export interface ChatImageAttachment {
  id: string;
  path: string;
  mimeType: string;
  displayName: string;
}

/** A preconfigured agent: a named persona with pinned instructions and runtime. */
export interface AgentDefinition {
  id: string;
  name: string;
  instructions: string;
  provider: ChatProvider;
  model: string;
  effort?: string | null;
  speed?: string | null;
  colorHex: string;
  emoji?: string | null;
  /** Absolute path of an imported avatar image; emoji/initials render when unset. */
  imagePath?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatThread {
  id: string;
  title: string;
  provider: ChatProvider;
  providerInstanceID?: string;
  model: string;
  /** Reasoning/effort/thinking level when the provider supports it. */
  effort?: string | null;
  /** Speed tier when the provider supports a separate speed knob. */
  speed?: string | null;
  /** The first-class conversation surface currently owning this thread. */
  surface?: ChatSurface;
  /** Isolated Git worktree owned by this chat. Absent means the project folder. */
  workingDirectory?: string;
  providerSessionID?: string;
  lastTurnID?: string;
  messages: ChatMessage[];
  runtimeEvents: ProviderRuntimeEvent[];
  interactionRequests: RuntimeInteractionRecord[];
  /** Rendered PTY scrollback captured whenever terminal mode returns to GUI mode. */
  terminalArchives?: TerminalArchive[];
  /** Set on side threads: the main thread this conversation branched from. */
  parentThreadID?: string;
  /** Set on side threads: the parent-thread message the branch hangs off. */
  anchorMessageID?: string;
  /** Agent that most recently handled (or is handling) a turn here. */
  agentID?: string;
  /** Parent transcript captured when the side thread was created. */
  contextSeed?: string;
  createdAt: number;
  updatedAt: number;
}

export type ChatSurface = "gui" | "terminal";

export interface TerminalArchive {
  id: string;
  content: string;
  startedAt: number;
  endedAt: number;
}

export interface TerminalSupport {
  supported: boolean;
  browserAvailable: boolean;
  reason?: string | null;
}

export interface TerminalStatus {
  threadID: string;
  state: "running" | "exited";
  cursor: number;
  firstCursor: number;
  browserAvailable: boolean;
  startedAt: number;
}

export interface TerminalRead {
  chunks: Array<{ cursor: number; dataBase64: string }>;
  cursor: number;
  firstCursor: number;
  gap: boolean;
  state: "running" | "exited";
}

export interface ProviderModelOption {
  model: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  /** Effort values reported by the provider for this model. */
  effortLevels?: string[];
}

export type ProviderCommandKind = "command" | "skill" | "prompt";

export interface ProviderCommandOption {
  id: string;
  name: string;
  invocation: string;
  displayName: string;
  description?: string;
  kind: ProviderCommandKind;
  source: string;
  scope?: string;
  argumentHint?: string;
  provider: ChatProvider;
}

export interface ProviderCommandCatalog {
  items: ProviderCommandOption[];
  source: "live" | "unavailable";
  error?: string;
}

export type ProviderModelCatalogSource = "live" | "unavailable";

export interface ProviderModelCatalog {
  models: ProviderModelOption[];
  source: ProviderModelCatalogSource;
  /** Present when live discovery failed. `models` will be empty. */
  error?: string;
}

export interface ChatProject {
  id: string;
  folderPath: string;
  threads: ChatThread[];
}

export interface ProviderProfile {
  id: string;
  provider: ChatProvider;
  displayName: string;
  executablePath?: string;
  serverURL?: string;
  homeDirectory?: string;
  environment: Record<string, string>;
  colorHex: string;
  isEnabled: boolean;
  /** Model IDs intentionally omitted from provider/model pickers. */
  hiddenModels: string[];
}

export interface TitleGenerationRuntime {
  provider: ChatProvider;
  model: string;
  effort?: string | null;
  speed?: "normal" | "fast" | null;
}

export interface WorkspaceDocument {
  schemaVersion: number;
  projects: ChatProject[];
  providerProfiles: ProviderProfile[];
  agents: AgentDefinition[];
  /** Null/absent means generated titles inherit the runtime used by the chat. */
  titleGenerationRuntime?: TitleGenerationRuntime | null;
  voice: VoiceSettings;
}

export interface RuntimeEventEnvelope {
  projectID: string;
  threadID: string;
  event: ProviderRuntimeEvent;
}

export interface TurnFinishedEnvelope {
  projectID: string;
  threadID: string;
  turnID: string;
  terminalState?: ProviderTurnTerminalState;
}

export interface ThreadTitleUpdatedEnvelope {
  projectID: string;
  threadID: string;
  title: string;
}

/** Backend inventory of in-flight turns (sidebar activity hydrate). */
export interface ActiveTurnRecord {
  projectID: string;
  threadID: string;
  turnID: string;
}

export interface ProviderHealth {
  profileID: string;
  state: string;
  executablePath?: string;
  version?: string;
  message: string;
}

export function projectName(project: ChatProject): string {
  const parts = project.folderPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? project.folderPath;
}
