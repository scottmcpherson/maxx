//! Real PTY smoke: broker launch, streamed ANSI output, input, resize, stop,
//! archive persistence, and browser-authority lifecycle through an executable
//! fake provider TUI.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use maxx_core::contract::ChatProvider;
use maxx_core::persist::{
    ChatProject, ChatSurface, ChatThread, ProviderProfile, WorkspaceDocument, WorkspacePersistence,
};
use maxx_lib::browser_runtime::{BrowserRuntime, FakeBrowserEngine};
use maxx_lib::events::EventSink;
use maxx_lib::state::AppState;
use maxx_lib::terminal::TerminalBroker;
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

struct NoEvents;

impl EventSink for NoEvents {
    fn emit_value(&self, _event: &str, _payload: Value) {}
}

async fn read_until(
    broker: &TerminalBroker,
    thread_id: Uuid,
    cursor: &mut u64,
    needle: &str,
) -> String {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut output = String::new();
    while !output.contains(needle) {
        let read = tokio::time::timeout_at(deadline, broker.read(thread_id, *cursor, None))
            .await
            .expect("terminal output timed out")
            .expect("terminal read");
        for chunk in read.chunks {
            output.push_str(&String::from_utf8_lossy(
                &STANDARD.decode(chunk.data_base64).expect("base64 output"),
            ));
            *cursor = chunk.cursor;
        }
    }
    output
}

