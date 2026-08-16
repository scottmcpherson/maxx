//! Application state: the single source of truth for the workspace document
//! (port of the `AppStore` persistence responsibilities) plus the provider
//! runtime. Views receive snapshots and incremental runtime events.

use crate::engine::runtime::Runtime;
use crate::engine::TurnRequest;
use crate::events::{emit, EventSink};
use maxx_core::contract::*;
use maxx_core::persist::*;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::browser_runtime::BrowserRuntime;
use crate::terminal::TerminalBroker;

pub struct AppState {
    pub workspace: Mutex<WorkspaceDocument>,
    pub persistence: WorkspacePersistence,
    pub runtime: Runtime,
    pub browser: Arc<BrowserRuntime>,
    pub terminals: TerminalBroker,
    pub events: Arc<dyn EventSink>,
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

#[derive(Debug, Clone)]
pub struct TurnExecutionOutcome {
    pub terminal_state: Option<ProviderTurnTerminalState>,
    pub assistant_text: String,
    pub needs_attention: Option<String>,
}

pub fn workspace_path() -> PathBuf {
    if let Some(directory) = std::env::var_os("MAXX_DATA_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(directory).join("workspace.json");
    }
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    base.join("Maxx").join("workspace.json")
}

/// Store for imported agent avatar images, next to workspace.json. The
/// Electron media protocol serves only this directory and explicitly resolved
/// message files.
pub fn agent_images_dir() -> PathBuf {
    workspace_path().with_file_name("agent-images")
}

/// Persistent copies of images attached to user chat messages.
pub fn chat_images_dir() -> PathBuf {
    workspace_path().with_file_name("chat-images")
}

/// Stable non-repository working directory for chats without a project.
pub fn chats_dir() -> PathBuf {
    workspace_path().with_file_name("chats")
}

impl AppState {
    pub fn load(browser: Arc<BrowserRuntime>, events: Arc<dyn EventSink>) -> Self {
        let persistence = WorkspacePersistence::new(workspace_path());
        let mut document = match persistence.load() {
            Ok(result) => result.document,
            Err(error) => {
                log::warn!("workspace load failed, starting fresh: {error}");
                WorkspaceDocument::default()
            }
        };
        let duplicate_projects = crate::host_session::deduplicate_project_folders(&mut document);
        // On launch, a turn persisted without a terminal closes as interrupted.
        let recovered = close_interrupted_turns(&mut document.projects);
        if duplicate_projects > 0 || recovered > 0 {
            let _ = persistence.save(&document);
        }
        Self {
            workspace: Mutex::new(document),
            persistence,
            runtime: Runtime::new(browser.clone()),
            browser: browser.clone(),
            terminals: TerminalBroker::new(browser),
            events,
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
        project_id: Uuid,
        request: TurnRequest,
    ) -> Option<ProviderTurnTerminalState> {
        self.run_turn_with_policy(project_id, request, false)
            .await
            .terminal_state
    }

    /// Execute a background turn without granting implicit approval or
    /// inventing user input. The first interactive request is persisted and
    /// emitted normally, then the provider is cancelled and the caller gets a
    /// durable `needs_attention` reason.
    pub async fn run_unattended_turn(
        self: Arc<Self>,
        project_id: Uuid,
        request: TurnRequest,
    ) -> TurnExecutionOutcome {
        self.run_turn_with_policy(project_id, request, true).await
    }

    async fn run_turn_with_policy(
        self: Arc<Self>,
        project_id: Uuid,
        request: TurnRequest,
        unattended: bool,
    ) -> TurnExecutionOutcome {
        let thread_id = request.thread_id;
        let turn_id = request.turn_id;
        let provider = request.provider;
        let provider_instance_id = request.provider_instance_id;
        let agent_id = request.agent_id;
        let mut events = self.runtime.events_for(project_id, request).await;
        let mut assistant_text = String::new();
        let mut assistant_source_event: Option<Uuid> = None;
        let mut terminal_state: Option<ProviderTurnTerminalState> = None;
        let mut needs_attention: Option<String> = None;

        loop {
            let next = if needs_attention.is_some() {
                tokio::time::timeout(std::time::Duration::from_secs(10), events.recv())
                    .await
                    .ok()
                    .flatten()
            } else {
                events.recv().await
            };
            let Some(event) = next else { break };
            let interaction_requested = unattended
                && needs_attention.is_none()
                && (event.kind.is(RuntimeEventKind::APPROVAL_REQUEST)
                    || event.kind.is(RuntimeEventKind::USER_INPUT_REQUEST));
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
            emit(
                self.events.as_ref(),
                "runtime://event",
                &RuntimeEventEnvelope {
                    project_id,
                    thread_id,
                    event,
                },
            );
            if interaction_requested {
                needs_attention = Some(
                    "The scheduled agent requested approval or user input. Open its automation chat to continue safely."
                        .into(),
                );
                self.runtime.cancel(turn_id).await;
            }
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
                        content: assistant_text.clone(),
                        attachments: Vec::new(),
                        annotations: Vec::new(),
                        text_selections: Vec::new(),
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
        emit(
            self.events.as_ref(),
            "turn://finished",
            &TurnFinishedEnvelope {
                project_id,
                thread_id,
                turn_id,
                terminal_state,
            },
        );
        emit(
            self.events.as_ref(),
            "notification://turn-finished",
            &serde_json::json!({"title": thread_title, "terminalState": terminal_state}),
        );
        TurnExecutionOutcome {
            terminal_state,
            assistant_text,
            needs_attention,
        }
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
