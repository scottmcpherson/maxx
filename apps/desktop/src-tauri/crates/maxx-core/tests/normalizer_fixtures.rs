//! Port of `ProviderFixtureNormalizerTests.swift`. The JSONL fixtures are
//! byte-identical copies of `MaxxTests/Fixtures`, so the Rust normalizer is
//! held to the same recorded-protocol expectations as the Swift one.

use maxx_core::contract::*;
use maxx_core::normalize::{normalize, NormalizerState, ProviderEventDraft};
use maxx_core::StreamingJsonLineBuffer;
use uuid::Uuid;

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}.jsonl", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("fixture {path}: {e}"))
}

fn fixture_lines(name: &str) -> Vec<Vec<u8>> {
    fixture_bytes(name)
        .split(|&b| b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| l.to_vec())
        .collect()
}

fn run_fixture(
    name: &str,
    provider: ChatProvider,
    state: &mut NormalizerState,
) -> Vec<ProviderEventDraft> {
    fixture_lines(name)
        .iter()
        .flat_map(|line| {
            normalize(line, provider, state).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
        })
        .collect()
}

/// Port of `feedFixture`: replay the fixture through the streaming line buffer
/// with adversarial chunk sizes to prove byte-boundary independence.
fn feed_fixture(
    name: &str,
    chunk_sizes: &[usize],
    provider: ChatProvider,
    state: &mut NormalizerState,
) -> Vec<ProviderEventDraft> {
    let data = fixture_bytes(name);
    let mut buffer = StreamingJsonLineBuffer::new();
    let mut drafts = Vec::new();
    let mut offset = 0;
    let mut chunk_index = 0;
    while offset < data.len() {
        let size = chunk_sizes[chunk_index % chunk_sizes.len()].min(data.len() - offset);
        for line in buffer.append(&data[offset..offset + size]) {
            drafts.extend(normalize(&line, provider, state).expect(name));
        }
        offset += size;
        chunk_index += 1;
    }
    if let Some(line) = buffer.finish() {
        drafts.extend(normalize(&line, provider, state).expect(name));
    }
    drafts
}

fn assistant_text(drafts: &[ProviderEventDraft]) -> String {
    drafts
        .iter()
        .filter_map(|d| match d {
            ProviderEventDraft::AssistantDelta(text) => Some(text.clone()),
            ProviderEventDraft::Payload { kind, payload, .. }
                if kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA)
                    || kind.is(RuntimeEventKind::ASSISTANT_TEXT) =>
            {
                payload.text.clone()
            }
            _ => None,
        })
        .collect()
}

fn reasoning_text(drafts: &[ProviderEventDraft]) -> String {
    drafts
        .iter()
        .filter_map(|d| match d {
            ProviderEventDraft::Payload { kind, payload, .. }
                if kind.is(RuntimeEventKind::REASONING_SUMMARY) =>
            {
                payload.text.clone()
            }
            _ => None,
        })
        .collect()
}

fn reasoning_item_ids(drafts: &[ProviderEventDraft]) -> Vec<String> {
    drafts
        .iter()
        .filter_map(|d| match d {
            ProviderEventDraft::Payload { kind, item_id, .. }
                if kind.is(RuntimeEventKind::REASONING_SUMMARY) =>
            {
                item_id.clone()
            }
            _ => None,
        })
        .collect()
}

fn terminals(drafts: &[ProviderEventDraft]) -> Vec<ProviderTurnTerminalState> {
    drafts
        .iter()
        .filter_map(|d| match d {
            ProviderEventDraft::Terminal(state) => Some(*state),
            ProviderEventDraft::Completed => Some(ProviderTurnTerminalState::Completed),
            _ => None,
        })
        .collect()
}

fn usages(drafts: &[ProviderEventDraft]) -> Vec<RuntimeUsage> {
    drafts
        .iter()
        .filter_map(|d| match d {
            ProviderEventDraft::Payload { kind, payload, .. }
                if kind.is(RuntimeEventKind::USAGE) =>
            {
                payload.usage.clone()
            }
            _ => None,
        })
        .collect()
}

fn request_ids(drafts: &[ProviderEventDraft]) -> Vec<Uuid> {
    drafts
        .iter()
        .filter_map(|d| match d {
            ProviderEventDraft::Payload { request_id, .. } => *request_id,
            _ => None,
        })
        .collect()
}

