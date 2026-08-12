//! Port of `ACPProviderRuntime` (shared by Grok and Cursor): ACP 1 over
//! stdio JSON-RPC. One session process per (profile, thread). A single ordered
//! loop owns the process output so notifications preceding the prompt response
//! are always delivered before the terminal, mirroring the Swift incoming
//! barrier.

use super::process::{JsonLineProcess, LaunchSpec};
use super::{yield_draft, yield_error, DraftSender, ProviderEngine, TurnRequest};
use async_trait::async_trait;
use maxx_core::contract::*;
use maxx_core::normalize::{normalize, NormalizerState, ProviderEventDraft};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, watch, Mutex};
use tokio::time::{Duration, Instant};
use uuid::Uuid;

const ACP_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const HERMES_MAXX_BROWSER_POLICY: &str = "Maxx Browser is the only browser-control surface available in this session. Use the maxx_browser MCP tools for every browser action. Reuse the assigned tab, observe before acting, require an observed state change after each interaction, and never launch or attach to Chrome from terminal tools.";

pub struct AcpEngine {
    provider: ChatProvider,
    /// Build CLI args, including any provider-native instruction channel.
    arguments: fn(&TurnRequest) -> Result<Vec<String>, String>,
    sessions: Mutex<HashMap<(Uuid, Uuid), Arc<AcpSession>>>,
    session_by_turn: Mutex<HashMap<Uuid, (Uuid, Uuid)>>,
}

impl AcpEngine {
    pub fn grok() -> Self {
        Self {
            provider: ChatProvider::Grok,
            arguments: grok_arguments,
            sessions: Mutex::new(HashMap::new()),
            session_by_turn: Mutex::new(HashMap::new()),
        }
    }

    pub fn cursor() -> Self {
        Self {
            provider: ChatProvider::Cursor,
            arguments: cursor_arguments,
            sessions: Mutex::new(HashMap::new()),
            session_by_turn: Mutex::new(HashMap::new()),
        }
    }

    /// Hermes selects its model via its own config (`hermes model`); the ACP
    /// server takes no model or effort flags.
    pub fn hermes() -> Self {
        Self {
            provider: ChatProvider::Hermes,
            arguments: hermes_arguments,
            sessions: Mutex::new(HashMap::new()),
            session_by_turn: Mutex::new(HashMap::new()),
        }
    }
}

fn grok_arguments(request: &TurnRequest) -> Result<Vec<String>, String> {
    let mut arguments = Vec::new();
    if let Some(instructions) = &request.agent_instructions {
        arguments.extend(["--rules".into(), instructions.clone(), "--no-memory".into()]);
    }
    arguments.push("agent".into());
    if let Some(model) = request.selected_model() {
        arguments.extend(["--model".into(), model]);
    }
    if let Some(effort) = request.selected_effort() {
        arguments.extend(["--reasoning-effort".into(), effort]);
    }
    arguments.push("stdio".into());
    Ok(arguments)
}

fn cursor_arguments(request: &TurnRequest) -> Result<Vec<String>, String> {
    if request.agent_instructions.is_some() {
        return Err(
            "Cursor's ACP transport does not expose a per-session system instruction channel, so it cannot run Maxx custom agents safely."
                .into(),
        );
    }
    Ok(vec!["acp".into()])
}

fn hermes_arguments(request: &TurnRequest) -> Result<Vec<String>, String> {
    if request.agent_instructions.is_some() {
        return Err(
            "Hermes's ACP transport does not expose a per-session system instruction channel, so it cannot run Maxx custom agents safely."
                .into(),
        );
    }
    Ok(vec!["acp".into()])
}

struct PendingInteraction {
    native_id: Value,
    option_by_decision: HashMap<String, String>,
    is_question: bool,
}

#[derive(Default)]
struct SessionState {
    process: Option<Arc<JsonLineProcess>>,
    session_id: Option<String>,
    normalizer: NormalizerState,
    pending: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    interactions: HashMap<Uuid, PendingInteraction>,
    current_turn: Option<(Uuid, DraftSender)>,
    supports_load_session: bool,
    supports_http_mcp: bool,
    current_model: Option<String>,
}

struct AcpSession {
    provider: ChatProvider,
    state: Mutex<SessionState>,
    next_id: AtomicI64,
    activity: watch::Sender<u64>,
}

#[async_trait]
impl ProviderEngine for AcpEngine {
    fn provider(&self) -> ChatProvider {
        self.provider
    }

