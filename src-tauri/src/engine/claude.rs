//! Port of `ClaudeRuntimeAdapter` / `ClaudeStreamingSession`: one long-lived
//! `claude --input-format stream-json` process per (profile, thread), a
//! bidirectional control channel for initialize / set_model / interrupt /
//! permission responses, and native-session reaffirmation on resumed turns.

use super::process::{JsonLineProcess, LaunchSpec};
use super::{yield_draft, yield_error, DraftSender, ProviderEngine, TurnRequest};
use async_trait::async_trait;
use maxx_core::contract::*;
use maxx_core::normalize::{normalize, NormalizerState, ProviderEventDraft};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

#[derive(Default)]
pub struct ClaudeEngine {
    sessions: Mutex<HashMap<(Uuid, Uuid), Arc<ClaudeSession>>>,
    session_by_turn: Mutex<HashMap<Uuid, (Uuid, Uuid)>>,
}

struct PendingInteraction {
    native_request_id: String,
    original_input: Option<Value>,
    permission_suggestions: Option<Value>,
    is_question: bool,
}

#[derive(Default)]
struct SessionState {
    process: Option<Arc<JsonLineProcess>>,
    normalizer: NormalizerState,
    initialized: bool,
    current_model: Option<String>,
    current_turn: Option<(Uuid, DraftSender)>,
    cancellation_requested: Option<Uuid>,
    pending_control: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    interactions: HashMap<Uuid, PendingInteraction>,
}

#[derive(Default)]
struct ClaudeSession {
    state: Mutex<SessionState>,
}

#[async_trait]
impl ProviderEngine for ClaudeEngine {
    fn provider(&self) -> ChatProvider {
        ChatProvider::Claude
    }

