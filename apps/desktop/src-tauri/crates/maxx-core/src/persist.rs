//! Port of `ChatModels.swift`, `ProviderProfiles.swift` (data model) and
//! `WorkspacePersistence.swift`: the `workspace.json` document, schema
//! migration, retention compaction, and interrupted-turn recovery.

use crate::contract::*;
use crate::error::CoreError;
use crate::order;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const CURRENT_WORKSPACE_SCHEMA_VERSION: i64 = 11;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatAttachment {
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    pub path: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserAnnotationRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserAnnotationContext {
    pub id: String,
    #[serde(rename = "tabId")]
    pub tab_id: String,
    pub url: String,
    pub selector: String,
    #[serde(rename = "tagName")]
    pub tag_name: String,
    pub role: Option<String>,
    pub name: String,
    pub text: String,
    pub instruction: String,
    #[serde(rename = "previewDataUrl")]
    pub preview_data_url: String,
    pub rect: BrowserAnnotationRect,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    pub role: ChatRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ChatAttachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotations: Vec<BrowserAnnotationContext>,
    #[serde(
        rename = "textSelections",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub text_selections: Vec<ChatTextSelection>,
    #[serde(rename = "createdAt")]
    pub created_at: AppleDate,
    #[serde(
        rename = "sourceEventID",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub source_event_id: Option<Uuid>,
    /// Agent that produced this message (assistant messages in agent threads).
    #[serde(rename = "agentID", skip_serializing_if = "Option::is_none", default)]
    pub agent_id: Option<Uuid>,
}

/// A user-selected excerpt from the parent transcript attached to a side-chat
/// prompt. The full parent transcript is supplied separately as context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatTextSelection {
    pub id: String,
    pub text: String,
}

/// A preconfigured agent: a named persona with pinned instructions and runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentDefinition {
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    pub name: String,
    /// Operator instructions injected into the provider prompt whenever the
    /// agent handles a turn.
    #[serde(default)]
    pub instructions: String,
    pub provider: ChatProvider,
    #[serde(default)]
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speed: Option<String>,
    /// Avatar tint; the UI derives a gradient and pairs it with initials.
    #[serde(rename = "colorHex", default)]
    pub color_hex: String,
    /// Optional emoji that replaces the initials avatar.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub emoji: Option<String>,
    /// Absolute path of an imported avatar image in the workspace's
    /// agent-images store; emoji/initials render when unset.
    #[serde(rename = "imagePath", skip_serializing_if = "Option::is_none", default)]
    pub image_path: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: AppleDate,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: AppleDate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatSurface {
    Gui,
    Terminal,
}