fn unknown_raw_types(drafts: &[ProviderEventDraft]) -> Vec<String> {
    drafts
        .iter()
        .filter_map(|d| match d {
            ProviderEventDraft::Payload { kind, payload, .. }
                if kind.is(RuntimeEventKind::WARNING)
                    && payload.title.as_deref() == Some("Unknown provider event") =>
            {
                payload.raw_type.clone()
            }
            _ => None,
        })
        .collect()
}

fn is_kind(draft: &ProviderEventDraft, raw: &str) -> bool {
    matches!(draft, ProviderEventDraft::Payload { kind, .. } if kind.is(raw))
}

fn count_kind(drafts: &[ProviderEventDraft], raw: &str) -> usize {
    drafts.iter().filter(|d| is_kind(d, raw)).count()
}

fn completed_count(drafts: &[ProviderEventDraft]) -> usize {
    drafts
        .iter()
        .filter(|d| {
            matches!(
                d,
                ProviderEventDraft::Completed
                    | ProviderEventDraft::Terminal(ProviderTurnTerminalState::Completed)
            )
        })
        .count()
}

#[test]
fn live_codex_usage_warning_and_terminal_regression() {
    let mut state = NormalizerState::default();
    let drafts = run_fixture(
        "codex/live-usage-warning-2026-07-14",
        ChatProvider::Codex,
        &mut state,
    );

    assert_eq!(
        usages(&drafts),
        vec![RuntimeUsage {
            input_tokens: Some(21816),
            output_tokens: Some(12),
            cached_input_tokens: Some(9984),
            context_tokens: Some(21828),
            context_window: Some(258400),
            cost: None,
            currency: None,
        }],
        "provider=Codex fixture=live-usage-warning-2026-07-14 expected=populated-nested-usage"
    );
    assert_eq!(count_kind(&drafts, RuntimeEventKind::WARNING), 1);
    assert_eq!(count_kind(&drafts, RuntimeEventKind::ERROR), 0);
    assert_eq!(
        terminals(&drafts),
        vec![ProviderTurnTerminalState::Completed]
    );
}

#[test]
fn live_claude_text_block_stop_never_creates_phantom_tool() {
    let mut state = NormalizerState::default();
    let drafts = run_fixture(
        "claude/live-text-block-stop-2026-07-14",
        ChatProvider::Claude,
        &mut state,
    );

    assert_eq!(assistant_text(&drafts), "Test received.");
    assert_eq!(
        count_kind(&drafts, RuntimeEventKind::TOOL),
        0,
        "provider=Claude fixture=live-text-block-stop-2026-07-14 expected=no-phantom-tool"
    );
    assert_eq!(
        terminals(&drafts),
        vec![ProviderTurnTerminalState::Completed]
    );
}

#[test]
fn live_grok_housekeeping_reasoning_and_warning_regression() {
    let mut state = NormalizerState::default();
    let drafts = run_fixture(
        "grok/live-housekeeping-reasoning-2026-07-14",
        ChatProvider::Grok,
        &mut state,
    );

    assert_eq!(assistant_text(&drafts), "Test received.");
    assert_eq!(reasoning_text(&drafts), "Short thought.");
    let ids: std::collections::HashSet<String> = reasoning_item_ids(&drafts).into_iter().collect();
    assert_eq!(ids.len(), 1, "expected=stable-reasoning-item");
    assert_eq!(unknown_raw_types(&drafts), Vec::<String>::new());
    assert_eq!(
        count_kind(&drafts, RuntimeEventKind::WARNING),
        1,
        "expected=mcp-failure-warning"
    );
    assert_eq!(
        terminals(&drafts),
        vec![ProviderTurnTerminalState::Completed]
    );
}

#[test]
fn live_cursor_routine_notifications_and_provider_failure_regression() {
    let mut state = NormalizerState::default();
    let drafts = run_fixture(
        "cursor/live-default-failure-2026-07-14",
        ChatProvider::Cursor,
        &mut state,
    );

    assert_eq!(
        assistant_text(&drafts),
        "",
        "expected=error-not-assistant-text"
    );
    assert_eq!(reasoning_text(&drafts), "The user sent a test message.");
    let ids: std::collections::HashSet<String> = reasoning_item_ids(&drafts).into_iter().collect();
    assert_eq!(ids.len(), 1);
    assert_eq!(unknown_raw_types(&drafts), Vec::<String>::new());
    assert!(
        count_kind(&drafts, RuntimeEventKind::ERROR) > 0,
        "expected=structured-error"
    );
    assert_eq!(terminals(&drafts), vec![ProviderTurnTerminalState::Failed]);
}

