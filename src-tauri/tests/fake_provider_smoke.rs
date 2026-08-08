//! End-to-end runtime smoke test: a real child process (fake Claude CLI)
//! drives the full pipeline — spawn → control handshake → stream-json →
//! normalization → stamping — and must satisfy the canonical contract:
//! session binding, streamed assistant text, usage, and exactly one
//! completed terminal.

use maxx_core::contract::*;
use maxx_core::persist::ProviderProfile;
use maxx_lib::engine::runtime::Runtime;
use maxx_lib::engine::TurnRequest;
use uuid::Uuid;

fn fake_claude_profile() -> ProviderProfile {
    let script = format!(
        "{}/tests/fixtures/fake_claude.py",
        env!("CARGO_MANIFEST_DIR")
    );
    // Ensure it is executable for the spawn path used by real profiles.
    let _ = std::process::Command::new("chmod")
        .args(["+x", &script])
        .status();
    let mut profile = ProviderProfile::default_for(ChatProvider::Claude);
    profile.executable_path = Some(script);
    profile
}

#[tokio::test]
async fn fake_claude_turn_streams_and_terminates_exactly_once() {
    let runtime = Runtime::without_browser();
    let profile = fake_claude_profile();
    let request = TurnRequest {
        turn_id: Uuid::new_v4(),
        thread_id: Uuid::new_v4(),
        provider_instance_id: profile.id,
        provider: ChatProvider::Claude,
        model: "Default".into(),
        effort: None,
        speed: None,
        agent_instructions: None,
        prompt: "Say hello".into(),
        attachments: Vec::new(),
        working_directory: std::env::temp_dir().to_string_lossy().to_string(),
        session_id: None,
        agent_id: None,
        browser_access: None,
        profile,
    };

    let mut events = runtime.events_for(Uuid::nil(), request.clone()).await;
    let mut collected: Vec<ProviderRuntimeEvent> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let next = tokio::time::timeout_at(deadline, events.recv()).await;
        match next {
            Ok(Some(event)) => {
                let terminal = event.kind.is(RuntimeEventKind::TURN_TERMINAL);
                collected.push(event);
                if terminal {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => panic!("fake provider turn timed out; events so far: {collected:?}"),
        }
    }
    runtime.shutdown().await;

    // Terminal guarantee: exactly one turn.terminal, state completed.
    let terminals: Vec<_> = collected
        .iter()
        .filter(|e| e.kind.is(RuntimeEventKind::TURN_TERMINAL))
        .collect();
    assert_eq!(terminals.len(), 1, "events: {collected:?}");
    assert_eq!(
        terminals[0].payload.terminal_state,
        Some(ProviderTurnTerminalState::Completed)
    );

    // Session binding from the native init event.
    assert!(collected.iter().any(|e| {
        e.kind.is(RuntimeEventKind::SESSION_BINDING)
            && e.payload.session_binding.as_deref() == Some("fake-claude-session-1")
    }));

    // Streamed assistant text is preserved in order.
    let text: String = collected
        .iter()
        .filter(|e| e.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA))
        .filter_map(|e| e.payload.text.clone())
        .collect();
    assert_eq!(text, "Hello from the fake provider");

    // Usage from the result frame.
    assert!(collected.iter().any(|e| {
        e.kind.is(RuntimeEventKind::USAGE)
            && e.payload.usage.as_ref().and_then(|u| u.input_tokens) == Some(7)
    }));

    // Identity and ordering: sequences start at one and increase.
    let ordered = maxx_core::order::ordered(&collected);
    assert_eq!(ordered.len(), collected.len());
    for (index, event) in ordered.iter().enumerate() {
        assert_eq!(event.sequence, (index + 1) as i64);
        assert_eq!(event.thread_id, request.thread_id);
        assert_eq!(event.turn_id, request.turn_id);
    }
}