    async fn run_turn(&self, request: TurnRequest, sink: DraftSender) {
        let arguments = match (self.arguments)(&request) {
            Ok(arguments) => arguments,
            Err(error) => {
                yield_error(&sink, error).await;
                return;
            }
        };
        let key = (request.provider_instance_id, request.thread_id);
        let (session, replaced) = {
            let mut sessions = self.sessions.lock().await;
            let replaced = request
                .starts_fresh_agent_session()
                .then(|| sessions.remove(&key))
                .flatten();
            let session = sessions
                .entry(key)
                .or_insert_with(|| {
                    let (activity, _) = watch::channel(0);
                    Arc::new(AcpSession {
                        provider: self.provider,
                        state: Mutex::new(SessionState::default()),
                        next_id: AtomicI64::new(1),
                        activity,
                    })
                })
                .clone();
            (session, replaced)
        };
        if let Some(replaced) = replaced {
            retire_session(&replaced).await;
        }
        self.session_by_turn
            .lock()
            .await
            .insert(request.turn_id, key);
        tokio::spawn(async move {
            if let Err(error) = begin(&session, arguments, &request, sink.clone()).await {
                session.state.lock().await.current_turn = None;
                yield_error(&sink, error).await;
            }
        });
    }

    async fn cancel(&self, turn_id: Uuid) {
        let key = { self.session_by_turn.lock().await.get(&turn_id).copied() };
        let Some(key) = key else { return };
        let session = { self.sessions.lock().await.get(&key).cloned() };
        let Some(session) = session else { return };
        let (process, session_id, sink) = {
            let state = session.state.lock().await;
            if state.current_turn.as_ref().map(|(id, _)| *id) != Some(turn_id) {
                return;
            }
            (
                state.process.clone(),
                state.session_id.clone(),
                state.current_turn.as_ref().map(|(_, sink)| sink.clone()),
            )
        };
        let cancelled = match (&process, &session_id) {
            (Some(process), Some(session_id)) => process
                .send(&json!({
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": {"sessionId": session_id}
                }))
                .await
                .is_ok(),
            _ => false,
        };
        if cancelled {
            let session = session.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                force_cancel(&session, turn_id).await;
            });
        } else if let Some(sink) = sink {
            session.state.lock().await.current_turn = None;
            yield_draft(
                &sink,
                ProviderEventDraft::Terminal(ProviderTurnTerminalState::Cancelled),
            )
            .await;
        }
    }

    async fn resolve(
        &self,
        request_id: Uuid,
        decision: RuntimeInteractionDecision,
    ) -> Result<(), String> {
        let sessions: Vec<Arc<AcpSession>> = self.sessions.lock().await.values().cloned().collect();
        for session in sessions {
            let entry = {
                let mut state = session.state.lock().await;
                match state.interactions.remove(&request_id) {
                    Some(interaction) => Some((interaction, state.process.clone())),
                    None => None,
                }
            };
            let Some((interaction, process)) = entry else {
                continue;
            };
            let process = process.ok_or_else(|| {
                format!(
                    "The {} request is no longer actionable.",
                    session.provider.display_name()
                )
            })?;

            let result = if interaction.is_question && decision.kind.is_none() {
                let mut answers: HashMap<String, Vec<String>> = HashMap::new();
                for value in &decision.selected_option_ids {
                    if let Some((question, answer)) = value.split_once(':') {
                        answers
                            .entry(question.to_string())
                            .or_default()
                            .push(answer.to_string());
                    }
                }
                for (question, answer) in &decision.text_answers {
                    answers.insert(question.clone(), vec![answer.clone()]);
                }
                json!({"answers": answers})
            } else if decision.kind == Some(RuntimeDecisionKind::Cancel) {
                json!({"outcome": {"outcome": "cancelled"}})
            } else {
                let option_id = decision
                    .selected_option_ids
                    .first()
                    .cloned()
                    .or_else(|| {
                        decision.kind.and_then(|kind| {
                            interaction
                                .option_by_decision
                                .get(decision_key(kind))
                                .cloned()
                        })
                    })
                    .or_else(|| interaction.option_by_decision.get("deny").cloned())
                    .ok_or("The ACP agent did not provide a compatible permission option.")?;
                json!({"outcome": {"outcome": "selected", "optionId": option_id}})
            };
            return process
                .send(&json!({"jsonrpc": "2.0", "id": interaction.native_id, "result": result}))
                .await;
        }
        Err(format!(
            "The {} request is no longer actionable.",
            self.provider.display_name()
        ))
    }

    async fn release_thread(&self, provider_instance_id: Uuid, thread_id: Uuid) {
        let key = (provider_instance_id, thread_id);
        let session = self.sessions.lock().await.remove(&key);
        self.session_by_turn
            .lock()
            .await
            .retain(|_, route| *route != key);
        if let Some(session) = session {
            retire_session(&session).await;
        }
    }

    async fn shutdown(&self) {
        let sessions: Vec<Arc<AcpSession>> =
            self.sessions.lock().await.drain().map(|(_, s)| s).collect();
        self.session_by_turn.lock().await.clear();
        for session in sessions {
            retire_session(&session).await;
        }
    }
}