#[test]
fn live_opencode_deltas_roles_steps_dedup_and_terminal_regression() {
    let mut state = NormalizerState::default();
    let drafts = run_fixture(
        "opencode/live-stream-role-steps-2026-07-14",
        ChatProvider::Opencode,
        &mut state,
    );

    assert_eq!(
        assistant_text(&drafts),
        "Test received.",
        "expected=assistant-only-exactly-once"
    );
    assert_eq!(reasoning_text(&drafts), "Short thought.");
    let ids: std::collections::HashSet<String> = reasoning_item_ids(&drafts).into_iter().collect();
    assert_eq!(ids.len(), 1);
    assert_eq!(unknown_raw_types(&drafts), Vec::<String>::new());
    assert_eq!(
        usages(&drafts).last().and_then(|u| u.input_tokens),
        Some(56)
    );
    assert_eq!(
        terminals(&drafts),
        vec![ProviderTurnTerminalState::Completed]
    );
}

#[test]
fn pi_fixture_remains_free_of_unknowns() {
    let mut state = NormalizerState::default();
    let drafts = run_fixture(
        "pi/rpc-stream-question-complete",
        ChatProvider::Pi,
        &mut state,
    );
    assert_eq!(unknown_raw_types(&drafts), Vec::<String>::new());
    assert_eq!(assistant_text(&drafts), "Hello world");
    assert_eq!(
        terminals(&drafts),
        vec![ProviderTurnTerminalState::Completed]
    );
}

#[test]
fn codex_app_server_fixture_captures_session_streaming_approval_and_terminal() {
    let mut state = NormalizerState::default();
    let drafts = feed_fixture(
        "codex/start-stream-approval-complete",
        &[1, 2, 5, 3, 8],
        ChatProvider::Codex,
        &mut state,
    );

    assert_eq!(state.session_id.as_deref(), Some("codex-session-1"));
    assert_eq!(completed_count(&drafts), 1);
    assert_eq!(assistant_text(&drafts), "Hello world");
    assert!(
        count_kind(&drafts, RuntimeEventKind::APPROVAL_REQUEST) > 0,
        "expected=approval"
    );
    assert!(
        count_kind(&drafts, RuntimeEventKind::COMMAND) > 0,
        "expected=command"
    );
}

#[test]
fn claude_fixture_captures_session_utf8_streaming_tool_usage_and_terminal() {
    let mut state = NormalizerState::default();
    let drafts = feed_fixture(
        "claude/stream-tool-complete",
        &[1],
        ChatProvider::Claude,
        &mut state,
    );

    assert_eq!(state.session_id.as_deref(), Some("claude-session-1"));
    assert_eq!(completed_count(&drafts), 1);
    assert_eq!(assistant_text(&drafts), "Hello world");
    assert!(
        count_kind(&drafts, RuntimeEventKind::TOOL) > 0,
        "expected=tool"
    );
    assert!(
        count_kind(&drafts, RuntimeEventKind::USAGE) > 0,
        "expected=usage"
    );
    assert!(
        count_kind(&drafts, RuntimeEventKind::PLAN) > 0,
        "expected=plan"
    );
    assert!(
        count_kind(&drafts, RuntimeEventKind::WARNING) > 0,
        "expected=warning"
    );
}

#[test]
fn grok_acp_fixture_captures_session_streaming_permission_and_terminal() {
    let mut state = NormalizerState::default();
    let drafts = feed_fixture(
        "grok/acp-stream-permission-complete",
        &[7, 1, 13, 2],
        ChatProvider::Grok,
        &mut state,
    );

    assert_eq!(state.session_id.as_deref(), Some("grok-session-1"));
    assert_eq!(completed_count(&drafts), 1);
    assert_eq!(assistant_text(&drafts), "Hello world");
    assert!(
        count_kind(&drafts, RuntimeEventKind::APPROVAL_REQUEST) > 0,
        "expected=approval"
    );
}

