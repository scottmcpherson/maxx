//! Provider runtime shell: per-provider protocol engines produce
//! `ProviderEventDraft`s; the orchestrator in `runtime.rs` stamps them into
//! canonical events (terminal guarantee included) and fans them out to the
//! frontend and persistence. Provider-specific branching stays inside the
//! engines, mirroring the Swift adapter isolation.

pub mod acp;
pub mod catalog;
pub mod claude;
pub mod codex;
pub mod command_catalog;
pub mod jsonrpc;
pub mod launch;
pub mod opencode;
pub mod pi;
pub mod process;
pub mod runtime;

use async_trait::async_trait;
use maxx_core::contract::{ChatProvider, RuntimeInteractionDecision};
use maxx_core::normalize::ProviderEventDraft;
use maxx_core::persist::{ChatImageAttachment, ProviderProfile};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::browser_runtime::BrowserProviderAccess;

#[derive(Debug, Clone, PartialEq)]
pub struct ReconciledSessionTurn {
    pub native_id: String,
    pub started_at: maxx_core::contract::AppleDate,
    pub user_content: String,
    pub assistant_content: String,
}

/// Draft stream from an engine to the orchestrator. `Err` carries a thrown
/// adapter error which the stamper converts into error + failed terminal.
pub type DraftSender = mpsc::Sender<Result<ProviderEventDraft, String>>;
pub type DraftReceiver = mpsc::Receiver<Result<ProviderEventDraft, String>>;

#[derive(Debug, Clone)]
pub struct TurnRequest {
    pub turn_id: Uuid,
    pub thread_id: Uuid,
    pub provider_instance_id: Uuid,
    pub provider: ChatProvider,
    pub model: String,
    /// Reasoning / effort / thinking level (provider-specific).
    pub effort: Option<String>,
    /// Speed tier when supported (most providers leave this unset).
    pub speed: Option<String>,
    /// Privileged per-agent instructions. Provider adapters must place this in
    /// a native system/developer channel and never merge it into `prompt`.
    pub agent_instructions: Option<String>,
    pub prompt: String,
    pub attachments: Vec<ChatImageAttachment>,
    pub working_directory: String,
    pub session_id: Option<String>,
    pub profile: ProviderProfile,
    /// Preconfigured agent handling this turn, when it is an agent turn.
    pub agent_id: Option<Uuid>,
    /// Ephemeral MCP authority for the provider-native session. Debug output is
    /// redacted and the value is never persisted in the workspace document.
    pub browser_access: Option<Arc<BrowserProviderAccess>>,
}

#[derive(Debug, Clone)]
pub struct SteerRequest {
    pub turn_id: Uuid,
    pub prompt: String,
    pub attachments: Vec<ChatImageAttachment>,
}

impl TurnRequest {
    pub fn starts_fresh_agent_session(&self) -> bool {
        self.agent_instructions.is_some() && self.session_id.is_none()
    }

    pub fn selected_model(&self) -> Option<String> {
        if self.model.eq_ignore_ascii_case("default") {
            None
        } else {
            Some(self.model.clone())
        }
    }

    pub fn selected_effort(&self) -> Option<String> {
        self.effort
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }
}

#[cfg(test)]
pub(crate) fn test_request(provider: ChatProvider) -> TurnRequest {
    let profile = ProviderProfile::default_for(provider);
    TurnRequest {
        turn_id: Uuid::new_v4(),
        thread_id: Uuid::new_v4(),
        provider_instance_id: profile.id,
        provider,
        model: "default".into(),
        effort: None,
        speed: None,
        agent_instructions: None,
        prompt: "user prompt".into(),
        attachments: Vec::new(),
        working_directory: "/tmp".into(),
        session_id: None,
        profile,
        agent_id: None,
        browser_access: None,
    }
}

#[async_trait]
pub trait ProviderEngine: Send + Sync {
    fn provider(&self) -> ChatProvider;
    /// Begin a turn; must return promptly and stream drafts through `sink`.
    async fn run_turn(&self, request: TurnRequest, sink: DraftSender);
    async fn steer(&self, _request: SteerRequest) -> Result<(), String> {
        Err(format!(
            "{} does not support steering an active turn.",
            self.provider().display_name()
        ))
    }
    async fn cancel(&self, turn_id: Uuid);
    async fn resolve(
        &self,
        request_id: Uuid,
        decision: RuntimeInteractionDecision,
    ) -> Result<(), String>;
    /// Read the provider's authoritative persisted conversation. Providers
    /// without a structured read API return `None` and use terminal archives.
    async fn reconcile_session(
        &self,
        _request: TurnRequest,
    ) -> Result<Option<Vec<ReconciledSessionTurn>>, String> {
        Ok(None)
    }
    /// Tear down the provider-native session owned by one Maxx thread.
    /// Background text generation uses isolated synthetic thread IDs and must
    /// release them as soon as the result has been collected.
    async fn release_thread(&self, provider_instance_id: Uuid, thread_id: Uuid);
    async fn shutdown(&self);
}

/// Send a draft, ignoring backpressure failures after the consumer is gone.
pub(crate) async fn yield_draft(sink: &DraftSender, draft: ProviderEventDraft) {
    let _ = sink.send(Ok(draft)).await;
}

pub(crate) async fn yield_error(sink: &DraftSender, message: String) {
    let _ = sink.send(Err(message)).await;
}
