//! Port of `CodexRuntimeAdapter`: one long-lived `codex app-server --stdio`
//! per (profile, Maxx thread), `thread/start` / `thread/resume`, `turn/start`
//! per turn, JSON-RPC server requests for approvals and user input.

use super::jsonrpc::JsonRpcClient;
use super::process::{JsonLineProcess, LaunchSpec};
use super::{
    yield_draft, yield_error, DraftSender, ProviderEngine, ReconciledSessionTurn, SteerRequest,
    TurnRequest,
};
use crate::host_tools::HostToolAccess;
use async_trait::async_trait;
use maxx_core::contract::*;
use maxx_core::normalize::{normalize, NormalizerState, ProviderEventDraft};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Default)]
pub struct CodexEngine {
    instances: Mutex<HashMap<(Uuid, Uuid), Arc<CodexInstance>>>,
    instance_by_turn: Mutex<HashMap<Uuid, (Uuid, Uuid)>>,
}

struct ActiveTurn {
    turn_id: Uuid,
    sink: DraftSender,
    native_turn_id: Option<String>,
}

struct PendingInteraction {
    native_id: Value,
    method: String,
    elicitation_schema: Option<Value>,
}

const MAXX_BROWSER_DEVELOPER_INSTRUCTIONS: &str = "The maxx_browser MCP tools are the only browser controls available in Maxx. Use them directly instead of loading any browser-control skill or client. Reuse known tabs. To open a requested URL, call browser_open_tab directly; it selects and reveals the new tab, so do not precede it with status/list calls or follow it with select unless the task specifically requires those operations.";
const ORDINARY_THREAD_DEVELOPER_INSTRUCTIONS: &str = "The maxx_browser MCP tools are the only browser controls available in Maxx. Use them directly instead of loading any browser-control skill or client. Reuse known tabs. To open a requested URL, call browser_open_tab directly; it selects and reveals the new tab, so do not precede it with status/list calls or follow it with select unless the task specifically requires those operations. This is an ordinary Maxx chat, not a preconfigured agent turn. Do not adopt or prefix replies with a named persona solely because of the working directory, project files, prior messages, or remembered context. A named persona is active only when Maxx supplies it separately as developer instructions.";
const ORDINARY_THREAD_CONTEXT: &str = "No named Maxx agent persona is active for this turn. Do not adopt a persona or prefix the response with a person's name based on prior messages, the working directory, project files, or external memory. Named-agent identity is supplied separately by Maxx and is absent here.";

#[derive(Default)]
struct InstanceState {
    client: Option<Arc<JsonRpcClient>>,
    normalizer: NormalizerState,
    native_thread_by_thread: HashMap<Uuid, String>,
    active_by_native_thread: HashMap<String, ActiveTurn>,
    interactions: HashMap<Uuid, PendingInteraction>,
}

#[derive(Default)]
struct CodexInstance {
    state: Mutex<InstanceState>,
}

#[async_trait]
impl ProviderEngine for CodexEngine {
    fn provider(&self) -> ChatProvider {
        ChatProvider::Codex
    }

    async fn run_turn(&self, request: TurnRequest, sink: DraftSender) {
        let key = (request.provider_instance_id, request.thread_id);
        let instance = {
            let mut instances = self.instances.lock().await;
            instances
                .entry(key)
                .or_insert_with(|| Arc::new(CodexInstance::default()))
                .clone()
        };
        self.instance_by_turn
            .lock()
            .await
            .insert(request.turn_id, key);
        tokio::spawn(async move {
            if let Err(error) = begin(&instance, &request, sink.clone()).await {
                clear_turn(&instance, request.turn_id).await;
                yield_error(&sink, error).await;
            }
        });
    }