#[test]
fn hermes_acp_content_updates_preserve_tool_identity_and_expandable_body() {
    let mut state = NormalizerState::default();
    let drafts = run_fixture(
        "hermes/acp-content-tool-complete",
        ChatProvider::Hermes,
        &mut state,
    );

    let tools = drafts
        .iter()
        .filter_map(|draft| match draft {
            ProviderEventDraft::Payload {
                kind,
                item_id,
                payload,
                ..
            } if kind.is(RuntimeEventKind::TOOL) => Some((item_id, payload)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].0, tools[1].0);
    let started = tools[0].1.tool.as_ref().expect("started tool");
    assert_eq!(started.name, "navigate: https://example.com");
    assert_eq!(started.state, RuntimeItemState::Pending);
    assert!(started.input.as_deref().unwrap().contains("example.com"));
    let completed = tools[1].1.tool.as_ref().expect("completed tool");
    assert_eq!(completed.name, "navigate: https://example.com");
    assert_eq!(completed.state, RuntimeItemState::Completed);
    assert!(completed.input.as_deref().unwrap().contains("example.com"));
    assert_eq!(completed.output.as_deref(), Some("Example Domain"));

    let commands = drafts
        .iter()
        .filter_map(|draft| match draft {
            ProviderEventDraft::Payload {
                kind,
                item_id,
                payload,
                ..
            } if kind.is(RuntimeEventKind::COMMAND) => Some((item_id, payload)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0].0, commands[1].0);
    assert_eq!(commands[0].1.title.as_deref(), Some("browser_click"));
    assert_eq!(commands[0].1.state, Some(RuntimeItemState::Pending));
    assert!(commands[0]
        .1
        .command
        .as_deref()
        .unwrap()
        .contains("button-1"));
    assert_eq!(commands[1].1.title.as_deref(), Some("browser_click"));
    assert_eq!(commands[1].1.state, Some(RuntimeItemState::Completed));
    assert!(commands[1]
        .1
        .command
        .as_deref()
        .unwrap()
        .contains("button-1"));
    assert_eq!(commands[1].1.output.as_deref(), Some("Clicked button-1"));
}

#[test]
fn hermes_acp_screenshot_keeps_artifact_reference_without_inline_pixels() {
    let artifact_id = Uuid::new_v4();
    let tab_id = Uuid::new_v4();
    let result = serde_json::json!({
        "artifacts": [{
            "id": artifact_id,
            "uri": format!("maxx-browser://artifact/{artifact_id}"),
            "mimeType": "image/png",
            "byteLength": 24576,
            "title": "Browser screenshot"
        }],
        "tabId": tab_id,
        "value": {"title": "Browser screenshot"}
    })
    .to_string();
    let start = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {"sessionId": "hermes-session", "update": {
            "sessionUpdate": "tool_call", "toolCallId": "screenshot-1",
            "title": "browser_screenshot", "kind": "other",
            "content": [{"type": "content", "content": {"type": "text", "text": "{}"}}]
        }}
    });
    let completed = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {"sessionId": "hermes-session", "update": {
            "sessionUpdate": "tool_call_update", "toolCallId": "screenshot-1",
            "status": "completed",
            "content": [
                {"type": "content", "content": {"type": "text", "text": result}},
                {"type": "content", "content": {"type": "image", "data": "very-large-base64-pixels", "mimeType": "image/png"}}
            ]
        }}
    });
    let mut state = NormalizerState::default();
    normalize(
        &serde_json::to_vec(&start).expect("start"),
        ChatProvider::Hermes,
        &mut state,
    )
    .expect("normalized start");
    let drafts = normalize(
        &serde_json::to_vec(&completed).expect("completed"),
        ChatProvider::Hermes,
        &mut state,
    )
    .expect("normalized completion");
    let ProviderEventDraft::Payload { payload, .. } = &drafts[0] else {
        panic!("expected tool payload");
    };
    let artifacts = payload.artifacts.as_ref().expect("artifact reference");
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].id, artifact_id);
    assert_eq!(artifacts[0].byte_length, 24576);
    let output = payload
        .tool
        .as_ref()
        .and_then(|tool| tool.output.as_deref())
        .expect("tool output");
    assert!(output.contains("maxx-browser://artifact/"));
    assert!(!output.contains("very-large-base64-pixels"));
}

