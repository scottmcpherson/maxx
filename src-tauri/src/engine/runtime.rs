//! Port of `ProviderRuntime`: owns one engine per provider, routes
//! interactive-request resolution to the originating engine, and runs the
//! stamping loop that turns adapter drafts into canonical events with the
//! single-terminal guarantee.

use super::{
    acp::AcpEngine, claude::ClaudeEngine, codex::CodexEngine, opencode::OpenCodeEngine,
    pi::PiEngine, DraftReceiver, ProviderEngine, ReconciledSessionTurn, SteerRequest, TurnRequest,
};
use maxx_core::contract::*;
use maxx_core::normalize::ProviderEventDraft;
use maxx_core::TurnStamper;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::browser_runtime::{BrowserRuntime, BrowserSessionScope};

pub use super::TurnRequest as RuntimeTurnRequest;

/// Live turn visible to the frontend for sidebar activity / hydrate.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ActiveTurnInfo {
    #[serde(rename = "projectID")]
    pub project_id: Uuid,
    #[serde(rename = "threadID")]
    pub thread_id: Uuid,
    #[serde(rename = "turnID")]
    pub turn_id: Uuid,
}

struct LiveTurn {
    project_id: Uuid,
    thread_id: Uuid,
    provider: ChatProvider,
}

pub struct Runtime {
    engines: HashMap<ChatProvider, Arc<dyn ProviderEngine>>,
    /// In-flight turns keyed by turn id. Source of truth for sidebar activity.
    live_turns: Mutex<HashMap<Uuid, LiveTurn>>,
    request_routes: Mutex<HashMap<Uuid, ChatProvider>>,
    browser: Option<Arc<BrowserRuntime>>,
    automations: RwLock<Option<Arc<crate::automation_service::AutomationService>>>,
}

impl Runtime {
    pub fn new(browser: Arc<BrowserRuntime>) -> Self {
        Self::with_optional_browser(Some(browser))
    }

    /// Construct the provider runtime without issuing browser capabilities.
    /// Used by transport tests that exercise providers in isolation.
    pub fn without_browser() -> Self {
        Self::with_optional_browser(None)
    }

    fn with_optional_browser(browser: Option<Arc<BrowserRuntime>>) -> Self {
        let engines: Vec<Arc<dyn ProviderEngine>> = vec![
            Arc::new(CodexEngine::default()),
            Arc::new(ClaudeEngine::default()),
            Arc::new(AcpEngine::grok()),
            Arc::new(AcpEngine::cursor()),
            Arc::new(AcpEngine::hermes()),
            Arc::new(OpenCodeEngine::default()),
            Arc::new(PiEngine::default()),
        ];
        Self {
            engines: engines.into_iter().map(|e| (e.provider(), e)).collect(),
            live_turns: Mutex::new(HashMap::new()),
            request_routes: Mutex::new(HashMap::new()),
            browser,
            automations: RwLock::new(None),
        }
    }

    pub fn set_automation_service(
        &self,
        service: Arc<crate::automation_service::AutomationService>,
    ) {
        *self
            .automations
            .write()
            .expect("automation runtime lock poisoned") = Some(service);
    }

    pub fn automation_access_for(
        &self,
        project_id: Uuid,
        thread_id: Uuid,
        provider: ChatProvider,
        provider_instance_id: Uuid,
        model: String,
        effort: Option<String>,
        speed: Option<String>,
        mutations_allowed: bool,
    ) -> Option<Arc<crate::host_tools::HostToolAccess>> {
        self.automations
            .read()
            .expect("automation runtime lock poisoned")
            .as_ref()
            .map(|service| {
                service.access_for_scope(crate::automation_service::AutomationScope {
                    project_id,
                    thread_id,
                    provider,
                    provider_instance_id,
                    model,
                    effort,
                    speed,
                    mutations_allowed,
                })
            })
    }

