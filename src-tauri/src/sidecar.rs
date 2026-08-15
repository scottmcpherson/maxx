use crate::browser_runtime::{
    BrowserArtifactContent, BrowserOperation, BrowserRuntime, ElectronBrowserEngine,
};
use crate::events::EventSink;
use crate::host::SidecarHostBridge;
use crate::host_session::{
    create_host_folder, has_capability, home_folder, list_host_folder, read_media_bytes,
    required_capability, store_media_bytes, AccessPreset, AuthenticatedPeer, FolderAuthorizations,
    FolderEntry, HostHandler, HostHub,
};
use crate::state::AppState;
use crate::voice::VoiceState;
use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use maxx_core::contract::{ChatProvider, RuntimeInteractionDecision};
use maxx_core::persist::{AgentDefinition, ProviderProfile, TitleGenerationRuntime};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct SidecarEvents {
    outbound: mpsc::UnboundedSender<Value>,
    journal: Arc<crate::host_session::EventJournal>,
}

impl EventSink for SidecarEvents {
    fn emit_value(&self, event: &str, payload: Value) {
        if let Err(error) = self.journal.emit(event, payload.clone()) {
            log::warn!("could not persist host event: {error}");
        }
        let _ = self
            .outbound
            .send(json!({"type":"event","event":event,"payload":payload}));
    }
}

struct SidecarState {
    app: Arc<AppState>,
    browser: Arc<BrowserRuntime>,
    voice: Arc<VoiceState>,
    hosts: Arc<HostHub>,
    outbound: mpsc::UnboundedSender<Value>,
    host_supervisors: Mutex<HashMap<String, CancellationToken>>,
}

struct DispatchHandler {
    state: Arc<SidecarState>,
    folders: FolderAuthorizations,
}

impl DispatchHandler {
    fn new(state: Arc<SidecarState>) -> Self {
        Self {
            state,
            folders: FolderAuthorizations::default(),
        }
    }
}

#[async_trait]
impl HostHandler for DispatchHandler {
    async fn handle(
        &self,
        peer: &AuthenticatedPeer,
        method: &str,
        mut params: Value,
    ) -> Result<Value, String> {
        if method == "host_forget_peer" {
            self.state.hosts.forget_incoming(&peer.id)?;
            return Ok(Value::Null);
        }
        if method.starts_with("host_") {
            return Err("A connected peer cannot manage this Mac's host connections".into());
        }
        let required_access = required_capability(method)
            .ok_or_else(|| format!("{method} is not available to connected environments"))?;
        if !has_capability(&peer.capabilities, required_access) {
            return Err(format!("{} is not allowed to use {method}", peer.name));
        }
        match method {
            "home_folder" => {
                let result = dispatch(self.state.clone(), method, params).await?;
                if let Some(path) = result.get("path").and_then(Value::as_str) {
                    self.folders.remember_home(&peer.id, path).await;
                }
                Ok(result)
            }
            "list_folder" => {
                let requested = required::<String>(&params, "path")?;
                let authorized = self.folders.authorize(&peer.id, &requested).await?;
                params["path"] = Value::String(authorized.clone());
                let result = dispatch(self.state.clone(), method, params).await?;
                let entries: Vec<FolderEntry> = serde_json::from_value(result.clone())
                    .map_err(|error| format!("Could not read folder entries: {error}"))?;
                self.folders
                    .remember_listing(&peer.id, authorized, &entries)
                    .await;
                Ok(result)
            }
            "create_folder" => {
                let parent = required::<String>(&params, "parent")?;
                params["parent"] = Value::String(self.folders.authorize(&peer.id, &parent).await?);
                let result = dispatch(self.state.clone(), method, params).await?;
                if let Some(path) = result.get("path").and_then(Value::as_str) {
                    self.folders
                        .remember_created(&peer.id, path.to_string())
                        .await;
                }
                Ok(result)
            }
            "add_project" => {
                let folder = required::<String>(&params, "folderPath")?;
                params["folderPath"] =
                    Value::String(self.folders.authorize(&peer.id, &folder).await?);
                dispatch(self.state.clone(), method, params).await
            }
            _ => dispatch(self.state.clone(), method, params).await,
        }
    }
}

fn take_host_id(params: &Value) -> Option<String> {
    params
        .get("hostId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn without_host_id(params: &Value) -> Value {
    let mut value = params.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("hostId");
    }
    value
}