#[tokio::test]
#[ignore = "requires loopback socket permission"]
async fn terminal_broker_round_trips_a_real_pty_and_archives_on_gui_handoff() {
    let root = std::env::temp_dir().join(format!("maxx-terminal-smoke-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("temporary directory");
    let browser = BrowserRuntime::start(
        Arc::new(FakeBrowserEngine::default()),
        root.join("browser-artifacts"),
    )
    .await
    .expect("browser runtime");
    let project_id = Uuid::new_v4();
    let mut thread = ChatThread::new(
        "Terminal smoke".into(),
        ChatProvider::Opencode,
        "Default".into(),
    );
    thread.provider_session_id = Some(Uuid::new_v4().to_string());
    let thread_id = thread.id;
    let script = format!(
        "{}/tests/fixtures/fake_terminal.py",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut profile = ProviderProfile::default_for(ChatProvider::Opencode);
    profile.executable_path = Some(script);
    profile.environment.insert("NO_COLOR".into(), "1".into());
    let document = WorkspaceDocument {
        projects: vec![ChatProject {
            id: project_id,
            folder_path: root.to_string_lossy().into_owned(),
            threads: vec![thread],
        }],
        provider_profiles: vec![profile],
        ..Default::default()
    };
    let app = Arc::new(AppState::from_document(
        document,
        WorkspacePersistence::new(root.join("workspace.json")),
        browser.clone(),
        Arc::new(NoEvents),
    ));

    let status = app
        .terminals
        .start(app.clone(), project_id, thread_id, Some(24), Some(80))
        .await
        .expect("terminal start");
    assert!(status.browser_available);
    assert_eq!(
        app.workspace.lock().await.projects[0].threads[0].surface,
        ChatSurface::Terminal
    );

    let mut cursor = 0;
    let ready = read_until(&app.terminals, thread_id, &mut cursor, "FAKE_TUI_READY").await;
    assert!(
        ready.contains("\x1b[32m"),
        "ANSI output was not preserved: {ready:?}"
    );
    assert!(
        ready.contains("FAKE_TUI_ENV:NO_COLOR=<unset>;TERM=xterm-256color;COLORTERM=truecolor"),
        "PTY child inherited the wrong color environment: {ready:?}"
    );
    app.terminals
        .resize(thread_id, 30, 100)
        .await
        .expect("resize");
    app.terminals
        .input(thread_id, STANDARD.encode(b"hello terminal\r"))
        .await
        .expect("terminal input");
    let echo = read_until(
        &app.terminals,
        thread_id,
        &mut cursor,
        "FAKE_TUI_ECHO:hello terminal",
    )
    .await;
    assert!(echo.contains("FAKE_TUI_ECHO:hello terminal"));

    app.terminals
        .input(thread_id, STANDARD.encode(b"/exit\r"))
        .await
        .expect("terminal exit input");
    let exit_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let status = app
            .terminals
            .status(thread_id)
            .await
            .expect("terminal status");
        if status.state == maxx_lib::terminal::TerminalProcessState::Exited {
            break;
        }
        assert!(
            tokio::time::Instant::now() < exit_deadline,
            "terminal did not exit"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let restarted = app
        .terminals
        .start(app.clone(), project_id, thread_id, Some(30), Some(100))
        .await
        .expect("terminal restart");
    assert_eq!(
        restarted.state,
        maxx_lib::terminal::TerminalProcessState::Running
    );
    let mut restart_cursor = 0;
    let restarted_output = read_until(
        &app.terminals,
        thread_id,
        &mut restart_cursor,
        "FAKE_TUI_READY",
    )
    .await;
    assert!(restarted_output.contains("FAKE_TUI_READY"));

    app.terminals
        .stop(
            app.clone(),
            project_id,
            thread_id,
            Some("FAKE_TUI_READY\nFAKE_TUI_ECHO:hello terminal".into()),
        )
        .await
        .expect("terminal stop");
    let workspace = app.workspace.lock().await;
    let stored = &workspace.projects[0].threads[0];
    assert_eq!(stored.surface, ChatSurface::Gui);
    assert_eq!(stored.terminal_archives.len(), 1);
    assert!(stored.terminal_archives[0]
        .content
        .contains("hello terminal"));
    drop(workspace);

    app.runtime.shutdown().await;
    browser.shutdown().await.expect("browser shutdown");
    std::fs::remove_dir_all(&root).expect("temporary cleanup");
}

async fn reconciles_native_terminal_turn(provider: ChatProvider) {
    let root = std::env::temp_dir().join(format!(
        "maxx-terminal-reconcile-{}-{}",
        provider.raw_value(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).expect("temporary directory");
    let browser = BrowserRuntime::start(
        Arc::new(FakeBrowserEngine::default()),
        root.join("browser-artifacts"),
    )
    .await
    .expect("browser runtime");
    let project_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let mut thread = ChatThread::new(
        format!("{} reconciliation", provider.display_name()),
        provider,
        "Default".into(),
    );
    thread.provider_session_id = Some(session_id.to_string());
    let thread_id = thread.id;
    let script = format!(
        "{}/tests/fixtures/fake_native_terminal.py",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut profile = ProviderProfile::default_for(provider);
    profile.executable_path = Some(script);
    profile.home_directory = Some(root.to_string_lossy().into_owned());
    profile
        .environment
        .insert("FAKE_SESSION_ID".into(), session_id.to_string());

    let native_path = match provider {
        ChatProvider::Pi => {
            let sessions = root.join("pi-sessions");
            let project = sessions.join("--project--");
            std::fs::create_dir_all(&project).expect("Pi session directory");
            let path = project.join(format!("2026-08-13T12-00-00Z_{session_id}.jsonl"));
            std::fs::write(
                &path,
                [
                    serde_json::json!({"type":"session","version":3,"id":session_id,"timestamp":"2026-08-13T12:00:00Z","cwd":root}).to_string(),
                    serde_json::json!({"type":"message","id":"baseline-user","parentId":null,"timestamp":"2026-08-13T12:00:01Z","message":{"role":"user","content":[{"type":"text","text":"baseline prompt"}]}}).to_string(),
                    serde_json::json!({"type":"message","id":"baseline-assistant","parentId":"baseline-user","timestamp":"2026-08-13T12:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"baseline answer"}]}}).to_string(),
                ]
                .join("\n")
                    + "\n",
            )
            .expect("Pi session fixture");
            profile.environment.insert(
                "PI_CODING_AGENT_SESSION_DIR".into(),
                sessions.to_string_lossy().into_owned(),
            );
            profile
                .environment
                .insert("FAKE_NATIVE_KIND".into(), "pi".into());
            path
        }
        ChatProvider::Grok => {
            let grok_home = root.join("grok-home");
            let session = grok_home
                .join("sessions")
                .join("%2Fproject")
                .join(session_id.to_string());
            std::fs::create_dir_all(&session).expect("Grok session directory");
            std::fs::write(grok_home.join("config.toml"), "[ui]\ncompact_mode = true\n")
                .expect("Grok config fixture");
            let path = session.join("updates.jsonl");
            std::fs::write(
                &path,
                [
                    serde_json::json!({"timestamp":1786203711,"method":"session/update","params":{"sessionId":session_id,"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"baseline prompt"}},"_meta":{"eventId":"baseline-user"}}}).to_string(),
                    serde_json::json!({"timestamp":1786203712,"method":"session/update","params":{"sessionId":session_id,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"baseline answer"}},"_meta":{"eventId":"baseline-assistant","promptId":"baseline-prompt"}}}).to_string(),
                    serde_json::json!({"timestamp":1786203713,"method":"_x.ai/session/update","params":{"sessionId":session_id,"update":{"sessionUpdate":"turn_completed"},"_meta":{"eventId":"baseline-complete"}}}).to_string(),
                ]
                .join("\n")
                    + "\n",
            )
            .expect("Grok updates fixture");
            profile
                .environment
                .insert("GROK_HOME".into(), grok_home.to_string_lossy().into_owned());
            profile
                .environment
                .insert("FAKE_NATIVE_KIND".into(), "grok".into());
            path
        }
        ChatProvider::Hermes => {
            let hermes_home = root.join("hermes-home");
            std::fs::create_dir_all(&hermes_home).expect("Hermes home");
            std::fs::write(hermes_home.join("config.yaml"), "model:\n  default: test\n")
                .expect("Hermes config fixture");
            let path = hermes_home.join("state.db");
            let connection = rusqlite::Connection::open(&path).expect("Hermes state fixture");
            connection
                .execute_batch(
                    "CREATE TABLE sessions (id TEXT PRIMARY KEY);
                     CREATE TABLE messages (
                        id INTEGER PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        role TEXT NOT NULL,
                        content TEXT,
                        timestamp REAL NOT NULL,
                        active INTEGER NOT NULL DEFAULT 1
                     );",
                )
                .expect("Hermes schema fixture");
            connection
                .execute(
                    "INSERT INTO sessions (id) VALUES (?1)",
                    [session_id.to_string()],
                )
                .expect("Hermes session fixture");
            connection
                .execute(
                    "INSERT INTO messages (id, session_id, role, content, timestamp, active)
                     VALUES (1, ?1, 'user', 'baseline prompt', 1786203711, 1),
                            (2, ?1, 'assistant', 'baseline answer', 1786203712, 1)",
                    [session_id.to_string()],
                )
                .expect("Hermes messages fixture");
            drop(connection);
            profile.environment.insert(
                "HERMES_HOME".into(),
                hermes_home.to_string_lossy().into_owned(),
            );
            profile
                .environment
                .insert("FAKE_NATIVE_KIND".into(), "hermes".into());
            path
        }
        ChatProvider::Cursor => {
            let transcript = root
                .join(".cursor/projects")
                .join("project")
                .join("agent-transcripts")
                .join(session_id.to_string())
                .join(format!("{session_id}.jsonl"));
            std::fs::create_dir_all(transcript.parent().unwrap())
                .expect("Cursor transcript directory");
            std::fs::write(
                &transcript,
                [
                    serde_json::json!({"role":"user","timestamp":1786203711,"message":{"content":[{"type":"text","text":"baseline prompt"}]}}).to_string(),
                    serde_json::json!({"role":"assistant","timestamp":1786203712,"message":{"content":[{"type":"text","text":"baseline answer"}]}}).to_string(),
                ]
                .join("\n")
                    + "\n",
            )
            .expect("Cursor transcript fixture");
            profile
                .environment
                .insert("FAKE_NATIVE_KIND".into(), "cursor".into());
            transcript
        }
        _ => panic!("unsupported reconciliation fixture provider"),
    };
    profile.environment.insert(
        "FAKE_NATIVE_PATH".into(),
        native_path.to_string_lossy().into_owned(),
    );

    let document = WorkspaceDocument {
        projects: vec![ChatProject {
            id: project_id,
            folder_path: root.to_string_lossy().into_owned(),
            threads: vec![thread],
        }],
        provider_profiles: vec![profile],
        ..Default::default()
    };
    let app = Arc::new(AppState::from_document(
        document,
        WorkspacePersistence::new(root.join("workspace.json")),
        browser.clone(),
        Arc::new(NoEvents),
    ));

    let status = app
        .terminals
        .start(app.clone(), project_id, thread_id, Some(24), Some(80))
        .await
        .expect("terminal start");
    assert!(status.browser_available);
    let mut cursor = 0;
    read_until(&app.terminals, thread_id, &mut cursor, "FAKE_NATIVE_READY").await;
    app.terminals
        .input(thread_id, STANDARD.encode(b"terminal prompt\r"))
        .await
        .expect("terminal input");
    read_until(
        &app.terminals,
        thread_id,
        &mut cursor,
        "FAKE_NATIVE_RECORDED:terminal prompt",
    )
    .await;
    app.terminals
        .stop(
            app.clone(),
            project_id,
            thread_id,
            Some("archive fallback must not be used".into()),
        )
        .await
        .expect("terminal stop");

    let workspace = app.workspace.lock().await;
    let stored = &workspace.projects[0].threads[0];
    assert_eq!(stored.surface, ChatSurface::Gui);
    assert!(stored.terminal_archives.is_empty());
    assert_eq!(stored.messages.len(), 2);
    assert_eq!(stored.messages[0].content, "terminal prompt");
    assert_eq!(stored.messages[1].content, "native answer");
    drop(workspace);

    app.runtime.shutdown().await;
    browser.shutdown().await.expect("browser shutdown");
    std::fs::remove_dir_all(&root).expect("temporary cleanup");
}

#[tokio::test]
#[ignore = "requires loopback socket permission"]
async fn native_terminal_turns_reconcile_into_gui_messages() {
    reconciles_native_terminal_turn(ChatProvider::Pi).await;
    reconciles_native_terminal_turn(ChatProvider::Grok).await;
    reconciles_native_terminal_turn(ChatProvider::Hermes).await;
    reconciles_native_terminal_turn(ChatProvider::Cursor).await;
}
