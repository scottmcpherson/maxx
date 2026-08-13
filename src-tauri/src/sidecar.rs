use crate::browser_runtime::{
    BrowserArtifactContent, BrowserOperation, BrowserRuntime, ElectronBrowserEngine,
};
use crate::events::EventSink;
use crate::host::SidecarHostBridge;
use crate::state::AppState;
use crate::voice::VoiceState;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use maxx_core::contract::{ChatProvider, RuntimeInteractionDecision};
use maxx_core::persist::{AgentDefinition, ProviderProfile, TitleGenerationRuntime};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use uuid::Uuid;

struct SidecarEvents {
    outbound: mpsc::UnboundedSender<Value>,
}

impl EventSink for SidecarEvents {
    fn emit_value(&self, event: &str, payload: Value) {
        let _ = self
            .outbound
            .send(json!({"type":"event","event":event,"payload":payload}));
    }
}

struct SidecarState {
    app: Arc<AppState>,
    browser: Arc<BrowserRuntime>,
    voice: Arc<VoiceState>,
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
    match method {
        "workspace_snapshot" => value(crate::commands::workspace_snapshot(state.app.clone()).await),
        "active_turns" => value(crate::commands::active_turns(state.app.clone()).await),
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
                required(&params, "imagePaths")?,
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
                required(&params, "imagePaths")?,
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
                required(&params, "imagePaths")?,
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
    let events: Arc<dyn EventSink> = Arc::new(SidecarEvents {
        outbound: outbound.clone(),
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
    });
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
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
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
                        let _ = browser.broker.human_input(tab_id).await;
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
    browser.shutdown().await.map_err(|error| error.to_string())
}