async fn targets_local_project(state: &SidecarState, params: &Value) -> bool {
    let Some(project_id) = params
        .get("projectId")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
    else {
        return false;
    };
    state
        .app
        .workspace
        .lock()
        .await
        .projects
        .iter()
        .any(|project| project.id == project_id)
}

fn required<T: DeserializeOwned>(params: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(
        params
            .get(key)
            .cloned()
            .ok_or_else(|| format!("missing parameter {key}"))?,
    )
    .map_err(|error| format!("invalid parameter {key}: {error}"))
}

fn optional<T: DeserializeOwned>(params: &Value, key: &str) -> Result<Option<T>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| format!("invalid parameter {key}: {error}")),
    }
}

fn value<T: serde::Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

async fn dispatch(state: Arc<SidecarState>, method: &str, params: Value) -> Result<Value, String> {
    if !method.starts_with("host_") {
        if let Some(host_id) = take_host_id(&params) {
            // The project is the authoritative owner for project-scoped
            // commands. A stale renderer selection must never forward a local
            // chat to another Maxx instance and leave the composer waiting on
            // a remote response.
            if !state.hosts.is_local(&host_id) && !targets_local_project(&state, &params).await {
                return state
                    .hosts
                    .invoke_remote(&host_id, method, without_host_id(&params))
                    .await;
            }
        }
    }
    match method {
        "host_status" => value(Ok(state.hosts.status().await)),
        "host_discovery" => value(Ok(state.hosts.discovery().await)),
        "host_listen" => {
            let bind = optional::<String>(&params, "bindAddress")?;
            let handler = Arc::new(DispatchHandler::new(state.clone()));
            value(state.hosts.start_listen(bind.as_deref(), handler).await)
        }
        "host_unlisten" => value(state.hosts.stop_listen().await),
        "host_create_pairing" => value(
            state
                .hosts
                .create_pairing(required::<AccessPreset>(&params, "preset")?)
                .await,
        ),
        "host_cancel_pairing" => {
            state.hosts.cancel_pairing()?;
            Ok(Value::Null)
        }
        "host_connect" => {
            let address: String = required(&params, "address")?;
            let code: String = required(&params, "code")?;
            let info = state.hosts.connect(&address, &code).await?;
            ensure_host_supervisor(state.clone(), info.id.clone()).await;
            value(Ok(info))
        }
        "host_disconnect" => {
            let host_id = required::<String>(&params, "hostId")?;
            stop_host_supervisor(&state, &host_id).await;
            value(state.hosts.disconnect(&host_id).await)
        }
        "host_revoke_peer" => value(
            state
                .hosts
                .revoke_paired_device(&required::<String>(&params, "peerId")?)
                .await,
        ),
        "list_folder" => value(list_host_folder(&required::<String>(&params, "path")?)),
        "create_folder" => value(
            create_host_folder(
                &required::<String>(&params, "parent")?,
                &required::<String>(&params, "name")?,
            )
            .map(|path| json!({ "path": path })),
        ),
        "home_folder" => value(home_folder().map(|path| json!({ "path": path }))),
        "upload_media" => {
            let encoded: String = required(&params, "dataBase64")?;
            let mime: String = required(&params, "mimeType")?;
            let name: String = required(&params, "displayName")?;
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|error| format!("The image data is invalid: {error}"))?;
            let attachment =
                store_media_bytes(&crate::state::chat_images_dir(), &bytes, &mime, &name)?;
            serde_json::to_value(attachment).map_err(|error| error.to_string())
        }
        "read_media" => {
            let id: Uuid = required(&params, "attachmentId")?;
            let (bytes, mime, name) = read_media_bytes(&crate::state::chat_images_dir(), id)?;
            Ok(json!({
                "id": id,
                "mimeType": mime,
                "displayName": name,
                "dataBase64": STANDARD.encode(bytes),
            }))
        }
        "load_media" => {
            let resolved = crate::media::resolve_media_source(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "threadId")?,
                required(&params, "destination")?,
            )
            .await?;
            let bytes = std::fs::read(&resolved.path)
                .map_err(|error| format!("Could not read media: {error}"))?;
            Ok(json!({
                "kind": resolved.kind,
                "mimeType": resolved.mime_type,
                "displayName": resolved.display_name,
                "dataBase64": STANDARD.encode(bytes),
            }))
        }
        "workspace_snapshot" => value(crate::commands::workspace_snapshot(state.app.clone()).await),
        "active_turns" => value(crate::commands::active_turns(state.app.clone()).await),
        "git_status" => {
            value(crate::git::git_status(state.app.clone(), required(&params, "projectId")?).await)
        }
        "git_commit" => value(
            crate::git::git_commit(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "message")?,
            )
            .await,
        ),
        "git_push" => {
            value(crate::git::git_push(state.app.clone(), required(&params, "projectId")?).await)
        }
        "add_project" => value(
            crate::commands::add_project(state.app.clone(), required(&params, "folderPath")?).await,
        ),
        "remove_project" => value(
            crate::commands::remove_project(state.app.clone(), required(&params, "projectId")?)
                .await,
        ),
        "add_thread" => value(
            crate::commands::add_thread(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "provider")?,
                required(&params, "model")?,
                required(&params, "title")?,
            )
            .await,
        ),
        "add_thread_with_runtime" => value(
            crate::commands::add_thread_with_runtime(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "provider")?,
                required(&params, "model")?,
                required(&params, "title")?,
                optional(&params, "effort")?,
                optional(&params, "speed")?,
                optional(&params, "surface")?,
            )
            .await,
        ),
        "remove_thread" => value(
            crate::commands::remove_thread(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "threadId")?,
            )
            .await,
        ),
        "update_thread" => value(
            crate::commands::update_thread(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "threadId")?,
                optional(&params, "title")?,
                optional(&params, "provider")?,
                optional(&params, "model")?,
                optional(&params, "effort")?,
                optional(&params, "speed")?,
                optional(&params, "updateRuntimeKnobs")?,
            )
            .await,
        ),
        "terminal_support" => value(Ok(crate::terminal::TerminalBroker::support(required(
            &params, "provider",
        )?))),
        "terminal_start" => value(
            state
                .app
                .terminals
                .start(
                    state.app.clone(),
                    required(&params, "projectId")?,
                    required(&params, "threadId")?,
                    optional(&params, "rows")?,
                    optional(&params, "cols")?,
                )
                .await,
        ),
        "terminal_status" => value(Ok(state
            .app
            .terminals
            .status(required(&params, "threadId")?)
            .await)),
        "terminal_input" => value(
            state
                .app
                .terminals
                .input(
                    required(&params, "threadId")?,
                    required(&params, "dataBase64")?,
                )
                .await,
        ),
        "terminal_resize" => value(
            state
                .app
                .terminals
                .resize(
                    required(&params, "threadId")?,
                    required(&params, "rows")?,
                    required(&params, "cols")?,
                )
                .await,
        ),
        "terminal_read" => value(
            state
                .app
                .terminals
                .read(
                    required(&params, "threadId")?,
                    required(&params, "after")?,
                    optional(&params, "maxBytes")?,
                )
                .await,
        ),
        "terminal_stop" => value(
            state
                .app
                .terminals
                .stop(
                    state.app.clone(),
                    required(&params, "projectId")?,
                    required(&params, "threadId")?,
                    optional(&params, "archive")?,
                )
                .await,
        ),
        "update_profiles" => value(
            crate::commands::update_profiles(
                state.app.clone(),
                required::<Vec<ProviderProfile>>(&params, "profiles")?,
            )
            .await,
        ),
        "update_title_generation_runtime" => value(
            crate::commands::update_title_generation_runtime(
                state.app.clone(),
                optional::<TitleGenerationRuntime>(&params, "runtime")?,
            )
            .await,
        ),
        "update_agents" => value(
            crate::commands::update_agents(
                state.app.clone(),
                required::<Vec<AgentDefinition>>(&params, "agents")?,
            )
            .await,
        ),
        "import_agent_image" => value(
            crate::commands::import_agent_image(
                required(&params, "agentId")?,
                required(&params, "sourcePath")?,
            )
            .await,
        ),
        "send_prompt" => value(
            crate::commands::send_prompt(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "threadId")?,
                required(&params, "prompt")?,
                optional(&params, "imagePaths")?.unwrap_or_default(),
                optional(&params, "attachmentIds")?.unwrap_or_default(),
                optional(&params, "annotations")?.unwrap_or_default(),
            )
            .await,
        ),
        "steer_prompt" => value(
            crate::commands::steer_prompt(
                state.app.clone(),
                crate::commands::SteerPromptCommand {
                    project_id: required(&params, "projectId")?,
                    thread_id: required(&params, "threadId")?,
                    turn_id: required(&params, "turnId")?,
                    prompt: required(&params, "prompt")?,
                    image_paths: optional(&params, "imagePaths")?.unwrap_or_default(),
                    attachment_ids: optional(&params, "attachmentIds")?.unwrap_or_default(),
                    annotations: optional(&params, "annotations")?.unwrap_or_default(),
                },
            )
            .await,
        ),
        "start_side_thread" => value(
            crate::commands::start_side_thread(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "parentThreadId")?,
                required(&params, "agentIds")?,
                required(&params, "prompt")?,
                optional(&params, "imagePaths")?.unwrap_or_default(),
                optional(&params, "attachmentIds")?.unwrap_or_default(),
                optional(&params, "annotations")?.unwrap_or_default(),
            )
            .await,
        ),
        "send_agent_prompt" => value(
            crate::commands::send_agent_prompt(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "threadId")?,
                required(&params, "agentIds")?,
                required(&params, "prompt")?,
                optional(&params, "imagePaths")?.unwrap_or_default(),
                optional(&params, "attachmentIds")?.unwrap_or_default(),
            )
            .await,
        ),
        "cancel_turn" => value(
            crate::commands::cancel_turn(state.app.clone(), required(&params, "turnId")?).await,
        ),
        "resolve_request" => value(
            crate::commands::resolve_request(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "threadId")?,
                required(&params, "requestId")?,
                required::<RuntimeInteractionDecision>(&params, "decision")?,
            )
            .await,
        ),
        "provider_health" => value(
            crate::commands::provider_health(state.app.clone(), required(&params, "profileId")?)
                .await,
        ),
        "list_provider_models" => value(
            crate::commands::list_provider_models(
                state.app.clone(),
                required::<ChatProvider>(&params, "provider")?,
                optional(&params, "profileId")?,
                optional(&params, "workingDirectory")?,
            )
            .await,
        ),
        "list_provider_commands" => value(
            crate::commands::list_provider_commands(
                state.app.clone(),
                required(&params, "provider")?,
                optional(&params, "profileId")?,
                optional(&params, "workingDirectory")?,
            )
            .await,
        ),
        "resolve_media_source" => value(
            crate::media::resolve_media_source(
                state.app.clone(),
                required(&params, "projectId")?,
                required(&params, "threadId")?,
                required(&params, "destination")?,
            )
            .await,
        ),
        "voice_status" => value(crate::voice::voice_status(state.app.clone()).await),
        "update_voice_settings" => value(
            crate::voice::update_voice_settings(state.app.clone(), required(&params, "settings")?)
                .await,
        ),
        "voice_start" => {
            value(crate::voice::voice_start(state.app.clone(), state.voice.clone()).await)
        }
        "voice_send_audio" => value(
            crate::voice::voice_send_audio(
                state.voice.clone(),
                required(&params, "session")?,
                required(&params, "chunk")?,
            )
            .await,
        ),
        "voice_stop" => value(
            crate::voice::voice_stop(state.voice.clone(), required(&params, "session")?).await,
        ),
        "authorize_image_previews" => Ok(Value::Null),
        "browser_ui_tabs" => {
            let thread_id: Uuid = required(&params, "threadId")?;
            let assigned = state.browser.sessions.tabs_for_thread(thread_id);
            let tabs = state
                .browser
                .broker
                .tab_summaries()
                .await
                .into_iter()
                .filter(|tab| assigned.contains(&tab.id))
                .collect::<Vec<_>>();
            serde_json::to_value(tabs).map_err(|error| error.to_string())
        }
        "browser_ui_open_tab" => {
            let result = state
                .browser
                .human_open_tab(required(&params, "threadId")?, optional(&params, "url")?)
                .await
                .map_err(|error| error.to_string())?;
            serde_json::to_value(
                result
                    .tab_id
                    .ok_or("browser open did not return a tab id")?,
            )
            .map_err(|error| error.to_string())
        }
        "browser_ui_select_tab" => {
            browser_operation(
                &state.browser,
                BrowserOperation::SelectTab {
                    tab_id: required(&params, "tabId")?,
                },
            )
            .await
        }
        "browser_ui_close_tab" => {
            browser_operation(
                &state.browser,
                BrowserOperation::CloseTab {
                    tab_id: required(&params, "tabId")?,
                },
            )
            .await
        }
        "browser_ui_reorder_tabs" => {
            let thread_id: Uuid = required(&params, "threadId")?;
            let tab_ids: Vec<Uuid> = required(&params, "tabIds")?;
            let assigned = state.browser.sessions.tabs_for_thread(thread_id);
            let requested = tab_ids.iter().copied().collect::<HashSet<_>>();
            if requested.len() != tab_ids.len() || requested != assigned {
                return Err(
                    "browser tab order must contain every tab in the thread exactly once".into(),
                );
            }
            state
                .browser
                .broker
                .reorder_tabs(&tab_ids)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "browser_ui_navigate" => {
            browser_operation(
                &state.browser,
                BrowserOperation::Navigate {
                    tab_id: required(&params, "tabId")?,
                    url: required(&params, "url")?,
                },
            )
            .await
        }
        "browser_ui_back" => {
            browser_operation(
                &state.browser,
                BrowserOperation::GoBack {
                    tab_id: required(&params, "tabId")?,
                },
            )
            .await
        }
        "browser_ui_forward" => {
            browser_operation(
                &state.browser,
                BrowserOperation::GoForward {
                    tab_id: required(&params, "tabId")?,
                },
            )
            .await
        }
        "browser_ui_reload" => {
            browser_operation(
                &state.browser,
                BrowserOperation::Reload {
                    tab_id: required(&params, "tabId")?,
                },
            )
            .await
        }
        "browser_ui_artifact" => {
            browser_artifact(
                &state,
                required(&params, "threadId")?,
                required(&params, "artifactId")?,
            )
            .await
        }
        other => Err(format!("unknown sidecar method {other}")),
    }
}