    async fn run_turn(&self, request: TurnRequest, sink: DraftSender) {
        let key = (request.provider_instance_id, request.thread_id);
        let (session, replaced) = {
            let mut sessions = self.sessions.lock().await;
            let replaced = request
                .starts_fresh_agent_session()
                .then(|| sessions.remove(&key))
                .flatten();
            let session = sessions
                .entry(key)
                .or_insert_with(|| Arc::new(ClaudeSession::default()))
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
        let session = session.clone();
        tokio::spawn(async move {
            if let Err(error) = begin(&session, &request, sink.clone()).await {
                let mut state = session.state.lock().await;
                state.current_turn = None;
                state.cancellation_requested = None;
                drop(state);
                yield_error(&sink, error).await;
            }
        });
    }

    async fn cancel(&self, turn_id: Uuid) {
        let key = { self.session_by_turn.lock().await.get(&turn_id).copied() };
        let Some(key) = key else { return };
        let session = { self.sessions.lock().await.get(&key).cloned() };
        let Some(session) = session else { return };
        cancel_turn(&session, turn_id).await;
    }

    async fn resolve(
        &self,
        request_id: Uuid,
        decision: RuntimeInteractionDecision,
    ) -> Result<(), String> {
        let sessions: Vec<Arc<ClaudeSession>> =
            self.sessions.lock().await.values().cloned().collect();
        for session in sessions {
            if session
                .state
                .lock()
                .await
                .interactions
                .contains_key(&request_id)
            {
                return resolve_interaction(&session, request_id, decision).await;
            }
        }
        Err("The Claude request is no longer actionable.".into())
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
        let sessions: Vec<Arc<ClaudeSession>> =
            self.sessions.lock().await.drain().map(|(_, s)| s).collect();
        self.session_by_turn.lock().await.clear();
        for session in sessions {
            retire_session(&session).await;
        }
    }
}

async fn retire_session(session: &Arc<ClaudeSession>) {
    let (process, sink) = {
        let mut state = session.state.lock().await;
        for (_, sender) in state.pending_control.drain() {
            let _ = sender.send(Err("shutdown".into()));
        }
        state.interactions.clear();
        state.initialized = false;
        state.cancellation_requested = None;
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

async fn begin(
    session: &Arc<ClaudeSession>,
    request: &TurnRequest,
    sink: DraftSender,
) -> Result<(), String> {
    {
        let mut state = session.state.lock().await;
        if state.current_turn.is_some() {
            return Err("Claude already has an active turn in this session.".into());
        }
        state.current_turn = Some((request.turn_id, sink.clone()));
        state.cancellation_requested = None;
    }
    yield_draft(
        &sink,
        ProviderEventDraft::Status("Starting Claude streaming session…".into()),
    )
    .await;

    ensure_process(session, request).await?;

    // A persistent Claude process does not repeat its system/init event on
    // later turns; reaffirm the already native-confirmed binding.
    {
        let state = session.state.lock().await;
        if let (Some(requested), Some(confirmed)) =
            (&request.session_id, &state.normalizer.session_id)
        {
            if requested == confirmed {
                let sink = sink.clone();
                let confirmed = confirmed.clone();
                drop(state);
                yield_draft(&sink, ProviderEventDraft::SessionUpdated(confirmed)).await;
            }
        }
    }

    let selected_model = request.selected_model();
    let needs_model_change = {
        let state = session.state.lock().await;
        state.initialized && selected_model != state.current_model
    };
    if needs_model_change {
        send_control_request(
            session,
            json!({"subtype": "set_model", "model": selected_model}),
        )
        .await?;
        session.state.lock().await.current_model = selected_model.clone();
    }

    let (process, session_id) = {
        let state = session.state.lock().await;
        (
            state.process.clone().ok_or("Claude process unavailable")?,
            state
                .normalizer
                .session_id
                .clone()
                .or_else(|| request.session_id.clone()),
        )
    };
    let content = if request.attachments.is_empty() {
        Value::String(request.prompt.clone())
    } else {
        let mut blocks = Vec::new();
        if !request.prompt.is_empty() {
            blocks.push(json!({"type": "text", "text": request.prompt}));
        }
        for image in crate::attachments::encode_images(&request.attachments)? {
            blocks.push(json!({
                "type": "image",
                "source": {"type": "base64", "media_type": image.mime_type, "data": image.data}
            }));
        }
        Value::Array(blocks)
    };
    let mut message = json!({
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": Value::Null
    });
    if let Some(session_id) = session_id {
        message["session_id"] = Value::String(session_id);
    }
    process.send(&message).await
}

async fn ensure_process(session: &Arc<ClaudeSession>, request: &TurnRequest) -> Result<(), String> {
    if session.state.lock().await.process.is_some() {
        return Ok(());
    }
    let configuration = super::launch::launch_configuration(&request.profile)?;
    let selected_model = request.selected_model();
    let mut arguments = claude_arguments(request);
    let browser_config = request
        .browser_access
        .as_deref()
        .map(EphemeralClaudeMcpConfig::create)
        .transpose()?;
    if let Some(config) = &browser_config {
        arguments.extend([
            "--mcp-config".into(),
            config.path.to_string_lossy().to_string(),
            "--allowedTools".into(),
            "mcp__maxx_browser".into(),
        ]);
    }
    let process = JsonLineProcess::spawn(&LaunchSpec {
        executable: configuration.executable.to_string_lossy().to_string(),
        arguments,
        working_directory: Some(request.working_directory.clone()),
        environment: configuration.environment,
    })?;
    {
        let mut state = session.state.lock().await;
        state.process = Some(process.clone());
        state.current_model = selected_model;
    }
    let reader_session = session.clone();
    let reader_process = process.clone();
    tokio::spawn(async move {
        loop {
            let line = {
                let mut lines = reader_process.lines.lock().await;
                lines.recv().await
            };
            match line {
                Some(Ok(line)) => receive(&reader_session, &line).await,
                Some(Err(error)) => {
                    connection_closed(&reader_session, &reader_process, error).await;
                    return;
                }
                None => {
                    connection_closed(
                        &reader_session,
                        &reader_process,
                        "Claude connection closed".into(),
                    )
                    .await;
                    return;
                }
            }
        }
    });
    send_control_request(
        session,
        json!({"subtype": "initialize", "hooks": Value::Null}),
    )
    .await?;
    session.state.lock().await.initialized = true;
    // Claude reads its explicit MCP configuration during startup. Dropping the
    // guard deletes the mode-0600 secret-bearing file immediately afterward.
    drop(browser_config);
    Ok(())
}

fn claude_arguments(request: &TurnRequest) -> Vec<String> {
    let mut arguments: Vec<String> = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(model) = request.selected_model() {
        arguments.extend(["--model".into(), model]);
    }
    if let Some(effort) = request.selected_effort() {
        arguments.extend(["--effort".into(), effort]);
    }
    if let Some(instructions) = &request.agent_instructions {
        arguments.extend(["--append-system-prompt".into(), instructions.clone()]);
    }
    if let Some(session_id) = &request.session_id {
        arguments.extend(["--resume".into(), session_id.clone()]);
    }
    arguments
}

struct EphemeralClaudeMcpConfig {
    path: PathBuf,
}

impl EphemeralClaudeMcpConfig {
    fn create(access: &crate::browser_runtime::BrowserProviderAccess) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "maxx-claude-browser-mcp-{}.json",
            Uuid::new_v4().simple()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|error| format!("Could not create Claude browser MCP config: {error}"))?;
        let body = json!({
            "mcpServers": {
                "maxx_browser": {
                    "type": "http",
                    "url": access.endpoint,
                    "headers": {
                        "Authorization": format!("Bearer {}", access.bearer_token)
                    }
                }
            }
        });
        let serialized = serde_json::to_vec(&body)
            .map_err(|error| format!("Could not encode Claude browser MCP config: {error}"))?;
        if let Err(error) = file.write_all(&serialized).and_then(|_| file.sync_all()) {
            let _ = std::fs::remove_file(&path);
            return Err(format!(
                "Could not write Claude browser MCP config: {error}"
            ));
        }
        Ok(Self { path })
    }
}

impl Drop for EphemeralClaudeMcpConfig {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("could not remove Claude browser MCP config: {error}");
            }
        }
    }
}