async fn retire_session(session: &Arc<AcpSession>) {
    let (process, sink) = {
        let mut state = session.state.lock().await;
        for (_, sender) in state.pending.drain() {
            let _ = sender.send(Err("shutdown".into()));
        }
        state.interactions.clear();
        state.session_id = None;
        state.current_model = None;
        state.normalizer = NormalizerState::default();
        state.supports_load_session = false;
        state.supports_http_mcp = false;
        (
            state.process.take(),
            state.current_turn.take().map(|(_, sink)| sink),
        )
    };
    if let Some(sink) = sink {
        yield_draft(
            &sink,
            ProviderEventDraft::Terminal(ProviderTurnTerminalState::Cancelled),
        )
        .await;
    }
    if let Some(process) = process {
        process.shutdown().await;
    }
}

fn decision_key(kind: RuntimeDecisionKind) -> &'static str {
    match kind {
        RuntimeDecisionKind::Approve => "approve",
        RuntimeDecisionKind::ApproveForSession => "approveForSession",
        RuntimeDecisionKind::Deny => "deny",
        RuntimeDecisionKind::Cancel => "cancel",
    }
}

async fn begin(
    session: &Arc<AcpSession>,
    arguments: Vec<String>,
    request: &TurnRequest,
    sink: DraftSender,
) -> Result<(), String> {
    {
        let mut state = session.state.lock().await;
        if state.current_turn.is_some() {
            return Err(format!(
                "{} already has an active turn in this session.",
                session.provider.display_name()
            ));
        }
        state.current_turn = Some((request.turn_id, sink.clone()));
    }

    let needs_process = session.state.lock().await.process.is_none();
    if needs_process {
        let configuration = super::launch::launch_configuration(&request.profile)?;
        let mut environment = configuration.environment;
        configure_acp_environment(
            session.provider,
            request.browser_access.is_some(),
            &mut environment,
        );
        let process = JsonLineProcess::spawn(&LaunchSpec {
            executable: configuration.executable.to_string_lossy().to_string(),
            arguments,
            working_directory: Some(request.working_directory.clone()),
            environment,
        })?;
        session.state.lock().await.process = Some(process.clone());
        spawn_reader(session.clone(), process);

        let init = rpc_request(
            session,
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": false, "writeTextFile": false},
                    "terminal": false
                },
                "clientInfo": {"name": "maxx", "title": "Maxx", "version": "1.0"}
            }),
        )
        .await?;
        let version = init.get("protocolVersion").and_then(Value::as_i64);
        if version != Some(1) {
            return Err(format!(
                "{} negotiated ACP protocol {}; Maxx Provider Runtime v1 requires ACP 1.",
                session.provider.display_name(),
                version
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "unknown".into())
            ));
        }
        let supports_load = init
            .get("agentCapabilities")
            .and_then(Value::as_object)
            .and_then(|c| c.get("loadSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let supports_http_mcp = init
            .get("agentCapabilities")
            .and_then(Value::as_object)
            .and_then(|capabilities| capabilities.get("mcpCapabilities"))
            .and_then(Value::as_object)
            .and_then(|capabilities| capabilities.get("http"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut state = session.state.lock().await;
        state.supports_load_session = supports_load;
        state.supports_http_mcp = supports_http_mcp;
        drop(state);
    }

    // Establish the ACP session (new or load), then prompt.
    let existing_session = session.state.lock().await.session_id.clone();
    let session_id = if let Some(id) = existing_session {
        id
    } else {
        let supports_http_mcp = session.state.lock().await.supports_http_mcp;
        let mut params = json!({
            "cwd": request.working_directory,
            "mcpServers": browser_mcp_servers(request.browser_access.as_deref(), supports_http_mcp)
        });
        let method = if let Some(saved) = &request.session_id {
            let supported = session.state.lock().await.supports_load_session;
            if !supported {
                return Err(format!(
                    "provider.session.not-found: {} ACP does not advertise session loading.",
                    session.provider.display_name()
                ));
            }
            params["sessionId"] = Value::String(saved.clone());
            "session/load"
        } else {
            "session/new"
        };
        let response = rpc_request(session, method, params).await?;
        let current_model = acp_current_model(&response);
        if let Some(result) = response.as_object() {
            // Remember the active model's context window (Grok advertises it
            // per model) so prompt-response usage can report `used / max`.
            maxx_core::normalize::capture_acp_context_window(
                result,
                &mut session.state.lock().await.normalizer,
            );
        }
        let id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| request.session_id.clone())
            .ok_or_else(|| format!("{method} omitted result.sessionId"))?;
        {
            let mut state = session.state.lock().await;
            state.session_id = Some(id.clone());
            state.normalizer.session_id = Some(id.clone());
            state.current_model = current_model;
        }
        yield_draft(&sink, ProviderEventDraft::SessionUpdated(id.clone())).await;
        yield_draft(
            &sink,
            ProviderEventDraft::Status(format!(
                "{} session ready",
                session.provider.display_name()
            )),
        )
        .await;
        id
    };

    // Hermes takes no model flag at launch; use the ACP model-selection
    // extension only when the requested model actually changed. Hermes
    // rebuilds its AIAgent during `session/set_model`, so dynamically attached
    // MCP toolsets must be reattached afterward via the standard session/load
    // request. Temporarily unbinding the session drops Hermes's history replay
    // notifications while keeping the provider-owned history intact.
    if session.provider == ChatProvider::Hermes {
        if let Some(model) = request.selected_model() {
            let current_model = session.state.lock().await.current_model.clone();
            if current_model.as_deref() != Some(model.as_str()) {
                rpc_request(
                    session,
                    "session/set_model",
                    json!({"sessionId": session_id, "modelId": model}),
                )
                .await
                .map_err(|error| format!("Hermes could not switch to {model}: {error}"))?;

                if request.browser_access.is_some() {
                    let supports_load = session.state.lock().await.supports_load_session;
                    if !supports_load {
                        return Err(
                            "Hermes changed models but cannot reload its browser MCP toolset."
                                .into(),
                        );
                    }
                    let supports_http_mcp = session.state.lock().await.supports_http_mcp;
                    {
                        let mut state = session.state.lock().await;
                        state.session_id = None;
                    }
                    let reattach = rpc_request(
                        session,
                        "session/load",
                        json!({
                            "cwd": request.working_directory,
                            "sessionId": session_id,
                            "mcpServers": browser_mcp_servers(
                                request.browser_access.as_deref(),
                                supports_http_mcp,
                            )
                        }),
                    )
                    .await;
                    {
                        let mut state = session.state.lock().await;
                        state.session_id = Some(session_id.clone());
                        state.normalizer.session_id = Some(session_id.clone());
                    }
                    reattach.map_err(|error| {
                        format!("Hermes could not restore browser tools after switching to {model}: {error}")
                    })?;
                }
                session.state.lock().await.current_model = Some(model);
            }
        }
    }

    yield_draft(
        &sink,
        ProviderEventDraft::Status(format!("{} is working…", session.provider.display_name())),
    )
    .await;
    let mut prompt = Vec::new();
    if !request.prompt.is_empty() {
        prompt.push(json!({"type": "text", "text": request.prompt}));
    }
    for image in crate::attachments::encode_images(&request.attachments)? {
        prompt.push(json!({"type": "image", "data": image.data, "mimeType": image.mime_type}));
    }
    let response = rpc_request(
        session,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": prompt
        }),
    )
    .await?;

    // Reuse the normalizer's stop-reason mapping (including a pending failed
    // terminal from a Cursor provider-error chunk).
    let wrapped = json!({"result": response});
    let line = serde_json::to_vec(&wrapped).map_err(|e| e.to_string())?;
    let drafts = {
        let mut state = session.state.lock().await;
        let drafts =
            normalize(&line, session.provider, &mut state.normalizer).map_err(|e| e.to_string())?;
        state.current_turn = None;
        drafts
    };
    let mut yielded_terminal = false;
    for draft in drafts {
        if matches!(
            draft,
            ProviderEventDraft::Terminal(_) | ProviderEventDraft::Completed
        ) {
            yielded_terminal = true;
        }
        yield_draft(&sink, draft).await;
    }
    if !yielded_terminal {
        yield_draft(&sink, ProviderEventDraft::Completed).await;
    }
    Ok(())
}