async fn ensure_host_supervisor(state: Arc<SidecarState>, host_id: String) {
    let token = {
        let mut supervisors = state.host_supervisors.lock().await;
        if supervisors.contains_key(&host_id) {
            return;
        }
        let token = CancellationToken::new();
        supervisors.insert(host_id.clone(), token.clone());
        token
    };
    tokio::spawn(async move {
        supervise_host(state, host_id, token).await;
    });
}

async fn stop_host_supervisor(state: &SidecarState, host_id: &str) {
    if let Some(token) = state.host_supervisors.lock().await.remove(host_id) {
        token.cancel();
    }
}

async fn supervise_host(state: Arc<SidecarState>, host_id: String, shutdown: CancellationToken) {
    let mut retry_seconds = 1_u64;
    while !shutdown.is_cancelled() && state.hosts.is_remembered(&host_id) {
        let client = match state.hosts.connected_client(&host_id).await {
            Some(client) => client,
            None => match state.hosts.reconnect(&host_id).await {
                Ok(client) => client,
                Err(error) => {
                    state
                        .hosts
                        .set_connection_error(&host_id, error.clone())
                        .await;
                    emit_remote_event_to_renderer(
                        &state.outbound,
                        &host_id,
                        "host://status-changed",
                        json!({"error": error}),
                    );
                    if wait_for_retry(&shutdown, retry_seconds).await {
                        break;
                    }
                    retry_seconds = (retry_seconds * 2).min(30);
                    continue;
                }
            },
        };
        retry_seconds = 1;
        emit_remote_event_to_renderer(
            &state.outbound,
            &host_id,
            "host://connected",
            json!({
                "resyncRequired": client.resync_required,
                "eventCursor": client.server_cursor,
            }),
        );
        let mut last_cursor = None;
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => {
                    client.close().await;
                    break;
                }
                event = client.next_event() => {
                    let Some(event) = event else { break };
                    last_cursor = Some(event.cursor);
                    emit_remote_event_to_renderer(
                        &state.outbound,
                        &host_id,
                        &event.event,
                        event.payload,
                    );
                }
            }
        }
        if let Some(cursor) = last_cursor {
            if let Err(error) = state.hosts.record_event_cursor(&host_id, cursor) {
                log::warn!("could not persist event cursor for {host_id}: {error}");
            }
        }
        state.hosts.remove_if_same(&host_id, &client).await;
        if shutdown.is_cancelled() || !state.hosts.is_remembered(&host_id) {
            break;
        }
        state
            .hosts
            .set_connection_error(&host_id, "Connection lost. Retrying…".into())
            .await;
        emit_remote_event_to_renderer(
            &state.outbound,
            &host_id,
            "host://disconnected",
            Value::Null,
        );
        if wait_for_retry(&shutdown, retry_seconds).await {
            break;
        }
        retry_seconds = (retry_seconds * 2).min(30);
    }
}

