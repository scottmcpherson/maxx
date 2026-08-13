//! Live cross-provider handoff check against real provider CLIs.
//!
//! Runs only when `MAXX_LIVE_HANDOFF=1` so the default suite stays offline and
//! fast. This is the test that answers the actual product question: after a
//! runtime switch, does the incoming provider genuinely know what was discussed,
//! and does the framing stop it from re-answering the replayed turns?

use maxx_core::contract::*;
use maxx_core::handoff::{render_handoff, DEFAULT_HANDOFF_BUDGET};
use maxx_core::persist::{ChatMessage, ChatRole, ProviderProfile};
use maxx_lib::engine::runtime::Runtime;
use maxx_lib::engine::TurnRequest;
use uuid::Uuid;

fn enabled() -> bool {
    std::env::var("MAXX_LIVE_HANDOFF").ok().as_deref() == Some("1")
}

fn message(role: ChatRole, content: &str) -> ChatMessage {
    ChatMessage {
        id: Uuid::new_v4(),
        role,
        content: content.into(),
        attachments: Vec::new(),
        annotations: Vec::new(),
        created_at: AppleDate::default(),
        source_event_id: None,
        agent_id: None,
    }
}

/// The transcript a Claude thread would hold after "respond with a full
/// markdown test", trimmed to what matters for the follow-up question.
fn claude_transcript() -> Vec<ChatMessage> {
    vec![
        message(ChatRole::User, "respond with a full markdown test"),
        message(
            ChatRole::Assistant,
            "# Markdown Test\n\n\
             ## Heading 2\n\n\
             Some **bold** and *italic* text with `inline code`.\n\n\
             - bullet one\n- bullet two\n\n\
             1. numbered one\n2. numbered two\n\n\
             > A blockquote.\n\n\
             ```python\nprint(\"hello\")\n```\n\n\
             | Column A | Column B |\n| --- | --- |\n| a | b |\n",
        ),
    ]
}

async fn run_turn(
    provider: ChatProvider,
    prompt: String,
) -> (String, Option<ProviderTurnTerminalState>) {
    let runtime = Runtime::without_browser();
    let profile = ProviderProfile::default_for(provider);
    // Both CLIs reject an empty model, so use the provider's default option the
    // same way the composer does.
    let model = maxx_lib::engine::catalog::list_models_for_profile(&profile, None)
        .await
        .into_iter()
        .find(|option| option.is_default)
        .map(|option| option.model)
        .expect("provider exposes a default model");
    let request = TurnRequest {
        turn_id: Uuid::new_v4(),
        thread_id: Uuid::new_v4(),
        provider_instance_id: profile.id,
        provider,
        model,
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
    let mut text = String::new();
    let mut terminal = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Some(event)) => {
                if event.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA)
                    || event.kind.is(RuntimeEventKind::ASSISTANT_TEXT)
                {
                    text.push_str(event.payload.text.as_deref().unwrap_or_default());
                }
                if event.kind.is(RuntimeEventKind::ERROR) {
                    eprintln!("provider error: {:?}", event.payload.error);
                }
                if event.kind.is(RuntimeEventKind::TURN_TERMINAL) {
                    terminal = event.payload.terminal_state;
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => panic!(
                "{} turn timed out; text so far: {text}",
                provider.display_name()
            ),
        }
    }
    runtime.shutdown().await;
    (text, terminal)
}

/// The incoming provider must answer *about* the prior conversation.
#[tokio::test]
async fn codex_answers_from_claudes_handed_off_context() {
    if !enabled() {
        return;
    }
    let handoff = render_handoff(&claude_transcript(), Some("Claude"), DEFAULT_HANDOFF_BUDGET)
        .expect("exchange is transferable");
    let prompt = handoff.apply(
        "what did we just chat about? Answer in one short sentence, and do not \
         reproduce the content.",
    );

    let (text, terminal) = run_turn(ChatProvider::Codex, prompt).await;
    println!("--- codex answer ---\n{text}\n--------------------");
    assert_eq!(terminal, Some(ProviderTurnTerminalState::Completed));
    assert!(!text.trim().is_empty(), "codex returned no assistant text");

    // It knows the subject: it must reference the markdown test.
    let lower = text.to_ascii_lowercase();
    assert!(
        lower.contains("markdown"),
        "codex did not use the handed-off context; answer was: {text}"
    );

    // And the framing held: it summarised rather than re-rendering the test.
    // A genuine re-answer reproduces the fenced block and the table.
    assert!(
        !(text.contains("```") && text.contains("| Column A |")),
        "codex re-answered the replayed prompt instead of continuing: {text}"
    );
}

/// Same handoff, different incoming runtime: the seam is provider-agnostic.
#[tokio::test]
async fn claude_answers_from_codexs_handed_off_context() {
    if !enabled() {
        return;
    }
    let transcript = vec![
        message(ChatRole::User, "what is the capital of Portugal?"),
        message(ChatRole::Assistant, "Lisbon."),
    ];
    let handoff = render_handoff(&transcript, Some("Codex"), DEFAULT_HANDOFF_BUDGET)
        .expect("exchange is transferable");
    let prompt = handoff.apply("which city did you just name? Reply with only the city name.");

    let (text, terminal) = run_turn(ChatProvider::Claude, prompt).await;
    println!("--- claude answer ---\n{text}\n---------------------");
    assert_eq!(terminal, Some(ProviderTurnTerminalState::Completed));
    assert!(
        text.to_ascii_lowercase().contains("lisbon"),
        "claude did not use the handed-off context; answer was: {text}"
    );
}
