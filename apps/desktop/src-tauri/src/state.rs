//! Application state: the single source of truth for the workspace document
//! (port of the `AppStore` persistence responsibilities) plus the provider
//! runtime. Views receive snapshots and incremental runtime events.

use crate::engine::runtime::{ActiveTurnInfo, Runtime};
use crate::engine::TurnRequest;
use crate::events::{emit, EventSink};
use maxx_core::contract::*;
use maxx_core::persist::*;
use serde::Serialize;
use std::collections::HashMap;
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
    /// Voice interruption requests are deliberately transient.  Keeping the
    /// request beside final turn persistence gives cancellation and the
    /// provider event loop one ordering boundary without journaling any voice
    /// control data.
    pub(crate) voice_interruptions: Mutex<HashMap<Uuid, VoiceInterruption>>,
}

const MAX_VOICE_INTERRUPTION_RECORDS: usize = 64;
const MAX_VOICE_SPOKEN_TEXT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VoiceInterruption {
    pub project_id: Uuid,
    pub thread_id: Uuid,
    pub heard_text: String,
}

pub(crate) fn validate_voice_turn_ownership(
    active: &[ActiveTurnInfo],
    project_id: Uuid,
    thread_id: Uuid,
    turn_id: Uuid,
) -> Result<bool, String> {
    let Some(turn) = active.iter().find(|turn| turn.turn_id == turn_id) else {
        return Ok(false);
    };
    if turn.project_id != project_id || turn.thread_id != thread_id {
        return Err("The voice interruption does not belong to this thread.".into());
    }
    Ok(true)
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
pub fn chat_attachments_dir() -> PathBuf {
    workspace_path().with_file_name("chat-attachments")
}

/// Stable non-repository working directory for chats without a project.
pub fn chats_dir() -> PathBuf {
    workspace_path().with_file_name("chats")
}

impl AppState {
    pub fn from_document(
        document: WorkspaceDocument,
        persistence: WorkspacePersistence,
        browser: Arc<BrowserRuntime>,
        events: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            workspace: Mutex::new(document),
            persistence,
            runtime: Runtime::new(browser.clone()),
            browser: browser.clone(),
            terminals: TerminalBroker::new(browser),
            events,
            voice_interruptions: Mutex::new(HashMap::new()),
        }
    }

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
        Self::from_document(document, persistence, browser, events)
    }

    pub(crate) async fn begin_voice_interruption(
        &self,
        project_id: Uuid,
        thread_id: Uuid,
        turn_id: Uuid,
        heard_text: String,
    ) -> Result<bool, String> {
        // The registry lock is acquired before checking liveness.  The final
        // persistence path acquires it in the same order, so a request cannot
        // be inserted after a turn has been finalized.
        let mut interruptions = self.voice_interruptions.lock().await;
        let active = self.runtime.active_turns().await;
        if validate_voice_turn_ownership(&active, project_id, thread_id, turn_id)? {
            if !interruptions.contains_key(&turn_id)
                && interruptions.len() >= MAX_VOICE_INTERRUPTION_RECORDS
            {
                return Err("Too many voice interruptions are already pending.".into());
            }
            interruptions.insert(
                turn_id,
                VoiceInterruption {
                    project_id,
                    thread_id,
                    heard_text,
                },
            );
            return Ok(true);
        }
        Ok(false)
    }

    pub(crate) async fn voice_interruption(&self, turn_id: Uuid) -> Option<VoiceInterruption> {
        self.voice_interruptions.lock().await.get(&turn_id).cloned()
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
            let interrupted = self.voice_interruption(turn_id).await;
            if event.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA) && interrupted.is_some() {
                // The renderer has already told us this text was not heard.
                // It is excluded from both the canonical event stream and the
                // live renderer stream; the finalizer also filters events that
                // raced this check.
                continue;
            }
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
        // Hold the same registry lock used by begin_voice_interruption while
        // mutating the transcript and removing the live turn.  This is the
        // commit point that prevents cancellation from racing final
        // persistence.
        let mut interruptions = self.voice_interruptions.lock().await;
        let interruption = interruptions
            .get(&turn_id)
            .filter(|interruption| {
                interruption.project_id == project_id && interruption.thread_id == thread_id
            })
            .cloned();
        {
            let mut workspace = self.workspace.lock().await;
            if let Some(thread) = find_thread(&mut workspace, project_id, thread_id) {
                thread.runtime_events = maxx_core::order::ordered(&thread.runtime_events);
                if let Some(interruption) = &interruption {
                    apply_spoken_prefix_to_thread(thread, turn_id, &interruption.heard_text);
                    assistant_text = interruption.heard_text.clone();
                } else if !assistant_text.is_empty() {
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
        if interruption.is_some() {
            // Barge-in is a hard native-session boundary, not merely a
            // provider interrupt.  Release the adapter-owned session after
            // the live turn is removed so the next handoff cannot resume
            // unspoken provider state.
            let _ = self
                .runtime
                .release_thread(provider, provider_instance_id, thread_id)
                .await;
        }
        interruptions.remove(&turn_id);
        drop(interruptions);
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

/// Keep only the renderer-confirmed prefix of assistant deltas for one turn.
/// Deltas from every other turn, and every non-delta event, remain untouched.
pub(crate) fn retain_spoken_assistant_prefix(
    events: &mut Vec<ProviderRuntimeEvent>,
    turn_id: Uuid,
    spoken: &str,
) {
    let mut offset = 0usize;
    let mut retained = Vec::with_capacity(events.len());
    for mut event in events.drain(..) {
        if !event.turn_id.eq(&turn_id) || !event.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA) {
            retained.push(event);
            continue;
        }
        let Some(text) = event.payload.text.as_deref() else {
            continue;
        };
        let char_count = text.chars().count();
        let Some(end) = spoken[offset..]
            .char_indices()
            .nth(char_count)
            .map(|(index, _)| offset + index)
            .or_else(|| (offset < spoken.len()).then_some(spoken.len()))
        else {
            continue;
        };
        if end <= offset {
            continue;
        }
        event.payload.text = Some(spoken[offset..end].to_string());
        offset = end;
        retained.push(event);
    }
    *events = retained;
}

/// Apply a barge-in boundary to a persisted thread.  This is shared by the
/// active-turn finalizer and the late TTS barge-in path after the provider has
/// already reached a terminal state.
pub(crate) fn apply_spoken_prefix_to_thread(
    thread: &mut ChatThread,
    turn_id: Uuid,
    spoken: &str,
) -> bool {
    let delta_ids: std::collections::HashSet<Uuid> = thread
        .runtime_events
        .iter()
        .filter(|event| {
            event.turn_id == turn_id && event.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA)
        })
        .map(|event| event.id)
        .collect();
    let belongs_to_turn = thread.last_turn_id == Some(turn_id)
        || thread
            .runtime_events
            .iter()
            .any(|event| event.turn_id == turn_id)
        || thread.messages.iter().any(|message| {
            message
                .source_event_id
                .is_some_and(|id| delta_ids.contains(&id))
        });
    if !belongs_to_turn {
        return false;
    }

    retain_spoken_assistant_prefix(&mut thread.runtime_events, turn_id, spoken);
    let first_source = thread
        .runtime_events
        .iter()
        .find(|event| {
            event.turn_id == turn_id
                && event.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA)
                && event
                    .payload
                    .text
                    .as_deref()
                    .is_some_and(|text| !text.is_empty())
        })
        .map(|event| event.id);

    let mut changed_message = false;
    thread.messages.retain_mut(|message| {
        let is_turn_assistant = message.role == ChatRole::Assistant
            && message
                .source_event_id
                .is_some_and(|id| delta_ids.contains(&id));
        if !is_turn_assistant {
            return true;
        }
        changed_message = true;
        if spoken.is_empty() {
            false
        } else {
            message.content = spoken.to_string();
            message.source_event_id = first_source;
            true
        }
    });
    if !spoken.is_empty() && !changed_message {
        thread.messages.push(ChatMessage {
            id: Uuid::new_v4(),
            role: ChatRole::Assistant,
            content: spoken.to_string(),
            attachments: Vec::new(),
            annotations: Vec::new(),
            text_selections: Vec::new(),
            created_at: AppleDate::now(),
            source_event_id: first_source,
            agent_id: thread.agent_id,
        });
    }
    // A voice interruption ends the provider-native continuation boundary.
    // Do not let a later handoff resume text the user did not hear.
    if thread.last_turn_id == Some(turn_id) {
        thread.provider_session_id = None;
        thread.provider_resume_cursor = None;
    }
    thread.updated_at = AppleDate::now();
    true
}