#[test]
fn grok_acp_prompt_response_reports_context_not_cumulative_billing() {
    let mut state = NormalizerState::default();
    let drafts = run_fixture(
        "grok/acp-usage-context-window",
        ChatProvider::Grok,
        &mut state,
    );

    // The turn_completed notification carries turn-cumulative billing (two
    // model calls summed); it must not claim to measure the context.
    // Only the prompt response's top-level _meta does — and a zero-token
    // response (locally-handled slash command, no model call) yields nothing.
    let usage = usages(&drafts);
    assert_eq!(
        usage.len(),
        2,
        "expected=billing-event-then-context-event-only"
    );
    assert_eq!(
        usage[0].context_tokens, None,
        "expected=no-context-from-billing-totals"
    );
    assert_eq!(usage[0].input_tokens, Some(32384));
    assert_eq!(
        usage[1],
        RuntimeUsage {
            input_tokens: Some(16233),
            output_tokens: Some(21),
            cached_input_tokens: Some(16128),
            context_tokens: Some(16254),
            context_window: Some(500000),
            cost: None,
            currency: None,
        },
        "expected=last-model-call-context-with-window"
    );
    assert_eq!(
        terminals(&drafts),
        vec![
            ProviderTurnTerminalState::Completed,
            ProviderTurnTerminalState::Completed
        ]
    );
}

#[test]
fn cursor_acp_fixture_captures_session_reasoning_plan_streaming_and_terminal() {
    let mut state = NormalizerState::default();
    let drafts = feed_fixture(
        "cursor/acp-stream-question-complete",
        &[3, 1, 4, 1, 5, 9],
        ChatProvider::Cursor,
        &mut state,
    );

    assert_eq!(state.session_id.as_deref(), Some("cursor-session-1"));
    assert_eq!(completed_count(&drafts), 1);
    assert_eq!(assistant_text(&drafts), "Done");
    assert!(
        count_kind(&drafts, RuntimeEventKind::PLAN) > 0,
        "expected=plan"
    );
    assert!(
        count_kind(&drafts, RuntimeEventKind::REASONING_SUMMARY) > 0,
        "expected=reasoning"
    );
}

#[test]
fn opencode_fixture_captures_session_streaming_tool_requests_and_terminal() {
    let mut state = NormalizerState::default();
    let drafts = feed_fixture(
        "opencode/server-stream-question-complete",
        &[2, 11, 1, 6],
        ChatProvider::Opencode,
        &mut state,
    );

    assert_eq!(state.session_id.as_deref(), Some("opencode-session-1"));
    assert_eq!(completed_count(&drafts), 1);
    assert_eq!(assistant_text(&drafts), "Hello");
    assert!(
        count_kind(&drafts, RuntimeEventKind::TOOL) > 0,
        "expected=tool"
    );
    assert!(
        count_kind(&drafts, RuntimeEventKind::APPROVAL_REQUEST) > 0,
        "expected=approval"
    );
    assert!(
        count_kind(&drafts, RuntimeEventKind::USER_INPUT_REQUEST) > 0,
        "expected=question"
    );
}

#[test]
fn pi_rpc_fixture_captures_session_streaming_tools_question_usage_and_terminal() {
    let mut state = NormalizerState::default();
    let drafts = feed_fixture(
        "pi/rpc-stream-question-complete",
        &[1, 7, 2, 13],
        ChatProvider::Pi,
        &mut state,
    );

    assert_eq!(state.session_id.as_deref(), Some("pi-session-1"));
    assert_eq!(completed_count(&drafts), 1);
    assert_eq!(assistant_text(&drafts), "Hello world");
    assert!(count_kind(&drafts, RuntimeEventKind::REASONING_SUMMARY) > 0);
    assert!(count_kind(&drafts, RuntimeEventKind::COMMAND) > 0);
    assert!(count_kind(&drafts, RuntimeEventKind::FILE_CHANGE) > 0);
    assert!(count_kind(&drafts, RuntimeEventKind::USER_INPUT_REQUEST) > 0);
    assert!(count_kind(&drafts, RuntimeEventKind::USAGE) > 0);
}