    /// Register a turn as live before the engine task starts so inventory is
    /// visible as soon as `send_prompt` returns (authoritative hydrate).
    pub async fn track_turn(
        &self,
        project_id: Uuid,
        thread_id: Uuid,
        turn_id: Uuid,
        provider: ChatProvider,
    ) {
        self.live_turns.lock().await.insert(
            turn_id,
            LiveTurn {
                project_id,
                thread_id,
                provider,
            },
        );
    }

    /// Begin a turn and return the canonical event stream. The receiver yields
    /// already-stamped events ending with exactly one `turn.terminal`.
    pub async fn events_for(
        &self,
        project_id: Uuid,
        mut request: TurnRequest,
    ) -> mpsc::Receiver<ProviderRuntimeEvent> {
        let (event_tx, event_rx) = mpsc::channel::<ProviderRuntimeEvent>(1024);
        let (draft_tx, draft_rx) = mpsc::channel(1024);
        // Idempotent with `track_turn` from send_prompt.
        self.track_turn(
            project_id,
            request.thread_id,
            request.turn_id,
            request.provider,
        )
        .await;

        if let Some(browser) = &self.browser {
            let mut scope = BrowserSessionScope::full_access(
                project_id,
                request.thread_id,
                request.provider,
                request.provider_instance_id,
            );
            scope.provider_session_id = request.session_id.clone();
            scope.agent_id = request.agent_id;
            scope.file_roots = vec![request.working_directory.clone().into()];
            let access = browser.access_for_scope(scope);
            request
                .host_tools
                .retain(|tool| tool.name != "maxx_browser");
            request.host_tools.push(Arc::new(access.as_host_tool()));
        }
        request
            .host_tools
            .retain(|tool| tool.name != "maxx_automations");
        if let Some(access) = self.automation_access_for(
            project_id,
            request.thread_id,
            request.provider,
            request.provider_instance_id,
            request.model.clone(),
            request.effort.clone(),
            request.speed.clone(),
            !request.unattended,
        ) {
            request.host_tools.push(access);
        }

        let stamper = TurnStamper::new(
            request.provider_instance_id,
            request.thread_id,
            request.turn_id,
        );
        match self.engines.get(&request.provider) {
            Some(engine) => {
                engine.run_turn(request.clone(), draft_tx).await;
                tokio::spawn(stamping_loop(stamper, draft_rx, event_tx));
            }
            None => {
                drop(draft_tx);
                let mut stamper = stamper;
                for event in stamper.fail(format!(
                    "No adapter for provider {}",
                    request.provider.raw_value()
                )) {
                    let _ = event_tx.send(event).await;
                }
            }
        }
        event_rx
    }

    /// Inventory of turns still live in the runtime (backend-authoritative).
    pub async fn active_turns(&self) -> Vec<ActiveTurnInfo> {
        self.live_turns
            .lock()
            .await
            .iter()
            .map(|(turn_id, live)| ActiveTurnInfo {
                project_id: live.project_id,
                thread_id: live.thread_id,
                turn_id: *turn_id,
            })
            .collect()
    }

