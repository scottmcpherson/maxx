use maxx_core::contract::*;
use maxx_core::persist::ProviderProfile;
use maxx_lib::engine::runtime::Runtime;
use maxx_lib::engine::TurnRequest;
use uuid::Uuid;

fn fake_omp_profile() -> ProviderProfile {
    let script = format!(
        "{}/tests/fixtures/fake_omp_acp.py",
        env!("CARGO_MANIFEST_DIR")
    );
    let _ = std::process::Command::new("chmod")
        .args(["+x", &script])
        .status();
    let mut profile = ProviderProfile::default_for(ChatProvider::Omp);
    profile.executable_path = Some(script);
    profile
}

#[tokio::test]
async fn fake_omp_turn_configures_model_and_thinking_before_prompting() {
    let runtime = Runtime::without_browser();
    let profile = fake_omp_profile();
    let request = TurnRequest {
        turn_id: Uuid::new_v4(),
        thread_id: Uuid::new_v4(),
        provider_instance_id: profile.id,
        provider: ChatProvider::Omp,
        model: "sparky/qwen".into(),
        effort: Some("off".into()),
        speed: None,
        agent_instructions: None,
        prompt: "Confirm configuration".into(),
        attachments: Vec::new(),
        working_directory: std::env::temp_dir().to_string_lossy().to_string(),
        session_id: None,
        ephemeral: false,
        unattended: false,
        agent_id: None,
        host_tools: Vec::new(),
        profile,
    };

    let mut events = runtime.events_for(Uuid::nil(), request).await;
    let mut collected = Vec::new();
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
            Err(_) => panic!("fake OMP turn timed out; events so far: {collected:?}"),
        }
    }
    runtime.shutdown().await;

    assert!(collected.iter().any(|event| {
        event.kind.is(RuntimeEventKind::SESSION_BINDING)
            && event.payload.session_binding.as_deref() == Some("fake-omp-session-1")
    }));
    let text = collected
        .iter()
        .filter(|event| event.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA))
        .filter_map(|event| event.payload.text.as_deref())
        .collect::<String>();
    assert_eq!(text, "OMP configured");
    let terminals = collected
        .iter()
        .filter(|event| event.kind.is(RuntimeEventKind::TURN_TERMINAL))
        .collect::<Vec<_>>();
    assert_eq!(terminals.len(), 1, "events: {collected:?}");
    assert_eq!(
        terminals[0].payload.terminal_state,
        Some(ProviderTurnTerminalState::Completed)
    );
}