#[test]
fn normalizers_handle_empty_malformed_unknown_and_out_of_order_messages() {
    let mut state = NormalizerState::default();
    assert!(normalize(b"", ChatProvider::Codex, &mut state)
        .unwrap()
        .is_empty());
    assert!(normalize(b"{broken", ChatProvider::Codex, &mut state).is_err());

    let unknown = normalize(
        br#"{"method":"future/event","params":{}}"#,
        ChatProvider::Codex,
        &mut state,
    )
    .unwrap();
    assert_eq!(
        unknown_raw_types(&unknown),
        vec!["future/event".to_string()]
    );

    let out_of_order = normalize(
        br#"{"method":"item/agentMessage/delta","params":{"threadId":"future-session","turnId":"future-turn","itemId":"m","delta":"early"}}"#,
        ChatProvider::Codex,
        &mut state,
    )
    .unwrap();
    assert_eq!(
        assistant_text(&out_of_order),
        "early",
        "expected=preserved-delta"
    );
}

#[test]
fn codex_suppresses_completed_assistant_aggregate_and_known_housekeeping() {
    let mut state = NormalizerState::default();
    let messages = [
        r#"{"method":"item/agentMessage/delta","params":{"itemId":"message-1","delta":"Hello"}}"#,
        r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"message-1","text":"Hello"}}}"#,
        r#"{"method":"item/completed","params":{"item":{"type":"userMessage","id":"user-1","content":[]}}}"#,
        r#"{"method":"thread/status/changed","params":{"status":{"type":"idle"}}}"#,
        r#"{"method":"mcpServer/startupStatus/updated","params":{"name":"filesystem","status":"ready","error":null}}"#,
        r#"{"method":"hook/started","params":{"run":{"id":"hook-1","eventName":"userPromptSubmit","status":"running","entries":[]}}}"#,
        r#"{"method":"hook/completed","params":{"run":{"id":"hook-1","eventName":"userPromptSubmit","status":"completed","entries":[]}}}"#,
    ];
    let drafts: Vec<ProviderEventDraft> = messages
        .iter()
        .flat_map(|m| normalize(m.as_bytes(), ChatProvider::Codex, &mut state).unwrap())
        .collect();

    assert_eq!(assistant_text(&drafts), "Hello");
    assert_eq!(count_kind(&drafts, RuntimeEventKind::WARNING), 0);
}

#[test]
fn codex_does_not_repeat_completed_message_after_streaming_deltas() {
    let mut state = NormalizerState::default();
    let delta = normalize(
        br#"{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"message-1","delta":"Hello"}}"#,
        ChatProvider::Codex,
        &mut state,
    )
    .unwrap();
    let completed = normalize(
        br#"{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":"message-1","text":"Hello"}}}"#,
        ChatProvider::Codex,
        &mut state,
    )
    .unwrap();
    let mut all = delta;
    all.extend(completed);
    assert_eq!(assistant_text(&all), "Hello");

    let mut non_streaming_state = NormalizerState::default();
    let non_streaming = normalize(
        br#"{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":"message-2","text":"Complete only"}}}"#,
        ChatProvider::Codex,
        &mut non_streaming_state,
    )
    .unwrap();
    assert_eq!(assistant_text(&non_streaming), "Complete only");
}

#[test]
fn opencode_does_not_repeat_aggregate_after_streaming_deltas() {
    let mut state = NormalizerState::default();
    let messages = [
        r#"{"type":"message.part.updated","properties":{"part":{"id":"part-1","sessionID":"session","type":"text","text":"Hello"},"delta":"Hello "}}"#,
        r#"{"type":"message.part.updated","properties":{"part":{"id":"part-1","sessionID":"session","type":"text","text":"Hello world"},"delta":"world"}}"#,
        r#"{"type":"message.part.updated","properties":{"part":{"id":"part-1","sessionID":"session","type":"text","text":"Hello world"}}}"#,
    ];
    let drafts: Vec<ProviderEventDraft> = messages
        .iter()
        .flat_map(|m| normalize(m.as_bytes(), ChatProvider::Opencode, &mut state).unwrap())
        .collect();
    assert_eq!(assistant_text(&drafts), "Hello world");

    let mut aggregate_only_state = NormalizerState::default();
    let aggregate_only = normalize(
        br#"{"type":"message.part.updated","properties":{"part":{"id":"part-2","sessionID":"session","type":"text","text":"Complete only"}}}"#,
        ChatProvider::Opencode,
        &mut aggregate_only_state,
    )
    .unwrap();
    assert_eq!(assistant_text(&aggregate_only), "Complete only");
}

