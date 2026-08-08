//! Port of `ProviderNativeEventNormalizer.swift`: one native protocol message
//! (a JSON line) in, zero or more internal event drafts out. Provider-specific
//! branching lives here and nowhere else in the core.

use crate::contract::*;
use crate::error::CoreError;
use crate::ids::stable_uuid;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

type Object = Map<String, Value>;

/// Internal draft events emitted by adapters before canonical stamping.
/// Port of `ProviderEventDraft`.
#[derive(Debug, Clone, PartialEq)]
pub enum ProviderEventDraft {
    Status(String),
    SessionUpdated(String),
    AssistantDelta(String),
    Payload {
        kind: RuntimeEventKind,
        item_id: Option<String>,
        request_id: Option<Uuid>,
        payload: RuntimeEventPayload,
        native_reference: Option<ProviderNativeReference>,
    },
    Terminal(ProviderTurnTerminalState),
    Completed,
}

/// Port of `ProviderNativeNormalizerState`.
#[derive(Debug, Clone, Default)]
pub struct NormalizerState {
    pub session_id: Option<String>,
    pub request_ids: HashMap<String, Uuid>,
    pub tool_names: HashMap<String, String>,
    pub tool_ids_by_index: HashMap<String, String>,
    pub message_roles: HashMap<String, String>,
    pub part_types: HashMap<String, String>,
    pub streamed_assistant_item_ids: HashSet<String>,
    pub streamed_reasoning_item_ids: HashSet<String>,
    pub pending_terminal_state: Option<ProviderTurnTerminalState>,
    /// Context window of the session's active model, captured from ACP
    /// `session/new` / `session/load` responses (`models.availableModels[].
    /// _meta.totalContextTokens`). Stamped onto prompt-response usage events.
    pub context_window: Option<i64>,
}

impl NormalizerState {
    pub fn with_session(session_id: impl Into<String>) -> Self {
        Self {
            session_id: Some(session_id.into()),
            ..Default::default()
        }
    }

    pub fn request_id(&mut self, native_id: &str) -> Uuid {
        if let Some(existing) = self.request_ids.get(native_id) {
            return *existing;
        }
        let id = stable_uuid("provider.native.request", native_id);
        self.request_ids.insert(native_id.to_string(), id);
        id
    }
}

pub fn normalize(
    line: &[u8],
    provider: ChatProvider,
    state: &mut NormalizerState,
) -> Result<Vec<ProviderEventDraft>, CoreError> {
    if line.is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_slice(line).map_err(|e| CoreError::Malformed {
        provider,
        detail: e.to_string(),
    })?;
    let object = value.as_object().ok_or_else(|| CoreError::Malformed {
        provider,
        detail: "Expected a JSON object.".into(),
    })?;

    if object.contains_key("fixture") {
        return Ok(Vec::new());
    }
    match provider {
        ChatProvider::Codex => normalize_codex(object, state),
        ChatProvider::Claude => normalize_claude(object, state),
        ChatProvider::Grok | ChatProvider::Cursor | ChatProvider::Hermes => {
            normalize_acp(object, provider, state)
        }
        ChatProvider::Opencode => normalize_opencode(object, state),
        ChatProvider::Pi => normalize_pi(object, state),
    }
}

