//! Port of `PiRuntimeAdapter`: one long-lived `pi --mode rpc` process per
//! (profile, thread) because one RPC process has one mutable current session.
//! `get_state` binds the native session, `prompt` starts a turn, the
//! normalizer's `agent_settled` handling terminates it, `abort` cancels.

use super::process::{JsonLineProcess, LaunchSpec};
use super::{
    yield_draft, yield_error, DraftSender, ProviderEngine, ReconciledSessionTurn, TurnRequest,
};
use async_trait::async_trait;
use maxx_core::contract::*;
use maxx_core::normalize::{normalize, NormalizerState, ProviderEventDraft};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

#[derive(Default)]
pub struct PiEngine {
    sessions: Mutex<HashMap<(Uuid, Uuid), Arc<PiSession>>>,
    session_by_turn: Mutex<HashMap<Uuid, (Uuid, Uuid)>>,
}

struct PendingInteraction {
    native_id: Value,
    method: String,
    question_id: String,
    options: Vec<String>,
}

#[derive(Default)]
struct SessionState {
    process: Option<Arc<JsonLineProcess>>,
    normalizer: NormalizerState,
    session_id: Option<String>,
    current_turn: Option<(Uuid, DraftSender)>,
    pending_commands: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    browser_extension: Option<PiBrowserExtension>,
    interactions: HashMap<Uuid, PendingInteraction>,
}

#[derive(Default)]
struct PiSession {
    state: Mutex<SessionState>,
}

#[async_trait]
impl ProviderEngine for PiEngine {
    fn provider(&self) -> ChatProvider {
        ChatProvider::Pi
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
                .or_insert_with(|| Arc::new(PiSession::default()))
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
            if let Err(error) = begin(&session, &request, sink.clone()).await {
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
        let process = {
            let state = session.state.lock().await;
            if state.current_turn.as_ref().map(|(id, _)| *id) != Some(turn_id) {
                return;
            }
            state.process.clone()
        };
        let sent = match &process {
            Some(process) => process
                .send(&json!({"id": format!("maxx-abort-{}", Uuid::new_v4()), "type": "abort"}))
                .await
                .is_ok(),
            None => false,
        };
        if sent {
            let session = session.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                force_cancel(&session, turn_id).await;
            });
        } else {
            force_cancel(&session, turn_id).await;
        }
    }

    async fn resolve(
        &self,
        request_id: Uuid,
        decision: RuntimeInteractionDecision,
    ) -> Result<(), String> {
        let sessions: Vec<Arc<PiSession>> = self.sessions.lock().await.values().cloned().collect();
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
            let process = process.ok_or("The Pi extension request is no longer actionable.")?;

            let mut response = Map::new();
            response.insert("type".into(), Value::String("extension_ui_response".into()));
            response.insert("id".into(), interaction.native_id.clone());
            if decision.kind == Some(RuntimeDecisionKind::Cancel) {
                response.insert("cancelled".into(), Value::Bool(true));
            } else if interaction.method == "confirm" {
                let selected = selected_option(&decision, &interaction.question_id);
                response.insert(
                    "confirmed".into(),
                    Value::Bool(selected.as_deref() == Some("confirm")),
                );
            } else if interaction.method == "select" {
                let selected = selected_option(&decision, &interaction.question_id)
                    .ok_or("Pi select request needs a selected option.")?;
                let index: usize = selected
                    .strip_prefix("option-")
                    .and_then(|i| i.parse().ok())
                    .ok_or("Pi select request received an unknown option.")?;
                let label = interaction
                    .options
                    .get(index)
                    .cloned()
                    .ok_or("Pi select request received an out-of-range option.")?;
                response.insert("value".into(), Value::String(label));
            } else {
                let text = decision
                    .text_answers
                    .get(&interaction.question_id)
                    .cloned()
                    .or_else(|| decision.text_answers.values().next().cloned())
                    .unwrap_or_default();
                response.insert("value".into(), Value::String(text));
            }
            return process.send(&Value::Object(response)).await;
        }
        Err("The Pi extension request is no longer actionable.".into())
    }

    async fn reconcile_session(
        &self,
        request: TurnRequest,
    ) -> Result<Option<Vec<ReconciledSessionTurn>>, String> {
        let session_id = request
            .session_id
            .as_deref()
            .ok_or("The Pi session has not been established yet.")?;
        let configuration = super::launch::launch_configuration(&request.profile)?;
        let sessions_root = configuration
            .environment
            .get("PI_CODING_AGENT_SESSION_DIR")
            .map(|path| profile_path(path, &configuration.home))
            .unwrap_or_else(|| {
                configuration
                    .environment
                    .get("PI_CODING_AGENT_DIR")
                    .map(|path| profile_path(path, &configuration.home))
                    .unwrap_or_else(|| configuration.home.join(".pi/agent"))
                    .join("sessions")
            });
        let path = find_pi_session(&sessions_root, session_id).await?;
        Ok(Some(read_pi_session(&path, session_id).await?))
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
        let sessions: Vec<Arc<PiSession>> =
            self.sessions.lock().await.drain().map(|(_, s)| s).collect();
        self.session_by_turn.lock().await.clear();
        for session in sessions {
            retire_session(&session).await;
        }
    }
}