#[test]
fn opencode_suppresses_empty_session_diffs_and_excludes_session_metadata() {
    let mut state = NormalizerState::default();
    let empty = normalize(
        br#"{"type":"session.diff","properties":{"sessionID":"opencode-session-1","diff":[]}}"#,
        ChatProvider::Opencode,
        &mut state,
    )
    .unwrap();
    assert!(
        empty.is_empty(),
        "empty session diffs are bookkeeping noise"
    );

    let populated = normalize(
        br#"{"type":"session.diff","properties":{"sessionID":"opencode-session-1","diff":[{"path":"src/main.rs","type":"update","diff":"@@ -1 +1 @@"}]}}"#,
        ChatProvider::Opencode,
        &mut state,
    )
    .unwrap();
    let [ProviderEventDraft::Payload { kind, payload, .. }] = populated.as_slice() else {
        panic!("expected one diff payload");
    };
    assert!(kind.is(RuntimeEventKind::DIFF));
    assert_eq!(
        payload
            .files
            .as_ref()
            .and_then(|files| files.first())
            .map(|file| file.path.as_str()),
        Some("src/main.rs")
    );
    let diff = payload.diff.as_deref().expect("renderable diff");
    assert!(diff.contains("@@ -1 +1 @@"));
    assert!(!diff.contains("sessionID"));
    assert!(!diff.contains("opencode-session-1"));
}

#[test]
fn codex_suppresses_benign_lifecycle_noise_but_preserves_failures() {
    let mut state = NormalizerState::default();
    let benign_lines = [
        r#"{"method":"thread/status/changed","params":{"threadId":"thread","status":{"type":"active","activeFlags":[]}}}"#,
        r#"{"method":"thread/goal/cleared","params":{"threadId":"thread"}}"#,
        r#"{"method":"reasoning","params":{"threadId":"thread","turnId":"turn","summary":[]}}"#,
        r#"{"method":"mcpServer/startupStatus/updated","params":{"name":"example","status":"ready"}}"#,
        r#"{"method":"hook/started","params":{"threadId":"thread","run":{"status":"running"}}}"#,
        r#"{"method":"hook/completed","params":{"threadId":"thread","run":{"status":"completed","entries":[]}}}"#,
        r#"{"method":"item/completed","params":{"threadId":"thread","item":{"type":"userMessage","id":"user-1","content":[]}}}"#,
    ];
    for line in benign_lines {
        assert!(
            normalize(line.as_bytes(), ChatProvider::Codex, &mut state)
                .unwrap()
                .is_empty(),
            "{line}"
        );
    }

    let mcp_failure = normalize(
        br#"{"method":"mcpServer/startupStatus/updated","params":{"name":"broken","status":"failed","error":"connection refused"}}"#,
        ChatProvider::Codex,
        &mut state,
    )
    .unwrap();
    assert!(count_kind(&mcp_failure, RuntimeEventKind::WARNING) > 0);

    let thread_failure = normalize(
        br#"{"method":"thread/status/changed","params":{"threadId":"thread","status":{"type":"systemError"}}}"#,
        ChatProvider::Codex,
        &mut state,
    )
    .unwrap();
    assert!(count_kind(&thread_failure, RuntimeEventKind::ERROR) > 0);
}

#[test]
fn codex_mcp_elicitation_is_actionable_user_input() {
    let mut state = NormalizerState::default();
    let drafts = normalize(
        br#"{"id":41,"method":"mcpServer/elicitation/request","params":{"threadId":"thread","serverName":"example","mode":"form","message":"Choose browser access","requestedSchema":{"type":"object","required":["scope"],"properties":{"scope":{"type":"string","title":"Scope","enum":["page","site"],"enumNames":["This page","This site"]},"remember":{"type":"boolean","description":"Remember this choice"}}}}}"#,
        ChatProvider::Codex,
        &mut state,
    )
    .unwrap();

    let ProviderEventDraft::Payload {
        kind,
        request_id,
        payload,
        ..
    } = &drafts[0]
    else {
        panic!("expected interactive payload");
    };
    assert!(kind.is(RuntimeEventKind::USER_INPUT_REQUEST));
    assert!(request_id.is_some());
    let input = payload.user_input.as_ref().expect("user input");
    assert_eq!(input.questions.len(), 2);
    let scope = input
        .questions
        .iter()
        .find(|question| question.id == "scope")
        .expect("scope question");
    assert!(scope.is_required);
    assert_eq!(scope.options[0].label, "This page");
}