#[cfg(test)]
mod browser_mcp_tests {
    use super::*;
    use crate::browser_runtime::BrowserProviderAccess;

    #[test]
    fn ephemeral_config_is_private_exact_and_deleted_on_drop() {
        let access = BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "secret-token".into(),
        };
        let guard = EphemeralClaudeMcpConfig::create(&access).unwrap();
        let path = guard.path.clone();
        let body: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            body["mcpServers"]["maxx_browser"]["headers"]["Authorization"],
            "Bearer secret-token"
        );
        assert_eq!(
            body["mcpServers"]["maxx_browser"]["url"],
            "http://127.0.0.1:43123/mcp"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(guard);
        assert!(!path.exists());
    }

    #[test]
    fn agent_identity_is_appended_to_claudes_system_prompt() {
        let mut request = crate::engine::test_request(ChatProvider::Claude);
        request.agent_instructions = Some("You are Dana.".into());

        let arguments = claude_arguments(&request);
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["--append-system-prompt", "You are Dana."]));
        assert_eq!(request.prompt, "user prompt");
    }
}

async fn send_control_request(
    session: &Arc<ClaudeSession>,
    request: Value,
) -> Result<Value, String> {
    let request_id = format!("maxx_{}", Uuid::new_v4());
    let (tx, rx) = oneshot::channel();
    let process = {
        let mut state = session.state.lock().await;
        let process = state.process.clone().ok_or("Claude connection closed")?;
        state.pending_control.insert(request_id.clone(), tx);
        process
    };
    let message = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": request
    });
    if let Err(error) = process.send(&message).await {
        session
            .state
            .lock()
            .await
            .pending_control
            .remove(&request_id);
        return Err(error);
    }
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Claude control request dropped".into()),
        Err(_) => {
            session
                .state
                .lock()
                .await
                .pending_control
                .remove(&request_id);
            Err("Claude control request timed out".into())
        }
    }
}

