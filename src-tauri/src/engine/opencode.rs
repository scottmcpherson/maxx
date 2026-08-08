//! Port of `OpenCodeRuntimeAdapter` + `OpenCodeHTTPClient`: a Maxx-owned
//! `opencode serve` per (profile, Maxx thread) (or a configured external server Maxx never
//! terminates), the SSE `/event` stream normalized per session, and HTTP
//! endpoints for sessions, prompts, aborts, and permission/question replies.

use super::process::{JsonLineProcess, LaunchSpec};
use super::{yield_draft, yield_error, DraftSender, ProviderEngine, TurnRequest};
use async_trait::async_trait;
use futures_util::StreamExt;
use maxx_core::contract::*;
use maxx_core::normalize::{normalize, NormalizerState, ProviderEventDraft};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Default)]
pub struct OpenCodeEngine {
    instances: Mutex<HashMap<(Uuid, Uuid), Arc<OpenCodeInstance>>>,
    instance_by_turn: Mutex<HashMap<Uuid, (Uuid, Uuid)>>,
}

struct ActiveTurn {
    turn_id: Uuid,
    session_id: String,
    sink: DraftSender,
    normalizer: NormalizerState,
}

struct PendingInteraction {
    native_request_id: String,
    session_id: String,
    is_question: bool,
    question_count: usize,
}

#[derive(Default)]
struct InstanceState {
    base_url: Option<String>,
    owned_server: Option<Arc<JsonLineProcess>>,
    events_running: bool,
    directory: Option<String>,
    environment: HashMap<String, String>,
    active_by_session: HashMap<String, ActiveTurn>,
    interactions: HashMap<Uuid, PendingInteraction>,
}

#[derive(Default)]
struct OpenCodeInstance {
    state: Mutex<InstanceState>,
    http: reqwest::Client,
}

#[async_trait]
impl ProviderEngine for OpenCodeEngine {
    fn provider(&self) -> ChatProvider {
        ChatProvider::Opencode
    }

    async fn run_turn(&self, request: TurnRequest, sink: DraftSender) {
        let key = (request.provider_instance_id, request.thread_id);
        let instance = {
            let mut instances = self.instances.lock().await;
            instances
                .entry(key)
                .or_insert_with(|| Arc::new(OpenCodeInstance::default()))
                .clone()
        };
        self.instance_by_turn
            .lock()
            .await
            .insert(request.turn_id, key);
        tokio::spawn(async move {
            if let Err(error) = begin(&instance, &request, sink.clone()).await {
                let mut state = instance.state.lock().await;
                state
                    .active_by_session
                    .retain(|_, t| t.turn_id != request.turn_id);
                drop(state);
                yield_error(&sink, error).await;
            }
        });
    }

