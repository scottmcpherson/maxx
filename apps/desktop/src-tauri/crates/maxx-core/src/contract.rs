//! Canonical provider runtime contract, ported from `ProviderRuntimeContract.swift`.
//!
//! JSON shapes are byte-compatible with the Swift app's Codable output so the
//! Tauri port can share `workspace.json` with the SwiftUI app: field names use
//! the exact Swift property spellings (`providerInstanceID`, not
//! `providerInstanceId`), dates encode as seconds since 2001-01-01 (Swift's
//! reference date), and optional fields are omitted when nil.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Seconds between the Unix epoch and Swift's reference date (2001-01-01T00:00:00Z).
pub const APPLE_REFERENCE_EPOCH_OFFSET: f64 = 978_307_200.0;

/// A timestamp encoded the way Swift's default `JSONEncoder` encodes `Date`:
/// fractional seconds since 2001-01-01T00:00:00Z.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize, Default)]
#[serde(transparent)]
pub struct AppleDate(pub f64);

impl AppleDate {
    pub fn now() -> Self {
        let unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        AppleDate(unix - APPLE_REFERENCE_EPOCH_OFFSET)
    }

    pub fn from_unix_seconds(unix: f64) -> Self {
        AppleDate(unix - APPLE_REFERENCE_EPOCH_OFFSET)
    }

    pub fn unix_seconds(self) -> f64 {
        self.0 + APPLE_REFERENCE_EPOCH_OFFSET
    }

    pub fn total_cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

/// Open string event kind. Unknown kinds round-trip without loss.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RuntimeEventKind(pub String);

impl RuntimeEventKind {
    pub const SESSION_STATE: &'static str = "session.state";
    pub const SESSION_BINDING: &'static str = "session.binding";
    pub const ASSISTANT_TEXT_DELTA: &'static str = "assistant.text.delta";
    pub const ASSISTANT_TEXT: &'static str = "assistant.text";
    pub const REASONING_SUMMARY: &'static str = "reasoning.summary";
    pub const PLAN: &'static str = "plan";
    pub const COMMAND: &'static str = "command";
    pub const FILE_CHANGE: &'static str = "file.change";
    pub const DIFF: &'static str = "diff";
    pub const TOOL: &'static str = "tool";
    pub const USAGE: &'static str = "usage";
    pub const APPROVAL_REQUEST: &'static str = "request.approval";
    pub const USER_INPUT_REQUEST: &'static str = "request.user-input";
    pub const WARNING: &'static str = "warning";
    pub const ERROR: &'static str = "error";
    pub const TURN_TERMINAL: &'static str = "turn.terminal";

    pub fn session_state() -> Self {
        Self(Self::SESSION_STATE.into())
    }
    pub fn session_binding() -> Self {
        Self(Self::SESSION_BINDING.into())
    }
    pub fn assistant_text_delta() -> Self {
        Self(Self::ASSISTANT_TEXT_DELTA.into())
    }
    pub fn assistant_text() -> Self {
        Self(Self::ASSISTANT_TEXT.into())
    }
    pub fn reasoning_summary() -> Self {
        Self(Self::REASONING_SUMMARY.into())
    }
    pub fn plan() -> Self {
        Self(Self::PLAN.into())
    }
    pub fn command() -> Self {
        Self(Self::COMMAND.into())
    }
    pub fn file_change() -> Self {
        Self(Self::FILE_CHANGE.into())
    }
    pub fn diff() -> Self {
        Self(Self::DIFF.into())
    }
    pub fn tool() -> Self {
        Self(Self::TOOL.into())
    }
    pub fn usage() -> Self {
        Self(Self::USAGE.into())
    }
    pub fn approval_request() -> Self {
        Self(Self::APPROVAL_REQUEST.into())
    }
    pub fn user_input_request() -> Self {
        Self(Self::USER_INPUT_REQUEST.into())
    }
    pub fn warning() -> Self {
        Self(Self::WARNING.into())
    }
    pub fn error() -> Self {
        Self(Self::ERROR.into())
    }
    pub fn turn_terminal() -> Self {
        Self(Self::TURN_TERMINAL.into())
    }

    pub fn is(&self, raw: &str) -> bool {
        self.0 == raw
    }

