//! Port of the draft → canonical event stamping loop inside
//! `ProviderRuntime.events(for:)`. The stamper is the only place drafts become
//! persisted `ProviderRuntimeEvent`s, and it enforces the terminal guarantee:
//! every started turn ends with exactly one `turn.terminal` event, a structured
//! error precedes a failed terminal, and drafts after the terminal are dropped.

use crate::contract::*;
use crate::normalize::ProviderEventDraft;
use std::collections::HashMap;
use uuid::Uuid;

pub struct TurnStamper {
    provider_instance_id: Uuid,
    thread_id: Uuid,
    turn_id: Uuid,
    sequence: i64,
    item_ids: HashMap<String, Uuid>,
    emitted_terminal_state: Option<ProviderTurnTerminalState>,
    emitted_structured_error: bool,
}

impl TurnStamper {
    pub fn new(provider_instance_id: Uuid, thread_id: Uuid, turn_id: Uuid) -> Self {
        Self {
            provider_instance_id,
            thread_id,
            turn_id,
            sequence: 0,
            item_ids: HashMap::new(),
            emitted_terminal_state: None,
            emitted_structured_error: false,
        }
    }

    pub fn is_terminated(&self) -> bool {
        self.emitted_terminal_state.is_some()
    }

    pub fn terminal_state(&self) -> Option<ProviderTurnTerminalState> {
        self.emitted_terminal_state
    }

    /// Stamp one adapter draft into zero or more canonical events.
    pub fn stamp(&mut self, draft: ProviderEventDraft) -> Vec<ProviderRuntimeEvent> {
        if self.is_terminated() {
            return Vec::new();
        }
        match draft {
            ProviderEventDraft::Status(status) => vec![self.emit(
                RuntimeEventKind::session_state(),
                None,
                None,
                RuntimeEventPayload {
                    detail: Some(status),
                    session_state: Some(ProviderSessionState::Running),
                    ..Default::default()
                },
                None,
            )],
            ProviderEventDraft::SessionUpdated(session_id) => vec![self.emit(
                RuntimeEventKind::session_binding(),
                None,
                None,
                RuntimeEventPayload {
                    session_binding: Some(session_id),
                    ..Default::default()
                },
                None,
            )],
            ProviderEventDraft::AssistantDelta(text) => vec![self.emit(
                RuntimeEventKind::assistant_text_delta(),
                None,
                None,
                RuntimeEventPayload {
                    text: Some(text),
                    ..Default::default()
                },
                None,
            )],
            ProviderEventDraft::Payload {
                kind,
                item_id,
                request_id,
                payload,
                native_reference,
            } => {
                if kind.is(RuntimeEventKind::ERROR) {
                    self.emitted_structured_error = true;
                }
                if kind.is(RuntimeEventKind::TURN_TERMINAL) {
                    return self.terminal(
                        payload
                            .terminal_state
                            .unwrap_or(ProviderTurnTerminalState::Completed),
                    );
                }
                let item_uuid = item_id
                    .map(|native_id| *self.item_ids.entry(native_id).or_insert_with(Uuid::new_v4));
                vec![self.emit(kind, item_uuid, request_id, payload, native_reference)]
            }
            ProviderEventDraft::Terminal(state) => self.terminal(state),
            ProviderEventDraft::Completed => self.terminal(ProviderTurnTerminalState::Completed),
        }
    }

    /// The adapter stream finished without a native terminal: close as completed.
    pub fn finish(&mut self) -> Vec<ProviderRuntimeEvent> {
        self.terminal(ProviderTurnTerminalState::Completed)
    }

    pub fn cancelled(&mut self) -> Vec<ProviderRuntimeEvent> {
        self.terminal(ProviderTurnTerminalState::Cancelled)
    }

    /// A thrown adapter error: structured error event, then a failed terminal.
    pub fn fail(&mut self, message: String) -> Vec<ProviderRuntimeEvent> {
        if self.is_terminated() {
            return Vec::new();
        }
        let mut events = vec![self.emit(
            RuntimeEventKind::error(),
            None,
            None,
            RuntimeEventPayload {
                error: Some(RuntimeStructuredError {
                    code: "provider.turn.failed".into(),
                    message,
                    detail: None,
                    is_recoverable: true,
                    suggested_action: Some("Check provider health and retry the turn.".into()),
                }),
                ..Default::default()
            },
            None,
        )];
        self.emitted_structured_error = true;
        events.extend(self.terminal(ProviderTurnTerminalState::Failed));
        events
    }

    fn terminal(&mut self, state: ProviderTurnTerminalState) -> Vec<ProviderRuntimeEvent> {
        if self.is_terminated() {
            return Vec::new();
        }
        let effective =
            if state == ProviderTurnTerminalState::Completed && self.emitted_structured_error {
                ProviderTurnTerminalState::Failed
            } else {
                state
            };
        self.emitted_terminal_state = Some(effective);
        vec![self.emit_raw(
            RuntimeEventKind::turn_terminal(),
            None,
            None,
            RuntimeEventPayload {
                terminal_state: Some(effective),
                ..Default::default()
            },
            None,
        )]
    }

    fn emit(
        &mut self,
        kind: RuntimeEventKind,
        item_id: Option<Uuid>,
        request_id: Option<Uuid>,
        payload: RuntimeEventPayload,
        native_reference: Option<ProviderNativeReference>,
    ) -> ProviderRuntimeEvent {
        self.emit_raw(kind, item_id, request_id, payload, native_reference)
    }

    fn emit_raw(
        &mut self,
        kind: RuntimeEventKind,
        item_id: Option<Uuid>,
        request_id: Option<Uuid>,
        payload: RuntimeEventPayload,
        native_reference: Option<ProviderNativeReference>,
    ) -> ProviderRuntimeEvent {
        self.sequence += 1;
        ProviderRuntimeEvent {
            schema_version: CURRENT_EVENT_SCHEMA_VERSION,
            id: Uuid::new_v4(),
            provider_instance_id: self.provider_instance_id,
            thread_id: self.thread_id,
            turn_id: self.turn_id,
            item_id,
            request_id,
            sequence: self.sequence,
            occurred_at: AppleDate::now(),
            kind,
            payload,
            native_reference,
        }
    }
}