fn profile_path(path: &str, home: &std::path::Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home.join(rest);
    }
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        home.join(path)
    }
}

async fn find_pi_session(
    sessions_root: &std::path::Path,
    session_id: &str,
) -> Result<PathBuf, String> {
    let session_id = Uuid::parse_str(session_id)
        .map_err(|_| "provider.session.not-found: The saved Pi session ID is invalid.")?;
    let mut directories = tokio::fs::read_dir(sessions_root).await.map_err(|error| {
        format!(
            "provider.session.not-found: Could not read Pi sessions in {}: {error}",
            sessions_root.display()
        )
    })?;
    let suffix = format!("_{session_id}.jsonl");
    while let Some(entry) = directories
        .next_entry()
        .await
        .map_err(|error| format!("Could not inspect Pi sessions: {error}"))?
    {
        if !entry
            .file_type()
            .await
            .map_err(|error| format!("Could not inspect Pi session storage: {error}"))?
            .is_dir()
        {
            continue;
        }
        let mut files = tokio::fs::read_dir(entry.path())
            .await
            .map_err(|error| format!("Could not inspect Pi session directory: {error}"))?;
        while let Some(file) = files
            .next_entry()
            .await
            .map_err(|error| format!("Could not inspect Pi session file: {error}"))?
        {
            if file
                .file_name()
                .to_string_lossy()
                .ends_with(suffix.as_str())
                && file
                    .file_type()
                    .await
                    .map_err(|error| format!("Could not inspect Pi session file: {error}"))?
                    .is_file()
            {
                return Ok(file.path());
            }
        }
    }
    Err("provider.session.not-found: The saved Pi session is no longer available.".into())
}

#[derive(Default)]
struct PiSessionGraph {
    nodes: HashMap<String, PiLogNode>,
    latest_node: Option<String>,
}

struct PiLogNode {
    parent_id: Option<String>,
    timestamp: Option<AppleDate>,
    kind: PiLogNodeKind,
}

enum PiLogNodeKind {
    User(Option<String>),
    Assistant(Option<String>),
    Other,
}

struct PiTurnDraft {
    native_id: String,
    started_at: AppleDate,
    user_content: String,
    assistant_parts: Vec<String>,
}

