//! Transport-level proof of the cross-provider context handoff.
//!
//! `handoff_for_thread` is unit-tested in `commands.rs`, but that only shows the
//! preamble is assembled correctly. These tests spawn a real child process that
//! echoes the prompt it received, so what they assert is what actually crossed
//! the process boundary into a provider.

use maxx_core::contract::*;
use maxx_core::handoff::{render_handoff, DEFAULT_HANDOFF_BUDGET};
use maxx_core::persist::{ChatMessage, ChatRole, ProviderProfile};
use maxx_lib::engine::runtime::Runtime;
use maxx_lib::engine::TurnRequest;
use uuid::Uuid;

fn echo_profile() -> ProviderProfile {
    let script = format!(
        "{}/tests/fixtures/fake_claude_echo.py",
        env!("CARGO_MANIFEST_DIR")
    );
    let _ = std::process::Command::new("chmod")
        .args(["+x", &script])
        .status();
    let mut profile = ProviderProfile::default_for(ChatProvider::Claude);
    profile.executable_path = Some(script);
    profile
}

fn message(role: ChatRole, content: &str) -> ChatMessage {
    ChatMessage {
        id: Uuid::new_v4(),
        role,
        content: content.into(),
        attachments: Vec::new(),
        annotations: Vec::new(),
        text_selections: Vec::new(),
        created_at: AppleDate::default(),
        source_event_id: None,
        agent_id: None,
    }
}

/// Run one turn and return the assistant text the provider streamed back.
async fn echoed_prompt(prompt: String) -> String {
    let runtime = Runtime::without_browser();
    let profile = echo_profile();
    let request = TurnRequest {
        turn_id: Uuid::new_v4(),
        thread_id: Uuid::new_v4(),
        provider_instance_id: profile.id,
        provider: ChatProvider::Claude,
        model: "Default".into(),
        effort: None,
        speed: None,
        agent_instructions: None,
        prompt,
        attachments: Vec::new(),
        working_directory: std::env::temp_dir().to_string_lossy().to_string(),
        session_id: None,
        agent_id: None,
        browser_access: None,
        profile,
    };

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
            Err(_) => panic!("echo provider timed out; events so far: {collected:?}"),
        }
    }
    runtime.shutdown().await;

    assert_eq!(
        collected
            .iter()
            .filter(|e| e.kind.is(RuntimeEventKind::TURN_TERMINAL))
            .count(),
        1,
        "terminal guarantee still holds with a handoff preamble"
    );

    collected
        .iter()
        .filter(|e| {
            e.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA)
                || e.kind.is(RuntimeEventKind::ASSISTANT_TEXT)
        })
        .filter_map(|e| e.payload.text.clone())
        .collect()
}

#[tokio::test]
async fn handoff_preamble_reaches_the_provider_process() {
    // The scenario: Claude answered a markdown-test prompt, the thread was
    // switched to another runtime, and the follow-up asks about that history.
    let messages = vec![
        message(ChatRole::User, "respond with a full markdown test"),
        message(ChatRole::Assistant, "# Heading 1\n\n- list item\n\n`code`"),
    ];
    let handoff = render_handoff(&messages, Some("Claude"), DEFAULT_HANDOFF_BUDGET)
        .expect("exchange is transferable");
    let sent = handoff.apply("what did we just chat about?");

    let received = echoed_prompt(sent.clone()).await;

    // Byte-identical round trip: nothing was dropped, reordered or re-escaped by
    // the transport, and the delimiters survive JSON encoding intact.
    assert_eq!(received, sent);
    assert!(received.contains("<maxx-handoff>"));
    assert!(received.contains("</maxx-handoff>"));
    assert!(received.contains("respond with a full markdown test"));
    assert!(received.contains("# Heading 1"));
    assert!(received.contains("a different assistant (Claude)"));
    assert!(received
        .trim_end()
        .ends_with("what did we just chat about?"));
}

#[tokio::test]
async fn plain_prompt_is_unchanged_without_a_handoff() {
    // A thread with a live native session must not gain a preamble.
    let received = echoed_prompt("what did we just chat about?".into()).await;
    assert_eq!(received, "what did we just chat about?");
    assert!(!received.contains("maxx-handoff"));
}
