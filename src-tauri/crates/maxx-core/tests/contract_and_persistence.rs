//! Ports of the contract-level guarantees from `ProviderRuntimeContractTests`,
//! `WorkspacePersistenceTests` and `ProviderLifecyclePersistenceTests`:
//! ordering/dedup, the terminal guarantee, retention, schema migration,
//! unknown-kind round-trips, and interrupted-turn recovery.

use maxx_core::contract::*;
use maxx_core::normalize::ProviderEventDraft;
use maxx_core::persist::*;
use maxx_core::{order, TurnStamper};
use uuid::Uuid;

fn event(
    turn_id: Uuid,
    sequence: i64,
    occurred_at: f64,
    kind: RuntimeEventKind,
) -> ProviderRuntimeEvent {
    ProviderRuntimeEvent {
        schema_version: CURRENT_EVENT_SCHEMA_VERSION,
        id: Uuid::new_v4(),
        provider_instance_id: ChatProvider::Codex.default_instance_id(),
        thread_id: Uuid::nil(),
        turn_id,
        item_id: None,
        request_id: None,
        sequence,
        occurred_at: AppleDate(occurred_at),
        kind,
        payload: RuntimeEventPayload::default(),
        native_reference: None,
    }
}

#[test]
fn ordering_is_by_sequence_then_timestamp_and_dedupes_event_ids() {
    let turn = Uuid::new_v4();
    let mut first = event(turn, 1, 100.0, RuntimeEventKind::session_state());
    let second = event(turn, 2, 90.0, RuntimeEventKind::assistant_text_delta());
    let third = event(turn, 3, 95.0, RuntimeEventKind::turn_terminal());
    // Duplicate ID with later payload must be discarded, keeping the earliest.
    first.payload.detail = Some("original".into());
    let mut duplicate = first.clone();
    duplicate.payload.detail = Some("duplicate".into());

    let ordered = order::ordered(&[third.clone(), first.clone(), duplicate, second.clone()]);
    assert_eq!(ordered.len(), 3);
    assert_eq!(ordered[0].id, first.id);
    assert_eq!(ordered[0].payload.detail.as_deref(), Some("original"));
    assert_eq!(ordered[1].id, second.id);
    assert_eq!(ordered[2].id, third.id);
}

#[test]
fn ordering_orders_turn_blocks_chronologically_not_by_local_sequence() {
    let early_turn = Uuid::new_v4();
    let late_turn = Uuid::new_v4();
    // Later turn has smaller sequences; blocks must still order by date.
    let late = event(late_turn, 1, 200.0, RuntimeEventKind::session_state());
    let early_a = event(early_turn, 5, 100.0, RuntimeEventKind::session_state());
    let early_b = event(early_turn, 6, 101.0, RuntimeEventKind::turn_terminal());

    let ordered = order::ordered(&[late.clone(), early_b.clone(), early_a.clone()]);
    assert_eq!(
        ordered.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![early_a.id, early_b.id, late.id]
    );
}

