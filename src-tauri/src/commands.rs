//! Tauri command surface consumed by the React frontend. Mirrors the mutation
//! surface of the Swift `AppStore`.

use crate::engine::runtime::ActiveTurnInfo;
use crate::engine::TurnRequest;
use crate::state::{find_thread, AppState};
use maxx_core::contract::*;
use maxx_core::handoff::ContextHandoff;
use maxx_core::persist::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

type Shared<'a> = State<'a, Arc<AppState>>;

#[tauri::command]
pub async fn workspace_snapshot(state: Shared<'_>) -> Result<WorkspaceDocument, String> {
    Ok(state.workspace.lock().await.clone())
}

/// Backend-authoritative inventory of in-flight provider turns for sidebar activity.
#[tauri::command]
pub async fn active_turns(state: Shared<'_>) -> Result<Vec<ActiveTurnInfo>, String> {
    Ok(state.runtime.active_turns().await)
}

#[tauri::command]
pub async fn add_project(state: Shared<'_>, folder_path: String) -> Result<ChatProject, String> {
    let project = ChatProject {
        id: Uuid::new_v4(),
        folder_path,
        threads: Vec::new(),
    };
    state.workspace.lock().await.projects.push(project.clone());
    state.save().await;
    Ok(project)
}

#[tauri::command]
pub async fn remove_project(state: Shared<'_>, project_id: Uuid) -> Result<(), String> {
    let removed_threads = {
        let mut workspace = state.workspace.lock().await;
        let removed = workspace
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .map(|project| {
                project
                    .threads
                    .iter()
                    .map(|thread| thread.id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        workspace
            .projects
            .retain(|project| project.id != project_id);
        removed
    };
    for thread_id in removed_threads {
        state.browser.revoke_thread(thread_id).await;
    }
    state.save().await;
    {
        let workspace = state.workspace.lock().await;
        crate::attachments::prune_images(&workspace);
    }
    Ok(())
}

#[tauri::command]
pub async fn add_thread(
    state: Shared<'_>,
    project_id: Uuid,
    provider: ChatProvider,
    model: String,
    title: String,
) -> Result<ChatThread, String> {
    let thread = ChatThread::new(title, provider, model);
    {
        let mut workspace = state.workspace.lock().await;
        let project = workspace
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or("Unknown project")?;
        project.threads.push(thread.clone());
    }
    state.save().await;
    Ok(thread)
}

#[tauri::command]
pub async fn remove_thread(
    state: Shared<'_>,
    project_id: Uuid,
    thread_id: Uuid,
) -> Result<(), String> {
    let removed_threads = {
        let mut workspace = state.workspace.lock().await;
        if let Some(project) = workspace.projects.iter_mut().find(|p| p.id == project_id) {
            // Removing a main thread also removes the side threads hanging off it.
            let removed = project
                .threads
                .iter()
                .filter(|thread| {
                    thread.id == thread_id || thread.parent_thread_id == Some(thread_id)
                })
                .map(|thread| thread.id)
                .collect::<Vec<_>>();
            project
                .threads
                .retain(|t| t.id != thread_id && t.parent_thread_id != Some(thread_id));
            removed
        } else {
            Vec::new()
        }
    };
    for removed_thread_id in removed_threads {
        state.browser.revoke_thread(removed_thread_id).await;
    }
    state.save().await;
    {
        let workspace = state.workspace.lock().await;
        crate::attachments::prune_images(&workspace);
    }
    Ok(())
}

#[tauri::command]
pub async fn update_thread(
    state: Shared<'_>,
    project_id: Uuid,
    thread_id: Uuid,
    title: Option<String>,
    provider: Option<ChatProvider>,
    model: Option<String>,
    // When present with update_runtime_knobs, replaces thread effort (empty clears).
    effort: Option<String>,
    // When present with update_runtime_knobs, replaces thread speed (empty clears).
    speed: Option<String>,
    // When true, apply effort/speed fields even if they are empty (clear knobs).
    #[allow(non_snake_case)] updateRuntimeKnobs: Option<bool>,
) -> Result<(), String> {
    let update_knobs = updateRuntimeKnobs.unwrap_or(false);
    {
        let mut workspace = state.workspace.lock().await;
        let thread = find_thread(&mut workspace, project_id, thread_id).ok_or("Unknown thread")?;
        if let Some(title) = title {
            thread.title = title;
        }
        if let Some(provider) = provider {
            // A provider owns its own session and resume cursor. Switching the
            // runtime therefore starts a clean provider session while keeping
            // the visible conversation in the same Maxx thread.
            if provider != thread.provider {
                thread.provider = provider;
                thread.provider_instance_id = Some(provider.default_instance_id());
                thread.provider_session_id = None;
                thread.provider_resume_cursor = None;
            }
        }
        if let Some(model) = model {
            thread.model = model;
        }
        if update_knobs {
            thread.effort = effort.filter(|v| !v.trim().is_empty());
            thread.speed =
                speed.filter(|v| !v.trim().is_empty() && !v.eq_ignore_ascii_case("normal"));
        }
        thread.updated_at = AppleDate::now();
    }
    state.save().await;
    Ok(())
}

#[tauri::command]
pub async fn add_thread_with_runtime(
    state: Shared<'_>,
    project_id: Uuid,
    provider: ChatProvider,
    model: String,
    title: String,
    effort: Option<String>,
    speed: Option<String>,
) -> Result<ChatThread, String> {
    let mut thread = ChatThread::new(title, provider, model);
    thread.effort = effort.filter(|v| !v.trim().is_empty());
    thread.speed = speed.filter(|v| !v.trim().is_empty() && !v.eq_ignore_ascii_case("normal"));
    {
        let mut workspace = state.workspace.lock().await;
        let project = workspace
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or("Unknown project")?;
        project.threads.push(thread.clone());
    }
    state.save().await;
    Ok(thread)
}

#[tauri::command]
pub async fn list_provider_models(
    state: Shared<'_>,
    provider: ChatProvider,
    profile_id: Option<Uuid>,
    working_directory: Option<String>,
) -> Result<crate::engine::catalog::ProviderModelCatalog, String> {
    let profile = {
        let workspace = state.workspace.lock().await;
        let profile = if let Some(id) = profile_id {
            workspace
                .provider_profiles
                .iter()
                .find(|p| p.id == id)
                .cloned()
        } else {
            workspace
                .provider_profiles
                .iter()
                .find(|p| p.provider == provider && p.is_enabled)
                .cloned()
                .or_else(|| {
                    workspace
                        .provider_profiles
                        .iter()
                        .find(|p| p.provider == provider)
                        .cloned()
                })
        };
        profile.unwrap_or_else(|| ProviderProfile::default_for(provider))
    };
    Ok(
        crate::engine::catalog::resolve_models_for_profile(&profile, working_directory.as_deref())
            .await,
    )
}

#[tauri::command]
pub async fn update_profiles(
    state: Shared<'_>,
    profiles: Vec<ProviderProfile>,
) -> Result<Vec<ProviderProfile>, String> {
    {
        let mut workspace = state.workspace.lock().await;
        workspace.provider_profiles = profiles;
        normalize(&mut workspace);
    }
    state.save().await;
    Ok(state.workspace.lock().await.provider_profiles.clone())
}

/// Display name of the provider that produced the thread's existing transcript,
/// resolved from the provider instance on the most recent runtime event.
///
/// `None` means "do not claim a switch": either the last events came from the
/// thread's current runtime (a cleared stale binding rather than a handoff), or
/// the originating profile no longer exists.
fn previous_provider_label(
    profiles: &[ProviderProfile],
    thread: &ChatThread,
) -> Option<&'static str> {
    let instance = thread.runtime_events.last()?.provider_instance_id;
    if instance == thread.instance_id() {
        return None;
    }
    let provider = profiles
        .iter()
        .find(|profile| profile.id == instance)
        .map(|profile| profile.provider)
        // A deleted profile still leaves identifiable default instances behind.
        .or_else(|| {
            ChatProvider::ALL
                .into_iter()
                .find(|provider| provider.default_instance_id() == instance)
        })?;
    Some(provider.display_name())
}

/// Context to carry into the incoming provider's first prompt, with the label of
/// the runtime that produced it.
///
/// A provider owns its native session, so a switched runtime (or a cleared stale
/// binding) starts with no history even though the Maxx thread still shows the
/// conversation. The gate is `provider_session_id.is_none()`, which is
/// self-clearing: every engine emits a session binding before its first prompt,
/// so a bound thread never pays for this twice.
pub(crate) fn handoff_for_thread(
    profiles: &[ProviderProfile],
    agent_names: &HashMap<Uuid, String>,
    thread: &ChatThread,
) -> Option<(ContextHandoff, Option<&'static str>)> {
    if thread.provider_session_id.is_some() {
        return None;
    }
    let from_label = previous_provider_label(profiles, thread);
    let handoff = maxx_core::handoff::render_handoff_with_agents(
        &thread.messages,
        from_label,
        maxx_core::handoff::DEFAULT_HANDOFF_BUDGET,
        agent_names,
    )?;
    Some((handoff, from_label))
}

/// Agent-id → display-name map for handoff attribution.
fn agent_name_map(agents: &[AgentDefinition]) -> HashMap<Uuid, String> {
    agents.iter().map(|a| (a.id, a.name.clone())).collect()
}

#[tauri::command]
pub async fn send_prompt(
    app: tauri::AppHandle,
    state: Shared<'_>,
    project_id: Uuid,
    thread_id: Uuid,
    prompt: String,
    image_paths: Vec<String>,
) -> Result<Uuid, String> {
    let attachments = crate::attachments::import_images(&image_paths)?;
    let turn_id = Uuid::new_v4();
    let request = {
        let mut workspace = state.workspace.lock().await;
        let folder_path = workspace
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.folder_path.clone())
            .ok_or("Unknown project")?;
        let profiles = workspace.provider_profiles.clone();
        let agent_names = agent_name_map(&workspace.agents);
        let thread = find_thread(&mut workspace, project_id, thread_id).ok_or("Unknown thread")?;

        // Every engine takes `prompt` as plain text, so carrying the transcript
        // here covers all six providers with no adapter changes.
        let handoff = handoff_for_thread(&profiles, &agent_names, thread);
        // Recorded before the user turn so the transcript reads in order, and as
        // `system` so it never re-enters a later handoff as conversation.
        if let Some((handoff, from_label)) = &handoff {
            thread.messages.push(ChatMessage {
                id: Uuid::new_v4(),
                role: ChatRole::System,
                content: handoff.notice(*from_label, thread.provider.display_name()),
                attachments: Vec::new(),
                created_at: AppleDate::now(),
                source_event_id: None,
                agent_id: None,
            });
        }

        thread.messages.push(ChatMessage {
            id: Uuid::new_v4(),
            role: ChatRole::User,
            content: prompt.clone(),
            attachments: attachments.clone(),
            created_at: AppleDate::now(),
            source_event_id: None,
            agent_id: None,
        });
        thread.last_turn_id = Some(turn_id);
        thread.updated_at = AppleDate::now();
        let instance_id = thread.instance_id();
        let profile = profiles
            .iter()
            .find(|p| p.id == instance_id)
            .cloned()
            .unwrap_or_else(|| {
                let mut profile = ProviderProfile::default_for(thread.provider);
                profile.id = instance_id;
                profile
            });
        TurnRequest {
            turn_id,
            thread_id,
            provider_instance_id: instance_id,
            provider: thread.provider,
            model: thread.model.clone(),
            effort: thread.effort.clone(),
            speed: thread.speed.clone(),
            agent_instructions: None,
            // Only the provider sees the preamble; the stored user message and
            // the UI keep the prompt the user actually typed.
            prompt: match &handoff {
                Some((handoff, _)) => handoff.apply(&prompt),
                None => prompt,
            },
            attachments,
            working_directory: folder_path,
            session_id: thread.provider_session_id.clone(),
            agent_id: None,
            browser_access: None,
            profile,
        }
    };
    state.save().await;
    // Inventory must include this turn before the command returns so a concurrent
    // frontend refresh cannot miss it after optimistic set.
    state
        .runtime
        .track_turn(project_id, thread_id, turn_id, request.provider)
        .await;
    let state_arc: Arc<AppState> = state.inner().clone();
    tokio::spawn(state_arc.run_turn(app, project_id, request));
    Ok(turn_id)
}

#[tauri::command]
pub async fn update_agents(
    state: Shared<'_>,
    agents: Vec<AgentDefinition>,
) -> Result<Vec<AgentDefinition>, String> {
    {
        let mut workspace = state.workspace.lock().await;
        workspace.agents = agents;
    }
    state.save().await;
    let agents = state.workspace.lock().await.agents.clone();
    prune_agent_images(&agents);
    Ok(agents)
}

/// Copy a user-picked avatar image into the agent-images store and return the
/// stored absolute path. The caller persists it on the agent via
/// `update_agents`; files no longer referenced are pruned there. Each import
/// gets a fresh file name so a replaced image never fights the webview cache.
#[tauri::command]
pub async fn import_agent_image(agent_id: Uuid, source_path: String) -> Result<String, String> {
    let source = std::path::PathBuf::from(&source_path);
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|ext| matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp"))
        .ok_or_else(|| "Unsupported image type".to_string())?;
    let directory = crate::state::agent_images_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the image store: {error}"))?;
    let tag = Uuid::new_v4().simple().to_string();
    let destination = directory.join(format!("{agent_id}-{}.{extension}", &tag[..8]));
    std::fs::copy(&source, &destination)
        .map_err(|error| format!("Could not copy the image: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

/// Remove stored avatar files that no agent references (replaced or deleted).
fn prune_agent_images(agents: &[AgentDefinition]) {
    let referenced: HashSet<std::path::PathBuf> = agents
        .iter()
        .filter_map(|agent| agent.image_path.as_deref())
        .map(std::path::PathBuf::from)
        .collect();
    let Ok(entries) = std::fs::read_dir(crate::state::agent_images_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !referenced.contains(&path) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Apply an agent's runtime to a (side) thread, compose the user-message
/// content separately from its privileged instructions, and record the user's
/// message — the shared tail of both agent commands. Switching agents resets
/// the provider session so the incoming agent receives a clean native session.
///
/// `record_user_message` is false for the follow-up turns of a multi-mention
/// chain: the prompt is already in the transcript from the first agent's turn,
/// and this agent receives it again only as the live prompt.
fn prepare_agent_turn(
    profiles: &[ProviderProfile],
    agent_names: &HashMap<Uuid, String>,
    thread: &mut ChatThread,
    agent: &AgentDefinition,
    prompt: &str,
    attachments: &[ChatImageAttachment],
    turn_id: Uuid,
    folder_path: String,
    record_user_message: bool,
) -> TurnRequest {
    if thread.agent_id != Some(agent.id) {
        thread.provider = agent.provider;
        thread.provider_instance_id = Some(agent.provider.default_instance_id());
        thread.provider_session_id = None;
        thread.provider_resume_cursor = None;
        thread.agent_id = Some(agent.id);
    }
    thread.model = agent.model.clone();
    thread.effort = agent.effort.clone().filter(|v| !v.trim().is_empty());
    thread.speed = agent.speed.clone().filter(|v| !v.trim().is_empty());

    // A fresh provider session gets all conversation context. Agent identity
    // is always carried separately so each adapter can use its privileged
    // instruction channel, including after native session resume.
    let fresh_session = thread.provider_session_id.is_none();
    let agent_instructions =
        maxx_core::agents::agent_instructions(&agent.name, &agent.instructions);
    let seed = if fresh_session {
        thread.context_seed.clone()
    } else {
        None
    };
    let handoff =
        handoff_for_thread(profiles, agent_names, thread).map(|(handoff, _)| handoff.preamble);
    let provider_prompt =
        maxx_core::agents::compose_agent_user_prompt(seed.as_deref(), handoff.as_deref(), prompt);

    if record_user_message {
        thread.messages.push(ChatMessage {
            id: Uuid::new_v4(),
            role: ChatRole::User,
            content: prompt.to_string(),
            attachments: attachments.to_vec(),
            created_at: AppleDate::now(),
            source_event_id: None,
            agent_id: None,
        });
    }
    thread.last_turn_id = Some(turn_id);
    thread.updated_at = AppleDate::now();

    let instance_id = thread.instance_id();
    let profile = profiles
        .iter()
        .find(|p| p.id == instance_id)
        .cloned()
        .unwrap_or_else(|| {
            let mut profile = ProviderProfile::default_for(thread.provider);
            profile.id = instance_id;
            profile
        });
    TurnRequest {
        turn_id,
        thread_id: thread.id,
        provider_instance_id: instance_id,
        provider: thread.provider,
        model: thread.model.clone(),
        effort: thread.effort.clone(),
        speed: thread.speed.clone(),
        agent_instructions: Some(agent_instructions),
        prompt: provider_prompt,
        attachments: attachments.to_vec(),
        working_directory: folder_path,
        session_id: thread.provider_session_id.clone(),
        agent_id: Some(agent.id),
        browser_access: None,
        profile,
    }
}

/// Title for a side thread: the agent plus the opening ask. A leading
/// "@AgentName" is dropped from the snippet — the title already names the agent.
fn side_thread_title(agent_name: &str, prompt: &str) -> String {
    let flattened = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut rest = flattened.trim();
    let mention = format!("@{agent_name}");
    if let Some(head) = rest.get(..mention.len()) {
        if head.eq_ignore_ascii_case(&mention) {
            rest = rest[mention.len()..]
                .trim_start_matches([',', ':', ';'])
                .trim_start();
        }
    }
    let snippet: String = rest.chars().take(48).collect();
    if snippet.is_empty() {
        format!("{agent_name} thread")
    } else {
        format!("{agent_name} · {snippet}")
    }
}

/// Resolve mentioned agent ids to definitions, deduped in mention order —
/// the first entry opens the turn chain, the rest follow it.
fn resolve_agent_chain(
    agents: &[AgentDefinition],
    agent_ids: &[Uuid],
) -> Result<Vec<AgentDefinition>, String> {
    let mut seen = HashSet::new();
    let mut chain = Vec::new();
    for id in agent_ids {
        if !seen.insert(*id) {
            continue;
        }
        chain.push(
            agents
                .iter()
                .find(|a| a.id == *id)
                .cloned()
                .ok_or("Unknown agent")?,
        );
    }
    if chain.is_empty() {
        return Err("No agent addressed".into());
    }
    Ok(chain)
}

/// Run the first turn of a multi-mention chain, then each follow-up agent in
/// mention order. A follow-up starts only after the previous turn completes,
/// so its session replay (agent switch → fresh session + handoff) carries the
/// earlier agents' replies; a cancelled or failed turn aborts the rest.
async fn run_agent_chain(
    state: Arc<AppState>,
    app: tauri::AppHandle,
    project_id: Uuid,
    thread_id: Uuid,
    first: TurnRequest,
    rest: Vec<AgentDefinition>,
    prompt: String,
    attachments: Vec<ChatImageAttachment>,
    folder_path: String,
) {
    let mut terminal = state.clone().run_turn(app.clone(), project_id, first).await;
    for agent in rest {
        if terminal != Some(ProviderTurnTerminalState::Completed) {
            break;
        }
        let turn_id = Uuid::new_v4();
        let request = {
            let mut workspace = state.workspace.lock().await;
            let profiles = workspace.provider_profiles.clone();
            let agent_names = agent_name_map(&workspace.agents);
            let Some(thread) = find_thread(&mut workspace, project_id, thread_id) else {
                break;
            };
            prepare_agent_turn(
                &profiles,
                &agent_names,
                thread,
                &agent,
                &prompt,
                &attachments,
                turn_id,
                folder_path.clone(),
                false,
            )
        };
        state.save().await;
        state
            .runtime
            .track_turn(project_id, thread_id, turn_id, request.provider)
            .await;
        terminal = state
            .clone()
            .run_turn(app.clone(), project_id, request)
            .await;
    }
}

/// Branch a side thread off `parent_thread_id` for the mentioned agents and
/// run the first agent's turn; additional mentions respond in sequence. The
/// mention message is recorded in the parent thread (it anchors the branch)
/// and as the side thread's opening user message.
#[tauri::command]
pub async fn start_side_thread(
    app: tauri::AppHandle,
    state: Shared<'_>,
    project_id: Uuid,
    parent_thread_id: Uuid,
    agent_ids: Vec<Uuid>,
    prompt: String,
    image_paths: Vec<String>,
) -> Result<ChatThread, String> {
    let attachments = crate::attachments::import_images(&image_paths)?;
    let turn_id = Uuid::new_v4();
    let (request, thread_snapshot, rest, folder_path) = {
        let mut workspace = state.workspace.lock().await;
        let folder_path = workspace
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.folder_path.clone())
            .ok_or("Unknown project")?;
        let mut chain = resolve_agent_chain(&workspace.agents, &agent_ids)?;
        let rest = chain.split_off(1);
        let agent = chain.remove(0);
        let agent_names = agent_name_map(&workspace.agents);
        let profiles = workspace.provider_profiles.clone();

        let parent =
            find_thread(&mut workspace, project_id, parent_thread_id).ok_or("Unknown thread")?;
        if parent.parent_thread_id.is_some() {
            return Err("Side threads cannot branch further".into());
        }
        // Seed from the parent transcript as it stood before this mention, so
        // the prompt itself is not duplicated into the context block.
        let seed = maxx_core::handoff::render_handoff_with_agents(
            &parent.messages,
            None,
            maxx_core::handoff::DEFAULT_HANDOFF_BUDGET,
            &agent_names,
        )
        .map(|handoff| handoff.preamble);
        let anchor = ChatMessage {
            id: Uuid::new_v4(),
            role: ChatRole::User,
            content: prompt.clone(),
            attachments: attachments.clone(),
            created_at: AppleDate::now(),
            source_event_id: None,
            agent_id: None,
        };
        let anchor_id = anchor.id;
        parent.messages.push(anchor);
        parent.updated_at = AppleDate::now();

        let mut thread = ChatThread::new(
            side_thread_title(&agent.name, &prompt),
            agent.provider,
            agent.model.clone(),
        );
        thread.parent_thread_id = Some(parent_thread_id);
        thread.anchor_message_id = Some(anchor_id);
        thread.agent_id = Some(agent.id);
        thread.context_seed = seed;
        let request = prepare_agent_turn(
            &profiles,
            &agent_names,
            &mut thread,
            &agent,
            &prompt,
            &attachments,
            turn_id,
            folder_path.clone(),
            true,
        );

        let project = workspace
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or("Unknown project")?;
        project.threads.push(thread.clone());
        (request, thread, rest, folder_path)
    };
    state.save().await;
    state
        .runtime
        .track_turn(project_id, thread_snapshot.id, turn_id, request.provider)
        .await;
    let state_arc: Arc<AppState> = state.inner().clone();
    tokio::spawn(run_agent_chain(
        state_arc,
        app,
        project_id,
        thread_snapshot.id,
        request,
        rest,
        prompt,
        attachments,
        folder_path,
    ));
    Ok(thread_snapshot)
}

/// Send a follow-up in an existing side thread, addressed to `agent_ids`
/// (the mentioned agents in order, or the thread's current agent when
/// unmentioned). Multiple agents respond in sequence.
#[tauri::command]
pub async fn send_agent_prompt(
    app: tauri::AppHandle,
    state: Shared<'_>,
    project_id: Uuid,
    thread_id: Uuid,
    agent_ids: Vec<Uuid>,
    prompt: String,
    image_paths: Vec<String>,
) -> Result<Uuid, String> {
    let attachments = crate::attachments::import_images(&image_paths)?;
    let turn_id = Uuid::new_v4();
    let (request, rest, folder_path) = {
        let mut workspace = state.workspace.lock().await;
        let folder_path = workspace
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.folder_path.clone())
            .ok_or("Unknown project")?;
        let mut chain = resolve_agent_chain(&workspace.agents, &agent_ids)?;
        let rest = chain.split_off(1);
        let agent = chain.remove(0);
        let agent_names = agent_name_map(&workspace.agents);
        let profiles = workspace.provider_profiles.clone();
        let thread = find_thread(&mut workspace, project_id, thread_id).ok_or("Unknown thread")?;
        let request = prepare_agent_turn(
            &profiles,
            &agent_names,
            thread,
            &agent,
            &prompt,
            &attachments,
            turn_id,
            folder_path.clone(),
            true,
        );
        (request, rest, folder_path)
    };
    state.save().await;
    state
        .runtime
        .track_turn(project_id, thread_id, turn_id, request.provider)
        .await;
    let state_arc: Arc<AppState> = state.inner().clone();
    tokio::spawn(run_agent_chain(
        state_arc,
        app,
        project_id,
        thread_id,
        request,
        rest,
        prompt,
        attachments,
        folder_path,
    ));
    Ok(turn_id)
}

#[tauri::command]
pub async fn cancel_turn(state: Shared<'_>, turn_id: Uuid) -> Result<(), String> {
    state.runtime.cancel(turn_id).await;
    Ok(())
}

#[tauri::command]
pub async fn resolve_request(
    state: Shared<'_>,
    project_id: Uuid,
    thread_id: Uuid,
    request_id: Uuid,
    decision: RuntimeInteractionDecision,
) -> Result<(), String> {
    let provider = {
        let workspace = state.workspace.lock().await;
        workspace
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .and_then(|p| p.threads.iter().find(|t| t.id == thread_id))
            .map(|t| t.provider)
            .ok_or("Unknown thread")?
    };
    let status = match (&decision.kind, decision.kind) {
        (_, Some(RuntimeDecisionKind::Approve))
        | (_, Some(RuntimeDecisionKind::ApproveForSession)) => RuntimeInteractionStatus::Approved,
        (_, Some(RuntimeDecisionKind::Deny)) => RuntimeInteractionStatus::Denied,
        (_, Some(RuntimeDecisionKind::Cancel)) => RuntimeInteractionStatus::Cancelled,
        _ => RuntimeInteractionStatus::Answered,
    };
    state
        .runtime
        .resolve(provider, request_id, decision.clone())
        .await?;
    {
        let mut workspace = state.workspace.lock().await;
        if let Some(thread) = find_thread(&mut workspace, project_id, thread_id) {
            if let Some(record) = thread
                .interaction_requests
                .iter_mut()
                .find(|r| r.id == request_id)
            {
                record.status = status;
                record.decision = Some(decision);
                record.resolved_at = Some(AppleDate::now());
            }
        }
    }
    state.save().await;
    Ok(())
}

#[derive(Serialize)]
pub struct ProviderHealth {
    #[serde(rename = "profileID")]
    pub profile_id: Uuid,
    pub state: String,
    #[serde(rename = "executablePath")]
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

#[tauri::command]
pub async fn provider_health(
    state: Shared<'_>,
    profile_id: Uuid,
) -> Result<ProviderHealth, String> {
    let profile = {
        let workspace = state.workspace.lock().await;
        workspace
            .provider_profiles
            .iter()
            .find(|p| p.id == profile_id)
            .cloned()
            .ok_or("Unknown profile")?
    };
    if !profile.is_enabled {
        return Ok(ProviderHealth {
            profile_id,
            state: "disabled".into(),
            executable_path: None,
            version: None,
            message: "This profile is disabled.".into(),
        });
    }
    let configuration = match crate::engine::launch::launch_configuration(&profile) {
        Ok(configuration) => configuration,
        Err(message) => {
            return Ok(ProviderHealth {
                profile_id,
                state: "missing".into(),
                executable_path: None,
                version: None,
                message,
            })
        }
    };
    let version = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        tokio::process::Command::new(&configuration.executable)
            .arg("--version")
            .envs(&configuration.environment)
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    .filter(|v| !v.is_empty());
    Ok(ProviderHealth {
        profile_id,
        state: "ready".into(),
        executable_path: Some(configuration.executable.to_string_lossy().to_string()),
        version,
        message: format!("{} CLI found.", profile.provider.display_name()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            id: Uuid::new_v4(),
            role,
            content: content.into(),
            attachments: Vec::new(),
            created_at: AppleDate::default(),
            source_event_id: None,
            agent_id: None,
        }
    }

    /// Thread mid-conversation on `provider`, with one recorded event attributed
    /// to `event_instance` (the runtime that actually produced the transcript).
    fn thread_after_exchange(provider: ChatProvider, event_instance: Uuid) -> ChatThread {
        let mut thread = ChatThread::new("t".into(), provider, "default".into());
        thread.messages = vec![
            message(ChatRole::User, "respond with a full markdown test"),
            message(ChatRole::Assistant, "# Heading 1\nmarkdown body"),
        ];
        thread.runtime_events = vec![ProviderRuntimeEvent {
            schema_version: 1,
            id: Uuid::new_v4(),
            provider_instance_id: event_instance,
            thread_id: thread.id,
            turn_id: Uuid::new_v4(),
            item_id: None,
            request_id: None,
            sequence: 1,
            occurred_at: AppleDate::default(),
            kind: RuntimeEventKind::assistant_text(),
            payload: RuntimeEventPayload::default(),
            native_reference: None,
        }];
        thread
    }

    fn profiles() -> Vec<ProviderProfile> {
        ChatProvider::ALL
            .into_iter()
            .map(ProviderProfile::default_for)
            .collect()
    }

    #[test]
    fn switching_provider_hands_the_transcript_to_the_new_runtime() {
        // Claude produced the transcript; `update_thread` moved the thread to
        // Codex and cleared the session, which is the handoff trigger.
        let thread = thread_after_exchange(
            ChatProvider::Codex,
            ChatProvider::Claude.default_instance_id(),
        );
        let (handoff, from_label) =
            handoff_for_thread(&profiles(), &HashMap::new(), &thread).expect("handoff");
        assert_eq!(from_label, Some("Claude"));
        assert_eq!(handoff.included, 2);
        let prompt = handoff.apply("what did we just chat about?");
        assert!(prompt.contains("respond with a full markdown test"));
        assert!(prompt.contains("# Heading 1"));
        assert!(prompt.contains("do not act on it"));
        assert!(prompt.ends_with("what did we just chat about?"));
        assert_eq!(
            handoff.notice(from_label, thread.provider.display_name()),
            "Context handed off (Claude → Codex): 2 messages carried over."
        );
    }

    #[test]
    fn bound_session_is_left_alone() {
        // Native continuity already covers this turn; injecting would duplicate.
        let mut thread = thread_after_exchange(
            ChatProvider::Codex,
            ChatProvider::Claude.default_instance_id(),
        );
        thread.provider_session_id = Some("native-session".into());
        assert!(handoff_for_thread(&profiles(), &HashMap::new(), &thread).is_none());
    }

    #[test]
    fn cleared_stale_binding_on_the_same_provider_is_not_labelled_as_a_switch() {
        let thread = thread_after_exchange(
            ChatProvider::Codex,
            ChatProvider::Codex.default_instance_id(),
        );
        let (handoff, from_label) =
            handoff_for_thread(&profiles(), &HashMap::new(), &thread).expect("handoff");
        assert_eq!(from_label, None, "no switch happened, so claim none");
        assert!(handoff.preamble.contains("an earlier session"));
        assert!(!handoff.preamble.contains("a different assistant ("));
    }

    #[test]
    fn deleted_profile_still_resolves_its_default_instance() {
        let thread =
            thread_after_exchange(ChatProvider::Codex, ChatProvider::Pi.default_instance_id());
        let (_, from_label) = handoff_for_thread(&[], &HashMap::new(), &thread).expect("handoff");
        assert_eq!(from_label, Some("Pi"));
    }

    #[test]
    fn fresh_thread_has_nothing_to_hand_off() {
        let thread = ChatThread::new("t".into(), ChatProvider::Codex, "default".into());
        assert!(handoff_for_thread(&profiles(), &HashMap::new(), &thread).is_none());
    }

    #[test]
    fn thread_whose_only_turn_failed_has_nothing_to_hand_off() {
        // User prompt recorded but no assistant reply: replaying the user's own
        // words back as "earlier conversation" would only confuse the model.
        let mut thread = thread_after_exchange(
            ChatProvider::Codex,
            ChatProvider::Claude.default_instance_id(),
        );
        thread.messages.retain(|m| m.role != ChatRole::Assistant);
        assert!(handoff_for_thread(&profiles(), &HashMap::new(), &thread).is_none());
    }

    fn agent(name: &str, provider: ChatProvider) -> AgentDefinition {
        AgentDefinition {
            id: Uuid::new_v4(),
            name: name.into(),
            instructions: format!("You are {name}. Be terse."),
            provider,
            model: "default".into(),
            effort: None,
            speed: None,
            color_hex: "#AABBCC".into(),
            emoji: None,
            image_path: None,
            created_at: AppleDate::default(),
            updated_at: AppleDate::default(),
        }
    }

    #[test]
    fn first_agent_turn_separates_privileged_identity_from_parent_seed() {
        let charlie = agent("Charlie", ChatProvider::Claude);
        let mut thread = ChatThread::new("side".into(), charlie.provider, "default".into());
        thread.agent_id = Some(charlie.id);
        thread.context_seed = Some("<maxx-handoff>PARENT CONTEXT</maxx-handoff>".into());
        let request = prepare_agent_turn(
            &profiles(),
            &HashMap::new(),
            &mut thread,
            &charlie,
            "@Charlie please review this work",
            &[],
            Uuid::new_v4(),
            "/tmp".into(),
            true,
        );
        let instructions = request.agent_instructions.as_deref().unwrap();
        assert!(instructions.contains("You are \"Charlie\""));
        assert!(instructions.contains("Be terse."));
        assert!(!request.prompt.contains("You are \"Charlie\""));
        assert!(!request.prompt.contains("Be terse."));
        assert!(request.prompt.contains("PARENT CONTEXT"));
        assert!(request.prompt.ends_with("@Charlie please review this work"));
        assert_eq!(request.agent_id, Some(charlie.id));
        // The stored transcript keeps only what the user typed.
        assert_eq!(
            thread.messages.last().unwrap().content,
            "@Charlie please review this work"
        );
    }

    #[test]
    fn switching_agents_resets_the_session_and_replays_the_side_conversation() {
        let charlie = agent("Charlie", ChatProvider::Claude);
        let dana = agent("Dana", ChatProvider::Codex);
        let mut thread = ChatThread::new("side".into(), charlie.provider, "default".into());
        thread.agent_id = Some(charlie.id);
        thread.provider_session_id = Some("charlie-session".into());
        thread.messages = vec![
            message(ChatRole::User, "please review this work"),
            message(ChatRole::Assistant, "Charlie's review: looks solid"),
        ];
        let request = prepare_agent_turn(
            &profiles(),
            &HashMap::new(),
            &mut thread,
            &dana,
            "@Dana do you agree?",
            &[],
            Uuid::new_v4(),
            "/tmp".into(),
            true,
        );
        assert_eq!(thread.provider, ChatProvider::Codex);
        assert_eq!(thread.agent_id, Some(dana.id));
        assert!(request.session_id.is_none(), "Dana starts her own session");
        assert!(request
            .agent_instructions
            .as_deref()
            .unwrap()
            .contains("You are \"Dana\""));
        assert!(!request.prompt.contains("You are \"Dana\""));
        assert!(
            request.prompt.contains("Charlie's review: looks solid"),
            "Dana must see the side-thread context"
        );
        assert!(request.prompt.ends_with("@Dana do you agree?"));
    }

    #[test]
    fn same_agent_with_a_bound_session_sends_the_plain_prompt() {
        let charlie = agent("Charlie", ChatProvider::Claude);
        let mut thread = ChatThread::new("side".into(), charlie.provider, "default".into());
        thread.agent_id = Some(charlie.id);
        thread.provider_session_id = Some("charlie-session".into());
        thread.context_seed = Some("SEED".into());
        thread.messages = vec![
            message(ChatRole::User, "please review"),
            message(ChatRole::Assistant, "done"),
        ];
        let request = prepare_agent_turn(
            &profiles(),
            &HashMap::new(),
            &mut thread,
            &charlie,
            "anything else?",
            &[],
            Uuid::new_v4(),
            "/tmp".into(),
            true,
        );
        assert_eq!(request.prompt, "anything else?");
        assert_eq!(request.session_id.as_deref(), Some("charlie-session"));
        assert!(request
            .agent_instructions
            .as_deref()
            .unwrap()
            .contains("You are \"Charlie\""));
    }

    #[test]
    fn chained_mention_turn_replays_context_without_duplicating_the_prompt() {
        // "@Charlie @Dana say hi": Charlie answered; now Dana's queued turn
        // runs with record_user_message = false.
        let charlie = agent("Charlie", ChatProvider::Claude);
        let dana = agent("Dana", ChatProvider::Codex);
        let mut thread = ChatThread::new("side".into(), charlie.provider, "default".into());
        thread.agent_id = Some(charlie.id);
        thread.provider_session_id = Some("charlie-session".into());
        let mut reply = message(ChatRole::Assistant, "CHARLIE: hi there");
        reply.agent_id = Some(charlie.id);
        thread.messages = vec![message(ChatRole::User, "@Charlie @Dana say hi"), reply];
        let names = agent_name_map(&[charlie.clone(), dana.clone()]);
        let request = prepare_agent_turn(
            &profiles(),
            &names,
            &mut thread,
            &dana,
            "@Charlie @Dana say hi",
            &[],
            Uuid::new_v4(),
            "/tmp".into(),
            false,
        );
        // The transcript still holds one user message and Charlie's reply.
        assert_eq!(thread.messages.len(), 2);
        assert_eq!(thread.agent_id, Some(dana.id));
        assert!(request.session_id.is_none(), "Dana starts her own session");
        assert!(request
            .agent_instructions
            .as_deref()
            .unwrap()
            .contains("You are \"Dana\""));
        assert!(!request.prompt.contains("You are \"Dana\""));
        // Charlie's reply is attributed so Dana does not read it as her own.
        assert!(request.prompt.contains("[assistant (Charlie)]"));
        assert!(request.prompt.ends_with("@Charlie @Dana say hi"));
    }

    #[test]
    fn agent_chains_resolve_in_mention_order_and_dedupe() {
        let charlie = agent("Charlie", ChatProvider::Claude);
        let dana = agent("Dana", ChatProvider::Codex);
        let agents = [charlie.clone(), dana.clone()];
        let chain = resolve_agent_chain(&agents, &[dana.id, charlie.id, dana.id]).expect("chain");
        assert_eq!(
            chain.iter().map(|a| a.id).collect::<Vec<_>>(),
            vec![dana.id, charlie.id]
        );
        assert!(resolve_agent_chain(&agents, &[]).is_err());
        assert!(resolve_agent_chain(&agents, &[Uuid::new_v4()]).is_err());
    }

    #[test]
    fn side_thread_titles_name_the_agent_and_the_ask() {
        assert_eq!(
            side_thread_title("Charlie", "please  review\nthis work"),
            "Charlie · please review this work"
        );
        assert_eq!(side_thread_title("Charlie", "  "), "Charlie thread");
    }

    #[test]
    fn side_thread_titles_drop_the_leading_mention() {
        assert_eq!(
            side_thread_title("Charlie", "@Charlie please review this work"),
            "Charlie · please review this work"
        );
        assert_eq!(
            side_thread_title("Charlie", "@charlie, what is the secret word?"),
            "Charlie · what is the secret word?"
        );
        // Only a mention of this agent is stripped, and only at the start.
        assert_eq!(
            side_thread_title("Charlie", "@Dana and @Charlie"),
            "Charlie · @Dana and @Charlie"
        );
        assert_eq!(side_thread_title("Charlie", "@Charlie"), "Charlie thread");
    }

    #[test]
    fn a_second_switch_does_not_nest_the_previous_notice() {
        let mut thread = thread_after_exchange(
            ChatProvider::Grok,
            ChatProvider::Claude.default_instance_id(),
        );
        thread.messages.push(message(
            ChatRole::System,
            "Context handed off (Claude → Codex): 2 messages carried over.",
        ));
        thread
            .messages
            .push(message(ChatRole::Assistant, "codex reply"));
        let (handoff, _) =
            handoff_for_thread(&profiles(), &HashMap::new(), &thread).expect("handoff");
        assert_eq!(handoff.included, 3, "system notice is not conversation");
        assert!(!handoff.preamble.contains("Context handed off"));
        assert!(handoff.preamble.contains("codex reply"));
    }
}