async fn receive(session: &Arc<ClaudeSession>, line: &[u8]) {
    let parsed: Option<Value> = serde_json::from_slice(line).ok();
    let object: Option<&Map<String, Value>> = parsed.as_ref().and_then(Value::as_object);
    let mut state = session.state.lock().await;
    let Some(object) = object else {
        if let Some((_, sink)) = state.current_turn.take() {
            state.cancellation_requested = None;
            let detail = String::from_utf8_lossy(line).to_string();
            drop(state);
            yield_error(
                &sink,
                format!("Claude emitted a malformed native message: {detail}"),
            )
            .await;
        }
        return;
    };
    let message_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if message_type == "control_response" {
        if let Some(response) = object.get("response").and_then(Value::as_object) {
            if let Some(request_id) = response.get("request_id").and_then(Value::as_str) {
                if let Some(sender) = state.pending_control.remove(request_id) {
                    if response.get("subtype").and_then(Value::as_str) == Some("error") {
                        let _ = sender.send(Err(response
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Claude control request failed.")
                            .to_string()));
                    } else {
                        let _ = sender
                            .send(Ok(response.get("response").cloned().unwrap_or(Value::Null)));
                    }
                    return;
                }
            }
        }
        return;
    }

    let Some((turn_id, sink)) = state.current_turn.clone() else {
        if let Some(session_id) = object.get("session_id").and_then(Value::as_str) {
            state.normalizer.session_id = Some(session_id.to_string());
        }
        return;
    };

    // A result after a requested interrupt is the cancellation acknowledgement,
    // even when Claude encodes it as error_during_execution.
    if message_type == "result" && state.cancellation_requested == Some(turn_id) {
        state.interactions.clear();
        state.current_turn = None;
        state.cancellation_requested = None;
        drop(state);
        yield_draft(
            &sink,
            ProviderEventDraft::Terminal(ProviderTurnTerminalState::Cancelled),
        )
        .await;
        return;
    }

    let drafts = match normalize(line, ChatProvider::Claude, &mut state.normalizer) {
        Ok(drafts) => drafts,
        Err(error) => {
            state.current_turn = None;
            state.cancellation_requested = None;
            drop(state);
            yield_error(&sink, error.to_string()).await;
            return;
        }
    };

    if message_type == "control_request" {
        if let Some(request_id) = object.get("request_id").and_then(Value::as_str) {
            let canonical = state.normalizer.request_id(request_id);
            let request = object.get("request").and_then(Value::as_object);
            state.interactions.insert(
                canonical,
                PendingInteraction {
                    native_request_id: request_id.to_string(),
                    original_input: request.and_then(|r| r.get("input")).cloned(),
                    permission_suggestions: request
                        .and_then(|r| r.get("permission_suggestions"))
                        .cloned(),
                    is_question: request
                        .and_then(|r| r.get("tool_name"))
                        .and_then(Value::as_str)
                        == Some("AskUserQuestion"),
                },
            );
        }
    }

    let mut terminal = false;
    for draft in &drafts {
        if matches!(
            draft,
            ProviderEventDraft::Terminal(_) | ProviderEventDraft::Completed
        ) {
            terminal = true;
        }
    }
    if terminal {
        state.current_turn = None;
        state.cancellation_requested = None;
    }
    drop(state);
    for draft in drafts {
        yield_draft(&sink, draft).await;
    }
}

async fn connection_closed(
    session: &Arc<ClaudeSession>,
    source: &Arc<JsonLineProcess>,
    error: String,
) {
    let mut state = session.state.lock().await;
    if let Some(process) = &state.process {
        if !Arc::ptr_eq(process, source) {
            return;
        }
    }
    state.process = None;
    state.initialized = false;
    for (_, sender) in state.pending_control.drain() {
        let _ = sender.send(Err(error.clone()));
    }
    state.interactions.clear();
    let current = state.current_turn.take();
    state.cancellation_requested = None;
    drop(state);
    if let Some((_, sink)) = current {
        yield_error(&sink, error).await;
    }
}