    async fn cancel(&self, turn_id: Uuid) {
        let key = { self.instance_by_turn.lock().await.get(&turn_id).copied() };
        let Some(key) = key else {
            return;
        };
        let instance = { self.instances.lock().await.get(&key).cloned() };
        let Some(instance) = instance else { return };
        let (base_url, directory, environment, session_id, sink) = {
            let state = instance.state.lock().await;
            let Some(turn) = state
                .active_by_session
                .values()
                .find(|t| t.turn_id == turn_id)
            else {
                return;
            };
            (
                state.base_url.clone(),
                state.directory.clone(),
                state.environment.clone(),
                turn.session_id.clone(),
                turn.sink.clone(),
            )
        };
        let Some(base_url) = base_url else { return };
        let aborted = http_request(
            &instance.http,
            &base_url,
            &format!("session/{session_id}/abort"),
            directory.as_deref(),
            "POST",
            Some(json!({})),
            &environment,
        )
        .await
        .is_ok();
        if !aborted {
            let mut state = instance.state.lock().await;
            state.active_by_session.remove(&session_id);
            drop(state);
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
        let instances: Vec<Arc<OpenCodeInstance>> =
            self.instances.lock().await.values().cloned().collect();
        for instance in instances {
            let entry = {
                let mut state = instance.state.lock().await;
                match state.interactions.remove(&request_id) {
                    Some(interaction) => Some((
                        interaction,
                        state.base_url.clone(),
                        state.directory.clone(),
                        state.environment.clone(),
                    )),
                    None => None,
                }
            };
            let Some((interaction, base_url, directory, environment)) = entry else {
                continue;
            };
            let base_url = base_url.ok_or("The OpenCode request is no longer actionable.")?;

            if interaction.is_question {
                if decision.kind == Some(RuntimeDecisionKind::Cancel)
                    || decision.kind == Some(RuntimeDecisionKind::Deny)
                {
                    return http_request(
                        &instance.http,
                        &base_url,
                        &format!("question/{}/reject", interaction.native_request_id),
                        directory.as_deref(),
                        "POST",
                        Some(json!({})),
                        &environment,
                    )
                    .await
                    .map(|_| ())
                    .map_err(|(_, e)| e);
                }
                // answers: [[String]] ordered by question index.
                let mut answers: Vec<Vec<String>> =
                    vec![Vec::new(); interaction.question_count.max(1)];
                for value in &decision.selected_option_ids {
                    if let Some((_, answer)) = value.split_once(':') {
                        answers[0].push(answer.to_string());
                    } else {
                        answers[0].push(value.clone());
                    }
                }
                for answer in decision.text_answers.values() {
                    answers[0].push(answer.clone());
                }
                return http_request(
                    &instance.http,
                    &base_url,
                    &format!("question/{}/reply", interaction.native_request_id),
                    directory.as_deref(),
                    "POST",
                    Some(json!({"answers": answers})),
                    &environment,
                )
                .await
                .map(|_| ())
                .map_err(|(_, e)| e);
            }

            let reply = match decision.kind {
                Some(RuntimeDecisionKind::Approve) => "once",
                Some(RuntimeDecisionKind::ApproveForSession) => "always",
                _ => "reject",
            };
            let primary = http_request(
                &instance.http,
                &base_url,
                &format!("permission/{}/reply", interaction.native_request_id),
                directory.as_deref(),
                "POST",
                Some(json!({"reply": reply})),
                &environment,
            )
            .await;
            if let Err((status, _)) = &primary {
                if *status == Some(404) || *status == Some(405) {
                    return http_request(
                        &instance.http,
                        &base_url,
                        &format!(
                            "session/{}/permissions/{}",
                            interaction.session_id, interaction.native_request_id
                        ),
                        directory.as_deref(),
                        "POST",
                        Some(json!({"response": reply})),
                        &environment,
                    )
                    .await
                    .map(|_| ())
                    .map_err(|(_, e)| e);
                }
            }
            return primary.map(|_| ()).map_err(|(_, e)| e);
        }
        Err("The OpenCode request is no longer actionable.".into())
    }

    async fn shutdown(&self) {
        let instances: Vec<Arc<OpenCodeInstance>> = self
            .instances
            .lock()
            .await
            .drain()
            .map(|(_, i)| i)
            .collect();
        self.instance_by_turn.lock().await.clear();
        for instance in instances {
            let (server, turns) = {
                let mut state = instance.state.lock().await;
                let turns: Vec<DraftSender> = state
                    .active_by_session
                    .drain()
                    .map(|(_, t)| t.sink)
                    .collect();
                state.interactions.clear();
                state.base_url = None;
                state.events_running = false;
                (state.owned_server.take(), turns)
            };
            for sink in turns {
                yield_draft(
                    &sink,
                    ProviderEventDraft::Terminal(ProviderTurnTerminalState::Cancelled),
                )
                .await;
            }
            // A configured external server is never terminated; only the
            // Maxx-owned scoped server process is.
            if let Some(server) = server {
                server.shutdown().await;
            }
        }
    }
}

async fn begin(
    instance: &Arc<OpenCodeInstance>,
    request: &TurnRequest,
    sink: DraftSender,
) -> Result<(), String> {
    let base_url = ensure_server(instance, request).await?;
    let (directory, environment) = {
        let mut state = instance.state.lock().await;
        state.directory = Some(request.working_directory.clone());
        (request.working_directory.clone(), state.environment.clone())
    };

    // Bind or create the native session.
    let session_id = if let Some(saved) = &request.session_id {
        let valid = http_request(
            &instance.http,
            &base_url,
            &format!("session/{saved}"),
            Some(&directory),
            "GET",
            None,
            &environment,
        )
        .await
        .is_ok();
        if valid {
            saved.clone()
        } else {
            return Err(format!(
                "provider.session.not-found: OpenCode session not found: {saved}"
            ));
        }
    } else {
        let created = http_request(
            &instance.http,
            &base_url,
            "session",
            Some(&directory),
            "POST",
            Some(json!({"title": "Maxx"})),
            &environment,
        )
        .await
        .map_err(|(_, e)| e)?;
        created
            .get("id")
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or("OpenCode did not return a session identifier.")?
    };

    {
        let mut state = instance.state.lock().await;
        let mut normalizer = NormalizerState::with_session(session_id.clone());
        normalizer.session_id = Some(session_id.clone());
        state.active_by_session.insert(
            session_id.clone(),
            ActiveTurn {
                turn_id: request.turn_id,
                session_id: session_id.clone(),
                sink: sink.clone(),
                normalizer,
            },
        );
    }
    yield_draft(
        &sink,
        ProviderEventDraft::SessionUpdated(session_id.clone()),
    )
    .await;
    yield_draft(
        &sink,
        ProviderEventDraft::Status("OpenCode session ready".into()),
    )
    .await;

    let body = opencode_prompt_body(request)?;
    http_request(
        &instance.http,
        &base_url,
        &format!("session/{session_id}/prompt_async"),
        Some(&directory),
        "POST",
        Some(body),
        &environment,
    )
    .await
    .map_err(|(_, e)| e)?;
    Ok(())
}

fn opencode_prompt_body(request: &TurnRequest) -> Result<Value, String> {
    let mut parts = Vec::new();
    if !request.prompt.is_empty() {
        parts.push(json!({"type": "text", "text": request.prompt.clone()}));
    }
    for image in crate::attachments::encode_images(&request.attachments)? {
        parts.push(json!({
            "type": "file",
            "mime": image.mime_type,
            "filename": image.display_name,
            "url": format!("data:{};base64,{}", image.mime_type, image.data)
        }));
    }
    let mut body = json!({"parts": parts});
    if let Some(instructions) = &request.agent_instructions {
        body["system"] = Value::String(instructions.clone());
    }
    if let Some(model) = request.selected_model() {
        if let Some((provider_id, model_id)) = model.split_once('/') {
            body["model"] = json!({"providerID": provider_id, "modelID": model_id});
        }
    }
    Ok(body)
}

async fn ensure_server(
    instance: &Arc<OpenCodeInstance>,
    request: &TurnRequest,
) -> Result<String, String> {
    {
        let state = instance.state.lock().await;
        if let Some(base_url) = &state.base_url {
            if state.events_running {
                return Ok(base_url.clone());
            }
        }
    }

    // A configured server URL wins; otherwise launch a Maxx-owned scoped server.
    let configured = request
        .profile
        .server_url
        .clone()
        .or_else(|| {
            request
                .profile
                .environment
                .get("OPENCODE_SERVER_URL")
                .cloned()
        })
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"));

    let mut environment: HashMap<String, String> = {
        let configuration = super::launch::launch_configuration(&request.profile);
        match &configuration {
            Ok(config) => config.environment.clone(),
            Err(_) if configured.is_some() => std::env::vars().collect(),
            Err(error) => return Err(error.clone()),
        }
    };
    if configured.is_some() && request.browser_access.is_some() {
        return Err(
            "OpenCode browser tools require a Maxx-owned per-thread server; a configured external server cannot receive scoped browser authority."
                .into(),
        );
    }
    if let Some(access) = request.browser_access.as_deref() {
        inject_browser_mcp_config(&mut environment, access)?;
    }

    let base_url = if let Some(configured) = configured {
        configured.trim_end_matches('/').to_string()
    } else {
        let configuration = super::launch::launch_configuration(&request.profile)?;
        let port = free_port()?;
        let server = JsonLineProcess::spawn(&LaunchSpec {
            executable: configuration.executable.to_string_lossy().to_string(),
            arguments: vec![
                "serve".into(),
                "--hostname".into(),
                "127.0.0.1".into(),
                "--port".into(),
                port.to_string(),
            ],
            working_directory: Some(request.working_directory.clone()),
            environment: environment.clone(),
        })?;
        instance.state.lock().await.owned_server = Some(server);
        format!("http://127.0.0.1:{port}")
    };

    // Wait for health before first use.
    let mut healthy = false;
    for _ in 0..40 {
        if http_request(
            &instance.http,
            &base_url,
            "global/health",
            None,
            "GET",
            None,
            &environment,
        )
        .await
        .is_ok()
        {
            healthy = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    if !healthy {
        return Err("The OpenCode server did not become healthy.".into());
    }

    {
        let mut state = instance.state.lock().await;
        state.base_url = Some(base_url.clone());
        state.environment = environment.clone();
        if !state.events_running {
            state.events_running = true;
            drop(state);
            spawn_event_stream(instance.clone(), base_url.clone(), environment);
        }
    }
    Ok(base_url)
}

fn inject_browser_mcp_config(
    environment: &mut HashMap<String, String>,
    access: &crate::browser_runtime::BrowserProviderAccess,
) -> Result<(), String> {
    let mut config = match environment.get("OPENCODE_CONFIG_CONTENT") {
        Some(existing) => serde_json::from_str::<Value>(existing)
            .map_err(|error| format!("OPENCODE_CONFIG_CONTENT is invalid JSON: {error}"))?,
        None => json!({}),
    };
    let root = config.as_object_mut().ok_or_else(|| {
        "OPENCODE_CONFIG_CONTENT must contain a JSON object before Maxx can add browser tools."
            .to_string()
    })?;
    let mcp = root.entry("mcp").or_insert_with(|| json!({}));
    let servers = mcp.as_object_mut().ok_or_else(|| {
        "OPENCODE_CONFIG_CONTENT.mcp must be an object before Maxx can add browser tools."
            .to_string()
    })?;
    servers.insert(
        "maxx_browser".into(),
        json!({
            "type": "remote",
            "url": access.endpoint,
            "enabled": true,
            "oauth": false,
            "headers": {
                "Authorization": "Bearer {env:MAXX_BROWSER_TOKEN}"
            }
        }),
    );
    environment.insert("MAXX_BROWSER_TOKEN".into(), access.bearer_token.clone());
    environment.insert(
        "OPENCODE_CONFIG_CONTENT".into(),
        serde_json::to_string(&config).map_err(|error| error.to_string())?,
    );
    Ok(())
}

fn spawn_event_stream(
    instance: Arc<OpenCodeInstance>,
    base_url: String,
    environment: HashMap<String, String>,
) {
    tokio::spawn(async move {
        loop {
            let request = authorized(instance.http.get(format!("{base_url}/event")), &environment)
                .header("Accept", "text/event-stream");
            let response = match request.send().await {
                Ok(response) => response,
                Err(_) => {
                    if !still_current(&instance, &base_url).await {
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
            let mut stream = response.bytes_stream();
            let mut buffer: Vec<u8> = Vec::new();
            while let Some(chunk) = stream.next().await {
                let Ok(chunk) = chunk else { break };
                buffer.extend_from_slice(&chunk);
                while let Some(position) = buffer.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=position).collect();
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim();
                    if let Some(data) = line.strip_prefix("data:") {
                        handle_event(&instance, data.trim()).await;
                    }
                }
            }
            if !still_current(&instance, &base_url).await {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

async fn still_current(instance: &Arc<OpenCodeInstance>, base_url: &str) -> bool {
    let state = instance.state.lock().await;
    state.base_url.as_deref() == Some(base_url) && state.events_running
}

async fn handle_event(instance: &Arc<OpenCodeInstance>, data: &str) {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return;
    };
    let Some(object) = value.as_object() else {
        return;
    };
    let properties = object.get("properties").and_then(Value::as_object);
    let event_session = properties.and_then(|p| {
        p.get("sessionID")
            .or_else(|| p.get("sessionId"))
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| {
                p.get("part")
                    .or_else(|| p.get("info"))
                    .and_then(Value::as_object)
                    .and_then(|nested| {
                        nested
                            .get("sessionID")
                            .or_else(|| nested.get("sessionId"))
                            .and_then(Value::as_str)
                            .map(String::from)
                    })
            })
    });

    let mut state = instance.state.lock().await;
    let session_key = match &event_session {
        Some(session) if state.active_by_session.contains_key(session) => session.clone(),
        Some(_) => return, // another session on a shared server
        None => {
            // Global events (heartbeats, server.connected) go to the sole
            // active turn when unambiguous, otherwise they are dropped.
            match state.active_by_session.keys().next().cloned() {
                Some(key) if state.active_by_session.len() == 1 => key,
                _ => return,
            }
        }
    };
    let Some(turn) = state.active_by_session.get_mut(&session_key) else {
        return;
    };

    let drafts = match normalize(
        data.as_bytes(),
        ChatProvider::Opencode,
        &mut turn.normalizer,
    ) {
        Ok(drafts) => drafts,
        Err(error) => {
            let sink = turn.sink.clone();
            state.active_by_session.remove(&session_key);
            drop(state);
            yield_error(&sink, error.to_string()).await;
            return;
        }
    };

    // Track native interactive request ids for HTTP replies.
    let event_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if event_type == "permission.asked" || event_type == "question.asked" {
        if let Some(properties) = properties {
            let native_id = properties
                .get("requestID")
                .or_else(|| properties.get("id"))
                .and_then(Value::as_str)
                .map(String::from);
            if let Some(native_id) = native_id {
                let question_count = properties
                    .get("questions")
                    .and_then(Value::as_array)
                    .map(|q| q.len())
                    .unwrap_or(1);
                for draft in &drafts {
                    if let ProviderEventDraft::Payload {
                        request_id: Some(request_id),
                        ..
                    } = draft
                    {
                        state.interactions.insert(
                            *request_id,
                            PendingInteraction {
                                native_request_id: native_id.clone(),
                                session_id: session_key.clone(),
                                is_question: event_type == "question.asked",
                                question_count,
                            },
                        );
                    }
                }
            }
        }
    }

    let turn = state.active_by_session.get(&session_key).unwrap();
    let sink = turn.sink.clone();
    let terminal = drafts.iter().any(|d| {
        matches!(
            d,
            ProviderEventDraft::Terminal(_) | ProviderEventDraft::Completed
        )
    });
    if terminal {
        state.active_by_session.remove(&session_key);
    }
    drop(state);
    for draft in drafts {
        yield_draft(&sink, draft).await;
    }
}

fn authorized(
    request: reqwest::RequestBuilder,
    environment: &HashMap<String, String>,
) -> reqwest::RequestBuilder {
    if let Some(password) = environment
        .get("OPENCODE_SERVER_PASSWORD")
        .filter(|p| !p.is_empty())
    {
        let username = environment
            .get("OPENCODE_SERVER_USERNAME")
            .cloned()
            .unwrap_or_else(|| "opencode".into());
        request.basic_auth(username, Some(password))
    } else {
        request
    }
}

async fn http_request(
    http: &reqwest::Client,
    base_url: &str,
    path: &str,
    directory: Option<&str>,
    method: &str,
    body: Option<Value>,
    environment: &HashMap<String, String>,
) -> Result<Value, (Option<u16>, String)> {
    let mut url = format!("{base_url}/{path}");
    if let Some(directory) = directory {
        url = format!("{url}?directory={}", urlencode(directory));
    }
    let request = match method {
        "POST" => http.post(&url),
        _ => http.get(&url),
    };
    let mut request = authorized(request, environment)
        .timeout(std::time::Duration::from_secs(15))
        .header("Accept", "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| (None, e.to_string()))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err((
            Some(status.as_u16()),
            format!("OpenCode HTTP {} for {path}: {text}", status.as_u16()),
        ));
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn urlencode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                encoded.push(byte as char)
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .map_err(|e| format!("No free local port for the OpenCode server: {e}"))
}

#[cfg(test)]
mod browser_mcp_tests {
    use super::*;
    use crate::browser_runtime::BrowserProviderAccess;

    #[test]
    fn merges_browser_server_without_serializing_the_secret() {
        let access = BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "secret-token".into(),
        };
        let mut environment = HashMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"theme":"maxx","mcp":{"existing":{"type":"local","command":["ok"]}}}"#.into(),
        )]);
        inject_browser_mcp_config(&mut environment, &access).unwrap();

        let config = environment.get("OPENCODE_CONFIG_CONTENT").unwrap();
        assert!(!config.contains("secret-token"));
        let parsed: Value = serde_json::from_str(config).unwrap();
        assert_eq!(parsed["theme"], "maxx");
        assert_eq!(parsed["mcp"]["existing"]["type"], "local");
        assert_eq!(
            parsed["mcp"]["maxx_browser"]["headers"]["Authorization"],
            "Bearer {env:MAXX_BROWSER_TOKEN}"
        );
        assert_eq!(environment["MAXX_BROWSER_TOKEN"], "secret-token");
    }

    #[test]
    fn agent_identity_uses_the_system_field_not_a_user_part() {
        let mut request = crate::engine::test_request(ChatProvider::Opencode);
        request.agent_instructions = Some("You are Dana.".into());

        let body = opencode_prompt_body(&request).unwrap();
        assert_eq!(body["system"], "You are Dana.");
        assert_eq!(
            body["parts"],
            json!([{"type": "text", "text": "user prompt"}])
        );
    }
}
