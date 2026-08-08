use super::{
    BrowserArtifactContent, BrowserFrameSubscription, BrowserHumanInput, BrowserOperation,
    BrowserRuntime, BrowserTabId, BrowserTabSummary,
};
use crate::state::AppState;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[tauri::command]
pub async fn browser_ui_tabs(
    runtime: State<'_, Arc<BrowserRuntime>>,
    thread_id: Uuid,
) -> Result<Vec<BrowserTabSummary>, String> {
    let assigned = runtime.sessions.tabs_for_thread(thread_id);
    Ok(runtime
        .broker
        .tab_summaries()
        .await
        .into_iter()
        .filter(|tab| assigned.contains(&tab.id))
        .collect())
}

#[tauri::command]
pub async fn browser_ui_open_tab(
    runtime: State<'_, Arc<BrowserRuntime>>,
    thread_id: Uuid,
    url: Option<String>,
) -> Result<BrowserTabId, String> {
    runtime
        .human_open_tab(thread_id, url)
        .await
        .map_err(|error| error.to_string())?
        .tab_id
        .ok_or_else(|| "browser open did not return a tab id".to_string())
}

#[tauri::command]
pub async fn browser_ui_select_tab(
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
) -> Result<(), String> {
    runtime
        .human_execute(BrowserOperation::SelectTab { tab_id })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_ui_close_tab(
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
) -> Result<(), String> {
    runtime
        .human_execute(BrowserOperation::CloseTab { tab_id })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_ui_navigate(
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
    url: String,
) -> Result<(), String> {
    runtime
        .human_execute(BrowserOperation::Navigate { tab_id, url })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_ui_back(
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
) -> Result<(), String> {
    runtime
        .human_execute(BrowserOperation::GoBack { tab_id })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_ui_forward(
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
) -> Result<(), String> {
    runtime
        .human_execute(BrowserOperation::GoForward { tab_id })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_ui_reload(
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
) -> Result<(), String> {
    runtime
        .human_execute(BrowserOperation::Reload { tab_id })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_ui_resize(
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
    width: u32,
    height: u32,
) -> Result<(), String> {
    runtime
        .human_execute(BrowserOperation::Resize {
            tab_id,
            width: width.clamp(320, 3840),
            height: height.clamp(240, 2160),
        })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_ui_start_frame_stream(
    app: AppHandle,
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
) -> Result<BrowserFrameSubscription, String> {
    let mut stream = runtime
        .broker
        .start_frame_stream(tab_id)
        .await
        .map_err(|error| error.to_string())?;
    let stream_id = stream.id;
    let initial_frame =
        match tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let current = { stream.frames.borrow_and_update().clone() };
                if let Some(frame) = current {
                    return Ok(frame);
                }
                stream.frames.changed().await.map_err(|_| {
                    "browser frame stream closed before its first frame".to_string()
                })?;
            }
        })
        .await
        {
            Ok(Ok(frame)) => frame,
            Ok(Err(error)) => {
                runtime.broker.stop_frame_stream(tab_id, stream_id).await;
                return Err(error);
            }
            Err(_) => {
                runtime.broker.stop_frame_stream(tab_id, stream_id).await;
                return Err("browser frame stream timed out before its first frame".to_string());
            }
        };
    runtime.broker.observe_frame(&initial_frame).await;
    let broker = runtime.broker.clone();
    tauri::async_runtime::spawn(async move {
        while stream.frames.changed().await.is_ok() {
            let frame = stream.frames.borrow_and_update().clone();
            let Some(frame) = frame else {
                continue;
            };
            broker.observe_frame(&frame).await;
            if app.emit("browser://frame", frame).is_err() {
                break;
            }
        }
    });
    Ok(BrowserFrameSubscription {
        stream_id,
        initial_frame,
    })
}

#[tauri::command]
pub async fn browser_ui_stop_frame_stream(
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
    stream_id: Uuid,
) -> Result<(), String> {
    runtime.broker.stop_frame_stream(tab_id, stream_id).await;
    Ok(())
}

#[tauri::command]
pub async fn browser_ui_artifact(
    state: State<'_, Arc<AppState>>,
    runtime: State<'_, Arc<BrowserRuntime>>,
    thread_id: Uuid,
    artifact_id: Uuid,
) -> Result<BrowserArtifactContent, String> {
    let artifact = {
        let workspace = state.workspace.lock().await;
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
    let bytes = runtime
        .artifacts
        .read_persisted_image(artifact.id, &artifact.mime_type, artifact.byte_length)
        .map_err(|error| error.to_string())?;
    Ok(BrowserArtifactContent {
        id: artifact.id,
        mime_type: artifact.mime_type,
        title: artifact.title,
        data_base64: STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub async fn browser_ui_input(
    runtime: State<'_, Arc<BrowserRuntime>>,
    tab_id: BrowserTabId,
    input: BrowserHumanInput,
) -> Result<u64, String> {
    runtime
        .broker
        .dispatch_human_input(tab_id, input)
        .await
        .map_err(|error| error.to_string())
}