async fn cancel_turn(session: &Arc<ClaudeSession>, turn_id: Uuid) {
    {
        let mut state = session.state.lock().await;
        if state.current_turn.as_ref().map(|(id, _)| *id) != Some(turn_id) {
            return;
        }
        state.cancellation_requested = Some(turn_id);
    }
    let interrupted = send_control_request(session, json!({"subtype": "interrupt"})).await;
    match interrupted {
        Ok(_) => {
            // Fallback: if the native interrupt never produces a result, close
            // the turn as cancelled and recycle the process.
            let session = session.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                complete_cancellation_if_needed(&session, turn_id).await;
            });
        }
        Err(_) => {
            complete_cancellation_if_needed(session, turn_id).await;
        }
    }
}

async fn complete_cancellation_if_needed(session: &Arc<ClaudeSession>, turn_id: Uuid) {
    let (sink, process) = {
        let mut state = session.state.lock().await;
        if state.current_turn.as_ref().map(|(id, _)| *id) != Some(turn_id) {
            return;
        }
        let (_, sink) = state.current_turn.take().unwrap();
        state.cancellation_requested = None;
        for (_, sender) in state.pending_control.drain() {
            let _ = sender.send(Err("cancelled".into()));
        }
        state.interactions.clear();
        state.initialized = false;
        (sink, state.process.take())
    };
    yield_draft(
        &sink,
        ProviderEventDraft::Terminal(ProviderTurnTerminalState::Cancelled),
    )
    .await;
    if let Some(process) = process {
        process.shutdown().await;
    }
}

async fn resolve_interaction(
    session: &Arc<ClaudeSession>,
    request_id: Uuid,
    decision: RuntimeInteractionDecision,
) -> Result<(), String> {
    let (interaction, process) = {
        let mut state = session.state.lock().await;
        let interaction = state
            .interactions
            .remove(&request_id)
            .ok_or("The Claude request is no longer actionable.")?;
        let process = state
            .process
            .clone()
            .ok_or("The Claude request is no longer actionable.")?;
        (interaction, process)
    };

    let response_data: Value = if interaction.is_question && decision.kind.is_none() {
        let mut updated_input = interaction
            .original_input
            .clone()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let mut answers: HashMap<String, String> = decision.text_answers.clone();
        for value in &decision.selected_option_ids {
            let Some((question, answer)) = value.split_once(':') else {
                continue;
            };
            answers
                .entry(question.to_string())
                .and_modify(|existing| {
                    if existing.is_empty() {
                        *existing = answer.to_string();
                    } else {
                        *existing = format!("{existing}, {answer}");
                    }
                })
                .or_insert_with(|| answer.to_string());
        }
        updated_input.insert(
            "answers".into(),
            serde_json::to_value(answers).unwrap_or_default(),
        );
        json!({"behavior": "allow", "updatedInput": updated_input})
    } else {
        match decision.kind {
            Some(RuntimeDecisionKind::Approve) | Some(RuntimeDecisionKind::ApproveForSession) => {
                let original_input = interaction
                    .original_input
                    .clone()
                    .unwrap_or(Value::Object(Map::new()));
                let mut allowed = json!({"behavior": "allow", "updatedInput": original_input});
                if decision.kind == Some(RuntimeDecisionKind::ApproveForSession) {
                    if let Some(suggestions) = &interaction.permission_suggestions {
                        if suggestions
                            .as_array()
                            .map(|a| !a.is_empty())
                            .unwrap_or(false)
                        {
                            allowed["updatedPermissions"] = suggestions.clone();
                        }
                    }
                }
                allowed
            }
            Some(RuntimeDecisionKind::Deny) => {
                json!({"behavior": "deny", "message": "Denied in Maxx", "interrupt": false})
            }
            _ => {
                json!({"behavior": "deny", "message": "Turn cancelled in Maxx", "interrupt": true})
            }
        }
    };

    process
        .send(&json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": interaction.native_request_id,
                "response": response_data
            }
        }))
        .await
}