impl PiSessionGraph {
    fn ingest(&mut self, value: Value) {
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            return;
        };
        let parent_id = value
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_pi_timestamp);
        let kind = if value.get("type").and_then(Value::as_str) == Some("message") {
            match value.pointer("/message/role").and_then(Value::as_str) {
                Some("user") => PiLogNodeKind::User(pi_message_text(&value)),
                Some("assistant") => PiLogNodeKind::Assistant(pi_message_text(&value)),
                _ => PiLogNodeKind::Other,
            }
        } else {
            PiLogNodeKind::Other
        };
        self.latest_node = Some(id.to_owned());
        self.nodes.insert(
            id.to_owned(),
            PiLogNode {
                parent_id,
                timestamp,
                kind,
            },
        );
    }

    fn reconciled_turns(self) -> Vec<ReconciledSessionTurn> {
        let Some(mut cursor) = self.latest_node else {
            return Vec::new();
        };
        let mut branch = Vec::new();
        let mut seen = HashSet::new();
        while seen.insert(cursor.clone()) {
            let Some(node) = self.nodes.get(&cursor) else {
                break;
            };
            branch.push((cursor, node));
            let Some(parent) = &node.parent_id else {
                break;
            };
            cursor = parent.clone();
        }
        branch.reverse();

        let mut turns = Vec::new();
        let mut current: Option<PiTurnDraft> = None;
        for (id, node) in branch {
            match &node.kind {
                PiLogNodeKind::User(Some(text)) => {
                    finish_pi_turn(&mut turns, current.take());
                    current = Some(PiTurnDraft {
                        native_id: id,
                        started_at: node.timestamp.unwrap_or_else(AppleDate::now),
                        user_content: text.clone(),
                        assistant_parts: Vec::new(),
                    });
                }
                PiLogNodeKind::Assistant(Some(text)) => {
                    if let Some(turn) = &mut current {
                        if !turn.assistant_parts.iter().any(|part| part == text) {
                            turn.assistant_parts.push(text.clone());
                        }
                    }
                }
                _ => {}
            }
        }
        finish_pi_turn(&mut turns, current);
        turns
    }
}

fn finish_pi_turn(turns: &mut Vec<ReconciledSessionTurn>, turn: Option<PiTurnDraft>) {
    let Some(turn) = turn else { return };
    if turn.user_content.trim().is_empty() {
        return;
    }
    turns.push(ReconciledSessionTurn {
        native_id: turn.native_id,
        started_at: turn.started_at,
        user_content: turn.user_content,
        assistant_content: turn.assistant_parts.join("\n\n").trim().to_owned(),
    });
}

fn pi_message_text(value: &Value) -> Option<String> {
    let content = value.pointer("/message/content")?;
    let text = match content {
        Value::String(text) => text.trim().to_owned(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_owned(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn parse_pi_timestamp(value: &str) -> Option<AppleDate> {
    value
        .parse::<jiff::Timestamp>()
        .ok()
        .map(|timestamp| AppleDate::from_unix_seconds(timestamp.as_millisecond() as f64 / 1_000.0))
}

async fn read_pi_session(
    path: &std::path::Path,
    session_id: &str,
) -> Result<Vec<ReconciledSessionTurn>, String> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("Could not open Pi session {}: {error}", path.display()))?;
    let mut lines = BufReader::new(file).lines();
    let mut graph = PiSessionGraph::default();
    let mut line_number = 0usize;
    let mut confirmed_session = false;
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|error| format!("Could not read Pi session {}: {error}", path.display()))?
    {
        line_number += 1;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line).map_err(|error| {
            format!(
                "Pi session {} contains invalid JSON on line {line_number}: {error}",
                path.display()
            )
        })?;
        if value.get("type").and_then(Value::as_str) == Some("session") {
            confirmed_session = value.get("id").and_then(Value::as_str) == Some(session_id);
            continue;
        }
        graph.ingest(value);
    }
    if !confirmed_session {
        return Err(
            "provider.session.not-found: The saved Pi session ID did not match its session file."
                .into(),
        );
    }
    Ok(graph.reconciled_turns())
}