async fn wait_for_retry(shutdown: &CancellationToken, seconds: u64) -> bool {
    tokio::select! {
        _ = shutdown.cancelled() => true,
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => false,
    }
}

fn restore_host_listener(state: Arc<SidecarState>) {
    if !state.hosts.listen_enabled() {
        return;
    }
    tokio::spawn(async move {
        while state.hosts.listen_enabled() && !state.hosts.is_listening().await {
            let handler = Arc::new(DispatchHandler::new(state.clone()));
            match state.hosts.restore_listen(handler).await {
                Ok(address) => {
                    log::info!("restored Maxx environment listener on {address}");
                    emit_remote_event_to_renderer(
                        &state.outbound,
                        crate::host_session::LOCAL_HOST_ID,
                        "host://status-changed",
                        json!({"listening": true, "address": address}),
                    );
                    return;
                }
                Err(error) => {
                    log::warn!("could not restore Maxx environment listener: {error}");
                }
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

fn emit_remote_event_to_renderer(
    outbound: &mpsc::UnboundedSender<Value>,
    host_id: &str,
    event: &str,
    payload: Value,
) {
    // Remote-originated events intentionally bypass SidecarEvents: sending them
    // through that sink would fan them back out to peers and create loops when
    // two Maxx installs connect in both directions.
    let _ = outbound.send(json!({
        "type":"event",
        "event":"host://event",
        "payload":{"hostId":host_id,"event":event,"payload":payload}
    }));
}

async fn browser_operation(
    browser: &Arc<BrowserRuntime>,
    operation: BrowserOperation,
) -> Result<Value, String> {
    browser
        .human_execute(operation)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

async fn browser_artifact(
    state: &SidecarState,
    thread_id: Uuid,
    artifact_id: Uuid,
) -> Result<Value, String> {
    let artifact = {
        let workspace = state.app.workspace.lock().await;
        workspace
            .projects
            .iter()
            .flat_map(|project| &project.threads)
            .find(|thread| thread.id == thread_id)
            .and_then(|thread| {
                thread
                    .runtime_events
                    .iter()
                    .flat_map(|event| event.payload.artifacts.iter().flatten())
                    .find(|artifact| artifact.id == artifact_id)
            })
            .cloned()
            .ok_or_else(|| "browser artifact does not belong to this thread".to_string())?
    };
    let bytes = state
        .browser
        .artifacts
        .read_persisted_image(artifact.id, &artifact.mime_type, artifact.byte_length)
        .map_err(|error| error.to_string())?;
    serde_json::to_value(BrowserArtifactContent {
        id: artifact.id,
        mime_type: artifact.mime_type,
        title: artifact.title,
        data_base64: STANDARD.encode(bytes),
    })
    .map_err(|error| error.to_string())
}

pub fn run() -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(run_async())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_events_are_renderer_only_frames() {
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        emit_remote_event_to_renderer(
            &outbound,
            "remote-a",
            "runtime://event",
            json!({"threadID":"thread-a"}),
        );
        assert_eq!(
            receiver.try_recv().unwrap(),
            json!({
                "type":"event",
                "event":"host://event",
                "payload":{
                    "hostId":"remote-a",
                    "event":"runtime://event",
                    "payload":{"threadID":"thread-a"}
                }
            })
        );
        assert!(receiver.try_recv().is_err());
    }
}

async fn run_async() -> Result<(), String> {
    VoiceState::install_crypto_provider();
    let (outbound, mut output) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = output.recv().await {
            let mut serialized = message.to_string();
            serialized.push('\n');
            if stdout.write_all(serialized.as_bytes()).await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });
    let host = SidecarHostBridge::new(outbound.clone());
    let hosts = Arc::new(HostHub::new());
    let events: Arc<dyn EventSink> = Arc::new(SidecarEvents {
        outbound: outbound.clone(),
        journal: hosts.events.clone(),
    });
    let browser_root = crate::state::workspace_path().with_file_name("browser-runtime");
    let browser = BrowserRuntime::start(
        ElectronBrowserEngine::new(host.clone()),
        browser_root.join("artifacts"),
    )
    .await
    .map_err(|error| error.to_string())?;
    let state = Arc::new(SidecarState {
        app: Arc::new(AppState::load(browser.clone(), events.clone())),
        browser: browser.clone(),
        voice: Arc::new(VoiceState::default()),
        hosts,
        outbound: outbound.clone(),
        host_supervisors: Mutex::new(HashMap::new()),
    });
    for host_id in state.hosts.remembered_ids() {
        ensure_host_supervisor(state.clone(), host_id).await;
    }
    restore_host_listener(state.clone());
    let mut reveals = browser.subscribe_ui_reveals();
    let reveal_events = events.clone();
    tokio::spawn(async move {
        while let Ok(reveal) = reveals.recv().await {
            crate::events::emit(reveal_events.as_ref(), "browser://reveal", &reveal);
        }
    });
    outbound
        .send(json!({"type":"ready"}))
        .map_err(|_| "desktop host disconnected before startup".to_string())?;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = loop {
            match lines.next_line().await {
                Ok(line) => break line,
                // Electron owns the pipe connected to the sidecar's stdin. On
                // macOS that descriptor can briefly surface EAGAIN after a PTY
                // child is launched. This is not a desktop-host disconnect, so
                // keep the protocol reader alive until input or EOF arrives.
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => return Err(error.to_string()),
            }
        };
        let Some(line) = line else { break };
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(error) => {
                log::warn!("ignored invalid sidecar message: {error}");
                continue;
            }
        };
        match message.get("type").and_then(Value::as_str) {
            Some("host_response") => {
                let Some(id) = message.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                let error = message.get("error").and_then(|error| {
                    Some(crate::browser_runtime::BrowserRuntimeError::new(
                        error.get("code")?.as_str()?,
                        error.get("message")?.as_str()?,
                    ))
                });
                host.resolve(id, message.get("result").cloned(), error)
                    .await;
            }
            Some("host_event") => {
                let event = message.get("event").and_then(Value::as_str);
                let payload = message.get("payload");
                let tab_id = payload
                    .and_then(|payload| payload.get("tabId").or_else(|| payload.get("id")))
                    .and_then(Value::as_str)
                    .and_then(|value| Uuid::parse_str(value).ok());
                if event == Some("browser.human_input") {
                    if let Some(tab_id) = tab_id {
                        // `human_input` interrupts the native engine, which sends a
                        // host request and waits for its response. Never await that
                        // round trip on the stdin reader that must receive the
                        // response, or every later command deadlocks behind it.
                        let broker = browser.broker.clone();
                        tokio::spawn(async move {
                            let _ = broker.human_input(tab_id).await;
                        });
                    }
                } else if event == Some("browser.lifecycle") {
                    if let (Some(tab_id), Some(url), Some(title), Some(loading)) = (
                        tab_id,
                        payload
                            .and_then(|value| value.get("url"))
                            .and_then(Value::as_str),
                        payload
                            .and_then(|value| value.get("title"))
                            .and_then(Value::as_str),
                        payload
                            .and_then(|value| value.get("loading"))
                            .and_then(Value::as_bool),
                    ) {
                        browser
                            .broker
                            .native_state(tab_id, url.to_string(), title.to_string(), loading)
                            .await;
                    }
                }
            }
            Some("request") => {
                let Some(id) = message.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                let method = message
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                let request_state = state.clone();
                let responses = outbound.clone();
                tokio::spawn(async move {
                    let response = match dispatch(request_state, &method, params).await {
                        Ok(result) => json!({"type":"response","id":id,"result":result}),
                        Err(message) => {
                            json!({"type":"response","id":id,"error":{"code":"runtime.command","message":message}})
                        }
                    };
                    let _ = responses.send(response);
                });
            }
            Some("shutdown") => break,
            _ => {}
        }
    }
    state.app.terminals.shutdown().await;
    match tokio::time::timeout(std::time::Duration::from_secs(5), browser.shutdown()).await {
        Ok(result) => result.map_err(|error| error.to_string()),
        Err(_) => {
            log::warn!("browser runtime shutdown timed out");
            Ok(())
        }
    }
}