    /// Run one isolated provider turn for background text generation.
    /// Synthetic turns never enter the visible active-turn inventory and never
    /// receive browser authority. Their provider-native session is released as
    /// soon as a final response (or timeout) is observed.
    pub async fn generate_text(&self, mut request: TurnRequest) -> Result<String, String> {
        const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
        request.ephemeral = true;

        let engine = self
            .engines
            .get(&request.provider)
            .cloned()
            .ok_or_else(|| format!("No adapter for provider {}", request.provider.raw_value()))?;
        let provider_instance_id = request.provider_instance_id;
        let thread_id = request.thread_id;
        let turn_id = request.turn_id;
        let profile = request.profile.clone();
        let (draft_tx, mut draft_rx) = mpsc::channel(256);
        engine.run_turn(request, draft_tx).await;
        let native_session_id = Arc::new(Mutex::new(None));
        let collected_session_id = native_session_id.clone();

        let collected = tokio::time::timeout(TIMEOUT, async {
            let mut output = String::new();
            while let Some(draft) = draft_rx.recv().await {
                match draft {
                    Ok(ProviderEventDraft::AssistantDelta(delta)) => output.push_str(&delta),
                    Ok(ProviderEventDraft::SessionUpdated(session_id)) => {
                        *collected_session_id.lock().await = Some(session_id)
                    }
                    Ok(ProviderEventDraft::Terminal(state)) => {
                        return match state {
                            ProviderTurnTerminalState::Completed if !output.trim().is_empty() => {
                                Ok(output)
                            }
                            ProviderTurnTerminalState::Completed => {
                                Err("Title generator returned no text.".into())
                            }
                            other => Err(format!("Title generator ended as {other:?}.")),
                        };
                    }
                    Ok(ProviderEventDraft::Completed) => {
                        return if output.trim().is_empty() {
                            Err("Title generator returned no text.".into())
                        } else {
                            Ok(output)
                        };
                    }
                    Err(error) => return Err(error),
                    _ => {}
                }
            }
            if output.trim().is_empty() {
                Err("Title generator ended without a response.".into())
            } else {
                Ok(output)
            }
        })
        .await;

        if collected.is_err() {
            engine.cancel(turn_id).await;
        }
        let result = collected.unwrap_or_else(|_| Err("Title generation timed out.".into()));
        let native_session_id = native_session_id.lock().await.take();
        engine
            .discard_ephemeral_thread(
                provider_instance_id,
                thread_id,
                &profile,
                native_session_id.as_deref(),
            )
            .await;
        result
    }

    pub async fn register_route(&self, request_id: Uuid, provider: ChatProvider) {
        self.request_routes
            .lock()
            .await
            .insert(request_id, provider);
    }

    pub async fn finish_turn(&self, turn_id: Uuid) {
        self.live_turns.lock().await.remove(&turn_id);
    }

    /// Relinquish the structured transport before a provider-native terminal
    /// takes ownership of the same session. A thread may have only one writer.
    pub async fn release_thread(
        &self,
        provider: ChatProvider,
        provider_instance_id: Uuid,
        thread_id: Uuid,
    ) -> Result<(), String> {
        if self
            .live_turns
            .lock()
            .await
            .values()
            .any(|turn| turn.thread_id == thread_id)
        {
            return Err("Wait for the current turn to finish before opening terminal mode.".into());
        }
        let engine = self
            .engines
            .get(&provider)
            .ok_or_else(|| format!("No adapter for provider {}", provider.raw_value()))?;
        engine.release_thread(provider_instance_id, thread_id).await;
        Ok(())
    }

    pub async fn reconcile_session(
        &self,
        request: TurnRequest,
    ) -> Result<Option<Vec<ReconciledSessionTurn>>, String> {
        let engine = self
            .engines
            .get(&request.provider)
            .ok_or_else(|| format!("No adapter for provider {}", request.provider.raw_value()))?;
        engine.reconcile_session(request).await
    }

    pub async fn cancel(&self, turn_id: Uuid) {
        let route = {
            self.live_turns
                .lock()
                .await
                .get(&turn_id)
                .map(|turn| (turn.provider, turn.thread_id))
        };
        let Some((provider, thread_id)) = route else {
            return;
        };
        if let Some(browser) = &self.browser {
            browser.interrupt_thread(thread_id).await;
        }
        if let Some(engine) = self.engines.get(&provider) {
            engine.cancel(turn_id).await;
        }
    }

    pub async fn steer(&self, request: SteerRequest) -> Result<(), String> {
        let provider = self
            .live_turns
            .lock()
            .await
            .get(&request.turn_id)
            .map(|turn| turn.provider)
            .ok_or("The turn is no longer active.")?;
        let engine = self
            .engines
            .get(&provider)
            .ok_or_else(|| format!("No adapter for provider {}", provider.raw_value()))?;
        engine.steer(request).await
    }