async fn retire_session(session: &Arc<PiSession>) {
    let (process, sink) = {
        let mut state = session.state.lock().await;
        for (_, sender) in state.pending_commands.drain() {
            let _ = sender.send(Err("shutdown".into()));
        }
        state.interactions.clear();
        state.session_id = None;
        state.browser_extension = None;
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
    session: &Arc<PiSession>,
    request: &TurnRequest,
    sink: DraftSender,
) -> Result<(), String> {
    {
        let mut state = session.state.lock().await;
        if state.current_turn.is_some() {
            return Err("Pi already has an active turn in this session.".into());
        }
        state.current_turn = Some((request.turn_id, sink.clone()));
    }

    let had_session = session.state.lock().await.session_id.is_some();
    ensure_process(session, request).await?;

    let state_response = command(session, "get_state", Map::new()).await?;
    let data = state_response
        .get("data")
        .and_then(Value::as_object)
        .ok_or("Pi get_state did not return a native session identifier.")?;
    let session_id = data
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("Pi get_state did not return a native session identifier.")?
        .to_string();
    if request.session_id.is_some()
        && !had_session
        && data.get("messageCount").and_then(Value::as_i64) == Some(0)
    {
        return Err(format!(
            "provider.session.not-found: Pi session not found: {}",
            request
                .session_id
                .clone()
                .unwrap_or_else(|| "unknown".into())
        ));
    }
    {
        let mut state = session.state.lock().await;
        state.session_id = Some(session_id.clone());
        state.normalizer.session_id = Some(session_id.clone());
    }
    yield_draft(&sink, ProviderEventDraft::SessionUpdated(session_id)).await;
    yield_draft(&sink, ProviderEventDraft::Status("Pi is working…".into())).await;

    let mut fields = Map::new();
    fields.insert("message".into(), Value::String(request.prompt.clone()));
    if !request.attachments.is_empty() {
        let images = crate::attachments::encode_images(&request.attachments)?
            .into_iter()
            .map(|image| json!({"type": "image", "data": image.data, "mimeType": image.mime_type}))
            .collect();
        fields.insert("images".into(), Value::Array(images));
    }
    command(session, "prompt", fields).await?;
    Ok(())
}

async fn ensure_process(session: &Arc<PiSession>, request: &TurnRequest) -> Result<(), String> {
    if session.state.lock().await.process.is_some() {
        return Ok(());
    }
    let configuration = super::launch::launch_configuration(&request.profile)?;
    let mut arguments = pi_arguments(request);
    let mut environment = configuration.environment;
    let browser_extension = request
        .browser_access
        .as_deref()
        .map(PiBrowserExtension::create)
        .transpose()?;
    if let (Some(access), Some(extension)) = (
        request.browser_access.as_deref(),
        browser_extension.as_ref(),
    ) {
        environment.insert("MAXX_BROWSER_ENDPOINT".into(), access.endpoint.clone());
        environment.insert("MAXX_BROWSER_TOKEN".into(), access.bearer_token.clone());
        arguments.extend([
            "--extension".into(),
            extension.path.to_string_lossy().to_string(),
        ]);
    }
    let process = JsonLineProcess::spawn(&LaunchSpec {
        executable: configuration.executable.to_string_lossy().to_string(),
        arguments,
        working_directory: Some(request.working_directory.clone()),
        environment,
    })?;
    {
        let mut state = session.state.lock().await;
        state.process = Some(process.clone());
        state.browser_extension = browser_extension;
    }

    let reader_session = session.clone();
    let reader_process = process;
    tokio::spawn(async move {
        loop {
            let line = {
                let mut lines = reader_process.lines.lock().await;
                lines.recv().await
            };
            match line {
                Some(Ok(line)) => receive(&reader_session, &line).await,
                _ => {
                    let (sink, pending) = {
                        let mut state = reader_session.state.lock().await;
                        if let Some(current) = &state.process {
                            if !Arc::ptr_eq(current, &reader_process) {
                                return;
                            }
                        }
                        state.process = None;
                        state.browser_extension = None;
                        state.session_id = None;
                        let pending: Vec<_> = state.pending_commands.drain().collect();
                        (state.current_turn.take().map(|(_, s)| s), pending)
                    };
                    for (_, sender) in pending {
                        let _ = sender.send(Err("Pi connection closed".into()));
                    }
                    if let Some(sink) = sink {
                        yield_error(&sink, "Pi connection closed".into()).await;
                    }
                    return;
                }
            }
        }
    });
    Ok(())
}

fn pi_arguments(request: &TurnRequest) -> Vec<String> {
    let mut arguments = vec!["--mode".to_string(), "rpc".to_string()];
    if let Some(model) = request.selected_model() {
        arguments.extend(["--model".into(), model]);
    }
    if let Some(effort) = request.selected_effort() {
        arguments.extend(["--thinking".into(), effort]);
    }
    if let Some(instructions) = &request.agent_instructions {
        arguments.extend(["--append-system-prompt".into(), instructions.clone()]);
    }
    if let Some(session_id) = &request.session_id {
        arguments.extend(["--session".into(), session_id.clone()]);
    }
    arguments
}

struct PiBrowserExtension {
    path: PathBuf,
}

impl PiBrowserExtension {
    fn create(_access: &crate::browser_runtime::BrowserProviderAccess) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "maxx-pi-browser-mcp-{}.ts",
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
            .map_err(|error| format!("Could not create Pi browser extension: {error}"))?;
        if let Err(error) = file
            .write_all(include_bytes!("../../resources/pi-browser-mcp.ts"))
            .and_then(|_| file.sync_all())
        {
            let _ = std::fs::remove_file(&path);
            return Err(format!("Could not write Pi browser extension: {error}"));
        }
        Ok(Self { path })
    }
}