    async fn steer(&self, request: SteerRequest) -> Result<(), String> {
        let mut ready = None;
        for _ in 0..80 {
            let key = self
                .instance_by_turn
                .lock()
                .await
                .get(&request.turn_id)
                .copied();
            if let Some(key) = key {
                if let Some(instance) = self.instances.lock().await.get(&key).cloned() {
                    let state = instance.state.lock().await;
                    if let Some((native_thread, active)) = state
                        .active_by_native_thread
                        .iter()
                        .find(|(_, turn)| turn.turn_id == request.turn_id)
                    {
                        if let (Some(client), Some(native_turn)) =
                            (state.client.clone(), active.native_turn_id.clone())
                        {
                            ready = Some((client, native_thread.clone(), native_turn));
                            break;
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let (client, native_thread, native_turn) =
            ready.ok_or("Codex is not ready to accept steering.")?;
        client
            .request(
                "turn/steer",
                json!({
                    "threadId": native_thread,
                    "expectedTurnId": native_turn,
                    "input": codex_user_input(&request.prompt, &request.attachments),
                }),
            )
            .await?;
        Ok(())
    }

    async fn cancel(&self, turn_id: Uuid) {
        let key = { self.instance_by_turn.lock().await.get(&turn_id).copied() };
        let Some(key) = key else {
            return;
        };
        let instance = { self.instances.lock().await.get(&key).cloned() };
        let Some(instance) = instance else { return };

        let (client, native) = {
            let state = instance.state.lock().await;
            let entry = state
                .active_by_native_thread
                .iter()
                .find(|(_, turn)| turn.turn_id == turn_id)
                .map(|(thread, turn)| (thread.clone(), turn.native_turn_id.clone()));
            (state.client.clone(), entry)
        };
        let (Some(client), Some((native_thread, native_turn))) = (client, native) else {
            return;
        };
        let mut params = json!({"threadId": native_thread});
        if let Some(native_turn) = native_turn {
            params["turnId"] = Value::String(native_turn);
        }
        if client.request("turn/interrupt", params).await.is_err() {
            // Escalate: close the turn as cancelled if the native interrupt failed.
            let sink = {
                let mut state = instance.state.lock().await;
                state
                    .active_by_native_thread
                    .retain(|_, turn| turn.turn_id != turn_id || turn.sink.is_closed());
                state
                    .active_by_native_thread
                    .values()
                    .find(|t| t.turn_id == turn_id)
                    .map(|t| t.sink.clone())
            };
            if let Some(sink) = sink {
                yield_draft(
                    &sink,
                    ProviderEventDraft::Terminal(ProviderTurnTerminalState::Cancelled),
                )
                .await;
            }
        }
    }

    async fn resolve(
        &self,
        request_id: Uuid,
        decision: RuntimeInteractionDecision,
    ) -> Result<(), String> {
        let instances: Vec<Arc<CodexInstance>> =
            self.instances.lock().await.values().cloned().collect();
        for instance in instances {
            let entry = {
                let mut state = instance.state.lock().await;
                match state.interactions.remove(&request_id) {
                    Some(interaction) => Some((interaction, state.client.clone())),
                    None => None,
                }
            };
            let Some((interaction, client)) = entry else {
                continue;
            };
            let client = client.ok_or("The Codex request is no longer actionable.")?;
            let result = if interaction.method == "mcpServer/elicitation/request" {
                codex_elicitation_result(&decision, interaction.elicitation_schema.as_ref())
            } else if interaction.method.contains("requestUserInput")
                || interaction.method.contains("request_user_input")
            {
                json!({"answers": codex_answers(&decision)})
            } else {
                let native_decision = match decision.kind {
                    Some(RuntimeDecisionKind::Approve) => "accept",
                    Some(RuntimeDecisionKind::ApproveForSession) => "acceptForSession",
                    Some(RuntimeDecisionKind::Deny) => "decline",
                    _ => "cancel",
                };
                json!({"decision": native_decision})
            };
            return client.respond(&interaction.native_id, result).await;
        }
        Err("The Codex request is no longer actionable.".into())
    }

    async fn reconcile_session(
        &self,
        request: TurnRequest,
    ) -> Result<Option<Vec<ReconciledSessionTurn>>, String> {
        let native_thread = request
            .session_id
            .as_deref()
            .ok_or("The Codex session has not been established yet.")?;
        let key = (request.provider_instance_id, request.thread_id);
        let instance = {
            let mut instances = self.instances.lock().await;
            instances
                .entry(key)
                .or_insert_with(|| Arc::new(CodexInstance::default()))
                .clone()
        };
        let client = ensure_client(&instance, &request).await?;
        let response = client
            .request(
                "thread/read",
                json!({"threadId": native_thread, "includeTurns": true}),
            )
            .await
            .map_err(|error| map_missing_session(error, &request))?;
        Ok(Some(reconciled_turns(&response)?))
    }

    async fn release_thread(&self, provider_instance_id: Uuid, thread_id: Uuid) {
        let key = (provider_instance_id, thread_id);
        let instance = self.instances.lock().await.remove(&key);
        self.instance_by_turn
            .lock()
            .await
            .retain(|_, route| *route != key);
        if let Some(instance) = instance {
            retire_instance(&instance).await;
        }
    }

    async fn shutdown(&self) {
        let instances: Vec<Arc<CodexInstance>> = self
            .instances
            .lock()
            .await
            .drain()
            .map(|(_, i)| i)
            .collect();
        self.instance_by_turn.lock().await.clear();
        for instance in instances {
            retire_instance(&instance).await;
        }
    }
}

async fn retire_instance(instance: &Arc<CodexInstance>) {
    let (client, turns) = {
        let mut state = instance.state.lock().await;
        let turns: Vec<DraftSender> = state
            .active_by_native_thread
            .drain()
            .map(|(_, turn)| turn.sink)
            .collect();
        state.interactions.clear();
        state.native_thread_by_thread.clear();
        (state.client.take(), turns)
    };
    for sink in turns {
        yield_draft(
            &sink,
            ProviderEventDraft::Terminal(ProviderTurnTerminalState::Cancelled),
        )
        .await;
    }
    if let Some(client) = client {
        client.shutdown().await;
    }
}

async fn begin(
    instance: &Arc<CodexInstance>,
    request: &TurnRequest,
    sink: DraftSender,
) -> Result<(), String> {
    let client = ensure_client(instance, request).await?;

    // Bind the Maxx thread to a native Codex thread (start or resume).
    // A same-provider agent switch clears the persisted session identifier;
    // discard the in-memory binding too so the old persona cannot survive.
    if request.starts_fresh_agent_session() {
        instance
            .state
            .lock()
            .await
            .native_thread_by_thread
            .remove(&request.thread_id);
    }
    let existing = {
        let state = instance.state.lock().await;
        state
            .native_thread_by_thread
            .get(&request.thread_id)
            .cloned()
    };
    let native_thread = if let Some(native) = existing.or_else(|| request.session_id.clone()) {
        let known = {
            let state = instance.state.lock().await;
            state
                .native_thread_by_thread
                .get(&request.thread_id)
                .is_some()
        };
        if !known {
            let response = client
                .request(
                    "thread/resume",
                    json!({
                        "threadId": native,
                        "cwd": request.working_directory,
                        "approvalPolicy": "on-request",
                        "developerInstructions": codex_developer_instructions(request)
                    }),
                )
                .await
                .map_err(|e| map_missing_session(e, request))?;
            let id = thread_id_from(&response).unwrap_or(native);
            let mut state = instance.state.lock().await;
            state
                .native_thread_by_thread
                .insert(request.thread_id, id.clone());
            id
        } else {
            native
        }
    } else {
        let params = codex_thread_start_params(request);
        let response = client.request("thread/start", params).await?;
        let id = thread_id_from(&response)
            .ok_or_else(|| "thread/start omitted result.thread.id".to_string())?;
        let mut state = instance.state.lock().await;
        state
            .native_thread_by_thread
            .insert(request.thread_id, id.clone());
        id
    };

    {
        let mut state = instance.state.lock().await;
        state.normalizer.session_id = Some(native_thread.clone());
        state.active_by_native_thread.insert(
            native_thread.clone(),
            ActiveTurn {
                turn_id: request.turn_id,
                sink: sink.clone(),
                native_turn_id: None,
            },
        );
    }
    yield_draft(
        &sink,
        ProviderEventDraft::SessionUpdated(native_thread.clone()),
    )
    .await;
    yield_draft(
        &sink,
        ProviderEventDraft::Status("Codex is working…".into()),
    )
    .await;

    let mut params = json!({
        "threadId": native_thread,
        "input": codex_user_input(&request.prompt, &request.attachments),
        "cwd": request.working_directory,
        "approvalPolicy": "on-request"
    });
    if request.agent_id.is_none() {
        params["additionalContext"] = json!({
            "maxx.thread-mode": {
                "kind": "application",
                "value": ORDINARY_THREAD_CONTEXT
            }
        });
    }
    if let Some(model) = request.selected_model() {
        params["model"] = Value::String(model);
    }
    if let Some(effort) = request.selected_effort() {
        params["model_reasoning_effort"] = Value::String(effort);
    }
    let response = client.request("turn/start", params).await?;
    if let Some(turn) = response.get("turn").and_then(Value::as_object) {
        if let Some(id) = turn.get("id").and_then(Value::as_str) {
            let mut state = instance.state.lock().await;
            if let Some(active) = state.active_by_native_thread.get_mut(&native_thread) {
                active.native_turn_id = Some(id.to_string());
            }
        }
    }
    Ok(())
}

fn codex_user_input(
    prompt: &str,
    attachments: &[maxx_core::persist::ChatAttachment],
) -> Vec<Value> {
    let mut input = Vec::new();
    if !prompt.is_empty() {
        input.push(json!({"type": "text", "text": prompt}));
    }
    input.extend(
        attachments
            .iter()
            .map(|attachment| json!({"type": "localImage", "path": attachment.path})),
    );
    input
}

fn map_missing_session(error: String, request: &TurnRequest) -> String {
    if request.session_id.is_some()
        && (error.to_lowercase().contains("not found") || error.to_lowercase().contains("unknown"))
    {
        "provider.session.not-found: The saved Codex session is no longer available.".into()
    } else {
        error
    }
}

fn reconciled_turns(response: &Value) -> Result<Vec<ReconciledSessionTurn>, String> {
    let turns = response
        .get("thread")
        .and_then(|thread| thread.get("turns"))
        .and_then(Value::as_array)
        .ok_or("thread/read omitted result.thread.turns")?;
    Ok(turns
        .iter()
        .filter_map(|turn| {
            let native_id = turn.get("id")?.as_str()?.to_string();
            let started_at = turn
                .get("startedAt")
                .or_else(|| turn.get("completedAt"))
                .and_then(Value::as_f64)
                .map(AppleDate::from_unix_seconds)
                .unwrap_or_else(AppleDate::now);
            let items = turn.get("items").and_then(Value::as_array)?;
            let mut user_parts = Vec::new();
            let mut assistant_parts = Vec::new();
            for item in items {
                match item.get("type").and_then(Value::as_str) {
                    Some("userMessage") => {
                        if let Some(content) = item.get("content").and_then(Value::as_array) {
                            user_parts.extend(content.iter().filter_map(|input| {
                                (input.get("type").and_then(Value::as_str) == Some("text"))
                                    .then(|| input.get("text").and_then(Value::as_str))
                                    .flatten()
                                    .map(str::to_string)
                            }));
                        }
                    }
                    Some("agentMessage") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                assistant_parts.push(text.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
            let user_content = user_parts.join("\n").trim().to_string();
            let assistant_content = assistant_parts.join("\n\n").trim().to_string();
            (!user_content.is_empty() || !assistant_content.is_empty()).then_some(
                ReconciledSessionTurn {
                    native_id,
                    started_at,
                    user_content,
                    assistant_content,
                },
            )
        })
        .collect())
}

async fn ensure_client(
    instance: &Arc<CodexInstance>,
    request: &TurnRequest,
) -> Result<Arc<JsonRpcClient>, String> {
    if let Some(client) = instance.state.lock().await.client.clone() {
        return Ok(client);
    }
    let configuration = super::launch::launch_configuration(&request.profile)?;
    let (arguments, environment) =
        codex_launch_settings(configuration.environment, &request.host_tools)?;
    let process = JsonLineProcess::spawn(&LaunchSpec {
        executable: configuration.executable.to_string_lossy().to_string(),
        arguments,
        working_directory: None,
        environment,
    })?;
    let client = JsonRpcClient::new(process);
    client
        .request(
            "initialize",
            json!({
                "clientInfo": {"name": "maxx", "title": "Maxx", "version": "1.0"},
                "capabilities": {
                    "experimentalApi": true,
                    "mcpServerOpenaiFormElicitation": true
                }
            }),
        )
        .await?;
    client.notify("initialized", Value::Null).await?;
    instance.state.lock().await.client = Some(client.clone());

    let consumer_instance = instance.clone();
    let consumer_client = client.clone();
    tokio::spawn(async move {
        loop {
            let message = {
                let mut incoming = consumer_client.incoming.lock().await;
                incoming.recv().await
            };
            let Some(message) = message else {
                fail_all_turns(
                    &consumer_instance,
                    "Codex app-server connection closed".into(),
                )
                .await;
                return;
            };
            handle_incoming(&consumer_instance, &consumer_client, message).await;
        }
    });
    Ok(client)
}

fn codex_launch_settings(
    mut environment: HashMap<String, String>,
    host_tools: &[Arc<HostToolAccess>],
) -> Result<(Vec<String>, HashMap<String, String>), String> {
    let mut arguments = vec!["app-server".into()];
    for access in host_tools {
        let token_environment_variable = access.token_environment_variable();
        environment.insert(
            token_environment_variable.clone(),
            access.bearer_token.clone(),
        );
        arguments.extend([
            "-c".into(),
            format!(
                "mcp_servers.{}.url={}",
                access.name,
                serde_json::to_string(&access.endpoint).map_err(|error| error.to_string())?
            ),
            "-c".into(),
            format!(
                "mcp_servers.{}.bearer_token_env_var=\"{}\"",
                access.name, token_environment_variable
            ),
            "-c".into(),
            format!(
                "mcp_servers.{}.default_tools_approval_mode=\"approve\"",
                access.name
            ),
        ]);
    }
    arguments.push("--stdio".into());
    Ok((arguments, environment))
}

async fn handle_incoming(
    instance: &Arc<CodexInstance>,
    client: &Arc<JsonRpcClient>,
    message: Value,
) {
    let Some(object) = message.as_object() else {
        return;
    };
    let Some(method) = object
        .get("method")
        .and_then(Value::as_str)
        .map(String::from)
    else {
        return;
    };
    let params = object
        .get("params")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let native_thread = params
        .get("threadId")
        .and_then(Value::as_str)
        .map(String::from);

    let line = match serde_json::to_vec(&message) {
        Ok(line) => line,
        Err(_) => return,
    };
    let mut state = instance.state.lock().await;
    let drafts = match normalize(&line, ChatProvider::Codex, &mut state.normalizer) {
        Ok(drafts) => drafts,
        Err(error) => {
            let sink = lookup_sink(&state, native_thread.as_deref());
            drop(state);
            if let Some(sink) = sink {
                yield_error(&sink, error.to_string()).await;
            }
            return;
        }
    };

    // Server requests carry an id and expect a JSON-RPC response; remember the
    // native id so resolve() can answer.
    if let Some(native_id) = object.get("id") {
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
                        elicitation_schema: params.get("requestedSchema").cloned(),
                    },
                );
            }
        }
        // Unsupported server requests must still be answered.
        let is_interactive = drafts.iter().any(|d| {
            matches!(
                d,
                ProviderEventDraft::Payload {
                    request_id: Some(_),
                    ..
                }
            )
        });
        if !is_interactive {
            let client = client.clone();
            let native_id = native_id.clone();
            tokio::spawn(async move {
                let _ = client
                    .respond_error(&native_id, -32601, "Unsupported Codex server request")
                    .await;
            });
        }
    }

    let mut finished_thread: Option<String> = None;
    let terminal = drafts.iter().any(|d| {
        matches!(
            d,
            ProviderEventDraft::Terminal(_) | ProviderEventDraft::Completed
        )
    });
    if terminal {
        finished_thread = native_thread.clone();
    }
    let sink = lookup_sink(&state, native_thread.as_deref());
    if let (Some(thread), true) = (finished_thread, terminal) {
        state.active_by_native_thread.remove(&thread);
    }
    drop(state);
    let Some(sink) = sink else { return };
    for draft in drafts {
        yield_draft(&sink, draft).await;
    }
}

fn lookup_sink(state: &InstanceState, native_thread: Option<&str>) -> Option<DraftSender> {
    if let Some(thread) = native_thread {
        if let Some(turn) = state.active_by_native_thread.get(thread) {
            return Some(turn.sink.clone());
        }
    }
    // Notifications without a thread id (warnings, errors) go to the sole
    // active turn when unambiguous.
    if state.active_by_native_thread.len() == 1 {
        return state
            .active_by_native_thread
            .values()
            .next()
            .map(|t| t.sink.clone());
    }
    None
}

async fn fail_all_turns(instance: &Arc<CodexInstance>, error: String) {
    let sinks: Vec<DraftSender> = {
        let mut state = instance.state.lock().await;
        state.client = None;
        state.interactions.clear();
        state
            .active_by_native_thread
            .drain()
            .map(|(_, t)| t.sink)
            .collect()
    };
    for sink in sinks {
        yield_error(&sink, error.clone()).await;
    }
}

async fn clear_turn(instance: &Arc<CodexInstance>, turn_id: Uuid) {
    let mut state = instance.state.lock().await;
    state
        .active_by_native_thread
        .retain(|_, turn| turn.turn_id != turn_id);
}

fn thread_id_from(response: &Value) -> Option<String> {
    response
        .get("thread")
        .and_then(Value::as_object)
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(String::from)
}

fn codex_answers(decision: &RuntimeInteractionDecision) -> Value {
    let mut values: HashMap<String, Vec<String>> = HashMap::new();
    for value in &decision.selected_option_ids {
        if let Some((question, answer)) = value.split_once(':') {
            values
                .entry(question.to_string())
                .or_default()
                .push(answer.to_string());
        }
    }
    for (question, answer) in &decision.text_answers {
        values.insert(question.clone(), vec![answer.clone()]);
    }
    let mut result = Map::new();
    for (question, answers) in values {
        result.insert(question, json!({"answers": answers}));
    }
    Value::Object(result)
}

fn codex_developer_instructions(request: &TurnRequest) -> String {
    let mut instructions = match request.agent_instructions.as_deref() {
        Some(instructions) => {
            format!("{MAXX_BROWSER_DEVELOPER_INSTRUCTIONS}\n\n{instructions}")
        }
        None => ORDINARY_THREAD_DEVELOPER_INSTRUCTIONS.to_string(),
    };
    if let Some(policy) = crate::host_tools::computer_policy(&request.host_tools) {
        instructions.push_str("\n\n");
        instructions.push_str(policy);
    }
    instructions
}

fn codex_thread_start_params(request: &TurnRequest) -> Value {
    let mut params = json!({
        "cwd": request.working_directory,
        "approvalPolicy": "on-request",
        "developerInstructions": codex_developer_instructions(request),
        "ephemeral": request.ephemeral
    });
    if let Some(model) = request.selected_model() {
        params["model"] = Value::String(model);
    }
    if let Some(effort) = request.selected_effort() {
        params["model_reasoning_effort"] = Value::String(effort);
    }
    params
}

fn codex_elicitation_result(
    decision: &RuntimeInteractionDecision,
    schema: Option<&Value>,
) -> Value {
    let action = match decision.kind {
        Some(RuntimeDecisionKind::Deny) => "decline",
        Some(RuntimeDecisionKind::Cancel) => "cancel",
        _ => "accept",
    };
    if action != "accept" {
        return json!({"action": action});
    }

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

    let properties = schema
        .and_then(Value::as_object)
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object);
    let mut content = Map::new();
    for (question, values) in answers {
        let property_type = properties
            .and_then(|properties| properties.get(&question))
            .and_then(Value::as_object)
            .and_then(|property| property.get("type"))
            .and_then(Value::as_str);
        let value = match property_type {
            Some("array") => Value::Array(values.into_iter().map(Value::String).collect()),
            Some("boolean") => values
                .first()
                .and_then(|value| value.parse::<bool>().ok())
                .map(Value::Bool)
                .unwrap_or(Value::Null),
            Some("integer") => values
                .first()
                .and_then(|value| value.parse::<i64>().ok())
                .map(serde_json::Number::from)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            Some("number") => values
                .first()
                .and_then(|value| value.parse::<f64>().ok())
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            _ => values
                .into_iter()
                .next()
                .map(Value::String)
                .unwrap_or(Value::Null),
        };
        content.insert(question, value);
    }
    json!({"action": "accept", "content": content})
}

#[cfg(test)]
mod browser_mcp_tests {
    use super::*;
    use crate::browser_runtime::BrowserProviderAccess;

    #[test]
    fn steering_uses_the_same_structured_input_as_a_new_turn() {
        let attachment = maxx_core::persist::ChatAttachment {
            id: Uuid::new_v4(),
            path: "/tmp/example.png".into(),
            mime_type: "image/png".into(),
            display_name: "example.png".into(),
        };
        assert_eq!(
            codex_user_input("change course", &[attachment]),
            vec![
                json!({"type": "text", "text": "change course"}),
                json!({"type": "localImage", "path": "/tmp/example.png"}),
            ]
        );
    }

    #[test]
    fn launch_settings_scope_browser_authority_through_an_environment_secret() {
        let access = BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "secret-token".into(),
        };
        let host_tool = Arc::new(access.as_host_tool());
        let (arguments, environment) = codex_launch_settings(HashMap::new(), &[host_tool]).unwrap();

        assert_eq!(arguments.first().map(String::as_str), Some("app-server"));
        assert_eq!(arguments.last().map(String::as_str), Some("--stdio"));
        assert!(!arguments
            .windows(2)
            .any(|values| values == ["--disable", "memories"]));
        assert!(arguments.iter().any(|value| {
            value == "mcp_servers.maxx_browser.url=\"http://127.0.0.1:43123/mcp\""
        }));
        assert!(arguments.iter().any(|value| {
            value == "mcp_servers.maxx_browser.bearer_token_env_var=\"MAXX_BROWSER_TOKEN\""
        }));
        assert!(arguments.iter().any(|value| {
            value == "mcp_servers.maxx_browser.default_tools_approval_mode=\"approve\""
        }));
        assert!(arguments
            .iter()
            .all(|value| !value.contains("secret-token")));
        assert_eq!(
            environment.get("MAXX_BROWSER_TOKEN").map(String::as_str),
            Some("secret-token")
        );
    }

    #[test]
    fn launch_settings_injects_multiple_host_tools_without_leaking_tokens() {
        let tools = vec![
            Arc::new(HostToolAccess::new(
                "maxx_browser",
                "http://127.0.0.1:43123/mcp",
                "browser-secret",
            )),
            Arc::new(HostToolAccess::new(
                "maxx_automations",
                "http://127.0.0.1:43124/mcp",
                "automation-secret",
            )),
        ];
        let (arguments, environment) = codex_launch_settings(HashMap::new(), &tools).unwrap();
        assert!(arguments.iter().any(|value| {
            value == "mcp_servers.maxx_automations.url=\"http://127.0.0.1:43124/mcp\""
        }));
        assert_eq!(
            environment
                .get("MAXX_AUTOMATIONS_TOKEN")
                .map(String::as_str),
            Some("automation-secret")
        );
        assert!(
            arguments
                .iter()
                .all(|value| !value.contains("browser-secret")
                    && !value.contains("automation-secret"))
        );
    }

    #[test]
    fn ordinary_threads_reject_implicit_personas() {
        assert!(ORDINARY_THREAD_DEVELOPER_INSTRUCTIONS.contains("ordinary Maxx chat"));
        assert!(!MAXX_BROWSER_DEVELOPER_INSTRUCTIONS.contains("ordinary Maxx chat"));
        assert!(!ORDINARY_THREAD_DEVELOPER_INSTRUCTIONS.contains("<maxx-agent>"));
        assert!(!ORDINARY_THREAD_CONTEXT.contains("<maxx-agent>"));
    }

    #[test]
    fn agent_identity_is_sent_as_developer_instructions() {
        let mut request = crate::engine::test_request(ChatProvider::Codex);
        request.agent_id = Some(Uuid::new_v4());
        request.agent_instructions = Some("You are Dana. Reply exactly with hi.".into());

        let developer = codex_developer_instructions(&request);
        assert!(developer.contains(MAXX_BROWSER_DEVELOPER_INSTRUCTIONS));
        assert!(developer.contains("You are Dana. Reply exactly with hi."));
        assert_eq!(request.prompt, "user prompt");
    }

    #[test]
    fn background_generation_uses_an_ephemeral_codex_thread() {
        let mut request = crate::engine::test_request(ChatProvider::Codex);
        request.ephemeral = true;
        let params = codex_thread_start_params(&request);

        assert_eq!(params["ephemeral"], true);
    }

    #[test]
    fn elicitation_answers_preserve_schema_types() {
        let decision = RuntimeInteractionDecision {
            selected_option_ids: vec!["enabled:true".into(), "targets:alpha".into()],
            text_answers: HashMap::from([("count".into(), "3".into())]),
            ..Default::default()
        };
        let schema = json!({
            "properties": {
                "enabled": {"type": "boolean"},
                "targets": {"type": "array"},
                "count": {"type": "integer"}
            }
        });
        assert_eq!(
            codex_elicitation_result(&decision, Some(&schema)),
            json!({
                "action": "accept",
                "content": {"enabled": true, "targets": ["alpha"], "count": 3}
            })
        );
    }

    #[test]
    fn thread_read_turns_become_authoritative_gui_messages() {
        let response = json!({
            "thread": {
                "turns": [
                    {
                        "id": "turn-before",
                        "startedAt": 1_700_000_000.0,
                        "items": [
                            {"type": "userMessage", "content": [
                                {"type": "text", "text": "Build it"},
                                {"type": "localImage", "path": "/tmp/image.png"}
                            ]},
                            {"type": "commandExecution", "command": "cargo test"},
                            {"type": "agentMessage", "text": "Working on it.", "phase": "commentary"},
                            {"type": "agentMessage", "text": "Done.", "phase": "final_answer"}
                        ]
                    },
                    {
                        "id": "tool-only",
                        "items": [{"type": "commandExecution", "command": "pwd"}]
                    }
                ]
            }
        });
        let turns = reconciled_turns(&response).unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].native_id, "turn-before");
        assert_eq!(turns[0].user_content, "Build it");
        assert_eq!(turns[0].assistant_content, "Working on it.\n\nDone.");
        assert_eq!(turns[0].started_at.unix_seconds(), 1_700_000_000.0);
    }
}
