//! Application state: the single source of truth for the workspace document
//! (port of the `AppStore` persistence responsibilities) plus the provider
//! runtime. Views receive snapshots and incremental runtime events.

use crate::engine::runtime::Runtime;
use crate::engine::TurnRequest;
use maxx_core::contract::*;
use maxx_core::persist::*;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::browser_runtime::BrowserRuntime;

pub struct AppState {
    pub workspace: Mutex<WorkspaceDocument>,
    pub persistence: WorkspacePersistence,
    pub runtime: Runtime,
    pub browser: Arc<BrowserRuntime>,
}

#[derive(Clone, Serialize)]
pub struct RuntimeEventEnvelope {
    #[serde(rename = "projectID")]
    pub project_id: Uuid,
    #[serde(rename = "threadID")]
    pub thread_id: Uuid,
    pub event: ProviderRuntimeEvent,
}

#[derive(Clone, Serialize)]
pub struct TurnFinishedEnvelope {
    #[serde(rename = "projectID")]
    pub project_id: Uuid,
    #[serde(rename = "threadID")]
    pub thread_id: Uuid,
    #[serde(rename = "turnID")]
    pub turn_id: Uuid,
    #[serde(rename = "terminalState")]
    pub terminal_state: Option<ProviderTurnTerminalState>,
}

pub fn workspace_path() -> PathBuf {
    // Shared with the Swift app during migration when present; otherwise the
    // Tauri app's own Application Support directory.
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    base.join("Maxx").join("workspace.json")
}

/// Store for imported agent avatar images, next to workspace.json. Served to
/// the webview through the asset protocol (scoped in tauri.conf.json).
pub fn agent_images_dir() -> PathBuf {
    workspace_path().with_file_name("agent-images")
}

/// Persistent copies of images attached to user chat messages.
pub fn chat_images_dir() -> PathBuf {
    workspace_path().with_file_name("chat-images")
}

impl AppState {
    pub fn load(browser: Arc<BrowserRuntime>) -> Self {
        let persistence = WorkspacePersistence::new(workspace_path());
        let mut document = match persistence.load() {
            Ok(result) => result.document,
            Err(error) => {
                log::warn!("workspace load failed, starting fresh: {error}");
                WorkspaceDocument::default()
            }
        };
        // On launch, a turn persisted without a terminal closes as interrupted.
        let recovered = close_interrupted_turns(&mut document.projects);
        if recovered > 0 {
            let _ = persistence.save(&document);
        }
        Self {
            workspace: Mutex::new(document),
            persistence,
            runtime: Runtime::new(browser.clone()),
            browser,
        }
    }

    pub async fn save(&self) {
        let document = self.workspace.lock().await.clone();
        if let Err(error) = self.persistence.save(&document) {
            log::error!("workspace save failed: {error}");
        }
    }

    /// Run one provider turn end to end: stream stamped events into the
    /// workspace, forward them to the frontend, and persist on terminal.
    /// Returns the turn's terminal state so a caller chaining turns (multi-agent
    /// mentions) can stop when a turn was cancelled or failed.
    pub async fn run_turn(
        self: Arc<Self>,
        app: tauri::AppHandle,
        project_id: Uuid,
        request: TurnRequest,
    ) -> Option<ProviderTurnTerminalState> {
        let thread_id = request.thread_id;
        let turn_id = request.turn_id;
        let provider = request.provider;
        let provider_instance_id = request.provider_instance_id;
        let agent_id = request.agent_id;
        let mut events = self.runtime.events_for(project_id, request).await;
        let mut assistant_text = String::new();
        let mut assistant_source_event: Option<Uuid> = None;
        let mut terminal_state: Option<ProviderTurnTerminalState> = None;

        while let Some(event) = events.recv().await {
            if event.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA) {
                if let Some(text) = &event.payload.text {
                    if assistant_source_event.is_none() {
                        assistant_source_event = Some(event.id);
                    }
                    assistant_text.push_str(text);
                }
            }
            if event.kind.is(RuntimeEventKind::TURN_TERMINAL) {
                terminal_state = event.payload.terminal_state;
            }
            if let Some(request_id) = event.request_id {
                self.runtime.register_route(request_id, provider).await;
            }

            {
                let mut workspace = self.workspace.lock().await;
                if let Some(thread) = find_thread(&mut workspace, project_id, thread_id) {
                    if event.kind.is(RuntimeEventKind::SESSION_BINDING) {
                        if let Some(binding) = &event.payload.session_binding {
                            thread.provider_session_id = Some(binding.clone());
                            self.browser.bind_provider_session(
                                provider_instance_id,
                                thread_id,
                                binding.clone(),
                            );
                        }
                    }
                    if let Some(cursor) = &event.payload.resume_cursor {
                        thread.provider_resume_cursor = Some(cursor.clone());
                    }
                    if let Some(record) = RuntimeInteractionRecord::from_event(&event) {
                        if !thread
                            .interaction_requests
                            .iter()
                            .any(|r| r.id == record.id)
                        {
                            thread.interaction_requests.push(record);
                        }
                    }
                    thread.runtime_events.push(event.clone());
                    thread.updated_at = AppleDate::now();
                }
            }
            let _ = app.emit(
                "runtime://event",
                RuntimeEventEnvelope {
                    project_id,
                    thread_id,
                    event,
                },
            );
        }

        let mut thread_title = String::new();
        {
            let mut workspace = self.workspace.lock().await;
            if let Some(thread) = find_thread(&mut workspace, project_id, thread_id) {
                thread.runtime_events = maxx_core::order::ordered(&thread.runtime_events);
                if !assistant_text.is_empty() {
                    thread.messages.push(ChatMessage {
                        id: Uuid::new_v4(),
                        role: ChatRole::Assistant,
                        content: assistant_text,
                        attachments: Vec::new(),
                        created_at: AppleDate::now(),
                        source_event_id: assistant_source_event,
                        agent_id,
                    });
                }
                thread.updated_at = AppleDate::now();
                thread_title = thread.title.clone();
            }
        }
        self.runtime.finish_turn(turn_id).await;
        self.save().await;
        let _ = app.emit(
            "turn://finished",
            TurnFinishedEnvelope {
                project_id,
                thread_id,
                turn_id,
                terminal_state,
            },
        );
        // Background-only: a user watching the thread already sees the result.
        crate::notify::turn_finished(&app, &thread_title, terminal_state);
        terminal_state
    }
}

pub fn find_thread<'a>(
    workspace: &'a mut WorkspaceDocument,
    project_id: Uuid,
    thread_id: Uuid,
) -> Option<&'a mut ChatThread> {
    workspace
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)?
        .threads
        .iter_mut()
        .find(|t| t.id == thread_id)
}