    pub fn is_known(&self) -> bool {
        matches!(
            self.0.as_str(),
            Self::SESSION_STATE
                | Self::SESSION_BINDING
                | Self::ASSISTANT_TEXT_DELTA
                | Self::ASSISTANT_TEXT
                | Self::REASONING_SUMMARY
                | Self::PLAN
                | Self::COMMAND
                | Self::FILE_CHANGE
                | Self::DIFF
                | Self::TOOL
                | Self::USAGE
                | Self::APPROVAL_REQUEST
                | Self::USER_INPUT_REQUEST
                | Self::WARNING
                | Self::ERROR
                | Self::TURN_TERMINAL
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderSessionState {
    Starting,
    Ready,
    Running,
    Waiting,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderTurnTerminalState {
    Completed,
    Cancelled,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeItemState {
    Pending,
    Running,
    Waiting,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatProvider {
    Codex,
    Claude,
    Grok,
    Cursor,
    Opencode,
    Pi,
    Hermes,
}

impl ChatProvider {
    pub const ALL: [ChatProvider; 7] = [
        ChatProvider::Codex,
        ChatProvider::Claude,
        ChatProvider::Grok,
        ChatProvider::Cursor,
        ChatProvider::Opencode,
        ChatProvider::Pi,
        ChatProvider::Hermes,
    ];

    pub fn raw_value(self) -> &'static str {
        match self {
            ChatProvider::Codex => "codex",
            ChatProvider::Claude => "claude",
            ChatProvider::Grok => "grok",
            ChatProvider::Cursor => "cursor",
            ChatProvider::Opencode => "opencode",
            ChatProvider::Pi => "pi",
            ChatProvider::Hermes => "hermes",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ChatProvider::Codex => "Codex",
            ChatProvider::Claude => "Claude",
            ChatProvider::Grok => "Grok",
            ChatProvider::Cursor => "Cursor",
            ChatProvider::Opencode => "OpenCode",
            ChatProvider::Pi => "Pi",
            ChatProvider::Hermes => "Hermes",
        }
    }

    pub fn executable_name(self) -> &'static str {
        match self {
            ChatProvider::Cursor => "cursor-agent",
            other => other.raw_value(),
        }
    }

    /// Stable default provider-instance IDs, identical to the Swift app.
    pub fn default_instance_id(self) -> Uuid {
        let raw = match self {
            ChatProvider::Codex => "00000000-0000-4000-8000-000000000001",
            ChatProvider::Claude => "00000000-0000-4000-8000-000000000002",
            ChatProvider::Grok => "00000000-0000-4000-8000-000000000003",
            ChatProvider::Cursor => "00000000-0000-4000-8000-000000000004",
            ChatProvider::Opencode => "00000000-0000-4000-8000-000000000005",
            ChatProvider::Pi => "00000000-0000-4000-8000-000000000006",
            ChatProvider::Hermes => "00000000-0000-4000-8000-000000000007",
        };
        Uuid::parse_str(raw).expect("static UUID")
    }

    pub fn default_profile_color_hex(self) -> &'static str {
        match self {
            ChatProvider::Codex => "#7C8CFF",
            ChatProvider::Claude => "#D99B67",
            ChatProvider::Grok => "#8BD3C7",
            ChatProvider::Cursor => "#B08CFF",
            ChatProvider::Opencode => "#79B8FF",
            ChatProvider::Pi => "#F2C14E",
            ChatProvider::Hermes => "#E28C8C",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ProviderNativeReference {
    #[serde(rename = "protocolName")]
    pub protocol_name: String,
    #[serde(
        rename = "protocolVersion",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub protocol_version: Option<String>,
    #[serde(rename = "sessionID", skip_serializing_if = "Option::is_none", default)]
    pub session_id: Option<String>,
    #[serde(rename = "turnID", skip_serializing_if = "Option::is_none", default)]
    pub turn_id: Option<String>,
    #[serde(rename = "itemID", skip_serializing_if = "Option::is_none", default)]
    pub item_id: Option<String>,
    #[serde(rename = "requestID", skip_serializing_if = "Option::is_none", default)]
    pub request_id: Option<String>,
    #[serde(rename = "eventType", skip_serializing_if = "Option::is_none", default)]
    pub event_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimePlanStep {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    pub state: RuntimeItemState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeFileChange {
    pub path: String,
    #[serde(rename = "changeType")]
    pub change_type: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub diff: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeToolCall {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output: Option<String>,
    pub state: RuntimeItemState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RuntimeUsage {
    #[serde(
        rename = "inputTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub input_tokens: Option<i64>,
    #[serde(
        rename = "outputTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub output_tokens: Option<i64>,
    #[serde(
        rename = "cachedInputTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub cached_input_tokens: Option<i64>,
    #[serde(
        rename = "contextTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub context_tokens: Option<i64>,
    #[serde(
        rename = "contextWindow",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub context_window: Option<i64>,
    /// Swift stores `Decimal`; the port uses f64, which is lossless for the
    /// currency magnitudes providers report.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub currency: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeApprovalKind {
    Command,
    FileRead,
    FileChange,
    Tool,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeDecisionKind {
    Approve,
    ApproveForSession,
    Deny,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeInteractionStatus {
    Pending,
    Resolving,
    Approved,
    Answered,
    Denied,
    Cancelled,
    Expired,
    Invalidated,
    Unsupported,
}

impl RuntimeInteractionStatus {
    pub fn is_actionable(self) -> bool {
        self == RuntimeInteractionStatus::Pending
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeDecisionOption {
    pub id: String,
    pub title: String,
    pub kind: RuntimeDecisionKind,
    #[serde(rename = "isPersistent")]
    pub is_persistent: bool,
    #[serde(
        rename = "nativeValue",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub native_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeApprovalRequest {
    pub kind: RuntimeApprovalKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub command: Option<String>,
    pub paths: Vec<String>,
    pub options: Vec<RuntimeDecisionOption>,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none", default)]
    pub expires_at: Option<AppleDate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeQuestionAnswerKind {
    SingleSelect,
    MultiSelect,
    FreeText,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeQuestionOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeQuestion {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub header: Option<String>,
    pub prompt: String,
    #[serde(rename = "answerKind")]
    pub answer_kind: RuntimeQuestionAnswerKind,
    pub options: Vec<RuntimeQuestionOption>,
    #[serde(rename = "isRequired")]
    pub is_required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeUserInputRequest {
    pub questions: Vec<RuntimeQuestion>,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none", default)]
    pub expires_at: Option<AppleDate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RuntimeInteractionDecision {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub kind: Option<RuntimeDecisionKind>,
    #[serde(rename = "selectedOptionIDs", default)]
    pub selected_option_ids: Vec<String>,
    #[serde(rename = "textAnswers", default)]
    pub text_answers: HashMap<String, String>,
}

impl RuntimeInteractionDecision {
    pub fn approval(kind: RuntimeDecisionKind) -> Self {
        Self {
            kind: Some(kind),
            ..Default::default()
        }
    }
}

/// Durable queue metadata for one interactive provider request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeInteractionRecord {
    pub id: Uuid,
    #[serde(rename = "requestEventID")]
    pub request_event_id: Uuid,
    #[serde(rename = "providerInstanceID")]
    pub provider_instance_id: Uuid,
    #[serde(rename = "threadID")]
    pub thread_id: Uuid,
    #[serde(rename = "turnID")]
    pub turn_id: Uuid,
    #[serde(rename = "createdAt")]
    pub created_at: AppleDate,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none", default)]
    pub expires_at: Option<AppleDate>,
    pub status: RuntimeInteractionStatus,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub decision: Option<RuntimeInteractionDecision>,
    #[serde(
        rename = "resolvedAt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub resolved_at: Option<AppleDate>,
    #[serde(
        rename = "statusDetail",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub status_detail: Option<String>,
}

impl RuntimeInteractionRecord {
    /// Mirrors the Swift failable initializer: only approval / user-input
    /// request events with a request ID produce a record.
    pub fn from_event(event: &ProviderRuntimeEvent) -> Option<Self> {
        if !(event.kind.is(RuntimeEventKind::APPROVAL_REQUEST)
            || event.kind.is(RuntimeEventKind::USER_INPUT_REQUEST))
        {
            return None;
        }
        let request_id = event.request_id?;
        let expires_at = event
            .payload
            .approval
            .as_ref()
            .and_then(|a| a.expires_at)
            .or_else(|| event.payload.user_input.as_ref().and_then(|q| q.expires_at));
        Some(Self {
            id: request_id,
            request_event_id: event.id,
            provider_instance_id: event.provider_instance_id,
            thread_id: event.thread_id,
            turn_id: event.turn_id,
            created_at: event.occurred_at,
            expires_at,
            status: RuntimeInteractionStatus::Pending,
            decision: None,
            resolved_at: None,
            status_detail: None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeStructuredError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    #[serde(rename = "isRecoverable")]
    pub is_recoverable: bool,
    #[serde(
        rename = "suggestedAction",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub suggested_action: Option<String>,
}

/// A durable, provider-produced artifact that belongs to the event's thread.
/// The canonical timeline stores only the scoped reference; binary contents
/// stay in the owning runtime's artifact store and are loaded on demand.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeArtifact {
    pub id: Uuid,
    pub uri: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "byteLength")]
    pub byte_length: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RuntimeEventPayload {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub state: Option<RuntimeItemState>,
    #[serde(
        rename = "sessionState",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub session_state: Option<ProviderSessionState>,
    #[serde(
        rename = "terminalState",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub terminal_state: Option<ProviderTurnTerminalState>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub command: Option<String>,
    #[serde(
        rename = "workingDirectory",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub working_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output: Option<String>,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub files: Option<Vec<RuntimeFileChange>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub plan: Option<Vec<RuntimePlanStep>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool: Option<RuntimeToolCall>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub artifacts: Option<Vec<RuntimeArtifact>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<RuntimeUsage>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub approval: Option<RuntimeApprovalRequest>,
    #[serde(rename = "userInput", skip_serializing_if = "Option::is_none", default)]
    pub user_input: Option<RuntimeUserInputRequest>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<RuntimeStructuredError>,
    #[serde(
        rename = "sessionBinding",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub session_binding: Option<String>,
    #[serde(
        rename = "resumeCursor",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub resume_cursor: Option<String>,
    #[serde(rename = "rawType", skip_serializing_if = "Option::is_none", default)]
    pub raw_type: Option<String>,
}

pub const CURRENT_EVENT_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeEvent {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    pub id: Uuid,
    #[serde(rename = "providerInstanceID")]
    pub provider_instance_id: Uuid,
    #[serde(rename = "threadID")]
    pub thread_id: Uuid,
    #[serde(rename = "turnID")]
    pub turn_id: Uuid,
    #[serde(rename = "itemID", skip_serializing_if = "Option::is_none", default)]
    pub item_id: Option<Uuid>,
    #[serde(rename = "requestID", skip_serializing_if = "Option::is_none", default)]
    pub request_id: Option<Uuid>,
    pub sequence: i64,
    #[serde(rename = "occurredAt")]
    pub occurred_at: AppleDate,
    pub kind: RuntimeEventKind,
    pub payload: RuntimeEventPayload,
    #[serde(
        rename = "nativeReference",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub native_reference: Option<ProviderNativeReference>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ProviderModelCapabilities {
    #[serde(rename = "supportsImages", default)]
    pub supports_images: bool,
    #[serde(rename = "supportsReasoning", default)]
    pub supports_reasoning: bool,
    #[serde(rename = "supportsTools", default = "default_true")]
    pub supports_tools: bool,
    #[serde(rename = "supportsModelChange", default)]
    pub supports_model_change: bool,
    #[serde(
        rename = "contextWindow",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub context_window: Option<i64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeCapabilities {
    #[serde(rename = "protocolName", default)]
    pub protocol_name: String,
    #[serde(
        rename = "protocolVersion",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub protocol_version: Option<String>,
    #[serde(rename = "streamsAssistantText")]
    pub streams_assistant_text: bool,
    #[serde(rename = "supportsCancellation")]
    pub supports_cancellation: bool,
    #[serde(rename = "supportsNativeInterruption", default)]
    pub supports_native_interruption: bool,
    #[serde(rename = "supportsResume", default)]
    pub supports_resume: bool,
    #[serde(rename = "supportsApprovals", default)]
    pub supports_approvals: bool,
    #[serde(rename = "supportsQuestions", default)]
    pub supports_questions: bool,
    #[serde(rename = "supportsCommands", default)]
    pub supports_commands: bool,
    #[serde(rename = "supportsFileChanges", default)]
    pub supports_file_changes: bool,
    #[serde(rename = "supportsDiffs", default)]
    pub supports_diffs: bool,
    #[serde(rename = "supportsTools", default)]
    pub supports_tools: bool,
    #[serde(rename = "supportsPlans", default)]
    pub supports_plans: bool,
    #[serde(rename = "supportsReasoning", default)]
    pub supports_reasoning: bool,
    #[serde(rename = "supportsUsage", default)]
    pub supports_usage: bool,
    #[serde(rename = "supportsModelChange", default)]
    pub supports_model_change: bool,
    #[serde(rename = "supportsExistingServer", default)]
    pub supports_existing_server: bool,
    #[serde(rename = "supportsManagedServer", default)]
    pub supports_managed_server: bool,
    #[serde(default)]
    pub model: ProviderModelCapabilities,
}