fn normalize_codex(
    object: &Object,
    state: &mut NormalizerState,
) -> Result<Vec<ProviderEventDraft>, CoreError> {
    if let Some(error) = object.get("error").and_then(Value::as_object) {
        return Err(CoreError::CommandFailed(
            s(error, &["message"]).unwrap_or_else(|| "Codex app-server error".into()),
        ));
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Ok(unknown(object, "codex-app-server", None));
    };
    let empty = Object::new();
    let params = object
        .get("params")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let reference = ProviderNativeReference {
        protocol_name: "codex-app-server".into(),
        session_id: s(params, &["threadId"]),
        turn_id: s(params, &["turnId"]),
        item_id: s(params, &["itemId"]),
        request_id: native_request_id(object),
        event_type: Some(method.to_string()),
        ..Default::default()
    };

    match method {
        "thread/started" => {
            let Some(id) = params
                .get("thread")
                .and_then(Value::as_object)
                .and_then(|t| t.get("id"))
                .and_then(Value::as_str)
            else {
                return Ok(Vec::new());
            };
            state.session_id = Some(id.to_string());
            Ok(vec![
                ProviderEventDraft::SessionUpdated(id.to_string()),
                ProviderEventDraft::Status("Codex session ready".into()),
            ])
        }
        "turn/started" => Ok(vec![ProviderEventDraft::Status("Codex is working…".into())]),
        "item/agentMessage/delta" => {
            let Some(delta) = s(params, &["delta", "text"]).filter(|d| !d.is_empty()) else {
                return Ok(Vec::new());
            };
            if let Some(item_id) = s(params, &["itemId", "item_id"]) {
                state.streamed_assistant_item_ids.insert(item_id);
            }
            Ok(vec![ProviderEventDraft::AssistantDelta(delta)])
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            let Some(delta) = s(params, &["delta", "text"]).filter(|d| !d.is_empty()) else {
                return Ok(Vec::new());
            };
            Ok(vec![payload_draft(
                RuntimeEventKind::reasoning_summary(),
                s(params, &["itemId"]),
                None,
                RuntimeEventPayload {
                    text: Some(delta),
                    state: Some(RuntimeItemState::Running),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "item/plan/delta" => Ok(vec![payload_draft(
            RuntimeEventKind::plan(),
            s(params, &["itemId"]),
            None,
            RuntimeEventPayload {
                text: s(params, &["delta"]),
                state: Some(RuntimeItemState::Running),
                ..Default::default()
            },
            Some(reference),
        )]),
        "item/commandExecution/outputDelta" => Ok(vec![payload_draft(
            RuntimeEventKind::command(),
            s(params, &["itemId"]),
            None,
            RuntimeEventPayload {
                state: Some(RuntimeItemState::Running),
                output: s(params, &["delta"]),
                ..Default::default()
            },
            Some(reference),
        )]),
        "item/fileChange/outputDelta" => Ok(vec![payload_draft(
            RuntimeEventKind::file_change(),
            s(params, &["itemId"]),
            None,
            RuntimeEventPayload {
                state: Some(RuntimeItemState::Running),
                output: s(params, &["delta"]),
                ..Default::default()
            },
            Some(reference),
        )]),
        "item/fileChange/patchUpdated" => Ok(vec![payload_draft(
            RuntimeEventKind::file_change(),
            s(params, &["itemId"]),
            None,
            RuntimeEventPayload {
                state: Some(RuntimeItemState::Running),
                files: file_changes(params.get("changes")),
                ..Default::default()
            },
            Some(reference),
        )]),
        "item/mcpToolCall/progress" => {
            let message = s(params, &["message"]);
            Ok(vec![payload_draft(
                RuntimeEventKind::tool(),
                s(params, &["itemId"]),
                None,
                RuntimeEventPayload {
                    title: Some("MCP tool".into()),
                    detail: message.clone(),
                    state: Some(RuntimeItemState::Running),
                    tool: Some(RuntimeToolCall {
                        name: "MCP tool".into(),
                        input: None,
                        output: message,
                        state: RuntimeItemState::Running,
                    }),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "item/started" | "item/completed" => {
            let Some(item) = params.get("item").and_then(Value::as_object) else {
                return Ok(Vec::new());
            };
            let Some(item_type) = item.get("type").and_then(Value::as_str) else {
                return Ok(Vec::new());
            };
            let native_item_id = s(item, &["id"]);
            let item_state = if method == "item/started" {
                RuntimeItemState::Running
            } else {
                item_completion_state(item)
            };
            match item_type {
                "agentMessage" | "agent_message" => {
                    if method != "item/completed" {
                        return Ok(Vec::new());
                    }
                    let Some(text) = s(item, &["text"]).filter(|t| !t.is_empty()) else {
                        return Ok(Vec::new());
                    };
                    if let Some(id) = &native_item_id {
                        if state.streamed_assistant_item_ids.remove(id) {
                            // app-server repeats the complete message after
                            // streaming its deltas; the canonical timeline
                            // already contains the text.
                            return Ok(Vec::new());
                        }
                    }
                    Ok(vec![ProviderEventDraft::AssistantDelta(text)])
                }
                // Acknowledgement of the user message, not new UI.
                "userMessage" | "user_message" | "hookPrompt" | "hook_prompt" => Ok(Vec::new()),
                "commandExecution" | "command_execution" => Ok(vec![payload_draft(
                    RuntimeEventKind::command(),
                    native_item_id,
                    None,
                    RuntimeEventPayload {
                        title: Some(s(item, &["command"]).unwrap_or_else(|| "Command".into())),
                        state: Some(item_state),
                        command: s(item, &["command"]),
                        working_directory: s(item, &["cwd"]),
                        output: s(item, &["aggregatedOutput", "aggregated_output"]),
                        exit_code: i(item, &["exitCode", "exit_code"]),
                        ..Default::default()
                    },
                    Some(reference),
                )]),
                "fileChange" | "file_change" => Ok(vec![payload_draft(
                    RuntimeEventKind::file_change(),
                    native_item_id,
                    None,
                    RuntimeEventPayload {
                        title: Some("File changes".into()),
                        state: Some(item_state),
                        files: file_changes(item.get("changes")),
                        ..Default::default()
                    },
                    Some(reference),
                )]),
                "mcpToolCall" | "dynamicToolCall" | "mcp_tool_call" | "dynamic_tool_call" => {
                    let name = s(item, &["tool", "name"]).unwrap_or_else(|| "Tool call".into());
                    let result = item.get("result");
                    Ok(vec![payload_draft(
                        RuntimeEventKind::tool(),
                        native_item_id,
                        None,
                        RuntimeEventPayload {
                            title: Some(name.clone()),
                            state: Some(item_state),
                            tool: Some(RuntimeToolCall {
                                name,
                                input: json_string(
                                    item.get("arguments").or_else(|| item.get("input")),
                                ),
                                output: tool_result_output(result),
                                state: item_state,
                            }),
                            artifacts: tool_result_artifacts(result),
                            ..Default::default()
                        },
                        Some(reference),
                    )])
                }
                "plan" => Ok(vec![payload_draft(
                    RuntimeEventKind::plan(),
                    native_item_id,
                    None,
                    RuntimeEventPayload {
                        state: Some(item_state),
                        plan: plan_steps(item.get("steps")),
                        ..Default::default()
                    },
                    Some(reference),
                )]),
                other => Ok(unknown(object, "codex-app-server", Some(other))),
            }
        }
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let native_id = native_request_id(object).unwrap_or_else(|| Uuid::new_v4().to_string());
            let request_id = state.request_id(&native_id);
            let kind = if method.contains("fileChange") {
                RuntimeApprovalKind::FileChange
            } else {
                RuntimeApprovalKind::Command
            };
            Ok(vec![payload_draft(
                RuntimeEventKind::approval_request(),
                s(params, &["itemId"]),
                Some(request_id),
                RuntimeEventPayload {
                    state: Some(RuntimeItemState::Waiting),
                    approval: Some(RuntimeApprovalRequest {
                        kind,
                        title: s(params, &["reason"]).unwrap_or_else(|| {
                            if kind == RuntimeApprovalKind::Command {
                                "Run command".into()
                            } else {
                                "Apply file changes".into()
                            }
                        }),
                        detail: None,
                        command: s(params, &["command"]),
                        paths: Vec::new(),
                        options: standard_approval_options(),
                        expires_at: None,
                    }),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "item/tool/requestUserInput" | "item/tool/request_user_input" => {
            let native_id = native_request_id(object).unwrap_or_else(|| Uuid::new_v4().to_string());
            let request_id = state.request_id(&native_id);
            Ok(vec![payload_draft(
                RuntimeEventKind::user_input_request(),
                s(params, &["itemId", "item_id"]),
                Some(request_id),
                RuntimeEventPayload {
                    state: Some(RuntimeItemState::Waiting),
                    user_input: Some(user_input(params)),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "mcpServer/elicitation/request" => {
            let native_id = native_request_id(object).unwrap_or_else(|| Uuid::new_v4().to_string());
            let request_id = state.request_id(&native_id);
            if let Some(user_input) = mcp_elicitation_input(params) {
                return Ok(vec![payload_draft(
                    RuntimeEventKind::user_input_request(),
                    None,
                    Some(request_id),
                    RuntimeEventPayload {
                        state: Some(RuntimeItemState::Waiting),
                        user_input: Some(user_input),
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }

            let server = s(params, &["serverName"]).unwrap_or_else(|| "MCP server".into());
            let detail = s(params, &["url"])
                .map(|url| format!("{server}\n{url}"))
                .or_else(|| Some(server));
            Ok(vec![payload_draft(
                RuntimeEventKind::approval_request(),
                None,
                Some(request_id),
                RuntimeEventPayload {
                    state: Some(RuntimeItemState::Waiting),
                    approval: Some(RuntimeApprovalRequest {
                        kind: RuntimeApprovalKind::Tool,
                        title: s(params, &["message"])
                            .unwrap_or_else(|| "MCP server request".into()),
                        detail,
                        command: None,
                        paths: Vec::new(),
                        options: standard_approval_options()
                            .into_iter()
                            .filter(|option| !option.is_persistent)
                            .collect(),
                        expires_at: None,
                    }),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "thread/tokenUsage/updated" => Ok(vec![payload_draft(
            RuntimeEventKind::usage(),
            None,
            None,
            RuntimeEventPayload {
                usage: Some(usage(params)),
                ..Default::default()
            },
            Some(reference),
        )]),
        "turn/plan/updated" => Ok(vec![payload_draft(
            RuntimeEventKind::plan(),
            None,
            None,
            RuntimeEventPayload {
                detail: s(params, &["explanation"]),
                state: Some(RuntimeItemState::Running),
                plan: plan_steps(params.get("plan")),
                ..Default::default()
            },
            Some(reference),
        )]),
        "turn/diff/updated" => Ok(vec![payload_draft(
            RuntimeEventKind::diff(),
            None,
            None,
            RuntimeEventPayload {
                diff: s(params, &["diff"]),
                ..Default::default()
            },
            Some(reference),
        )]),
        // Aggregate reasoning / goal lifecycle notifications duplicate the
        // canonical item deltas Maxx already renders.
        "reasoning" | "thread/goal/cleared" => Ok(Vec::new()),
        "thread/status/changed" => {
            let empty = Object::new();
            let status = params
                .get("status")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            if s(status, &["type"]).as_deref() != Some("systemError") {
                return Ok(Vec::new());
            }
            Ok(vec![payload_draft(
                RuntimeEventKind::error(),
                None,
                None,
                RuntimeEventPayload {
                    error: Some(RuntimeStructuredError {
                        code: "codex.app-server.thread-status".into(),
                        message: "Codex reported a system error for this thread.".into(),
                        detail: None,
                        is_recoverable: true,
                        suggested_action: Some("Retry the turn or start a new thread.".into()),
                    }),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "mcpServer/startupStatus/updated" => {
            if s(params, &["status"]).as_deref() != Some("failed") {
                return Ok(Vec::new());
            }
            let name = s(params, &["name"]).unwrap_or_else(|| "MCP server".into());
            Ok(vec![payload_draft(
                RuntimeEventKind::warning(),
                None,
                None,
                RuntimeEventPayload {
                    title: Some(format!("{name} failed to start")),
                    detail: s(params, &["error", "failureReason"]),
                    raw_type: Some(method.to_string()),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "hook/started" => Ok(Vec::new()),
        "hook/completed" => {
            let empty = Object::new();
            let run = params
                .get("run")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let status = s(run, &["status"]);
            if !matches!(
                status.as_deref(),
                Some("failed") | Some("blocked") | Some("stopped")
            ) {
                return Ok(Vec::new());
            }
            let entries = run.get("entries").and_then(Value::as_array).map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_object)
                    .filter_map(|e| s(e, &["text"]))
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            let detail = match entries {
                Some(text) if !text.is_empty() => Some(text),
                _ => s(run, &["statusMessage"]),
            };
            Ok(vec![payload_draft(
                RuntimeEventKind::warning(),
                None,
                None,
                RuntimeEventPayload {
                    title: Some(format!(
                        "Codex hook {}",
                        status.as_deref().unwrap_or("failed")
                    )),
                    detail,
                    raw_type: Some(method.to_string()),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "warning" => Ok(vec![payload_draft(
            RuntimeEventKind::warning(),
            None,
            None,
            RuntimeEventPayload {
                title: Some("Codex warning".into()),
                detail: s(params, &["message", "summary"]),
                ..Default::default()
            },
            Some(reference),
        )]),
        "error" => {
            let empty = Object::new();
            let error = params
                .get("error")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let message = s(error, &["message"])
                .or_else(|| s(params, &["message"]))
                .unwrap_or_else(|| "Codex reported an error.".into());
            let will_retry = params
                .get("willRetry")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(vec![payload_draft(
                RuntimeEventKind::error(),
                None,
                None,
                RuntimeEventPayload {
                    error: Some(RuntimeStructuredError {
                        code: "codex.app-server.error".into(),
                        message,
                        detail: json_string(error.get("codexErrorInfo")),
                        is_recoverable: will_retry,
                        suggested_action: Some(if will_retry {
                            "Codex is retrying the turn.".into()
                        } else {
                            "Review the error and retry the turn.".into()
                        }),
                    }),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "turn/completed" => {
            let status = params
                .get("turn")
                .and_then(Value::as_object)
                .map(|turn| s(turn, &["status"]))
                .unwrap_or_else(|| s(params, &["status"]));
            Ok(vec![terminal_draft(status.as_deref())])
        }
        other => Ok(unknown(object, "codex-app-server", Some(other))),
    }
}

fn normalize_claude(
    object: &Object,
    state: &mut NormalizerState,
) -> Result<Vec<ProviderEventDraft>, CoreError> {
    let Some(message_type) = object.get("type").and_then(Value::as_str) else {
        return Ok(unknown(object, "claude-stream-json", None));
    };
    let mut events: Vec<ProviderEventDraft> = Vec::new();
    if let Some(session_id) = object.get("session_id").and_then(Value::as_str) {
        if state.session_id.as_deref() != Some(session_id) {
            state.session_id = Some(session_id.to_string());
            events.push(ProviderEventDraft::SessionUpdated(session_id.to_string()));
        }
    }
    let reference = ProviderNativeReference {
        protocol_name: "claude-stream-json".into(),
        session_id: state.session_id.clone(),
        request_id: s(object, &["request_id"]),
        event_type: Some(message_type.to_string()),
        ..Default::default()
    };

    match message_type {
        "system" => {
            if let Some(exit_code) = i(object, &["exit_code"]).filter(|&c| c != 0) {
                let _ = exit_code;
                events.push(payload_draft(
                    RuntimeEventKind::warning(),
                    None,
                    None,
                    RuntimeEventPayload {
                        title: Some("Claude hook warning".into()),
                        detail: s(object, &["stderr", "stdout", "message"]),
                        raw_type: Some(s(object, &["subtype"]).unwrap_or_else(|| "system".into())),
                        ..Default::default()
                    },
                    Some(reference),
                ));
            } else {
                events.push(ProviderEventDraft::Status("Claude session ready".into()));
            }
        }
        "stream_event" => {
            let Some(stream_event) = object.get("event").and_then(Value::as_object) else {
                return Ok(events);
            };
            let Some(event_type) = stream_event.get("type").and_then(Value::as_str) else {
                return Ok(events);
            };
            let index = i(stream_event, &["index"]).map(|v| v.to_string());
            if event_type == "content_block_delta" {
                if let Some(delta) = stream_event.get("delta").and_then(Value::as_object) {
                    let delta_type = delta.get("type").and_then(Value::as_str);
                    if delta_type == Some("text_delta") {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            events.push(ProviderEventDraft::AssistantDelta(text.to_string()));
                        }
                    } else if delta_type == Some("thinking_delta") {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            events.push(payload_draft(
                                RuntimeEventKind::reasoning_summary(),
                                index.clone(),
                                None,
                                RuntimeEventPayload {
                                    text: Some(text.to_string()),
                                    state: Some(RuntimeItemState::Running),
                                    ..Default::default()
                                },
                                Some(reference),
                            ));
                        }
                    }
                }
            } else if event_type == "content_block_start" {
                let block = stream_event.get("content_block").and_then(Value::as_object);
                if let Some(block) = block {
                    if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                        let native_item_id = s(block, &["id"]).or_else(|| index.clone());
                        let name = s(block, &["name"]).unwrap_or_else(|| "Tool".into());
                        if let Some(item_id) = &native_item_id {
                            state.tool_names.insert(item_id.clone(), name.clone());
                        }
                        if let Some(index) = &index {
                            state.tool_names.insert(index.clone(), name.clone());
                            if let Some(item_id) = &native_item_id {
                                state
                                    .tool_ids_by_index
                                    .insert(index.clone(), item_id.clone());
                            }
                        }
                        events.push(payload_draft(
                            RuntimeEventKind::tool(),
                            native_item_id.clone(),
                            None,
                            RuntimeEventPayload {
                                title: Some(name.clone()),
                                state: Some(RuntimeItemState::Running),
                                tool: Some(RuntimeToolCall {
                                    name: name.clone(),
                                    input: json_string(block.get("input")),
                                    output: None,
                                    state: RuntimeItemState::Running,
                                }),
                                ..Default::default()
                            },
                            Some(reference.clone()),
                        ));
                        let lowered = name.to_lowercase();
                        if [
                            "todowrite",
                            "todo_write",
                            "task",
                            "taskcreate",
                            "taskupdate",
                        ]
                        .contains(&lowered.as_str())
                        {
                            if let Some(input) = block.get("input").and_then(Value::as_object) {
                                if let Some(raw_plan) =
                                    input.get("todos").or_else(|| input.get("tasks"))
                                {
                                    events.push(payload_draft(
                                        RuntimeEventKind::plan(),
                                        native_item_id,
                                        None,
                                        RuntimeEventPayload {
                                            state: Some(RuntimeItemState::Running),
                                            plan: plan_steps(Some(raw_plan)),
                                            ..Default::default()
                                        },
                                        Some(reference),
                                    ));
                                }
                            }
                        }
                    }
                }
            } else if event_type == "content_block_stop" {
                if let Some(index) = &index {
                    if let Some(native_item_id) = state.tool_ids_by_index.remove(index) {
                        let name = state
                            .tool_names
                            .remove(index)
                            .unwrap_or_else(|| "Tool".into());
                        state.tool_names.remove(&native_item_id);
                        events.push(payload_draft(
                            RuntimeEventKind::tool(),
                            Some(native_item_id),
                            None,
                            RuntimeEventPayload {
                                title: Some(name.clone()),
                                state: Some(RuntimeItemState::Completed),
                                tool: Some(RuntimeToolCall {
                                    name,
                                    input: None,
                                    output: None,
                                    state: RuntimeItemState::Completed,
                                }),
                                ..Default::default()
                            },
                            Some(reference),
                        ));
                    }
                }
            } else if event_type == "message_delta" {
                if let Some(usage_object) = stream_event.get("usage").and_then(Value::as_object) {
                    events.push(payload_draft(
                        RuntimeEventKind::usage(),
                        None,
                        None,
                        RuntimeEventPayload {
                            usage: Some(usage(usage_object)),
                            ..Default::default()
                        },
                        Some(reference),
                    ));
                }
            }
        }
        "assistant" => {
            if let Some(usage_object) = object
                .get("message")
                .and_then(Value::as_object)
                .and_then(|m| m.get("usage"))
                .and_then(Value::as_object)
            {
                // Per-message usage measures one API request, so it can carry
                // context occupancy; the turn-cumulative `result` usage cannot.
                let mut value = usage(usage_object);
                per_request_context(
                    &mut value,
                    i(usage_object, &["cache_creation_input_tokens"]),
                );
                events.push(payload_draft(
                    RuntimeEventKind::usage(),
                    None,
                    None,
                    RuntimeEventPayload {
                        usage: Some(value),
                        ..Default::default()
                    },
                    Some(reference),
                ));
            }
        }
        "control_request" => {
            let Some(request) = object.get("request").and_then(Value::as_object) else {
                return Ok(events);
            };
            let native_id =
                s(object, &["request_id"]).unwrap_or_else(|| Uuid::new_v4().to_string());
            let request_id = state.request_id(&native_id);
            let subtype = s(request, &["subtype"]).unwrap_or_else(|| "unknown".into());
            if subtype == "can_use_tool" {
                let tool = s(request, &["tool_name"]).unwrap_or_else(|| "Tool".into());
                if tool == "AskUserQuestion" {
                    if let Some(input) = request.get("input").and_then(Value::as_object) {
                        events.push(payload_draft(
                            RuntimeEventKind::user_input_request(),
                            s(request, &["tool_use_id"]),
                            Some(request_id),
                            RuntimeEventPayload {
                                state: Some(RuntimeItemState::Waiting),
                                user_input: Some(user_input(input)),
                                ..Default::default()
                            },
                            Some(reference),
                        ));
                    }
                } else {
                    let supports_persistent_policy = request
                        .get("permission_suggestions")
                        .and_then(Value::as_array)
                        .map(|a| !a.is_empty())
                        .unwrap_or(false);
                    let options: Vec<RuntimeDecisionOption> = standard_approval_options()
                        .into_iter()
                        .filter(|o| !o.is_persistent || supports_persistent_policy)
                        .collect();
                    events.push(payload_draft(
                        RuntimeEventKind::approval_request(),
                        s(request, &["tool_use_id"]),
                        Some(request_id),
                        RuntimeEventPayload {
                            state: Some(RuntimeItemState::Waiting),
                            approval: Some(RuntimeApprovalRequest {
                                kind: approval_kind(&tool),
                                title: format!("Allow {tool}?"),
                                detail: json_string(request.get("input")),
                                command: request
                                    .get("input")
                                    .and_then(Value::as_object)
                                    .and_then(|input| input.get("command"))
                                    .and_then(Value::as_str)
                                    .map(String::from),
                                paths: Vec::new(),
                                options,
                                expires_at: None,
                            }),
                            ..Default::default()
                        },
                        Some(reference),
                    ));
                }
            }
        }
        "rate_limit_event" => {
            let info = object
                .get("rate_limit_info")
                .and_then(Value::as_object)
                .unwrap_or(object);
            let status = s(info, &["status"]).unwrap_or_else(|| "unknown".into());
            if status != "allowed" {
                events.push(payload_draft(
                    RuntimeEventKind::warning(),
                    None,
                    None,
                    RuntimeEventPayload {
                        title: Some("Claude rate limit".into()),
                        detail: Some(s(info, &["message"]).unwrap_or_else(|| {
                            format!("Claude reported rate-limit status: {status}.")
                        })),
                        raw_type: Some(status),
                        ..Default::default()
                    },
                    Some(reference),
                ));
            }
        }
        "result" => {
            if object.get("is_error").and_then(Value::as_bool) == Some(true) {
                return Err(CoreError::CommandFailed(
                    s(object, &["result", "error"])
                        .unwrap_or_else(|| "Claude reported an error".into()),
                ));
            }
            if let Some(usage_object) = object.get("usage").and_then(Value::as_object) {
                events.push(payload_draft(
                    RuntimeEventKind::usage(),
                    None,
                    None,
                    RuntimeEventPayload {
                        usage: Some(usage(usage_object)),
                        ..Default::default()
                    },
                    Some(reference),
                ));
            }
            match s(object, &["subtype"]).map(|s| s.to_lowercase()).as_deref() {
                Some("cancelled") | Some("canceled") => events.push(ProviderEventDraft::Terminal(
                    ProviderTurnTerminalState::Cancelled,
                )),
                Some("interrupted") => events.push(ProviderEventDraft::Terminal(
                    ProviderTurnTerminalState::Interrupted,
                )),
                _ => events.push(ProviderEventDraft::Terminal(
                    ProviderTurnTerminalState::Completed,
                )),
            }
        }
        other => events.extend(unknown(object, "claude-stream-json", Some(other))),
    }
    Ok(events)
}

fn normalize_acp(
    object: &Object,
    provider: ChatProvider,
    state: &mut NormalizerState,
) -> Result<Vec<ProviderEventDraft>, CoreError> {
    let protocol_name = format!("{}-acp", provider.raw_value());
    if let Some(error) = object.get("error").and_then(Value::as_object) {
        return Err(CoreError::CommandFailed(
            s(error, &["message"]).unwrap_or_else(|| "ACP error".into()),
        ));
    }
    if let Some(result) = object.get("result").and_then(Value::as_object) {
        if let Some(protocol_version) = i(result, &["protocolVersion"]) {
            if protocol_version != 1 {
                return Err(CoreError::Unsupported(format!(
                    "{} negotiated ACP protocol {protocol_version}; Maxx Provider Runtime v1 requires ACP 1.",
                    provider.display_name()
                )));
            }
        }
        if let Some(session_id) = result.get("sessionId").and_then(Value::as_str) {
            state.session_id = Some(session_id.to_string());
            capture_acp_context_window(result, state);
            return Ok(vec![
                ProviderEventDraft::SessionUpdated(session_id.to_string()),
                ProviderEventDraft::Status(format!("{} session ready", provider.display_name())),
            ]);
        }
        if let Some(stop_reason) = result.get("stopReason").and_then(Value::as_str) {
            let mut drafts = Vec::new();
            if let Some(value) = acp_prompt_usage(result, state) {
                drafts.push(payload_draft(
                    RuntimeEventKind::usage(),
                    None,
                    None,
                    RuntimeEventPayload {
                        usage: Some(value),
                        ..Default::default()
                    },
                    Some(ProviderNativeReference {
                        protocol_name: protocol_name.clone(),
                        protocol_version: Some("1".into()),
                        session_id: state.session_id.clone(),
                        event_type: Some("session/prompt.response".into()),
                        ..Default::default()
                    }),
                ));
            }
            let provider_terminal = match stop_reason.to_lowercase().as_str() {
                "cancelled" | "canceled" => ProviderTurnTerminalState::Cancelled,
                "interrupted" => ProviderTurnTerminalState::Interrupted,
                "error" | "failed" => ProviderTurnTerminalState::Failed,
                _ => ProviderTurnTerminalState::Completed,
            };
            let terminal = state
                .pending_terminal_state
                .take()
                .unwrap_or(provider_terminal);
            drafts.push(ProviderEventDraft::Terminal(terminal));
            return Ok(drafts);
        }
        return Ok(Vec::new());
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Ok(unknown(object, &protocol_name, None));
    };
    let empty = Object::new();
    let params = object
        .get("params")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let session_id = s(params, &["sessionId"]).or_else(|| state.session_id.clone());
    let reference = ProviderNativeReference {
        protocol_name: protocol_name.clone(),
        protocol_version: Some("1".into()),
        session_id,
        request_id: native_request_id(object),
        event_type: Some(method.to_string()),
        ..Default::default()
    };
    if method == "session/update" {
        if let Some(update) = params.get("update").and_then(Value::as_object) {
            let update_type = s(update, &["sessionUpdate"]).unwrap_or_else(|| "unknown".into());
            return match update_type.as_str() {
                "agent_message_chunk" => {
                    let text = content_text(update.get("content")).unwrap_or_default();
                    if provider == ChatProvider::Cursor {
                        if let Some(failure) = cursor_provider_failure(&text) {
                            state.pending_terminal_state = Some(ProviderTurnTerminalState::Failed);
                            return Ok(vec![payload_draft(
                                RuntimeEventKind::error(),
                                None,
                                None,
                                RuntimeEventPayload {
                                    error: Some(failure),
                                    ..Default::default()
                                },
                                Some(reference),
                            )]);
                        }
                    }
                    if text.is_empty() {
                        Ok(Vec::new())
                    } else {
                        Ok(vec![ProviderEventDraft::AssistantDelta(text)])
                    }
                }
                "agent_thought_chunk" => Ok(vec![payload_draft(
                    RuntimeEventKind::reasoning_summary(),
                    Some("agent-thought".into()),
                    None,
                    RuntimeEventPayload {
                        text: content_text(update.get("content")),
                        state: Some(RuntimeItemState::Running),
                        ..Default::default()
                    },
                    Some(reference),
                )]),
                "available_commands_update" | "session_info_update" | "user_message_chunk" => {
                    Ok(Vec::new())
                }
                "tool_call" | "tool_call_update" => {
                    let native_item_id = s(update, &["toolCallId"]);
                    let name = s(update, &["title", "name"]).unwrap_or_else(|| "Tool".into());
                    let state_value = runtime_state(s(update, &["status"]).as_deref());
                    let tool_kind = s(update, &["kind"]).map(|k| k.to_lowercase());
                    if matches!(
                        tool_kind.as_deref(),
                        Some("edit") | Some("delete") | Some("move")
                    ) {
                        let files: Vec<RuntimeFileChange> = update
                            .get("locations")
                            .and_then(Value::as_array)
                            .map(|locations| {
                                locations
                                    .iter()
                                    .filter_map(Value::as_object)
                                    .filter_map(|location| {
                                        let path = s(location, &["path"])?;
                                        Some(RuntimeFileChange {
                                            path,
                                            change_type: tool_kind
                                                .clone()
                                                .unwrap_or_else(|| "edit".into()),
                                            summary: Some(name.clone()),
                                            diff: None,
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        return Ok(vec![payload_draft(
                            RuntimeEventKind::file_change(),
                            native_item_id,
                            None,
                            RuntimeEventPayload {
                                title: Some(name),
                                state: Some(state_value),
                                files: Some(files),
                                ..Default::default()
                            },
                            Some(reference),
                        )]);
                    }
                    if tool_kind.as_deref() == Some("execute") {
                        let input = update.get("rawInput").and_then(Value::as_object);
                        let command = input
                            .map(|i| s(i, &["command"]))
                            .unwrap_or(None)
                            .unwrap_or_else(|| name.clone());
                        return Ok(vec![payload_draft(
                            RuntimeEventKind::command(),
                            native_item_id,
                            None,
                            RuntimeEventPayload {
                                title: Some(name),
                                state: Some(state_value),
                                command: Some(command),
                                output: json_string(update.get("rawOutput")),
                                ..Default::default()
                            },
                            Some(reference),
                        )]);
                    }
                    Ok(vec![payload_draft(
                        RuntimeEventKind::tool(),
                        native_item_id,
                        None,
                        RuntimeEventPayload {
                            title: Some(name.clone()),
                            state: Some(state_value),
                            tool: Some(RuntimeToolCall {
                                name,
                                input: json_string(update.get("rawInput")),
                                output: json_string(update.get("rawOutput")),
                                state: state_value,
                            }),
                            ..Default::default()
                        },
                        Some(reference),
                    )])
                }
                "plan" => Ok(vec![payload_draft(
                    RuntimeEventKind::plan(),
                    None,
                    None,
                    RuntimeEventPayload {
                        plan: plan_steps(update.get("entries")),
                        ..Default::default()
                    },
                    Some(reference),
                )]),
                "usage_update" => Ok(vec![payload_draft(
                    RuntimeEventKind::usage(),
                    None,
                    None,
                    RuntimeEventPayload {
                        usage: Some(usage(update)),
                        ..Default::default()
                    },
                    Some(reference),
                )]),
                other => Ok(unknown(object, &protocol_name, Some(other))),
            };
        }
    }
    match method {
        "_x.ai/mcp/init_progress"
        | "_x.ai/mcp_initialized"
        | "_x.ai/queue/changed"
        | "_x.ai/session/prompt_complete"
        | "_x.ai/sessions/changed"
        | "_x.ai/mcp/servers_updated"
        | "_x.ai/announcements/update"
        | "_x.ai/settings/update" => return Ok(Vec::new()),
        "_x.ai/session_notification" => {
            let empty = Object::new();
            let update = params
                .get("update")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let Some(native_usage) = update.get("usage").and_then(Value::as_object) else {
                return Ok(Vec::new());
            };
            return Ok(vec![payload_draft(
                RuntimeEventKind::usage(),
                None,
                None,
                RuntimeEventPayload {
                    usage: Some(usage(native_usage)),
                    ..Default::default()
                },
                Some(reference),
            )]);
        }
        "_x.ai/mcp/server_status" => {
            let status = s(params, &["status"]).map(|s| s.to_lowercase());
            if !matches!(
                status.as_deref(),
                Some("unavailable") | Some("failed") | Some("error")
            ) {
                return Ok(Vec::new());
            }
            let name = s(params, &["name"]).unwrap_or_else(|| "MCP server".into());
            return Ok(vec![payload_draft(
                RuntimeEventKind::warning(),
                None,
                None,
                RuntimeEventPayload {
                    title: Some(format!("{name} MCP server unavailable")),
                    detail: s(params, &["detail", "reason"]),
                    raw_type: Some(method.to_string()),
                    ..Default::default()
                },
                Some(reference),
            )]);
        }
        _ => {}
    }
    if method == "session/request_permission" {
        let native_id = native_request_id(object).unwrap_or_else(|| Uuid::new_v4().to_string());
        let request_id = state.request_id(&native_id);
        let empty = Object::new();
        let tool_call = params
            .get("toolCall")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(Value::as_object)
                    .filter_map(|option| {
                        let id = option.get("optionId").and_then(Value::as_str)?;
                        let native_kind = option
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let kind = if native_kind.contains("reject") {
                            RuntimeDecisionKind::Deny
                        } else if native_kind.contains("always") {
                            RuntimeDecisionKind::ApproveForSession
                        } else {
                            RuntimeDecisionKind::Approve
                        };
                        Some(RuntimeDecisionOption {
                            id: id.to_string(),
                            title: option
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or(id)
                                .to_string(),
                            kind,
                            is_persistent: kind == RuntimeDecisionKind::ApproveForSession,
                            native_value: Some(id.to_string()),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(cancellation_only_options);
        return Ok(vec![payload_draft(
            RuntimeEventKind::approval_request(),
            s(tool_call, &["toolCallId"]),
            Some(request_id),
            RuntimeEventPayload {
                state: Some(RuntimeItemState::Waiting),
                approval: Some(RuntimeApprovalRequest {
                    kind: RuntimeApprovalKind::Tool,
                    title: s(tool_call, &["title"]).unwrap_or_else(|| "Allow tool?".into()),
                    detail: None,
                    command: None,
                    paths: Vec::new(),
                    options,
                    expires_at: None,
                }),
                ..Default::default()
            },
            Some(reference),
        )]);
    }
    if method == "session/request_input" || method == "session/request_user_input" {
        let native_id = native_request_id(object).unwrap_or_else(|| Uuid::new_v4().to_string());
        let request_id = state.request_id(&native_id);
        return Ok(vec![payload_draft(
            RuntimeEventKind::user_input_request(),
            None,
            Some(request_id),
            RuntimeEventPayload {
                state: Some(RuntimeItemState::Waiting),
                user_input: Some(user_input(params)),
                ..Default::default()
            },
            Some(reference),
        )]);
    }
    Ok(unknown(object, &protocol_name, Some(method)))
}

fn normalize_opencode(
    object: &Object,
    state: &mut NormalizerState,
) -> Result<Vec<ProviderEventDraft>, CoreError> {
    let Some(event_type) = object.get("type").and_then(Value::as_str) else {
        return Ok(unknown(object, "opencode-server", None));
    };
    let empty = Object::new();
    let properties = object
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let session_id =
        s(properties, &["sessionID", "sessionId"]).or_else(|| state.session_id.clone());
    let reference = ProviderNativeReference {
        protocol_name: "opencode-server".into(),
        session_id,
        event_type: Some(event_type.to_string()),
        ..Default::default()
    };
    match event_type {
        "server.connected" => Ok(vec![ProviderEventDraft::Status(
            "OpenCode server connected".into(),
        )]),
        "session.created" | "session.updated" => {
            let info = properties
                .get("info")
                .and_then(Value::as_object)
                .unwrap_or(properties);
            let Some(id) = s(info, &["id", "sessionID"]) else {
                return Ok(Vec::new());
            };
            state.session_id = Some(id.clone());
            Ok(vec![
                ProviderEventDraft::SessionUpdated(id),
                ProviderEventDraft::Status("OpenCode session ready".into()),
            ])
        }
        "message.part.updated" => {
            let Some(part) = properties.get("part").and_then(Value::as_object) else {
                return Ok(Vec::new());
            };
            let Some(part_type) = part.get("type").and_then(Value::as_str) else {
                return Ok(Vec::new());
            };
            let part_id = s(part, &["id"]);
            let message_id = s(part, &["messageID", "messageId"]);
            if let Some(id) = &part_id {
                state.part_types.insert(id.clone(), part_type.to_string());
            }
            if let Some(message_id) = &message_id {
                if state
                    .message_roles
                    .get(message_id)
                    .map(|r| r.to_lowercase())
                    .as_deref()
                    == Some("user")
                {
                    return Ok(Vec::new());
                }
            }
            if part_type == "text" {
                if let Some(delta) = s(properties, &["delta"]).filter(|d| !d.is_empty()) {
                    if let Some(id) = &part_id {
                        state.streamed_assistant_item_ids.insert(id.clone());
                    }
                    return Ok(vec![ProviderEventDraft::AssistantDelta(delta)]);
                }
                if let Some(id) = &part_id {
                    if state.streamed_assistant_item_ids.contains(id) {
                        return Ok(Vec::new());
                    }
                }
                let Some(text) = s(part, &["text"]).filter(|t| !t.is_empty()) else {
                    return Ok(Vec::new());
                };
                return Ok(vec![ProviderEventDraft::AssistantDelta(text)]);
            }
            if part_type == "reasoning" {
                if let Some(id) = &part_id {
                    if state.streamed_reasoning_item_ids.contains(id) {
                        return Ok(Vec::new());
                    }
                }
                let Some(text) = s(properties, &["delta"])
                    .or_else(|| s(part, &["text"]))
                    .filter(|t| !t.is_empty())
                else {
                    return Ok(Vec::new());
                };
                return Ok(vec![payload_draft(
                    RuntimeEventKind::reasoning_summary(),
                    part_id,
                    None,
                    RuntimeEventPayload {
                        text: Some(text),
                        state: Some(RuntimeItemState::Running),
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }
            if part_type == "step-start" {
                return Ok(Vec::new());
            }
            if part_type == "step-finish" {
                let Some(tokens) = part.get("tokens").and_then(Value::as_object) else {
                    return Ok(Vec::new());
                };
                return Ok(vec![payload_draft(
                    RuntimeEventKind::usage(),
                    part_id,
                    None,
                    RuntimeEventPayload {
                        usage: Some(opencode_step_usage(tokens)),
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }
            if part_type == "tool" {
                let empty = Object::new();
                let tool_state = part
                    .get("state")
                    .and_then(Value::as_object)
                    .unwrap_or(&empty);
                let name = s(part, &["tool"]).unwrap_or_else(|| "Tool".into());
                let state_value = runtime_state(s(tool_state, &["status"]).as_deref());
                return Ok(vec![payload_draft(
                    RuntimeEventKind::tool(),
                    part_id,
                    None,
                    RuntimeEventPayload {
                        title: Some(name.clone()),
                        state: Some(state_value),
                        tool: Some(RuntimeToolCall {
                            name,
                            input: json_string(tool_state.get("input")),
                            output: json_string(tool_state.get("output")),
                            state: state_value,
                        }),
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }
            if part_type == "patch" || part_type == "file" {
                let files = file_changes(
                    part.get("files")
                        .or_else(|| part.get("diff"))
                        .or(Some(&Value::Object(properties.clone()))),
                );
                return Ok(vec![payload_draft(
                    if part_type == "patch" {
                        RuntimeEventKind::diff()
                    } else {
                        RuntimeEventKind::file_change()
                    },
                    part_id,
                    None,
                    RuntimeEventPayload {
                        title: Some(if part_type == "patch" {
                            "OpenCode patch".into()
                        } else {
                            "OpenCode file change".into()
                        }),
                        state: Some(RuntimeItemState::Completed),
                        files,
                        diff: json_string(part.get("diff")),
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }
            Ok(unknown(object, "opencode-server", Some(part_type)))
        }
        "message.part.delta" => {
            if s(properties, &["field"]).as_deref() != Some("text") {
                return Ok(Vec::new());
            }
            let Some(delta) = s(properties, &["delta"]).filter(|d| !d.is_empty()) else {
                return Ok(Vec::new());
            };
            let message_id = s(properties, &["messageID", "messageId"]);
            if let Some(message_id) = &message_id {
                if state
                    .message_roles
                    .get(message_id)
                    .map(|r| r.to_lowercase())
                    .as_deref()
                    == Some("user")
                {
                    return Ok(Vec::new());
                }
            }
            let Some(part_id) = s(properties, &["partID", "partId"]) else {
                return Ok(Vec::new());
            };
            if state.part_types.get(&part_id).map(String::as_str) == Some("reasoning") {
                state.streamed_reasoning_item_ids.insert(part_id.clone());
                return Ok(vec![payload_draft(
                    RuntimeEventKind::reasoning_summary(),
                    Some(part_id),
                    None,
                    RuntimeEventPayload {
                        text: Some(delta),
                        state: Some(RuntimeItemState::Running),
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }
            state.streamed_assistant_item_ids.insert(part_id);
            Ok(vec![ProviderEventDraft::AssistantDelta(delta)])
        }
        "permission.asked" => {
            let native_id =
                s(properties, &["requestID", "id"]).unwrap_or_else(|| Uuid::new_v4().to_string());
            let request_id = state.request_id(&native_id);
            Ok(vec![payload_draft(
                RuntimeEventKind::approval_request(),
                None,
                Some(request_id),
                RuntimeEventPayload {
                    state: Some(RuntimeItemState::Waiting),
                    approval: Some(RuntimeApprovalRequest {
                        kind: approval_kind(
                            &s(properties, &["permission"]).unwrap_or_else(|| "tool".into()),
                        ),
                        title: "OpenCode permission".into(),
                        detail: json_string(properties.get("patterns")),
                        command: None,
                        paths: Vec::new(),
                        options: standard_approval_options(),
                        expires_at: None,
                    }),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "question.asked" => {
            let native_id =
                s(properties, &["requestID", "id"]).unwrap_or_else(|| Uuid::new_v4().to_string());
            let request_id = state.request_id(&native_id);
            Ok(vec![payload_draft(
                RuntimeEventKind::user_input_request(),
                None,
                Some(request_id),
                RuntimeEventPayload {
                    state: Some(RuntimeItemState::Waiting),
                    user_input: Some(user_input(properties)),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "session.diff" => Ok(vec![payload_draft(
            RuntimeEventKind::diff(),
            None,
            None,
            RuntimeEventPayload {
                files: file_changes(properties.get("diff")),
                diff: json_string(Some(&Value::Object(properties.clone()))),
                ..Default::default()
            },
            Some(reference),
        )]),
        "todo.updated" => Ok(vec![payload_draft(
            RuntimeEventKind::plan(),
            None,
            None,
            RuntimeEventPayload {
                plan: plan_steps(properties.get("todos")),
                ..Default::default()
            },
            Some(reference),
        )]),
        "message.updated" => {
            let info = properties
                .get("info")
                .and_then(Value::as_object)
                .unwrap_or(properties);
            if let (Some(message_id), Some(role)) = (s(info, &["id"]), s(info, &["role"])) {
                state.message_roles.insert(message_id, role);
            }
            if let Some(tokens) = info.get("tokens").and_then(Value::as_object) {
                return Ok(vec![payload_draft(
                    RuntimeEventKind::usage(),
                    s(info, &["id"]),
                    None,
                    RuntimeEventPayload {
                        usage: Some(opencode_step_usage(tokens)),
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }
            Ok(Vec::new())
        }
        "session.status" => {
            let status_object = properties
                .get("status")
                .and_then(Value::as_object)
                .unwrap_or(properties);
            let status = s(status_object, &["type", "status"]).map(|s| s.to_lowercase());
            if status.as_deref() == Some("idle") {
                return Ok(vec![ProviderEventDraft::Completed]);
            }
            if matches!(
                status.as_deref(),
                Some("retry") | Some("busy") | Some("active")
            ) {
                return Ok(vec![ProviderEventDraft::Status(format!(
                    "OpenCode session {}",
                    status.as_deref().unwrap_or("active")
                ))]);
            }
            Ok(Vec::new())
        }
        "session.error" => {
            let error_object = properties
                .get("error")
                .and_then(Value::as_object)
                .unwrap_or(properties);
            Err(CoreError::CommandFailed(
                s(error_object, &["message", "name"])
                    .unwrap_or_else(|| "OpenCode session failed".into()),
            ))
        }
        "session.idle" => Ok(vec![ProviderEventDraft::Completed]),
        "step-start" => Ok(Vec::new()),
        "step-finish" => {
            let Some(tokens) = properties.get("tokens").and_then(Value::as_object) else {
                return Ok(Vec::new());
            };
            Ok(vec![payload_draft(
                RuntimeEventKind::usage(),
                None,
                None,
                RuntimeEventPayload {
                    usage: Some(opencode_step_usage(tokens)),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "server.heartbeat"
        | "permission.replied"
        | "question.replied"
        | "question.rejected"
        | "plugin.added"
        | "catalog.updated"
        | "reference.updated"
        | "integration.updated" => Ok(Vec::new()),
        other => Ok(unknown(object, "opencode-server", Some(other))),
    }
}

fn normalize_pi(
    object: &Object,
    state: &mut NormalizerState,
) -> Result<Vec<ProviderEventDraft>, CoreError> {
    let Some(event_type) = object.get("type").and_then(Value::as_str) else {
        return Ok(unknown(object, "pi-rpc", None));
    };
    let reference = ProviderNativeReference {
        protocol_name: "pi-rpc".into(),
        protocol_version: Some("1".into()),
        session_id: state.session_id.clone(),
        item_id: s(object, &["toolCallId"]),
        request_id: if event_type == "extension_ui_request" {
            native_request_id(object)
        } else {
            None
        },
        event_type: Some(event_type.to_string()),
        ..Default::default()
    };

    match event_type {
        "response" => {
            if object.get("success").and_then(Value::as_bool) == Some(false) {
                return Err(CoreError::CommandFailed(
                    s(object, &["error"]).unwrap_or_else(|| "Pi rejected an RPC command.".into()),
                ));
            }
            if object.get("command").and_then(Value::as_str) == Some("get_state") {
                if let Some(session_id) = object
                    .get("data")
                    .and_then(Value::as_object)
                    .and_then(|data| s(data, &["sessionId"]))
                {
                    state.session_id = Some(session_id.clone());
                    return Ok(vec![
                        ProviderEventDraft::SessionUpdated(session_id),
                        ProviderEventDraft::Status("Pi session ready".into()),
                    ]);
                }
            }
            Ok(Vec::new())
        }
        "agent_start" => {
            state.pending_terminal_state = None;
            Ok(vec![ProviderEventDraft::Status("Pi is working…".into())])
        }
        "agent_end" => {
            if object.get("willRetry").and_then(Value::as_bool) == Some(true) {
                Ok(vec![ProviderEventDraft::Status(
                    "Pi is preparing an automatic retry…".into(),
                )])
            } else {
                Ok(Vec::new())
            }
        }
        "agent_settled" => {
            let terminal = state
                .pending_terminal_state
                .take()
                .unwrap_or(ProviderTurnTerminalState::Completed);
            Ok(vec![ProviderEventDraft::Terminal(terminal)])
        }
        "turn_start" | "message_start" => Ok(Vec::new()),
        "message_update" => {
            let Some(event) = object
                .get("assistantMessageEvent")
                .and_then(Value::as_object)
            else {
                return Ok(Vec::new());
            };
            let Some(inner_type) = event.get("type").and_then(Value::as_str) else {
                return Ok(Vec::new());
            };
            match inner_type {
                "text_delta" => {
                    let Some(delta) = s(event, &["delta"]).filter(|d| !d.is_empty()) else {
                        return Ok(Vec::new());
                    };
                    Ok(vec![ProviderEventDraft::AssistantDelta(delta)])
                }
                "thinking_delta" => {
                    let Some(delta) = s(event, &["delta"]).filter(|d| !d.is_empty()) else {
                        return Ok(Vec::new());
                    };
                    Ok(vec![payload_draft(
                        RuntimeEventKind::reasoning_summary(),
                        Some(format!(
                            "thinking-{}",
                            i(event, &["contentIndex"]).unwrap_or(0)
                        )),
                        None,
                        RuntimeEventPayload {
                            text: Some(delta),
                            state: Some(RuntimeItemState::Running),
                            ..Default::default()
                        },
                        Some(reference),
                    )])
                }
                "error" => {
                    let reason = s(event, &["reason"]).map(|r| r.to_lowercase());
                    if reason.as_deref() == Some("aborted") {
                        state.pending_terminal_state = Some(ProviderTurnTerminalState::Cancelled);
                        return Ok(vec![ProviderEventDraft::Status("Pi turn cancelled".into())]);
                    }
                    state.pending_terminal_state = Some(ProviderTurnTerminalState::Failed);
                    Ok(vec![payload_draft(
                        RuntimeEventKind::error(),
                        None,
                        None,
                        RuntimeEventPayload {
                            error: Some(RuntimeStructuredError {
                                code: "pi.message.error".into(),
                                message: s(event, &["error", "message"])
                                    .unwrap_or_else(|| "Pi message generation failed.".into()),
                                detail: None,
                                is_recoverable: true,
                                suggested_action: Some("Retry the turn.".into()),
                            }),
                            ..Default::default()
                        },
                        Some(reference),
                    )])
                }
                _ => Ok(Vec::new()),
            }
        }
        "message_end" => {
            let empty = Object::new();
            let message = object
                .get("message")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return Ok(Vec::new());
            }
            let Some(usage_object) = message.get("usage").and_then(Value::as_object) else {
                return Ok(Vec::new());
            };
            let mut value = usage(usage_object);
            per_request_context(&mut value, i(usage_object, &["cacheWrite"]));
            if let Some(cost) = usage_object.get("cost").and_then(Value::as_object) {
                value.cost = f(cost, &["total"]);
                value.currency = value.cost.map(|_| "USD".into());
            }
            Ok(vec![payload_draft(
                RuntimeEventKind::usage(),
                None,
                None,
                RuntimeEventPayload {
                    usage: Some(value),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "turn_end" => Ok(Vec::new()),
        "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
            let call_id = s(object, &["toolCallId"]).unwrap_or_else(|| Uuid::new_v4().to_string());
            let name = s(object, &["toolName"]).unwrap_or_else(|| "Tool".into());
            let empty = Object::new();
            let args = object
                .get("args")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            state.tool_names.insert(call_id.clone(), name.clone());
            let result = object.get("result").or_else(|| object.get("partialResult"));
            let output = content_text(
                result
                    .and_then(Value::as_object)
                    .and_then(|r| r.get("content"))
                    .or(result),
            );
            let is_error = object.get("isError").and_then(Value::as_bool) == Some(true);
            let item_state = match event_type {
                "tool_execution_start" | "tool_execution_update" => RuntimeItemState::Running,
                _ if is_error => RuntimeItemState::Failed,
                _ => RuntimeItemState::Completed,
            };
            let lowered = name.to_lowercase();
            if lowered == "bash" {
                return Ok(vec![payload_draft(
                    RuntimeEventKind::command(),
                    Some(call_id),
                    None,
                    RuntimeEventPayload {
                        title: Some("Pi command".into()),
                        state: Some(item_state),
                        command: s(args, &["command"]),
                        output,
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }
            if lowered == "edit" || lowered == "write" {
                let path = s(args, &["path", "filePath", "file"]);
                return Ok(vec![payload_draft(
                    RuntimeEventKind::file_change(),
                    Some(call_id),
                    None,
                    RuntimeEventPayload {
                        title: Some(format!("Pi {lowered}")),
                        state: Some(item_state),
                        output,
                        files: path.map(|p| {
                            vec![RuntimeFileChange {
                                path: p,
                                change_type: lowered.clone(),
                                summary: None,
                                diff: None,
                            }]
                        }),
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }
            Ok(vec![payload_draft(
                RuntimeEventKind::tool(),
                Some(call_id),
                None,
                RuntimeEventPayload {
                    title: Some(name.clone()),
                    state: Some(item_state),
                    tool: Some(RuntimeToolCall {
                        name,
                        input: json_string(Some(&Value::Object(args.clone()))),
                        output,
                        state: item_state,
                    }),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "extension_ui_request" => {
            let method = s(object, &["method"]).unwrap_or_else(|| "unknown".into());
            if [
                "notify",
                "setStatus",
                "setWidget",
                "setTitle",
                "set_editor_text",
            ]
            .contains(&method.as_str())
            {
                let detail = s(object, &["message", "statusText", "title"]);
                let Some(detail) = detail.filter(|d| !d.is_empty()) else {
                    return Ok(Vec::new());
                };
                if object.get("notifyType").and_then(Value::as_str) == Some("error") {
                    return Ok(vec![payload_draft(
                        RuntimeEventKind::error(),
                        None,
                        None,
                        RuntimeEventPayload {
                            error: Some(RuntimeStructuredError {
                                code: "pi.extension.notification".into(),
                                message: detail,
                                detail: None,
                                is_recoverable: true,
                                suggested_action: None,
                            }),
                            ..Default::default()
                        },
                        Some(reference),
                    )]);
                }
                return Ok(vec![payload_draft(
                    RuntimeEventKind::warning(),
                    None,
                    None,
                    RuntimeEventPayload {
                        title: Some("Pi extension".into()),
                        detail: Some(detail),
                        ..Default::default()
                    },
                    Some(reference),
                )]);
            }
            if !["select", "confirm", "input", "editor"].contains(&method.as_str()) {
                return Ok(unknown(
                    object,
                    "pi-rpc",
                    Some(&format!("extension_ui_request.{method}")),
                ));
            }
            let native_id = native_request_id(object).unwrap_or_else(|| Uuid::new_v4().to_string());
            let question_id = format!("pi-extension-{native_id}");
            let timeout = object.get("timeout").and_then(Value::as_f64);
            let expires_at = timeout.map(|t| AppleDate(AppleDate::now().0 + t / 1_000.0));
            let (options, answer_kind) = if method == "select" {
                (
                    object
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(Value::as_str)
                                .enumerate()
                                .map(|(index, label)| RuntimeQuestionOption {
                                    id: format!("option-{index}"),
                                    label: label.to_string(),
                                    description: None,
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default(),
                    RuntimeQuestionAnswerKind::SingleSelect,
                )
            } else if method == "confirm" {
                (
                    vec![
                        RuntimeQuestionOption {
                            id: "confirm".into(),
                            label: "Confirm".into(),
                            description: None,
                        },
                        RuntimeQuestionOption {
                            id: "decline".into(),
                            label: "Decline".into(),
                            description: None,
                        },
                    ],
                    RuntimeQuestionAnswerKind::SingleSelect,
                )
            } else {
                (Vec::new(), RuntimeQuestionAnswerKind::FreeText)
            };
            Ok(vec![payload_draft(
                RuntimeEventKind::user_input_request(),
                None,
                Some(state.request_id(&native_id)),
                RuntimeEventPayload {
                    state: Some(RuntimeItemState::Waiting),
                    user_input: Some(RuntimeUserInputRequest {
                        questions: vec![RuntimeQuestion {
                            id: question_id,
                            header: s(object, &["title"]),
                            prompt: s(object, &["message", "title", "placeholder"])
                                .unwrap_or_else(|| "Pi extension request".into()),
                            answer_kind,
                            options,
                            is_required: true,
                        }],
                        expires_at,
                    }),
                    ..Default::default()
                },
                Some(reference),
            )])
        }
        "compaction_start" => Ok(vec![ProviderEventDraft::Status(
            "Pi is compacting the session context…".into(),
        )]),
        "compaction_end" => Ok(vec![ProviderEventDraft::Status(
            "Pi finished compacting the session context".into(),
        )]),
        "auto_retry_start" => Ok(vec![payload_draft(
            RuntimeEventKind::warning(),
            None,
            None,
            RuntimeEventPayload {
                title: Some("Pi retrying".into()),
                detail: s(object, &["error", "message"]),
                state: Some(RuntimeItemState::Running),
                ..Default::default()
            },
            Some(reference),
        )]),
        "auto_retry_end" => Ok(vec![ProviderEventDraft::Status(
            "Pi automatic retry finished".into(),
        )]),
        "extension_error" => Ok(vec![payload_draft(
            RuntimeEventKind::error(),
            None,
            None,
            RuntimeEventPayload {
                error: Some(RuntimeStructuredError {
                    code: "pi.extension.error".into(),
                    message: s(object, &["error"])
                        .unwrap_or_else(|| "A Pi extension failed.".into()),
                    detail: s(object, &["extensionPath", "event"]),
                    is_recoverable: true,
                    suggested_action: Some("Review the Pi extension configuration.".into()),
                }),
                ..Default::default()
            },
            Some(reference),
        )]),
        "queue_update" => Ok(vec![ProviderEventDraft::Status(
            "Pi message queue updated".into(),
        )]),
        other => Ok(unknown(object, "pi-rpc", Some(other))),
    }
}

pub fn standard_approval_options() -> Vec<RuntimeDecisionOption> {
    vec![
        RuntimeDecisionOption {
            id: "approve".into(),
            title: "Allow once".into(),
            kind: RuntimeDecisionKind::Approve,
            is_persistent: false,
            native_value: None,
        },
        RuntimeDecisionOption {
            id: "approve-session".into(),
            title: "Allow for session".into(),
            kind: RuntimeDecisionKind::ApproveForSession,
            is_persistent: true,
            native_value: None,
        },
        RuntimeDecisionOption {
            id: "deny".into(),
            title: "Deny".into(),
            kind: RuntimeDecisionKind::Deny,
            is_persistent: false,
            native_value: None,
        },
        RuntimeDecisionOption {
            id: "cancel".into(),
            title: "Cancel turn".into(),
            kind: RuntimeDecisionKind::Cancel,
            is_persistent: false,
            native_value: None,
        },
    ]
}

fn cancellation_only_options() -> Vec<RuntimeDecisionOption> {
    vec![RuntimeDecisionOption {
        id: "cancel".into(),
        title: "Cancel request".into(),
        kind: RuntimeDecisionKind::Cancel,
        is_persistent: false,
        native_value: None,
    }]
}

fn unknown(
    object: &Object,
    protocol_name: &str,
    raw_type: Option<&str>,
) -> Vec<ProviderEventDraft> {
    let event_type = raw_type
        .map(String::from)
        .or_else(|| s(object, &["type", "method"]))
        .unwrap_or_else(|| "unknown".into());
    vec![payload_draft(
        RuntimeEventKind::warning(),
        None,
        None,
        RuntimeEventPayload {
            title: Some("Unknown provider event".into()),
            detail: Some(format!(
                "{protocol_name} emitted {event_type}. The event was preserved for diagnostics."
            )),
            raw_type: Some(event_type.clone()),
            ..Default::default()
        },
        Some(ProviderNativeReference {
            protocol_name: protocol_name.to_string(),
            event_type: Some(event_type),
            ..Default::default()
        }),
    )]
}

fn payload_draft(
    kind: RuntimeEventKind,
    item_id: Option<String>,
    request_id: Option<Uuid>,
    payload: RuntimeEventPayload,
    native_reference: Option<ProviderNativeReference>,
) -> ProviderEventDraft {
    ProviderEventDraft::Payload {
        kind,
        item_id,
        request_id,
        payload,
        native_reference,
    }
}

fn terminal_draft(status: Option<&str>) -> ProviderEventDraft {
    let terminal = match status.map(|s| s.to_lowercase()).as_deref() {
        Some("cancelled") | Some("canceled") => ProviderTurnTerminalState::Cancelled,
        Some("interrupted") => ProviderTurnTerminalState::Interrupted,
        Some("failed") => ProviderTurnTerminalState::Failed,
        _ => ProviderTurnTerminalState::Completed,
    };
    ProviderEventDraft::Terminal(terminal)
}

fn item_completion_state(object: &Object) -> RuntimeItemState {
    if let Some(code) = i(object, &["exitCode", "exit_code"]) {
        if code != 0 {
            return RuntimeItemState::Failed;
        }
    }
    runtime_state(s(object, &["status"]).as_deref())
}

fn runtime_state(value: Option<&str>) -> RuntimeItemState {
    match value.map(|v| v.to_lowercase()).as_deref() {
        Some("pending") => RuntimeItemState::Pending,
        Some("in_progress") | Some("inprogress") | Some("running") => RuntimeItemState::Running,
        Some("waiting") => RuntimeItemState::Waiting,
        Some("cancelled") | Some("canceled") => RuntimeItemState::Cancelled,
        Some("failed") | Some("error") => RuntimeItemState::Failed,
        _ => RuntimeItemState::Completed,
    }
}

/// Cursor Agent 2026.07.09 exposes this provider failure only as one ACP
/// assistant chunk and still returns `stopReason: end_turn`. Keep the fallback
/// deliberately narrow so ordinary prose containing "Error" stays normal text.
fn cursor_provider_failure(text: &str) -> Option<RuntimeStructuredError> {
    let message = text.trim();
    if !message.starts_with("Error: NonRetriableError: Provider Error ") {
        return None;
    }
    Some(RuntimeStructuredError {
        code: "cursor.acp.provider-error".into(),
        message: message.to_string(),
        detail: None,
        is_recoverable: false,
        suggested_action: Some(
            "Select Auto or another available model, then retry the turn.".into(),
        ),
    })
}

fn usage(object: &Object) -> RuntimeUsage {
    let token_usage = object.get("tokenUsage").and_then(Value::as_object);
    // `last` describes the most recent model call — the live context. `total`
    // accumulates billing across calls and must never feed context_tokens
    // (a multi-call turn would report several times the real context size).
    let last = token_usage.and_then(|t| t.get("last").and_then(Value::as_object));
    let nested = token_usage
        .and_then(|t| t.get("total").and_then(Value::as_object))
        .or(token_usage)
        .unwrap_or(object);
    let empty = Object::new();
    let cache = nested
        .get("cache")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    RuntimeUsage {
        input_tokens: i(nested, &["input_tokens", "inputTokens", "input"]),
        output_tokens: i(nested, &["output_tokens", "outputTokens", "output"]),
        cached_input_tokens: i(
            nested,
            &["cache_read_input_tokens", "cachedInputTokens", "cacheRead"],
        )
        .or_else(|| i(cache, &["read"])),
        context_tokens: last
            .and_then(|l| i(l, &["totalTokens", "total_tokens"]))
            .or_else(|| i(nested, &["used", "contextTokens"])),
        context_window: i(
            token_usage.unwrap_or(object),
            &["modelContextWindow", "size", "contextWindow"],
        )
        .or_else(|| i(nested, &["modelContextWindow", "size", "contextWindow"])),
        cost: f(nested, &["cost", "amount"]),
        currency: s(nested, &["currency"]),
    }
}

/// Record the active model's context window from an ACP `session/new` or
/// `session/load` response (`models.availableModels[]._meta.totalContextTokens`,
/// as sent by Grok) so prompt-response usage can report `used / max`.
pub fn capture_acp_context_window(result: &Object, state: &mut NormalizerState) {
    let Some(models) = result.get("models").and_then(Value::as_object) else {
        return;
    };
    let current = models.get("currentModelId").and_then(Value::as_str);
    let Some(available) = models.get("availableModels").and_then(Value::as_array) else {
        return;
    };
    let window = available
        .iter()
        .filter_map(Value::as_object)
        .find(|model| current.is_none() || model.get("modelId").and_then(Value::as_str) == current)
        .and_then(|model| model.get("_meta").and_then(Value::as_object))
        .and_then(|meta| i(meta, &["totalContextTokens", "contextWindow"]));
    if window.is_some() {
        state.context_window = window;
    }
}

/// Usage for an ACP `session/prompt` response. The top-level `_meta` token
/// fields describe the turn's final model call — true context occupancy —
/// unlike the turn-cumulative billing figures nested under `_meta.usage`.
fn acp_prompt_usage(result: &Object, state: &NormalizerState) -> Option<RuntimeUsage> {
    let meta = result.get("_meta").and_then(Value::as_object)?;
    // Locally-handled turns (e.g. Grok slash commands) make no model call and
    // report totalTokens 0 — that is "no measurement", not an empty context.
    let context_tokens = i(meta, &["totalTokens"]).filter(|total| *total > 0)?;
    Some(RuntimeUsage {
        input_tokens: i(meta, &["inputTokens"]),
        output_tokens: i(meta, &["outputTokens"]),
        cached_input_tokens: i(meta, &["cachedReadTokens"]),
        context_tokens: Some(context_tokens),
        context_window: state.context_window,
        cost: None,
        currency: None,
    })
}

/// OpenCode `tokens` objects describe a single request; count cache writes as
/// context alongside the mapped cache reads.
fn opencode_step_usage(tokens: &Object) -> RuntimeUsage {
    let mut value = usage(tokens);
    per_request_context(
        &mut value,
        tokens
            .get("cache")
            .and_then(Value::as_object)
            .and_then(|cache| i(cache, &["write"])),
    );
    value
}

/// Derive context occupancy for usage payloads whose figures describe a single
/// model request (input + cached input + output ≈ tokens now in the window).
/// Callers must NOT use this for turn- or session-cumulative billing totals.
fn per_request_context(value: &mut RuntimeUsage, extra_cached: Option<i64>) {
    if value.context_tokens.is_some() {
        return;
    }
    let total = value.input_tokens.unwrap_or(0)
        + value.cached_input_tokens.unwrap_or(0)
        + extra_cached.unwrap_or(0)
        + value.output_tokens.unwrap_or(0);
    if total > 0 {
        value.context_tokens = Some(total);
    }
}

fn file_changes(value: Option<&Value>) -> Option<Vec<RuntimeFileChange>> {
    let values = value?.as_array()?;
    let objects: Vec<&Object> = values.iter().filter_map(Value::as_object).collect();
    if objects.len() != values.len() {
        return None;
    }
    Some(
        objects
            .iter()
            .enumerate()
            .map(|(index, item)| RuntimeFileChange {
                path: s(item, &["path", "file", "filePath"])
                    .unwrap_or_else(|| format!("File {}", index + 1)),
                change_type: s(item, &["kind", "type", "changeType"])
                    .unwrap_or_else(|| "update".into()),
                summary: s(item, &["summary"]),
                diff: s(item, &["diff", "patch"]),
            })
            .collect(),
    )
}

fn plan_steps(value: Option<&Value>) -> Option<Vec<RuntimePlanStep>> {
    let values = value?.as_array()?;
    let objects: Vec<&Object> = values.iter().filter_map(Value::as_object).collect();
    if objects.len() != values.len() {
        return None;
    }
    Some(
        objects
            .iter()
            .enumerate()
            .map(|(index, item)| RuntimePlanStep {
                id: s(item, &["id"]).unwrap_or_else(|| format!("step-{index}")),
                title: s(item, &["content", "title", "step"])
                    .unwrap_or_else(|| format!("Step {}", index + 1)),
                detail: s(item, &["description", "detail"]),
                state: runtime_state(s(item, &["status", "state"]).as_deref()),
            })
            .collect(),
    )
}

fn user_input(object: &Object) -> RuntimeUserInputRequest {
    let fallback = vec![Value::Object(object.clone())];
    let values: Vec<Value> = object
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or(fallback);
    let questions = values
        .iter()
        .filter_map(Value::as_object)
        .enumerate()
        .map(|(index, question)| {
            let multiple = question
                .get("multiple")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let options: Vec<RuntimeQuestionOption> = question
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(Value::as_object)
                        .enumerate()
                        .map(|(option_index, option)| RuntimeQuestionOption {
                            id: s(option, &["id", "optionId", "label"])
                                .unwrap_or_else(|| format!("option-{option_index}")),
                            label: s(option, &["label", "name"])
                                .unwrap_or_else(|| format!("Option {}", option_index + 1)),
                            description: s(option, &["description"]),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let kind = if options.is_empty() {
                RuntimeQuestionAnswerKind::FreeText
            } else if multiple {
                RuntimeQuestionAnswerKind::MultiSelect
            } else {
                RuntimeQuestionAnswerKind::SingleSelect
            };
            RuntimeQuestion {
                id: s(question, &["id"]).unwrap_or_else(|| format!("question-{index}")),
                header: s(question, &["header"]),
                prompt: s(question, &["question", "prompt"])
                    .unwrap_or_else(|| "Provider question".into()),
                answer_kind: kind,
                options,
                is_required: question
                    .get("required")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            }
        })
        .collect();
    RuntimeUserInputRequest {
        questions,
        expires_at: None,
    }
}

fn mcp_elicitation_input(params: &Object) -> Option<RuntimeUserInputRequest> {
    let schema = params.get("requestedSchema")?.as_object()?;
    let properties = schema.get("properties")?.as_object()?;
    if properties.is_empty() {
        return None;
    }
    let required: std::collections::HashSet<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut property_names: Vec<&String> = properties.keys().collect();
    property_names.sort();
    let questions = property_names
        .into_iter()
        .filter_map(|id| {
            let property = properties.get(id)?.as_object()?;
            let property_type = s(property, &["type"]);
            let multiple = property_type.as_deref() == Some("array");
            let options = mcp_elicitation_options(property);
            let answer_kind = if options.is_empty() {
                RuntimeQuestionAnswerKind::FreeText
            } else if multiple {
                RuntimeQuestionAnswerKind::MultiSelect
            } else {
                RuntimeQuestionAnswerKind::SingleSelect
            };
            Some(RuntimeQuestion {
                id: id.clone(),
                header: s(property, &["title"]),
                prompt: s(property, &["description", "title"])
                    .unwrap_or_else(|| format!("Provide {id}")),
                answer_kind,
                options,
                is_required: required.contains(id.as_str()),
            })
        })
        .collect::<Vec<_>>();
    (!questions.is_empty()).then_some(RuntimeUserInputRequest {
        questions,
        expires_at: None,
    })
}

fn mcp_elicitation_options(property: &Object) -> Vec<RuntimeQuestionOption> {
    if s(property, &["type"]).as_deref() == Some("boolean") {
        return ["true", "false"]
            .into_iter()
            .map(|value| RuntimeQuestionOption {
                id: value.into(),
                label: if value == "true" { "Yes" } else { "No" }.into(),
                description: None,
            })
            .collect();
    }
    let source = if s(property, &["type"]).as_deref() == Some("array") {
        property.get("items").and_then(Value::as_object)
    } else {
        Some(property)
    };
    let Some(source) = source else {
        return Vec::new();
    };
    if let Some(values) = source.get("enum").and_then(Value::as_array) {
        let labels = source.get("enumNames").and_then(Value::as_array);
        return values
            .iter()
            .filter_map(Value::as_str)
            .enumerate()
            .map(|(index, value)| RuntimeQuestionOption {
                id: value.into(),
                label: labels
                    .and_then(|items| items.get(index))
                    .and_then(Value::as_str)
                    .unwrap_or(value)
                    .into(),
                description: None,
            })
            .collect();
    }
    source
        .get("oneOf")
        .or_else(|| source.get("anyOf"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|option| {
            let id = s(option, &["const"])?;
            Some(RuntimeQuestionOption {
                label: s(option, &["title"]).unwrap_or_else(|| id.clone()),
                id,
                description: None,
            })
        })
        .collect()
}

fn approval_kind(name: &str) -> RuntimeApprovalKind {
    let value = name.to_lowercase();
    if value.contains("bash") || value.contains("command") {
        return RuntimeApprovalKind::Command;
    }
    if value.contains("read") {
        return RuntimeApprovalKind::FileRead;
    }
    if value.contains("write") || value.contains("edit") {
        return RuntimeApprovalKind::FileChange;
    }
    RuntimeApprovalKind::Tool
}

fn content_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(content) = value.as_object() {
        return content
            .get("text")
            .and_then(Value::as_str)
            .map(String::from);
    }
    if let Some(contents) = value.as_array() {
        let joined: String = contents
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect();
        return Some(joined);
    }
    value.as_str().map(String::from)
}

fn native_request_id(object: &Object) -> Option<String> {
    match object.get("id") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => value
            .as_i64()
            .map(|v| v.to_string())
            .or_else(|| Some(value.to_string())),
        _ => None,
    }
}

fn s(object: &Object, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(String::from)
}

fn i(object: &Object, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        let value = object.get(*key)?;
        value.as_i64().or_else(|| value.as_f64().map(|f| f as i64))
    })
}

fn f(object: &Object, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        let value = object.get(*key)?;
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
    })
}

fn json_string(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) | Value::Array(_) => serde_json::to_string_pretty(value).ok(),
        _ => None,
    }
}

/// Codex app-server includes the complete MCP result on completed tool items.
/// Prefer its structured payload for the human-readable activity detail and
/// never persist inline image base64 in workspace.json.
fn tool_result_output(value: Option<&Value>) -> Option<String> {
    let value = parsed_json_value(value?)?;
    let structured = value
        .get("structuredContent")
        .or_else(|| value.get("structured_content"));
    if let Some(structured) = structured.filter(|value| !value.is_null()) {
        return json_string(Some(structured));
    }
    let redacted = redact_inline_images(&value);
    json_string(Some(&redacted))
}

fn tool_result_artifacts(value: Option<&Value>) -> Option<Vec<RuntimeArtifact>> {
    let value = parsed_json_value(value?)?;
    let mut seen = HashSet::new();
    let mut artifacts = Vec::new();
    append_runtime_artifacts(&value, &mut seen, &mut artifacts);

    // MCP servers may omit structuredContent and return their typed result as
    // JSON text alongside image content. Codex app-server preserves that shape
    // verbatim, so recover durable artifact references from each JSON text
    // item without persisting the adjacent inline image bytes.
    if let Some(content) = value.get("content").and_then(Value::as_array) {
        for item in content {
            if item.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            let Some(text) = item.get("text").and_then(Value::as_str) else {
                continue;
            };
            let Ok(nested) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            append_runtime_artifacts(&nested, &mut seen, &mut artifacts);
        }
    }

    (!artifacts.is_empty()).then_some(artifacts)
}

fn append_runtime_artifacts(
    value: &Value,
    seen: &mut HashSet<Uuid>,
    artifacts: &mut Vec<RuntimeArtifact>,
) {
    let arrays = [
        value.pointer("/structuredContent/artifacts"),
        value.pointer("/structured_content/artifacts"),
        value.get("artifacts"),
    ];
    for array in arrays.into_iter().flatten().filter_map(Value::as_array) {
        for value in array {
            let Some(object) = value.as_object() else {
                continue;
            };
            let Some(id) = s(object, &["id"]).and_then(|id| Uuid::parse_str(&id).ok()) else {
                continue;
            };
            let Some(uri) = s(object, &["uri"]) else {
                continue;
            };
            let Some(mime_type) = s(object, &["mimeType", "mime_type"]) else {
                continue;
            };
            let Some(byte_length) = object
                .get("byteLength")
                .or_else(|| object.get("byte_length"))
                .and_then(Value::as_u64)
            else {
                continue;
            };
            if seen.insert(id) {
                artifacts.push(RuntimeArtifact {
                    id,
                    uri,
                    mime_type,
                    byte_length,
                    title: s(object, &["title"]),
                });
            }
        }
    }
}

fn parsed_json_value(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => serde_json::from_str(text).ok(),
        other => Some(other.clone()),
    }
}

fn redact_inline_images(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(redact_inline_images).collect()),
        Value::Object(object) => {
            let is_image = object.get("type").and_then(Value::as_str) == Some("image");
            Value::Object(
                object
                    .iter()
                    .map(|(key, value)| {
                        let value = if is_image && key == "data" {
                            Value::String(format!(
                                "[{} bytes of base64 image data omitted]",
                                value.as_str().map(str::len).unwrap_or_default()
                            ))
                        } else {
                            redact_inline_images(value)
                        };
                        (key.clone(), value)
                    })
                    .collect(),
            )
        }
        other => other.clone(),
    }
}