impl Drop for PiBrowserExtension {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("could not remove Pi browser extension: {error}");
            }
        }
    }
}

async fn command(
    session: &Arc<PiSession>,
    command_type: &str,
    mut fields: Map<String, Value>,
) -> Result<Value, String> {
    let id = format!("maxx-{}", Uuid::new_v4());
    fields.insert("id".into(), Value::String(id.clone()));
    fields.insert("type".into(), Value::String(command_type.into()));
    let (tx, rx) = oneshot::channel();
    let process = {
        let mut state = session.state.lock().await;
        let process = state.process.clone().ok_or("Pi connection closed")?;
        state.pending_commands.insert(id.clone(), tx);
        process
    };
    if let Err(error) = process.send(&Value::Object(fields)).await {
        session.state.lock().await.pending_commands.remove(&id);
        return Err(error);
    }
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Pi command dropped".into()),
        Err(_) => {
            session.state.lock().await.pending_commands.remove(&id);
            Err("Pi command timed out".into())
        }
    }
}

async fn receive(session: &Arc<PiSession>, line: &[u8]) {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return;
    };
    let Some(object) = value.as_object() else {
        return;
    };
    let message_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // Command responses resolve their waiters in-loop; failures surface to the
    // caller instead of tearing the whole turn down.
    if message_type == "response" {
        if let Some(id) = object.get("id").and_then(Value::as_str) {
            let sender = session.state.lock().await.pending_commands.remove(id);
            if let Some(sender) = sender {
                if object.get("success").and_then(Value::as_bool) == Some(false) {
                    let _ = sender.send(Err(object
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Pi rejected an RPC command.")
                        .to_string()));
                } else {
                    let _ = sender.send(Ok(value.clone()));
                }
                return;
            }
        }
    }

    let mut state = session.state.lock().await;
    let drafts = match normalize(line, ChatProvider::Pi, &mut state.normalizer) {
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

    if message_type == "extension_ui_request" {
        if let Some(native_id) = object.get("id") {
            let method = object
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let native_key = match native_id {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let options: Vec<String> = object
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            for draft in &drafts {
                if let ProviderEventDraft::Payload {
                    request_id: Some(request_id),
                    ..
                } = draft
                {
                    state.interactions.insert(
                        *request_id,
                        PendingInteraction {
                            native_id: native_id.clone(),
                            method: method.clone(),
                            question_id: format!("pi-extension-{native_key}"),
                            options: options.clone(),
                        },
                    );
                }
            }
        }
    }

    let terminal = drafts.iter().any(|d| {
        matches!(
            d,
            ProviderEventDraft::Terminal(_) | ProviderEventDraft::Completed
        )
    });
    let sink = state.current_turn.as_ref().map(|(_, sink)| sink.clone());
    if terminal {
        state.current_turn = None;
    }
    drop(state);
    let Some(sink) = sink else { return };
    for draft in drafts {
        yield_draft(&sink, draft).await;
    }
}

fn selected_option(decision: &RuntimeInteractionDecision, question_id: &str) -> Option<String> {
    for value in &decision.selected_option_ids {
        if let Some((question, option)) = value.split_once(':') {
            if question == question_id {
                return Some(option.to_string());
            }
        } else {
            return Some(value.clone());
        }
    }
    None
}

async fn force_cancel(session: &Arc<PiSession>, turn_id: Uuid) {
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

    #[test]
    fn extension_is_private_contains_no_secret_and_is_deleted_on_drop() {
        let access = BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "secret-token".into(),
        };
        let guard = PiBrowserExtension::create(&access).unwrap();
        let path = guard.path.clone();
        let source = std::fs::read_to_string(&path).unwrap();
        assert!(source.contains("MAXX_BROWSER_ENDPOINT"));
        assert!(!source.contains("secret-token"));
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
    fn agent_identity_is_appended_to_pis_system_prompt() {
        let mut request = crate::engine::test_request(ChatProvider::Pi);
        request.agent_instructions = Some("You are Dana.".into());

        let arguments = pi_arguments(&request);
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["--append-system-prompt", "You are Dana."]));
        assert_eq!(request.prompt, "user prompt");
    }

    #[test]
    fn active_branch_becomes_gui_turns_without_thinking_or_tool_results() {
        let mut graph = PiSessionGraph::default();
        for value in [
            json!({"type":"model_change","id":"model","parentId":null,"timestamp":"2026-08-13T12:00:00Z"}),
            json!({"type":"message","id":"user-1","parentId":"model","timestamp":"2026-08-13T12:00:01Z","message":{"role":"user","content":[{"type":"text","text":"first prompt"}]}}),
            json!({"type":"message","id":"assistant-1","parentId":"user-1","timestamp":"2026-08-13T12:00:02Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"first answer"},{"type":"toolCall","name":"read"}]}}),
            json!({"type":"message","id":"tool-result","parentId":"assistant-1","timestamp":"2026-08-13T12:00:03Z","message":{"role":"toolResult","content":[{"type":"text","text":"not a user"}]}}),
            json!({"type":"message","id":"abandoned-user","parentId":"assistant-1","timestamp":"2026-08-13T12:00:04Z","message":{"role":"user","content":"abandoned branch"}}),
            json!({"type":"message","id":"abandoned-answer","parentId":"abandoned-user","timestamp":"2026-08-13T12:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"abandoned answer"}]}}),
            json!({"type":"message","id":"user-2","parentId":"tool-result","timestamp":"2026-08-13T12:00:06Z","message":{"role":"user","content":"terminal prompt"}}),
            json!({"type":"message","id":"assistant-2","parentId":"user-2","timestamp":"2026-08-13T12:00:07Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"terminal answer"}]}}),
        ] {
            graph.ingest(value);
        }

        let turns = graph.reconciled_turns();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].native_id, "user-1");
        assert_eq!(turns[0].user_content, "first prompt");
        assert_eq!(turns[0].assistant_content, "first answer");
        assert_eq!(turns[1].native_id, "user-2");
        assert_eq!(turns[1].user_content, "terminal prompt");
        assert_eq!(turns[1].assistant_content, "terminal answer");
    }

    #[tokio::test]
    async fn finds_and_streams_the_native_session_file() {
        let session_id = Uuid::new_v4();
        let root = std::env::temp_dir().join(format!("maxx-pi-session-test-{}", Uuid::new_v4()));
        let project = root.join("--project--");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join(format!("2026-08-13T12-00-00Z_{session_id}.jsonl"));
        std::fs::write(
            &path,
            [
                json!({"type":"session","version":3,"id":session_id,"timestamp":"2026-08-13T12:00:00Z","cwd":"/tmp"}).to_string(),
                json!({"type":"message","id":"user","parentId":null,"timestamp":"2026-08-13T12:00:01Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}).to_string(),
                json!({"type":"message","id":"assistant","parentId":"user","timestamp":"2026-08-13T12:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        assert_eq!(
            find_pi_session(&root, &session_id.to_string())
                .await
                .unwrap(),
            path
        );
        let turns = read_pi_session(&path, &session_id.to_string())
            .await
            .unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].user_content, "hello");
        assert_eq!(turns[0].assistant_content, "world");

        std::fs::remove_dir_all(root).unwrap();
    }
}