impl Default for ChatSurface {
    fn default() -> Self {
        Self::Gui
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TerminalArchive {
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    pub content: String,
    #[serde(rename = "startedAt", default)]
    pub started_at: AppleDate,
    #[serde(rename = "endedAt", default)]
    pub ended_at: AppleDate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatThread {
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    pub title: String,
    pub provider: ChatProvider,
    #[serde(rename = "providerInstanceID", default)]
    pub provider_instance_id: Option<Uuid>,
    pub model: String,
    /// Reasoning / effort / thinking level when the provider supports it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub effort: Option<String>,
    /// Speed tier when the provider exposes a separate speed control.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speed: Option<String>,
    /// Which first-class conversation surface should own this thread.
    #[serde(default)]
    pub surface: ChatSurface,
    /// Thread-scoped working directory. Present only when the chat owns an
    /// isolated Git worktree; ordinary chats use their project's folder.
    #[serde(
        rename = "workingDirectory",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub working_directory: Option<String>,
    #[serde(
        rename = "providerSessionID",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub provider_session_id: Option<String>,
    #[serde(
        rename = "providerResumeCursor",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub provider_resume_cursor: Option<String>,
    #[serde(
        rename = "lastTurnID",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_turn_id: Option<Uuid>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(rename = "runtimeEvents", default)]
    pub runtime_events: Vec<ProviderRuntimeEvent>,
    #[serde(rename = "interactionRequests", default)]
    pub interaction_requests: Vec<RuntimeInteractionRecord>,
    /// Rendered terminal scrollback captured at terminal-to-GUI handoff.
    #[serde(rename = "terminalArchives", default)]
    pub terminal_archives: Vec<TerminalArchive>,
    /// Set on side threads: the main thread this conversation branched from.
    #[serde(
        rename = "parentThreadID",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub parent_thread_id: Option<Uuid>,
    /// Set on side threads: the parent-thread message the branch hangs off.
    #[serde(
        rename = "anchorMessageID",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub anchor_message_id: Option<Uuid>,
    /// Agent that most recently handled (or is handling) a turn here.
    #[serde(rename = "agentID", skip_serializing_if = "Option::is_none", default)]
    pub agent_id: Option<Uuid>,
    /// Rendered parent-thread transcript captured when the side thread was
    /// created; replayed to any agent that starts a fresh provider session here.
    #[serde(
        rename = "contextSeed",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub context_seed: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: AppleDate,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: AppleDate,
}

impl ChatThread {
    pub fn new(title: String, provider: ChatProvider, model: String) -> Self {
        let now = AppleDate::now();
        Self {
            id: Uuid::new_v4(),
            title,
            provider,
            provider_instance_id: Some(provider.default_instance_id()),
            model,
            effort: None,
            speed: None,
            surface: ChatSurface::Gui,
            working_directory: None,
            provider_session_id: None,
            provider_resume_cursor: None,
            last_turn_id: None,
            messages: Vec::new(),
            runtime_events: Vec::new(),
            interaction_requests: Vec::new(),
            terminal_archives: Vec::new(),
            parent_thread_id: None,
            anchor_message_id: None,
            agent_id: None,
            context_seed: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Effective instance ID, mirroring the Swift decoding fallback to the
    /// provider's default instance.
    pub fn instance_id(&self) -> Uuid {
        self.provider_instance_id
            .unwrap_or_else(|| self.provider.default_instance_id())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatProject {
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    #[serde(rename = "folderPath")]
    pub folder_path: String,
    #[serde(default)]
    pub threads: Vec<ChatThread>,
}

/// Optional global runtime used for compact background text generation such
/// as thread titles. `None` means the owning thread's runtime is used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TitleGenerationRuntime {
    pub provider: ChatProvider,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speed: Option<String>,
}

impl ChatProject {
    pub fn name(&self) -> String {
        Path::new(&self.folder_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| self.folder_path.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderProfile {
    pub id: Uuid,
    pub provider: ChatProvider,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(
        rename = "executablePath",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub executable_path: Option<String>,
    #[serde(rename = "serverURL", skip_serializing_if = "Option::is_none", default)]
    pub server_url: Option<String>,
    #[serde(
        rename = "homeDirectory",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub home_directory: Option<String>,
    #[serde(default)]
    pub environment: HashMap<String, String>,
    #[serde(rename = "colorHex", default)]
    pub color_hex: String,
    #[serde(rename = "isEnabled", default = "default_true")]
    pub is_enabled: bool,
    #[serde(rename = "hiddenModels", default)]
    pub hidden_models: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl ProviderProfile {
    pub fn default_for(provider: ChatProvider) -> Self {
        Self {
            id: provider.default_instance_id(),
            provider,
            display_name: provider.display_name().to_string(),
            executable_path: None,
            server_url: None,
            home_directory: None,
            environment: HashMap::new(),
            color_hex: provider.default_profile_color_hex().to_string(),
            is_enabled: true,
            hidden_models: Vec::new(),
        }
    }

    pub fn default_profiles() -> Vec<Self> {
        ChatProvider::ALL
            .iter()
            .map(|p| Self::default_for(*p))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderConcurrencyPolicy {
    #[serde(
        rename = "globalLimit",
        alias = "global",
        default = "default_global_limit"
    )]
    pub global_limit: i64,
    #[serde(rename = "perProviderLimits", alias = "perProvider", default)]
    pub per_provider_limits: HashMap<ChatProvider, i64>,
}

fn default_global_limit() -> i64 {
    4
}

impl Default for ProviderConcurrencyPolicy {
    fn default() -> Self {
        Self {
            global_limit: 4,
            per_provider_limits: ChatProvider::ALL.iter().map(|p| (*p, 2)).collect(),
        }
    }
}

impl ProviderConcurrencyPolicy {
    pub fn limit(&self, provider: ChatProvider) -> i64 {
        self.per_provider_limits
            .get(&provider)
            .copied()
            .unwrap_or(self.global_limit)
            .max(1)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeRetentionPolicy {
    #[serde(rename = "maximumEventsPerThread", default = "default_max_events")]
    pub maximum_events_per_thread: usize,
    #[serde(
        rename = "maximumTextCharactersPerEvent",
        default = "default_max_chars"
    )]
    pub maximum_text_characters_per_event: usize,
}

fn default_max_events() -> usize {
    5_000
}

fn default_max_chars() -> usize {
    64_000
}

impl Default for RuntimeRetentionPolicy {
    fn default() -> Self {
        Self {
            maximum_events_per_thread: 5_000,
            maximum_text_characters_per_event: 64_000,
        }
    }
}

impl RuntimeRetentionPolicy {
    pub fn compact(&self, events: &[ProviderRuntimeEvent]) -> Vec<ProviderRuntimeEvent> {
        let max_events = self.maximum_events_per_thread.max(100);
        let bounded: Vec<ProviderRuntimeEvent> = order::ordered(events)
            .into_iter()
            .map(|e| self.compact_event(e))
            .collect();
        if bounded.len() <= max_events {
            return bounded;
        }
        let split = bounded.len() - max_events;
        let recent = &bounded[split..];
        let retained_metadata: Vec<ProviderRuntimeEvent> = bounded[..split]
            .iter()
            .filter(|e| {
                e.kind.is(RuntimeEventKind::SESSION_BINDING)
                    || e.kind.is(RuntimeEventKind::TURN_TERMINAL)
                    || e.kind.is(RuntimeEventKind::APPROVAL_REQUEST)
                    || e.kind.is(RuntimeEventKind::USER_INPUT_REQUEST)
            })
            .cloned()
            .collect();
        let mut combined = retained_metadata;
        combined.extend_from_slice(recent);
        order::ordered(&combined)
    }

    fn compact_event(&self, mut event: ProviderRuntimeEvent) -> ProviderRuntimeEvent {
        event.payload.text = self.truncate(event.payload.text.take());
        event.payload.detail = self.truncate(event.payload.detail.take());
        event.payload.output = self.truncate(event.payload.output.take());
        event.payload.diff = self.truncate(event.payload.diff.take());
        if let Some(tool) = &mut event.payload.tool {
            tool.input = self.truncate(tool.input.take());
            tool.output = self.truncate(tool.output.take());
        }
        if let Some(files) = &mut event.payload.files {
            for file in files.iter_mut() {
                file.diff = self.truncate(file.diff.take());
            }
        }
        event
    }

    fn truncate(&self, value: Option<String>) -> Option<String> {
        let max = self.maximum_text_characters_per_event.max(1_000);
        let value = value?;
        if value.chars().count() <= max {
            return Some(value);
        }
        let prefix: String = value.chars().take(max).collect();
        Some(prefix + "\n… output compacted by Maxx …")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceDocument {
    #[serde(rename = "schemaVersion", default = "default_schema_version")]
    pub schema_version: i64,
    #[serde(default)]
    pub projects: Vec<ChatProject>,
    #[serde(
        rename = "providerProfiles",
        default = "ProviderProfile::default_profiles"
    )]
    pub provider_profiles: Vec<ProviderProfile>,
    #[serde(default)]
    pub agents: Vec<AgentDefinition>,
    #[serde(
        rename = "titleGenerationRuntime",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub title_generation_runtime: Option<TitleGenerationRuntime>,
    #[serde(rename = "computerUse", default)]
    pub computer_use: crate::computer_use::ComputerUseSettings,
    #[serde(rename = "concurrencyPolicy", default)]
    pub concurrency_policy: ProviderConcurrencyPolicy,
    #[serde(rename = "retentionPolicy", default)]
    pub retention_policy: RuntimeRetentionPolicy,
    /// Voice dictation preferences. Carries no credential — see
    /// [`crate::voice::VoiceSettings`].
    #[serde(default)]
    pub voice: crate::voice::VoiceSettings,
}

fn default_schema_version() -> i64 {
    1
}

impl Default for WorkspaceDocument {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_WORKSPACE_SCHEMA_VERSION,
            projects: Vec::new(),
            provider_profiles: ProviderProfile::default_profiles(),
            agents: Vec::new(),
            title_generation_runtime: None,
            computer_use: crate::computer_use::ComputerUseSettings::default(),
            concurrency_policy: ProviderConcurrencyPolicy::default(),
            retention_policy: RuntimeRetentionPolicy::default(),
            voice: crate::voice::VoiceSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    Missing,
    LegacyProjectArray,
    VersionedDocument(i64),
}

pub struct LoadResult {
    pub document: WorkspaceDocument,
    pub source_format: SourceFormat,
}

pub struct WorkspacePersistence {
    pub path: PathBuf,
}

impl WorkspacePersistence {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> Result<LoadResult, CoreError> {
        if !self.path.exists() {
            let mut document = WorkspaceDocument::default();
            normalize(&mut document);
            return Ok(LoadResult {
                document,
                source_format: SourceFormat::Missing,
            });
        }
        let data = std::fs::read(&self.path)
            .map_err(|e| CoreError::Persistence(format!("read {}: {e}", self.path.display())))?;

        if let Ok(mut document) = serde_json::from_slice::<WorkspaceDocument>(&data) {
            // A legacy top-level project array also deserializes as a document
            // of all-default fields only when the JSON is an object; guard on
            // the raw shape to distinguish the two formats faithfully.
            if serde_json::from_slice::<Value>(&data)
                .map(|v| v.is_object())
                .unwrap_or(false)
            {
                let source_version = document.schema_version;
                document.schema_version = CURRENT_WORKSPACE_SCHEMA_VERSION;
                normalize(&mut document);
                return Ok(LoadResult {
                    document,
                    source_format: SourceFormat::VersionedDocument(source_version),
                });
            }
        }

        let legacy_projects: Vec<ChatProject> = serde_json::from_slice(&data)
            .map_err(|e| CoreError::Persistence(format!("decode workspace: {e}")))?;
        let mut document = WorkspaceDocument {
            projects: legacy_projects,
            ..Default::default()
        };
        normalize(&mut document);
        Ok(LoadResult {
            document,
            source_format: SourceFormat::LegacyProjectArray,
        })
    }

    pub fn save(&self, document: &WorkspaceDocument) -> Result<(), CoreError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CoreError::Persistence(format!("create {}: {e}", parent.display())))?;
        }
        let mut document = document.clone();
        document.schema_version = CURRENT_WORKSPACE_SCHEMA_VERSION;
        normalize(&mut document);
        for project in &mut document.projects {
            for thread in &mut project.threads {
                thread.runtime_events = document.retention_policy.compact(&thread.runtime_events);
            }
        }
        let json = serde_json::to_string_pretty(&document)
            .map_err(|e| CoreError::Persistence(format!("encode workspace: {e}")))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)
            .map_err(|e| CoreError::Persistence(format!("write {}: {e}", tmp.display())))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|e| CoreError::Persistence(format!("rename {}: {e}", self.path.display())))?;
        Ok(())
    }
}

/// Port of `WorkspacePersistence.normalize`: guarantee default profiles,
/// recover profiles referenced by threads (disabled placeholders), order
/// runtime events canonically, sort profiles.
pub fn normalize(document: &mut WorkspaceDocument) {
    document.computer_use.normalize();
    for profile in &mut document.provider_profiles {
        profile.hidden_models = profile
            .hidden_models
            .iter()
            .map(|model| model.trim())
            .filter(|model| !model.is_empty())
            .map(str::to_owned)
            .collect();
        profile.hidden_models.sort();
        profile.hidden_models.dedup();
        profile.executable_path = profile
            .executable_path
            .take()
            .map(|path| path.trim().to_owned())
            .filter(|path| !path.is_empty());
    }
    let mut known_ids: std::collections::HashSet<Uuid> =
        document.provider_profiles.iter().map(|p| p.id).collect();
    for provider in ChatProvider::ALL {
        if !known_ids.contains(&provider.default_instance_id()) {
            let profile = ProviderProfile::default_for(provider);
            known_ids.insert(profile.id);
            document.provider_profiles.push(profile);
        }
    }

    let mut recovered: Vec<ProviderProfile> = Vec::new();
    for project in &mut document.projects {
        for thread in &mut project.threads {
            thread.runtime_events = order::ordered(&thread.runtime_events);
            let instance_id = thread.instance_id();
            if !known_ids.contains(&instance_id) {
                known_ids.insert(instance_id);
                recovered.push(ProviderProfile {
                    id: instance_id,
                    provider: thread.provider,
                    display_name: format!("Unavailable {} profile", thread.provider.display_name()),
                    executable_path: None,
                    server_url: None,
                    home_directory: None,
                    environment: HashMap::new(),
                    color_hex: thread.provider.default_profile_color_hex().to_string(),
                    is_enabled: false,
                    hidden_models: Vec::new(),
                });
            }
        }
    }
    document.provider_profiles.extend(recovered);
    document.provider_profiles.sort_by(|a, b| {
        a.provider
            .raw_value()
            .cmp(b.provider.raw_value())
            .then_with(|| {
                a.display_name
                    .to_lowercase()
                    .cmp(&b.display_name.to_lowercase())
            })
    });
}

/// Port of `WorkspaceRecovery.closeInterruptedTurns`: a turn persisted without
/// a terminal event is closed exactly once as interrupted on launch.
pub fn close_interrupted_turns(projects: &mut [ChatProject]) -> usize {
    let mut recovered_count = 0;
    for project in projects.iter_mut() {
        for thread in project.threads.iter_mut() {
            let turn_id = thread
                .last_turn_id
                .or_else(|| thread.runtime_events.last().map(|e| e.turn_id));
            let Some(turn_id) = turn_id else { continue };
            let turn_events: Vec<ProviderRuntimeEvent> = order::ordered(
                &thread
                    .runtime_events
                    .iter()
                    .filter(|e| e.turn_id == turn_id)
                    .cloned()
                    .collect::<Vec<_>>(),
            );
            if !order::terminal_events(&turn_events, turn_id).is_empty() {
                continue;
            }

            let next_sequence = turn_events.iter().map(|e| e.sequence).max().unwrap_or(0) + 1;
            let can_resume =
                thread.provider_session_id.is_some() || thread.provider_resume_cursor.is_some();
            let instance_id = thread.instance_id();
            let warning = ProviderRuntimeEvent {
                schema_version: CURRENT_EVENT_SCHEMA_VERSION,
                id: Uuid::new_v4(),
                provider_instance_id: instance_id,
                thread_id: thread.id,
                turn_id,
                item_id: None,
                request_id: None,
                sequence: next_sequence,
                occurred_at: AppleDate::now(),
                kind: RuntimeEventKind::warning(),
                payload: RuntimeEventPayload {
                    title: Some(if can_resume {
                        "Turn interrupted by app exit".into()
                    } else {
                        "Session could not be recovered".into()
                    }),
                    detail: Some(if can_resume {
                        "The provider session is preserved and the next message will resume it."
                            .into()
                    } else {
                        "The provider did not leave a resumable session. Start a new turn to continue."
                            .into()
                    }),
                    ..Default::default()
                },
                native_reference: None,
            };
            let terminal = ProviderRuntimeEvent {
                schema_version: CURRENT_EVENT_SCHEMA_VERSION,
                id: Uuid::new_v4(),
                provider_instance_id: instance_id,
                thread_id: thread.id,
                turn_id,
                item_id: None,
                request_id: None,
                sequence: next_sequence + 1,
                occurred_at: AppleDate::now(),
                kind: RuntimeEventKind::turn_terminal(),
                payload: RuntimeEventPayload {
                    terminal_state: Some(ProviderTurnTerminalState::Interrupted),
                    ..Default::default()
                },
                native_reference: None,
            };
            thread.last_turn_id = Some(turn_id);
            let mut events = thread.runtime_events.clone();
            events.push(warning);
            events.push(terminal);
            thread.runtime_events = order::ordered(&events);
            recovered_count += 1;
        }
    }
    recovered_count
}

#[cfg(test)]
mod provider_profile_tests {
    use super::*;

    #[test]
    fn normalize_cleans_executable_path_and_hidden_models() {
        let mut document = WorkspaceDocument::default();
        let profile = document
            .provider_profiles
            .iter_mut()
            .find(|profile| profile.provider == ChatProvider::Codex)
            .unwrap();
        profile.executable_path = Some("  /opt/custom/codex  ".into());
        profile.hidden_models = vec![
            " gpt-5.4 ".into(),
            "".into(),
            "gpt-5.3".into(),
            "gpt-5.4".into(),
        ];

        normalize(&mut document);

        let profile = document
            .provider_profiles
            .iter()
            .find(|profile| profile.provider == ChatProvider::Codex)
            .unwrap();
        assert_eq!(profile.executable_path.as_deref(), Some("/opt/custom/codex"));
        assert_eq!(profile.hidden_models, ["gpt-5.3", "gpt-5.4"]);
    }

    #[test]
    fn empty_hidden_models_are_explicit_in_json_contract() {
        let json = serde_json::to_value(ProviderProfile::default_for(ChatProvider::Codex)).unwrap();
        assert_eq!(json.get("hiddenModels").unwrap(), &serde_json::json!([]));
    }
}