fn configure_acp_environment(
    provider: ChatProvider,
    has_maxx_browser: bool,
    environment: &mut HashMap<String, String>,
) {
    if provider != ChatProvider::Hermes || !has_maxx_browser {
        return;
    }
    environment.insert(
        "HERMES_ACP_DISABLED_TOOLSETS".into(),
        "browser,computer_use".into(),
    );
    environment.insert("HERMES_ACP_SKIP_CONFIGURED_MCP".into(), "1".into());
    environment.insert(
        "HERMES_ACP_EPHEMERAL_SYSTEM_PROMPT".into(),
        HERMES_MAXX_BROWSER_POLICY.into(),
    );
}

fn browser_mcp_servers(
    browser_access: Option<&crate::browser_runtime::BrowserProviderAccess>,
    supports_http_mcp: bool,
) -> Vec<Value> {
    let Some(access) = browser_access else {
        return Vec::new();
    };
    if supports_http_mcp {
        return vec![json!({
            "type": "http",
            "name": "maxx_browser",
            "url": access.endpoint,
            "headers": [{
                "name": "Authorization",
                "value": format!("Bearer {}", access.bearer_token)
            }]
        })];
    }
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(error) => {
            log::error!("could not resolve Maxx executable for browser MCP stdio bridge: {error}");
            return Vec::new();
        }
    };
    vec![json!({
        "name": "maxx_browser",
        "command": executable,
        "args": [crate::browser_runtime::BRIDGE_ARGUMENT],
        "env": [
            {"name": crate::browser_runtime::ENDPOINT_ENV, "value": access.endpoint},
            {"name": crate::browser_runtime::TOKEN_ENV, "value": access.bearer_token}
        ]
    })]
}