#[test]
fn codex_mcp_image_result_keeps_artifact_reference_without_persisting_pixels() {
    let artifact_id = Uuid::new_v4();
    let message = serde_json::json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread",
            "turnId": "turn",
            "item": {
                "type": "mcpToolCall",
                "id": "tool-1",
                "tool": "browser_screenshot",
                "arguments": {"tabId": Uuid::new_v4(), "fullPage": false},
                "result": {
                    "content": [
                        {"type": "text", "text": "screenshot metadata"},
                        {"type": "image", "data": "very-large-base64-pixels", "mimeType": "image/png"}
                    ],
                    "structuredContent": {
                        "artifacts": [{
                            "id": artifact_id,
                            "uri": format!("maxx-browser://artifact/{artifact_id}"),
                            "mimeType": "image/png",
                            "byteLength": 19083,
                            "title": "Browser screenshot"
                        }]
                    }
                }
            }
        }
    });
    let mut state = NormalizerState::default();
    let drafts = normalize(
        &serde_json::to_vec(&message).expect("message"),
        ChatProvider::Codex,
        &mut state,
    )
    .expect("normalized");
    let ProviderEventDraft::Payload { payload, .. } = &drafts[0] else {
        panic!("expected tool payload");
    };
    let artifacts = payload.artifacts.as_ref().expect("artifact reference");
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].id, artifact_id);
    assert_eq!(artifacts[0].byte_length, 19083);
    let output = payload
        .tool
        .as_ref()
        .and_then(|tool| tool.output.as_deref())
        .expect("tool output");
    assert!(output.contains("maxx-browser://artifact/"));
    assert!(!output.contains("very-large-base64-pixels"));
}

#[test]
fn codex_mcp_image_result_recovers_artifact_from_json_text_content() {
    let artifact_id = Uuid::new_v4();
    let tab_id = Uuid::new_v4();
    let text_result = serde_json::json!({
        "artifacts": [{
            "id": artifact_id,
            "uri": format!("maxx-browser://artifact/{artifact_id}"),
            "mimeType": "image/png",
            "byteLength": 19083,
            "title": "Browser screenshot"
        }],
        "controlEpoch": 0,
        "tabId": tab_id,
        "value": {
            "id": artifact_id,
            "uri": format!("maxx-browser://artifact/{artifact_id}"),
            "mimeType": "image/png",
            "byteLength": 19083,
            "title": "Browser screenshot"
        }
    })
    .to_string();
    let message = serde_json::json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread",
            "turnId": "turn",
            "item": {
                "type": "mcpToolCall",
                "id": "tool-1",
                "tool": "browser_screenshot",
                "arguments": {"tabId": tab_id, "fullPage": false},
                "result": {
                    "content": [
                        {"type": "text", "text": text_result},
                        {"type": "image", "data": "very-large-base64-pixels", "mimeType": "image/png"}
                    ],
                    "structuredContent": null
                }
            }
        }
    });
    let mut state = NormalizerState::default();
    let drafts = normalize(
        &serde_json::to_vec(&message).expect("message"),
        ChatProvider::Codex,
        &mut state,
    )
    .expect("normalized");
    let ProviderEventDraft::Payload { payload, .. } = &drafts[0] else {
        panic!("expected tool payload");
    };
    let artifacts = payload.artifacts.as_ref().expect("artifact reference");
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].id, artifact_id);
    assert_eq!(artifacts[0].byte_length, 19083);
    let output = payload
        .tool
        .as_ref()
        .and_then(|tool| tool.output.as_deref())
        .expect("tool output");
    assert!(output.contains("maxx-browser://artifact/"));
    assert!(!output.contains("very-large-base64-pixels"));
}

#[test]
fn stable_native_request_identifiers_survive_fixture_replay() {
    let mut first = NormalizerState::default();
    let mut second = NormalizerState::default();
    let first_drafts = run_fixture(
        "codex/start-stream-approval-complete",
        ChatProvider::Codex,
        &mut first,
    );
    let second_drafts = run_fixture(
        "codex/start-stream-approval-complete",
        ChatProvider::Codex,
        &mut second,
    );
    let first_ids = request_ids(&first_drafts);
    assert!(
        !first_ids.is_empty(),
        "fixture should produce at least one interactive request"
    );
    assert_eq!(
        first_ids,
        request_ids(&second_drafts),
        "expected=stable-request-ids"
    );
}