pub(crate) fn sanitize_voice_spoken_text(input: &str) -> String {
    let mut result = String::new();
    for character in input.chars() {
        if character.is_control() && character != '\n' && character != '\t' {
            continue;
        }
        let next_len = result.len() + character.len_utf8();
        if next_len > MAX_VOICE_SPOKEN_TEXT_BYTES {
            break;
        }
        result.push(character);
    }
    result
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

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(thread_id: Uuid, turn_id: Uuid, sequence: i64, text: &str) -> ProviderRuntimeEvent {
        ProviderRuntimeEvent {
            schema_version: CURRENT_EVENT_SCHEMA_VERSION,
            id: Uuid::new_v4(),
            provider_instance_id: Uuid::new_v4(),
            thread_id,
            turn_id,
            item_id: None,
            request_id: None,
            sequence,
            occurred_at: AppleDate::default(),
            kind: RuntimeEventKind::assistant_text_delta(),
            payload: RuntimeEventPayload {
                text: Some(text.into()),
                ..RuntimeEventPayload::default()
            },
            native_reference: None,
        }
    }

    #[test]
    fn spoken_prefix_filter_keeps_unrelated_events_and_splits_partial_delta() {
        let thread_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let first = delta(thread_id, turn_id, 1, "Hello ");
        let second = delta(thread_id, turn_id, 2, "world");
        let unrelated = ProviderRuntimeEvent {
            turn_id: Uuid::new_v4(),
            kind: RuntimeEventKind::assistant_text_delta(),
            payload: RuntimeEventPayload {
                text: Some("other turn".into()),
                ..RuntimeEventPayload::default()
            },
            ..first.clone()
        };
        let unrelated_id = unrelated.id;
        let first_id = first.id;
        let second_id = second.id;
        let mut events = vec![first, second, unrelated];

        retain_spoken_assistant_prefix(&mut events, turn_id, "Hello w");

        assert_eq!(events.len(), 3);
        assert_eq!(events[0].id, first_id);
        assert_eq!(events[0].payload.text.as_deref(), Some("Hello "));
        assert_eq!(events[1].id, second_id);
        assert_eq!(events[1].payload.text.as_deref(), Some("w"));
        assert_eq!(events[2].id, unrelated_id);
        assert_eq!(events[2].payload.text.as_deref(), Some("other turn"));
    }

    #[test]
    fn empty_spoken_prefix_removes_only_the_interrupted_turn_deltas() {
        let thread_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let unrelated = delta(thread_id, Uuid::new_v4(), 4, "keep me");
        let mut events = vec![delta(thread_id, turn_id, 1, "not heard"), unrelated];

        retain_spoken_assistant_prefix(&mut events, turn_id, "");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload.text.as_deref(), Some("keep me"));
    }

    #[test]
    fn apply_spoken_prefix_clears_binding_and_is_idempotent() {
        let thread_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let mut thread = ChatThread::new("Voice".into(), ChatProvider::Codex, "default".into());
        thread.last_turn_id = Some(turn_id);
        thread.provider_session_id = Some("native-session".into());
        thread.provider_resume_cursor = Some("resume-cursor".into());
        thread.runtime_events = vec![delta(thread_id, turn_id, 1, "Hello world")];

        assert!(apply_spoken_prefix_to_thread(&mut thread, turn_id, "Hello"));
        assert_eq!(thread.provider_session_id, None);
        assert_eq!(thread.provider_resume_cursor, None);
        assert_eq!(
            thread.runtime_events[0].payload.text.as_deref(),
            Some("Hello")
        );
        assert_eq!(thread.messages.len(), 1);
        assert_eq!(thread.messages[0].content, "Hello");

        assert!(apply_spoken_prefix_to_thread(&mut thread, turn_id, "Hello"));
        assert_eq!(thread.messages.len(), 1);
        assert_eq!(thread.messages[0].content, "Hello");
        assert_eq!(thread.runtime_events.len(), 1);
    }

    #[test]
    fn empty_spoken_prefix_removes_existing_assistant_message() {
        let thread_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let event = delta(thread_id, turn_id, 1, "not heard");
        let event_id = event.id;
        let mut thread = ChatThread::new("Voice".into(), ChatProvider::Codex, "default".into());
        thread.last_turn_id = Some(turn_id);
        thread.runtime_events = vec![event];
        thread.messages.push(ChatMessage {
            id: Uuid::new_v4(),
            role: ChatRole::Assistant,
            content: "not heard".into(),
            attachments: Vec::new(),
            annotations: Vec::new(),
            text_selections: Vec::new(),
            created_at: AppleDate::default(),
            source_event_id: Some(event_id),
            agent_id: None,
        });

        assert!(apply_spoken_prefix_to_thread(&mut thread, turn_id, ""));
        assert!(thread.messages.is_empty());
        assert!(thread.runtime_events.is_empty());
    }

    #[test]
    fn spoken_text_is_sanitized_and_bounded_without_splitting_utf8() {
        assert_eq!(
            sanitize_voice_spoken_text("Hi\u{0}\nthere\t🙂"),
            "Hi\nthere\t🙂"
        );
        assert_eq!(sanitize_voice_spoken_text(""), "");
        let oversized = format!("{}🙂", "a".repeat(MAX_VOICE_SPOKEN_TEXT_BYTES));
        let sanitized = sanitize_voice_spoken_text(&oversized);
        assert_eq!(sanitized.len(), MAX_VOICE_SPOKEN_TEXT_BYTES);
        assert!(sanitized.is_char_boundary(sanitized.len()));
    }
}