    pub async fn resolve(
        &self,
        provider: ChatProvider,
        request_id: Uuid,
        decision: RuntimeInteractionDecision,
    ) -> Result<(), String> {
        // Prefer the recorded route; fall back to the event's provider.
        let routed = { self.request_routes.lock().await.remove(&request_id) };
        let provider = routed.unwrap_or(provider);
        let engine = self
            .engines
            .get(&provider)
            .ok_or_else(|| format!("No adapter for provider {}", provider.raw_value()))?;
        let result = engine.resolve(request_id, decision).await;
        if result.is_err() {
            // Restore the route so a retry can still reach the engine.
            self.request_routes
                .lock()
                .await
                .insert(request_id, provider);
        }
        result
    }

    pub async fn shutdown(&self) {
        for engine in self.engines.values() {
            engine.shutdown().await;
        }
        self.live_turns.lock().await.clear();
        self.request_routes.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maxx_core::persist::ProviderProfile;

    fn sample_request(turn_id: Uuid, thread_id: Uuid) -> TurnRequest {
        TurnRequest {
            turn_id,
            thread_id,
            provider_instance_id: Uuid::nil(),
            provider: ChatProvider::Claude,
            model: "default".into(),
            effort: None,
            speed: None,
            agent_instructions: None,
            prompt: "hi".into(),
            attachments: Vec::new(),
            working_directory: "/tmp".into(),
            session_id: None,
            ephemeral: false,
            unattended: false,
            agent_id: None,
            host_tools: Vec::new(),
            profile: ProviderProfile::default_for(ChatProvider::Claude),
        }
    }

    #[tokio::test]
    async fn active_turns_tracks_live_inventory_until_finish() {
        let runtime = Runtime::without_browser();
        let project_id = Uuid::new_v4();
        let thread_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();

        assert!(runtime.active_turns().await.is_empty());

        let _rx = runtime
            .events_for(project_id, sample_request(turn_id, thread_id))
            .await;
        let inventory = runtime.active_turns().await;
        assert_eq!(inventory.len(), 1);
        assert_eq!(inventory[0].project_id, project_id);
        assert_eq!(inventory[0].thread_id, thread_id);
        assert_eq!(inventory[0].turn_id, turn_id);

        runtime.finish_turn(turn_id).await;
        assert!(runtime.active_turns().await.is_empty());
    }

    #[tokio::test]
    async fn track_turn_is_visible_before_events_for() {
        let runtime = Runtime::with_optional_browser(None);
        let project_id = Uuid::new_v4();
        let thread_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();

        runtime
            .track_turn(project_id, thread_id, turn_id, ChatProvider::Claude)
            .await;
        let inventory = runtime.active_turns().await;
        assert_eq!(inventory.len(), 1);
        assert_eq!(inventory[0].turn_id, turn_id);
        assert_eq!(inventory[0].thread_id, thread_id);

        // events_for re-tracks the same turn (idempotent).
        let _rx = runtime
            .events_for(project_id, sample_request(turn_id, thread_id))
            .await;
        assert_eq!(runtime.active_turns().await.len(), 1);

        runtime.finish_turn(turn_id).await;
        assert!(runtime.active_turns().await.is_empty());
    }
}

async fn stamping_loop(
    mut stamper: TurnStamper,
    mut drafts: DraftReceiver,
    events: mpsc::Sender<ProviderRuntimeEvent>,
) {
    while let Some(draft) = drafts.recv().await {
        let stamped = match draft {
            Ok(draft) => stamper.stamp(draft),
            Err(message) => stamper.fail(message),
        };
        for event in stamped {
            if events.send(event).await.is_err() {
                return;
            }
        }
        if stamper.is_terminated() {
            break;
        }
    }
    if !stamper.is_terminated() {
        for event in stamper.finish() {
            let _ = events.send(event).await;
        }
    }
}