fn acp_current_model(response: &Value) -> Option<String> {
    response
        .get("models")
        .and_then(Value::as_object)
        .and_then(|models| models.get("currentModelId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn spawn_reader(session: Arc<AcpSession>, process: Arc<JsonLineProcess>) {
    tokio::spawn(async move {
        loop {
            let line = {
                let mut lines = process.lines.lock().await;
                lines.recv().await
            };
            let closed = match line {
                Some(Ok(line)) => {
                    receive(&session, &line).await;
                    false
                }
                _ => true,
            };
            if closed {
                let (sink, pending) = {
                    let mut state = session.state.lock().await;
                    let Some(current) = &state.process else {
                        return;
                    };
                    if !Arc::ptr_eq(current, &process) {
                        return;
                    }
                    state.process = None;
                    state.session_id = None;
                    state.current_model = None;
                    state.normalizer = NormalizerState::default();
                    state.supports_load_session = false;
                    state.supports_http_mcp = false;
                    let pending: Vec<_> = state.pending.drain().collect();
                    (state.current_turn.take().map(|(_, s)| s), pending)
                };
                for (_, sender) in pending {
                    let _ = sender.send(Err(format!(
                        "{} connection closed",
                        session.provider.display_name()
                    )));
                }
                if let Some(sink) = sink {
                    yield_error(
                        &sink,
                        format!("{} connection closed", session.provider.display_name()),
                    )
                    .await;
                }
                return;
            }
        }
    });
}

async fn receive(session: &Arc<AcpSession>, line: &[u8]) {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return;
    };
    let Some(object) = value.as_object() else {
        return;
    };
    session
        .activity
        .send_modify(|version| *version = version.wrapping_add(1));

    // Responses to our requests resolve in-loop, preserving delivery order.
    let is_response = !object.contains_key("method")
        && (object.contains_key("result") || object.contains_key("error"));
    if is_response {
        if let Some(id) = object.get("id") {
            let key = match id {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let sender = session.state.lock().await.pending.remove(&key);
            if let Some(sender) = sender {
                let result = if let Some(error) = object.get("error") {
                    Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("ACP error")
                        .to_string())
                } else {
                    Ok(object.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = sender.send(result);
                return;
            }
        }
    }

    let method = object
        .get("method")
        .and_then(Value::as_str)
        .map(String::from);
    let mut state = session.state.lock().await;

    // Port of the Swift `turnBySession` guard: only lines for the bound
    // session reach the live turn. `session/load` replays the entire prior
    // conversation as `session/update` notifications before its response —
    // the session is not bound yet at that point, so the replay is dropped
    // instead of streaming history into the new turn. Unknown server→client
    // requests still get a -32601 answer so the agent is not left waiting.
    let line_session = object
        .get("params")
        .and_then(Value::as_object)
        .and_then(|p| p.get("sessionId"))
        .and_then(Value::as_str);
    let session_bound = match (state.session_id.as_deref(), line_session) {
        (Some(bound), Some(session)) => bound == session,
        (Some(_), None) => true,
        (None, _) => false,
    };
    if !session_bound {
        if let (Some(native_id), Some(method)) = (object.get("id"), &method) {
            let process = state.process.clone();
            let native_id = native_id.clone();
            let method = method.clone();
            drop(state);
            if let Some(process) = process {
                let _ = process
                    .send(&json!({
                        "jsonrpc": "2.0",
                        "id": native_id,
                        "error": {"code": -32601, "message": format!("Maxx does not support ACP client method {method}.")}
                    }))
                    .await;
            }
        }
        return;
    }

    let drafts = match normalize(line, session.provider, &mut state.normalizer) {
        Ok(drafts) => drafts,
        Err(error) => {
            let current = state.current_turn.take();
            drop(state);
            if let Some((_, sink)) = current {
                yield_error(&sink, error.to_string()).await;
            }
            return;
        }
    };

    // Server → client request: remember the native id for resolve(); answer
    // unsupported methods with -32601 like the Swift runtime.
    if let (Some(native_id), Some(method)) = (object.get("id"), &method) {
        let interactive: Vec<Uuid> = drafts
            .iter()
            .filter_map(|d| match d {
                ProviderEventDraft::Payload {
                    request_id: Some(id),
                    ..
                } => Some(*id),
                _ => None,
            })
            .collect();
        if interactive.is_empty() {
            if method != "session/update" {
                let process = state.process.clone();
                let native_id = native_id.clone();
                let method = method.clone();
                drop(state);
                if let Some(process) = process {
                    let _ = process
                        .send(&json!({
                            "jsonrpc": "2.0",
                            "id": native_id,
                            "error": {"code": -32601, "message": format!("Maxx does not support ACP client method {method}.")}
                        }))
                        .await;
                }
                state = session.state.lock().await;
            }
        } else {
            let option_by_decision = option_map(object);
            let is_question =
                method == "session/request_input" || method == "session/request_user_input";
            for request_id in interactive {
                state.interactions.insert(
                    request_id,
                    PendingInteraction {
                        native_id: native_id.clone(),
                        option_by_decision: option_by_decision.clone(),
                        is_question,
                    },
                );
            }
        }
    }

    let sink = state.current_turn.as_ref().map(|(_, sink)| sink.clone());
    drop(state);
    let Some(sink) = sink else { return };
    for draft in drafts {
        yield_draft(&sink, draft).await;
    }
}

fn option_map(object: &serde_json::Map<String, Value>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let options = object
        .get("params")
        .and_then(Value::as_object)
        .and_then(|p| p.get("options"))
        .and_then(Value::as_array);
    if let Some(options) = options {
        for option in options.iter().filter_map(Value::as_object) {
            let Some(id) = option.get("optionId").and_then(Value::as_str) else {
                continue;
            };
            let kind = option
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let key = if kind.contains("reject") {
                "deny"
            } else if kind.contains("always") {
                "approveForSession"
            } else {
                "approve"
            };
            map.entry(key.to_string()).or_insert_with(|| id.to_string());
        }
    }
    map
}

async fn rpc_request(
    session: &Arc<AcpSession>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let id = session.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    let activity = session.activity.subscribe();
    let process = {
        let mut state = session.state.lock().await;
        let process = state
            .process
            .clone()
            .ok_or_else(|| format!("{} connection closed", session.provider.display_name()))?;
        state.pending.insert(id.to_string(), tx);
        process
    };
    process
        .send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
        .await?;
    let timeout_policy = if method == "session/prompt" {
        RpcTimeoutPolicy::Inactivity
    } else {
        RpcTimeoutPolicy::Absolute
    };
    match wait_for_rpc_response(rx, activity, ACP_REQUEST_TIMEOUT, timeout_policy).await {
        RpcWaitOutcome::Response(result) => result,
        RpcWaitOutcome::Dropped => Err("ACP request dropped".into()),
        RpcWaitOutcome::TimedOut => {
            reset_timed_out_session(session, &id.to_string(), method).await;
            if timeout_policy == RpcTimeoutPolicy::Inactivity {
                Err(format!(
                    "{} became unresponsive: no ACP activity for 10 minutes",
                    session.provider.display_name()
                ))
            } else {
                Err(format!("ACP {method} request timed out"))
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RpcTimeoutPolicy {
    Absolute,
    Inactivity,
}

enum RpcWaitOutcome {
    Response(Result<Value, String>),
    Dropped,
    TimedOut,
}

async fn wait_for_rpc_response(
    mut response: oneshot::Receiver<Result<Value, String>>,
    mut activity: watch::Receiver<u64>,
    timeout: Duration,
    policy: RpcTimeoutPolicy,
) -> RpcWaitOutcome {
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut activity_open = true;

    loop {
        tokio::select! {
            result = &mut response => {
                return match result {
                    Ok(result) => RpcWaitOutcome::Response(result),
                    Err(_) => RpcWaitOutcome::Dropped,
                };
            }
            changed = activity.changed(), if policy == RpcTimeoutPolicy::Inactivity && activity_open => {
                if changed.is_ok() {
                    deadline.as_mut().reset(Instant::now() + timeout);
                } else {
                    activity_open = false;
                }
            }
            _ = &mut deadline => return RpcWaitOutcome::TimedOut,
        }
    }
}

async fn reset_timed_out_session(session: &Arc<AcpSession>, request_id: &str, method: &str) {
    let (process, session_id, pending) = {
        let mut state = session.state.lock().await;
        state.pending.remove(request_id);
        let pending: Vec<_> = state.pending.drain().map(|(_, sender)| sender).collect();
        let process = state.process.take();
        let session_id = state.session_id.take();
        state.interactions.clear();
        state.current_model = None;
        state.normalizer = NormalizerState::default();
        state.supports_load_session = false;
        state.supports_http_mcp = false;
        (process, session_id, pending)
    };

    for sender in pending {
        let _ = sender.send(Err(format!("ACP session reset after {method} timed out")));
    }

    if let Some(process) = process {
        if let Some(session_id) = session_id {
            let _ = process
                .send(&json!({
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": {"sessionId": session_id}
                }))
                .await;
        }
        process.shutdown().await;
    }
}

async fn force_cancel(session: &Arc<AcpSession>, turn_id: Uuid) {
    let sink = {
        let mut state = session.state.lock().await;
        if state.current_turn.as_ref().map(|(id, _)| *id) != Some(turn_id) {
            return;
        }
        state.current_turn.take().map(|(_, sink)| sink)
    };
    if let Some(sink) = sink {
        yield_draft(
            &sink,
            ProviderEventDraft::Terminal(ProviderTurnTerminalState::Cancelled),
        )
        .await;
    }
}

#[cfg(test)]
mod browser_mcp_tests {
    use super::*;
    use crate::browser_runtime::BrowserProviderAccess;

    fn test_session() -> Arc<AcpSession> {
        let (activity, _) = watch::channel(0);
        Arc::new(AcpSession {
            provider: ChatProvider::Hermes,
            state: Mutex::new(SessionState::default()),
            next_id: AtomicI64::new(1),
            activity,
        })
    }

    #[test]
    fn hermes_with_maxx_browser_gets_an_exclusive_browser_surface() {
        let mut environment = HashMap::from([("PATH".into(), "/bin".into())]);

        configure_acp_environment(ChatProvider::Hermes, true, &mut environment);

        assert_eq!(
            environment
                .get("HERMES_ACP_DISABLED_TOOLSETS")
                .map(String::as_str),
            Some("browser,computer_use")
        );
        assert_eq!(
            environment
                .get("HERMES_ACP_SKIP_CONFIGURED_MCP")
                .map(String::as_str),
            Some("1")
        );
        assert!(environment["HERMES_ACP_EPHEMERAL_SYSTEM_PROMPT"]
            .contains("only browser-control surface"));
        assert_eq!(environment.get("PATH").map(String::as_str), Some("/bin"));
    }

    #[test]
    fn other_acp_sessions_keep_their_native_tool_surface() {
        let mut environment = HashMap::new();
        configure_acp_environment(ChatProvider::Hermes, false, &mut environment);
        configure_acp_environment(ChatProvider::Cursor, true, &mut environment);
        assert!(environment.is_empty());
    }

    #[test]
    fn emits_http_when_advertised_and_stdio_otherwise() {
        let access = BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "secret-token".into(),
        };
        let stdio = browser_mcp_servers(Some(&access), false);
        assert_eq!(stdio.len(), 1);
        assert_eq!(stdio[0]["name"], "maxx_browser");
        assert_eq!(
            stdio[0]["args"],
            json!([crate::browser_runtime::BRIDGE_ARGUMENT])
        );
        assert_eq!(
            stdio[0]["env"],
            json!([
                {"name": crate::browser_runtime::ENDPOINT_ENV, "value": "http://127.0.0.1:43123/mcp"},
                {"name": crate::browser_runtime::TOKEN_ENV, "value": "secret-token"}
            ])
        );
        assert!(!stdio[0]["command"].as_str().unwrap().is_empty());
        assert!(browser_mcp_servers(None, true).is_empty());

        assert_eq!(
            browser_mcp_servers(Some(&access), true),
            vec![json!({
                "type": "http",
                "name": "maxx_browser",
                "url": "http://127.0.0.1:43123/mcp",
                "headers": [{
                    "name": "Authorization",
                    "value": "Bearer secret-token"
                }]
            })]
        );
    }

    #[test]
    fn reads_the_active_acp_model_before_deciding_to_switch() {
        assert_eq!(
            acp_current_model(&json!({"models": {"currentModelId": "grok-4.5"}})),
            Some("grok-4.5".into())
        );
        assert_eq!(acp_current_model(&json!({"models": {}})), None);
    }

    #[test]
    fn grok_uses_native_rules_and_disables_cross_session_memory_for_agents() {
        let mut request = crate::engine::test_request(ChatProvider::Grok);
        request.model = "grok-4.5".into();
        request.effort = Some("high".into());
        request.agent_instructions = Some("You are Dana.".into());

        assert_eq!(
            grok_arguments(&request).unwrap(),
            vec![
                "--rules",
                "You are Dana.",
                "--no-memory",
                "agent",
                "--model",
                "grok-4.5",
                "--reasoning-effort",
                "high",
                "stdio"
            ]
        );
        assert_eq!(request.prompt, "user prompt");
    }

    #[test]
    fn acp_harnesses_without_privileged_instructions_reject_custom_agents() {
        let mut cursor = crate::engine::test_request(ChatProvider::Cursor);
        cursor.agent_instructions = Some("You are Dana.".into());
        assert!(cursor_arguments(&cursor)
            .unwrap_err()
            .contains("cannot run Maxx custom agents safely"));

        let mut hermes = crate::engine::test_request(ChatProvider::Hermes);
        hermes.agent_instructions = Some("You are Dana.".into());
        assert!(hermes_arguments(&hermes)
            .unwrap_err()
            .contains("cannot run Maxx custom agents safely"));
    }

    #[tokio::test(start_paused = true)]
    async fn prompt_timeout_resets_when_acp_progress_arrives() {
        let (response_tx, response_rx) = oneshot::channel();
        let (activity_tx, activity_rx) = watch::channel(0);
        let waiter = tokio::spawn(wait_for_rpc_response(
            response_rx,
            activity_rx,
            ACP_REQUEST_TIMEOUT,
            RpcTimeoutPolicy::Inactivity,
        ));
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_secs(599)).await;
        activity_tx.send_modify(|version| *version += 1);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(599)).await;
        response_tx
            .send(Ok(json!({"stopReason": "end_turn"})))
            .unwrap();

        match waiter.await.unwrap() {
            RpcWaitOutcome::Response(Ok(response)) => {
                assert_eq!(response["stopReason"], "end_turn");
            }
            _ => panic!("active prompt should outlive the original absolute deadline"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn control_request_timeout_remains_absolute() {
        let (_response_tx, response_rx) = oneshot::channel();
        let (activity_tx, activity_rx) = watch::channel(0);
        let waiter = tokio::spawn(wait_for_rpc_response(
            response_rx,
            activity_rx,
            ACP_REQUEST_TIMEOUT,
            RpcTimeoutPolicy::Absolute,
        ));
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_secs(599)).await;
        activity_tx.send_modify(|version| *version += 1);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;

        assert!(matches!(waiter.await.unwrap(), RpcWaitOutcome::TimedOut));
    }

    #[tokio::test]
    async fn timed_out_session_drops_transport_state_and_pending_requests() {
        let session = test_session();
        let (pending_tx, pending_rx) = oneshot::channel();
        {
            let mut state = session.state.lock().await;
            state.session_id = Some("stale-session".into());
            state.current_model = Some("stale-model".into());
            state.supports_load_session = true;
            state.supports_http_mcp = true;
            state.normalizer.session_id = Some("stale-session".into());
            state.pending.insert("other-request".into(), pending_tx);
        }

        reset_timed_out_session(&session, "timed-out-request", "session/prompt").await;

        let state = session.state.lock().await;
        assert!(state.process.is_none());
        assert!(state.session_id.is_none());
        assert!(state.current_model.is_none());
        assert!(state.normalizer.session_id.is_none());
        assert!(!state.supports_load_session);
        assert!(!state.supports_http_mcp);
        assert!(state.pending.is_empty());
        drop(state);
        assert_eq!(
            pending_rx.await.unwrap().unwrap_err(),
            "ACP session reset after session/prompt timed out"
        );
    }
}