#[test]
fn stamper_emits_exactly_one_terminal_and_maps_error_completion_to_failed() {
    let mut stamper = TurnStamper::new(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let mut events = Vec::new();
    events.extend(stamper.stamp(ProviderEventDraft::Status("working".into())));
    events.extend(stamper.stamp(ProviderEventDraft::Payload {
        kind: RuntimeEventKind::error(),
        item_id: None,
        request_id: None,
        payload: RuntimeEventPayload {
            error: Some(RuntimeStructuredError {
                code: "test".into(),
                message: "boom".into(),
                detail: None,
                is_recoverable: true,
                suggested_action: None,
            }),
            ..Default::default()
        },
        native_reference: None,
    }));
    events.extend(stamper.stamp(ProviderEventDraft::Completed));
    // Duplicate native completion must be ignored after the first terminal.
    events.extend(stamper.stamp(ProviderEventDraft::Completed));
    events.extend(stamper.finish());

    let terminals: Vec<_> = events
        .iter()
        .filter(|e| e.kind.is(RuntimeEventKind::TURN_TERMINAL))
        .collect();
    assert_eq!(
        terminals.len(),
        1,
        "exactly one turn.terminal per started turn"
    );
    assert_eq!(
        terminals[0].payload.terminal_state,
        Some(ProviderTurnTerminalState::Failed),
        "a structured error upgrades a completed terminal to failed"
    );
    assert_eq!(
        events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
        (1..=events.len() as i64).collect::<Vec<_>>(),
        "sequences start at one and increase monotonically"
    );
}

#[test]
fn stamper_reuses_item_ids_for_updates_to_the_same_native_item() {
    let mut stamper = TurnStamper::new(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let running = stamper.stamp(ProviderEventDraft::Payload {
        kind: RuntimeEventKind::tool(),
        item_id: Some("native-item".into()),
        request_id: None,
        payload: RuntimeEventPayload::default(),
        native_reference: None,
    });
    let completed = stamper.stamp(ProviderEventDraft::Payload {
        kind: RuntimeEventKind::tool(),
        item_id: Some("native-item".into()),
        request_id: None,
        payload: RuntimeEventPayload::default(),
        native_reference: None,
    });
    assert_eq!(running[0].item_id, completed[0].item_id);
    assert!(running[0].item_id.is_some());
}

#[test]
fn stamper_failure_emits_structured_error_before_failed_terminal() {
    let mut stamper = TurnStamper::new(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let events = stamper.fail("adapter exploded".into());
    assert_eq!(events.len(), 2);
    assert!(events[0].kind.is(RuntimeEventKind::ERROR));
    assert!(events[1].kind.is(RuntimeEventKind::TURN_TERMINAL));
    assert_eq!(
        events[1].payload.terminal_state,
        Some(ProviderTurnTerminalState::Failed)
    );
}

#[test]
fn unknown_event_kind_round_trips_without_data_loss() {
    let mut source = event(
        Uuid::new_v4(),
        1,
        0.0,
        RuntimeEventKind("future.kind".into()),
    );
    source.payload.text = Some("payload survives".into());
    let json = serde_json::to_string(&source).unwrap();
    let decoded: ProviderRuntimeEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, source);
    assert!(!decoded.kind.is_known());
}

#[test]
fn swift_json_field_names_and_reference_dates_are_preserved() {
    let source = event(
        Uuid::new_v4(),
        1,
        774_000_000.5,
        RuntimeEventKind::session_state(),
    );
    let value: serde_json::Value = serde_json::to_value(&source).unwrap();
    let object = value.as_object().unwrap();
    for key in [
        "schemaVersion",
        "providerInstanceID",
        "threadID",
        "turnID",
        "occurredAt",
        "sequence",
        "kind",
        "payload",
    ] {
        assert!(
            object.contains_key(key),
            "missing Swift-compatible key {key}"
        );
    }
    assert_eq!(object["occurredAt"].as_f64(), Some(774_000_000.5));
    assert_eq!(object["kind"].as_str(), Some("session.state"));
}

#[test]
fn legacy_project_array_and_older_schemas_migrate_to_current_schema() {
    let dir = std::env::temp_dir().join(format!("maxx-core-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("workspace.json");

    let legacy = r#"[{"folderPath":"/tmp/project-a","threads":[{"title":"T","provider":"claude","model":"Default"}]}]"#;
    std::fs::write(&path, legacy).unwrap();
    let persistence = WorkspacePersistence::new(&path);
    let loaded = persistence.load().unwrap();
    assert_eq!(loaded.source_format, SourceFormat::LegacyProjectArray);
    assert_eq!(loaded.document.projects.len(), 1);
    assert_eq!(
        loaded.document.projects[0].threads[0].provider,
        ChatProvider::Claude
    );
    assert_eq!(
        loaded.document.projects[0].threads[0].instance_id(),
        ChatProvider::Claude.default_instance_id()
    );
    // Default profiles are guaranteed after normalization.
    assert!(loaded.document.provider_profiles.len() >= ChatProvider::ALL.len());

    persistence.save(&loaded.document).unwrap();
    let reloaded = persistence.load().unwrap();
    assert_eq!(
        reloaded.source_format,
        SourceFormat::VersionedDocument(CURRENT_WORKSPACE_SCHEMA_VERSION)
    );
    assert_eq!(
        reloaded.document.schema_version,
        CURRENT_WORKSPACE_SCHEMA_VERSION
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn title_generation_runtime_round_trips_and_can_be_unset() {
    let dir = std::env::temp_dir().join(format!("maxx-core-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("workspace.json");
    let persistence = WorkspacePersistence::new(&path);

    let mut document = WorkspaceDocument {
        title_generation_runtime: Some(TitleGenerationRuntime {
            provider: ChatProvider::Claude,
            model: "claude-sonnet-4-5".into(),
            effort: Some("high".into()),
            speed: None,
        }),
        ..Default::default()
    };
    persistence.save(&document).unwrap();
    assert_eq!(
        persistence.load().unwrap().document.title_generation_runtime,
        document.title_generation_runtime
    );

    document.title_generation_runtime = None;
    persistence.save(&document).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(json.get("titleGenerationRuntime").is_none());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn threads_referencing_missing_profiles_recover_a_disabled_placeholder() {
    let orphan_instance = Uuid::new_v4();
    let mut thread = ChatThread::new("Orphan".into(), ChatProvider::Grok, "Default".into());
    thread.provider_instance_id = Some(orphan_instance);
    let mut document = WorkspaceDocument {
        projects: vec![ChatProject {
            id: Uuid::new_v4(),
            folder_path: "/tmp/p".into(),
            threads: vec![thread],
        }],
        ..Default::default()
    };
    normalize(&mut document);
    let recovered = document
        .provider_profiles
        .iter()
        .find(|p| p.id == orphan_instance)
        .expect("recovered profile for orphaned thread");
    assert!(!recovered.is_enabled);
    assert_eq!(recovered.provider, ChatProvider::Grok);
    assert!(recovered.display_name.contains("Unavailable"));
}

#[test]
fn interrupted_turns_close_exactly_once_with_warning_then_terminal() {
    let turn = Uuid::new_v4();
    let mut thread = ChatThread::new("T".into(), ChatProvider::Codex, "Default".into());
    thread.provider_session_id = Some("native-1".into());
    thread.last_turn_id = Some(turn);
    let mut open_event = event(turn, 1, 10.0, RuntimeEventKind::assistant_text_delta());
    open_event.thread_id = thread.id;
    thread.runtime_events = vec![open_event];
    let mut projects = vec![ChatProject {
        id: Uuid::new_v4(),
        folder_path: "/tmp/p".into(),
        threads: vec![thread],
    }];

    assert_eq!(close_interrupted_turns(&mut projects), 1);
    let events = &projects[0].threads[0].runtime_events;
    let terminals: Vec<_> = events
        .iter()
        .filter(|e| e.kind.is(RuntimeEventKind::TURN_TERMINAL))
        .collect();
    assert_eq!(terminals.len(), 1);
    assert_eq!(
        terminals[0].payload.terminal_state,
        Some(ProviderTurnTerminalState::Interrupted)
    );
    let warning = events
        .iter()
        .find(|e| e.kind.is(RuntimeEventKind::WARNING))
        .unwrap();
    assert_eq!(
        warning.payload.title.as_deref(),
        Some("Turn interrupted by app exit")
    );

    // Running recovery again must be a no-op.
    assert_eq!(close_interrupted_turns(&mut projects), 0);
}

#[test]
fn retention_compacts_text_and_retains_interaction_metadata_beyond_the_cap() {
    let policy = RuntimeRetentionPolicy {
        maximum_events_per_thread: 100,
        maximum_text_characters_per_event: 1_000,
    };
    let turn = Uuid::new_v4();
    let mut events = Vec::new();
    // One early binding + approval that must survive compaction.
    let mut binding = event(turn, 1, 0.0, RuntimeEventKind::session_binding());
    binding.payload.session_binding = Some("session".into());
    events.push(binding.clone());
    let mut approval = event(turn, 2, 1.0, RuntimeEventKind::approval_request());
    approval.request_id = Some(Uuid::new_v4());
    events.push(approval.clone());
    for index in 0..150 {
        let mut delta = event(
            turn,
            3 + index,
            2.0 + index as f64,
            RuntimeEventKind::assistant_text_delta(),
        );
        delta.payload.text = Some("x".repeat(2_000));
        events.push(delta);
    }

    let compacted = policy.compact(&events);
    assert!(compacted.len() <= 102, "cap plus retained metadata");
    assert!(
        compacted.iter().any(|e| e.id == binding.id),
        "session binding retained"
    );
    assert!(
        compacted.iter().any(|e| e.id == approval.id),
        "approval retained"
    );
    let truncated = compacted
        .iter()
        .find(|e| e.kind.is(RuntimeEventKind::ASSISTANT_TEXT_DELTA))
        .unwrap();
    let text = truncated.payload.text.as_ref().unwrap();
    assert!(text.contains("output compacted by Maxx"));
    assert!(text.chars().count() < 1_100);
}

#[test]
fn interaction_records_derive_only_from_request_events() {
    let mut request = event(Uuid::new_v4(), 1, 0.0, RuntimeEventKind::approval_request());
    request.request_id = Some(Uuid::new_v4());
    let record = RuntimeInteractionRecord::from_event(&request).unwrap();
    assert_eq!(record.id, request.request_id.unwrap());
    assert_eq!(record.status, RuntimeInteractionStatus::Pending);
    assert!(record.status.is_actionable());

    let plain = event(
        Uuid::new_v4(),
        1,
        0.0,
        RuntimeEventKind::assistant_text_delta(),
    );
    assert!(RuntimeInteractionRecord::from_event(&plain).is_none());

    let mut missing_id = event(Uuid::new_v4(), 1, 0.0, RuntimeEventKind::approval_request());
    missing_id.request_id = None;
    assert!(RuntimeInteractionRecord::from_event(&missing_id).is_none());
}

#[test]
fn concurrency_policy_decodes_both_swift_key_spellings() {
    let modern = r#"{"globalLimit":3,"perProviderLimits":{"claude":1}}"#;
    let policy: ProviderConcurrencyPolicy = serde_json::from_str(modern).unwrap();
    assert_eq!(policy.global_limit, 3);
    assert_eq!(policy.limit(ChatProvider::Claude), 1);
    assert_eq!(policy.limit(ChatProvider::Pi), 3);

    let legacy = r#"{"global":2,"perProvider":{"codex":4}}"#;
    let policy: ProviderConcurrencyPolicy = serde_json::from_str(legacy).unwrap();
    assert_eq!(policy.global_limit, 2);
    assert_eq!(policy.limit(ChatProvider::Codex), 4);
}

/// The cross-provider handoff records its notice as a `system` message. Both
/// apps share `workspace.json`, so that role must survive a round trip with the
/// Swift-compatible spelling and must not be mistaken for conversation.
#[test]
fn handoff_system_notice_round_trips_in_the_shared_workspace_schema() {
    use maxx_core::handoff;

    let dir = std::env::temp_dir().join(format!("maxx-core-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("workspace.json");

    let mut thread = ChatThread::new("Handoff".into(), ChatProvider::Codex, "Default".into());
    thread.messages = vec![
        ChatMessage {
            id: Uuid::new_v4(),
            role: ChatRole::User,
            content: "respond with a full markdown test".into(),
            attachments: Vec::new(),
            annotations: Vec::new(),
            created_at: AppleDate(774_000_000.0),
            source_event_id: None,
            agent_id: None,
        },
        ChatMessage {
            id: Uuid::new_v4(),
            role: ChatRole::Assistant,
            content: "# Heading 1".into(),
            attachments: Vec::new(),
            annotations: Vec::new(),
            created_at: AppleDate(774_000_001.0),
            source_event_id: None,
            agent_id: None,
        },
        ChatMessage {
            id: Uuid::new_v4(),
            role: ChatRole::System,
            content: "Context handed off (Claude → Codex): 2 messages carried over.".into(),
            attachments: Vec::new(),
            annotations: Vec::new(),
            created_at: AppleDate(774_000_002.0),
            source_event_id: None,
            agent_id: None,
        },
    ];

    let mut document = WorkspaceDocument::default();
    document.projects.push(ChatProject {
        id: Uuid::new_v4(),
        folder_path: "/tmp/project".into(),
        threads: vec![thread],
    });

    // Swift's `ChatMessage.Role` encodes as its lowercase raw value.
    let value: serde_json::Value = serde_json::to_value(&document).unwrap();
    let roles: Vec<&str> = value["projects"][0]["threads"][0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["user", "assistant", "system"]);

    let persistence = WorkspacePersistence::new(&path);
    persistence.save(&document).unwrap();
    let reloaded = persistence.load().unwrap().document;
    let messages = &reloaded.projects[0].threads[0].messages;
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[2].role, ChatRole::System);
    assert_eq!(
        messages[2].content,
        "Context handed off (Claude → Codex): 2 messages carried over."
    );

    // The reloaded notice must not re-enter the next handoff as conversation.
    let handoff = handoff::render_handoff(messages, Some("Codex"), handoff::DEFAULT_HANDOFF_BUDGET)
        .expect("exchange is transferable");
    assert_eq!(handoff.included, 2);
    assert!(!handoff.preamble.contains("Context handed off"));

    std::fs::remove_dir_all(&dir).ok();
}
