//! End-to-end ACP engine test against a fake Grok agent whose `session/load`
//! replays the prior conversation as notifications before responding, the way
//! real ACP agents do. The replay must be dropped: only the live turn's
//! deltas may stream, and text/tool ordering must match emission order.

use maxx_core::contract::*;
use maxx_core::persist::ProviderProfile;
use maxx_lib::engine::runtime::Runtime;
use maxx_lib::engine::TurnRequest;
use uuid::Uuid;

fn fake_grok_profile() -> ProviderProfile {
    let script = format!(
        "{}/tests/fixtures/fake_grok_acp.py",
        env!("CARGO_MANIFEST_DIR")
    );
    let _ = std::process::Command::new("chmod")
        .args(["+x", &script])
        .status();
    let mut profile = ProviderProfile::default_for(ChatProvider::Grok);
    profile.executable_path = Some(script);
    profile
}

async fn collect_turn(runtime: &Runtime, request: TurnRequest) -> Vec<ProviderRuntimeEvent> {
    let mut events = runtime.events_for(Uuid::nil(), request).await;
    let mut collected: Vec<ProviderRuntimeEvent> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Some(event)) => {
                let terminal = event.kind.is(RuntimeEventKind::TURN_TERMINAL);
                collected.push(event);
                if terminal {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => panic!("fake ACP turn timed out; events so far: {collected:?}"),
        }
    }
    collected
}

#[tokio::test]
async fn session_load_replay_is_not_streamed_into_the_live_turn() {
    let runtime = Runtime::without_browser();
    let profile = fake_grok_profile();
    let request = TurnRequest {
        turn_id: Uuid::new_v4(),
        thread_id: Uuid::new_v4(),
        provider_instance_id: profile.id,
        provider: ChatProvider::Grok,
        model: "Default".into(),
        effort: None,
        speed: None,
        agent_instructions: None,
        prompt: "Second message".into(),
        attachments: Vec::new(),
        working_directory: std::env::temp_dir().to_string_lossy().to_string(),
        session_id: Some("fake-acp-session-1".into()),
        ephemeral: false,
        unattended: false,
        agent_id: None,
        host_tools: Vec::new(),
        profile,
    };
    let collected = collect_turn(&runtime, request).await;
    runtime.shutdown().await;

    // Exactly one completed terminal.
    let terminals: Vec<_> = collected
        .iter()
        .filter(|e| e.kind.is(RuntimeEventKind::TURN_TERMINAL))
        .collect();
    assert_eq!(terminals.len(), 1, "events: {collected:?}");
    assert_eq!(
        terminals[0].payload.terminal_state,
        Some(ProviderTurnTerminalState::Completed)
    );

    // The loaded session is bound.
    assert!(collected.iter().any(|e| {
        e.kind.is(RuntimeEventKind::SESSION_BINDING)
            && e.payload.session_binding.as_deref() == Some("fake-acp-session-1")
    }));

    // Only the live turn's text streams; the replayed history is dropped.
    let text: String = collected
        .iter()
        .filter(|e| e.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA))
        .filter_map(|e| e.payload.text.clone())
        .collect();
    assert_eq!(text, "Checking.Done.", "events: {collected:?}");
    assert!(collected.iter().all(|e| {
        e.payload.text.as_deref() != Some("Hi - how can I help you today?")
            && e.payload.text.as_deref() != Some("replayed thought")
    }));

    // Interleaving survives stamping: first delta < tool events < last delta.
    let delta_sequences: Vec<i64> = collected
        .iter()
        .filter(|e| e.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA))
        .map(|e| e.sequence)
        .collect();
    let tool_sequences: Vec<i64> = collected
        .iter()
        .filter(|e| e.kind.is(RuntimeEventKind::TOOL))
        .map(|e| e.sequence)
        .collect();
    assert_eq!(delta_sequences.len(), 2, "events: {collected:?}");
    assert!(!tool_sequences.is_empty(), "events: {collected:?}");
    assert!(tool_sequences
        .iter()
        .all(|s| *s > delta_sequences[0] && *s < delta_sequences[1]));
}

#[tokio::test]
async fn fresh_session_streams_live_deltas() {
    let runtime = Runtime::without_browser();
    let profile = fake_grok_profile();
    let request = TurnRequest {
        turn_id: Uuid::new_v4(),
        thread_id: Uuid::new_v4(),
        provider_instance_id: profile.id,
        provider: ChatProvider::Grok,
        model: "Default".into(),
        effort: None,
        speed: None,
        agent_instructions: None,
        prompt: "First message".into(),
        attachments: Vec::new(),
        working_directory: std::env::temp_dir().to_string_lossy().to_string(),
        session_id: None,
        ephemeral: false,
        unattended: false,
        agent_id: None,
        host_tools: Vec::new(),
        profile,
    };
    let collected = collect_turn(&runtime, request).await;
    runtime.shutdown().await;

    let text: String = collected
        .iter()
        .filter(|e| e.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA))
        .filter_map(|e| e.payload.text.clone())
        .collect();
    assert_eq!(text, "Checking.Done.", "events: {collected:?}");
    assert!(collected.iter().any(|e| {
        e.kind.is(RuntimeEventKind::SESSION_BINDING)
            && e.payload.session_binding.as_deref() == Some("fake-acp-session-1")
    }));
}
