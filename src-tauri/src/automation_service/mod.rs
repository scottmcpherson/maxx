//! Maxx-owned automation service: typed IPC mapping, authenticated provider
//! capability issuance, durable scheduler lifecycle, and unattended execution.

mod gateway;

use crate::automation::{
    AutomationStore, ClaimedRun, FinishRun, RunOutcome, RunRecord, RunStatus, Schedule,
    ScheduleAction, ScheduleKind, ScheduleRequest, ScheduleStatus, ScheduleUpdate,
};
use crate::events::{emit, EventSink};
use crate::host_tools::HostToolAccess;
use crate::state::{find_thread, AppState};
use jiff::Timestamp;
use maxx_core::contract::{AppleDate, ChatProvider, ProviderTurnTerminalState};
use maxx_core::persist::{ChatMessage, ChatRole, ChatThread};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const RUN_LEASE_MS: i64 = 120_000;
const RUN_HEARTBEAT_SECONDS: u64 = 30;
const MAX_CLAIMS_PER_TICK: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ProviderAccessKey {
    project_id: Uuid,
    thread_id: Uuid,
    provider: ChatProvider,
    model: String,
    effort: Option<String>,
    speed: Option<String>,
    profile_id: Uuid,
    mutations_allowed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationKind {
    Notification,
    AgentTurn,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AutomationSchedule {
    Once {
        at: String,
        timezone: String,
    },
    Interval {
        every_seconds: u64,
        timezone: String,
    },
    Cron {
        expression: String,
        timezone: String,
    },
}

impl AutomationSchedule {
    fn timezone(&self) -> &str {
        match self {
            Self::Once { timezone, .. }
            | Self::Interval { timezone, .. }
            | Self::Cron { timezone, .. } => timezone,
        }
    }

    fn into_store(self, now_ms: i64) -> Result<ScheduleKind, String> {
        match self {
            Self::Once { at, .. } => Ok(ScheduleKind::Once {
                at_ms: parse_timestamp(&at)?,
            }),
            Self::Interval { every_seconds, .. } => {
                let every_ms = i64::try_from(every_seconds)
                    .ok()
                    .and_then(|value| value.checked_mul(1_000))
                    .filter(|value| *value > 0)
                    .ok_or("Interval is too large or must be positive.")?;
                Ok(ScheduleKind::Interval {
                    every_ms,
                    start_at_ms: Some(
                        now_ms
                            .checked_add(every_ms)
                            .ok_or("Interval start time overflowed.")?,
                    ),
                })
            }
            Self::Cron { expression, .. } => Ok(ScheduleKind::Cron {
                expression,
                start_at_ms: None,
            }),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRuntimeRequest {
    pub provider: Option<ChatProvider>,
    pub model: Option<String>,
    #[serde(rename = "profileID")]
    pub profile_id: Option<Uuid>,
    #[serde(rename = "projectID")]
    pub project_id: Option<Uuid>,
    #[serde(rename = "threadID")]
    pub thread_id: Option<Uuid>,
    pub effort: Option<String>,
    pub speed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCreateRequest {
    pub title: String,
    pub kind: AutomationKind,
    pub prompt: String,
    pub schedule: AutomationSchedule,
    pub runtime: Option<AutomationRuntimeRequest>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpdateRequest {
    pub title: Option<String>,
    pub kind: Option<AutomationKind>,
    pub prompt: Option<String>,
    pub schedule: Option<AutomationSchedule>,
    pub runtime: Option<AutomationRuntimeRequest>,
    pub status: Option<AutomationMutableStatus>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationMutableStatus {
    Active,
    Paused,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationStatus {
    Active,
    Paused,
    Running,
    NeedsAttention,
    Failed,
    Completed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRuntimeView {
    pub provider: Option<ChatProvider>,
    pub model: Option<String>,
    #[serde(rename = "profileID")]
    pub profile_id: Option<Uuid>,
    #[serde(rename = "projectID")]
    pub project_id: Option<Uuid>,
    #[serde(rename = "threadID")]
    pub thread_id: Option<Uuid>,
    pub effort: Option<String>,
    pub speed: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunView {
    pub id: Uuid,
    pub scheduled_for: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub status: AutomationRunStatus,
    pub summary: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Queued,
    Running,
    Completed,
    NeedsAttention,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationView {
    pub id: Uuid,
    pub title: String,
    pub kind: AutomationKind,
    pub prompt: String,
    pub schedule: AutomationSchedule,
    pub status: AutomationStatus,
    pub runtime: Option<AutomationRuntimeView>,
    pub next_run_at: Option<String>,
    pub last_run: Option<AutomationRunView>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct AutomationScope {
    pub project_id: Uuid,
    pub thread_id: Uuid,
    pub provider: ChatProvider,
    pub provider_instance_id: Uuid,
    pub model: String,
    pub effort: Option<String>,
    pub speed: Option<String>,
    pub mutations_allowed: bool,
}

#[derive(Clone)]
pub struct AuthenticatedAutomationScope(pub AutomationScope);

pub struct AutomationService {
    store: AutomationStore,
    owner: String,
    endpoint: String,
    tokens: Mutex<HashMap<String, AutomationScope>>,
    provider_access: Mutex<HashMap<ProviderAccessKey, Arc<HostToolAccess>>>,
    app: OnceLock<Weak<AppState>>,
    events: Arc<dyn EventSink>,
    wakeup: Notify,
    cancellation: CancellationToken,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl AutomationService {
    pub async fn start(
        database_path: PathBuf,
        events: Arc<dyn EventSink>,
    ) -> Result<Arc<Self>, String> {
        let store = AutomationStore::open(database_path).map_err(|error| error.to_string())?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("Could not bind automation gateway: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Could not inspect automation gateway: {error}"))?;
        let cancellation = CancellationToken::new();
        let service = Arc::new(Self {
            store,
            owner: format!("maxx-{}", Uuid::new_v4()),
            endpoint: format!("http://{address}/mcp"),
            tokens: Mutex::new(HashMap::new()),
            provider_access: Mutex::new(HashMap::new()),
            app: OnceLock::new(),
            events,
            wakeup: Notify::new(),
            cancellation,
            tasks: Mutex::new(Vec::new()),
        });
        let gateway = gateway::spawn(service.clone(), listener)?;
        service
            .tasks
            .lock()
            .expect("automation task mutex poisoned")
            .push(gateway);
        Ok(service)
    }

    pub fn bind_app(self: &Arc<Self>, app: &Arc<AppState>) -> Result<(), String> {
        self.app
            .set(Arc::downgrade(app))
            .map_err(|_| "Automation service was already bound.".to_string())?;
        let service = self.clone();
        let task = tokio::spawn(async move { service.run_loop().await });
        self.tasks
            .lock()
            .expect("automation task mutex poisoned")
            .push(task);
        self.wakeup.notify_one();
        Ok(())
    }

    pub fn access_for_scope(&self, scope: AutomationScope) -> Arc<HostToolAccess> {
        let key = ProviderAccessKey {
            project_id: scope.project_id,
            thread_id: scope.thread_id,
            provider: scope.provider,
            model: scope.model.clone(),
            effort: scope.effort.clone(),
            speed: scope.speed.clone(),
            profile_id: scope.provider_instance_id,
            mutations_allowed: scope.mutations_allowed,
        };
        let mut cached = self
            .provider_access
            .lock()
            .expect("automation access mutex poisoned");
        cached
            .entry(key)
            .or_insert_with(|| {
                let mut secret = [0_u8; 32];
                rand::rngs::OsRng.fill_bytes(&mut secret);
                let token = base64::Engine::encode(
                    &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                    secret,
                );
                self.tokens
                    .lock()
                    .expect("automation token mutex poisoned")
                    .insert(token.clone(), scope);
                Arc::new(HostToolAccess::new(
                    "maxx_automations",
                    self.endpoint.clone(),
                    token,
                ))
            })
            .clone()
    }

    pub(crate) fn authenticate(&self, authorization: &str) -> Option<AutomationScope> {
        let token = authorization.strip_prefix("Bearer ")?;
        self.tokens.lock().ok()?.get(token).cloned()
    }

    pub async fn list(&self) -> Result<Vec<AutomationView>, String> {
        let mut schedules = self
            .store
            .list_schedules()
            .map_err(|error| error.to_string())?;
        schedules.sort_by_key(|schedule| std::cmp::Reverse(schedule.created_at_ms));
        schedules
            .iter()
            .map(|schedule| self.view(schedule))
            .collect()
    }

    pub async fn list_for_scope(
        &self,
        scope: &AutomationScope,
    ) -> Result<Vec<AutomationView>, String> {
        Ok(self
            .list()
            .await?
            .into_iter()
            .filter(|view| {
                self.store
                    .get_schedule(view.id)
                    .ok()
                    .flatten()
                    .is_some_and(|schedule| schedule.source_thread_id == Some(scope.thread_id))
            })
            .collect())
    }

    pub async fn create(
        self: &Arc<Self>,
        request: AutomationCreateRequest,
        scope: Option<&AutomationScope>,
    ) -> Result<AutomationView, String> {
        validate_text(&request.title, "Automation name")?;
        validate_text(&request.prompt, "Automation action")?;
        let app = self.app()?;
        // An authenticated MCP scope is the only source of chat ownership.
        // Runtime project/thread fields are accepted for local IPC callers,
        // but can never spoof the chat that issued a gateway request.
        let source_project_id = scope.map(|scope| scope.project_id).or_else(|| {
            request
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.project_id)
        });
        let source_thread_id = scope.map(|scope| scope.thread_id).or_else(|| {
            request
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.thread_id)
        });
        let mut runtime = resolved_runtime(request.runtime.as_ref(), scope);
        self.resolve_enabled_profile(&app, &mut runtime).await?;
        let timezone = request.schedule.timezone().to_string();
        let now = now_ms();
        let kind = request.schedule.clone().into_store(now)?;
        // Validate the complete timing definition before allocating a
        // dedicated execution chat. Invalid cron/timezone input must not
        // leave an orphaned chat behind.
        self.store
            .validate_schedule(&kind, &timezone, now)
            .map_err(|error| error.to_string())?;
        let execution = if request.kind == AutomationKind::AgentTurn {
            Some(
                self.create_execution_thread(&app, source_project_id, &request.title, &runtime)
                    .await?,
            )
        } else {
            None
        };
        let action = match request.kind {
            AutomationKind::Notification => ScheduleAction::Notification {
                message: request.prompt,
            },
            AutomationKind::AgentTurn => ScheduleAction::AgentTurn {
                prompt: request.prompt,
            },
        };
        let (execution_project_id, execution_thread_id, provider_instance_id) = execution
            .as_ref()
            .map(|value| (Some(value.0), Some(value.1.id), Some(value.1.instance_id())))
            .unwrap_or((None, None, None));
        let schedule = self
            .store
            .create_schedule(
                ScheduleRequest {
                    name: Some(request.title),
                    source_project_id,
                    source_thread_id,
                    execution_project_id,
                    execution_thread_id,
                    provider_instance_id,
                    provider: (request.kind == AutomationKind::AgentTurn)
                        .then(|| runtime.provider.raw_value().to_string()),
                    model: (request.kind == AutomationKind::AgentTurn)
                        .then(|| runtime.model.clone()),
                    effort: runtime.effort.clone(),
                    speed: runtime.speed.clone(),
                    profile_id: runtime.profile_id,
                    kind,
                    action,
                    timezone,
                    allow_overlap: false,
                },
                now,
            )
            .map_err(|error| error.to_string())?;
        self.changed(schedule.id, "created");
        self.wakeup.notify_one();
        self.view(&schedule)
    }

    pub async fn update(
        self: &Arc<Self>,
        id: Uuid,
        request: AutomationUpdateRequest,
    ) -> Result<AutomationView, String> {
        let current = self
            .store
            .get_schedule(id)
            .map_err(|error| error.to_string())?
            .ok_or("Automation not found.")?;
        if let Some(title) = &request.title {
            validate_text(title, "Automation name")?;
        }
        if let Some(prompt) = &request.prompt {
            validate_text(prompt, "Automation action")?;
        }
        let target_kind = request
            .kind
            .unwrap_or_else(|| automation_kind(&current.action));
        let now = now_ms();
        let (kind, timezone) = if let Some(schedule) = request.schedule.clone() {
            let timezone = Some(schedule.timezone().to_string());
            let kind = schedule.into_store(now)?;
            self.store
                .validate_schedule(&kind, timezone.as_deref().unwrap(), now)
                .map_err(|error| error.to_string())?;
            (Some(kind), timezone)
        } else {
            (None, None)
        };
        let current_runtime_scope =
            current
                .provider
                .as_deref()
                .and_then(parse_provider)
                .map(|provider| AutomationScope {
                    project_id: current
                        .source_project_id
                        .unwrap_or(crate::commands::CHATS_PROJECT_ID),
                    thread_id: current.source_thread_id.unwrap_or_else(Uuid::nil),
                    provider,
                    provider_instance_id: current
                        .profile_id
                        .or(current.provider_instance_id)
                        .unwrap_or_else(|| provider.default_instance_id()),
                    model: current.model.clone().unwrap_or_else(|| "Default".into()),
                    effort: current.effort.clone(),
                    speed: current.speed.clone(),
                    mutations_allowed: true,
                });
        let mut runtime =
            resolved_runtime(request.runtime.as_ref(), current_runtime_scope.as_ref());
        let mut execution_project_id = current.execution_project_id;
        let mut execution_thread_id = current.execution_thread_id;
        let mut provider_instance_id = current.provider_instance_id;
        let mut provider = current.provider.clone();
        let mut model = current.model.clone();
        let mut effort = current.effort.clone();
        let mut speed = current.speed.clone();
        let mut profile_id = current.profile_id;
        if target_kind == AutomationKind::AgentTurn {
            if request.runtime.is_some() || execution_thread_id.is_none() {
                let app = self.app()?;
                self.resolve_enabled_profile(&app, &mut runtime).await?;
                if let (Some(project_id), Some(thread_id)) =
                    (execution_project_id, execution_thread_id)
                {
                    self.update_execution_thread(&app, project_id, thread_id, &runtime)
                        .await?;
                    provider_instance_id = Some(
                        runtime
                            .profile_id
                            .unwrap_or_else(|| runtime.provider.default_instance_id()),
                    );
                } else {
                    let created = self
                        .create_execution_thread(
                            &app,
                            current.source_project_id,
                            request
                                .title
                                .as_deref()
                                .or(current.name.as_deref())
                                .unwrap_or("Automation"),
                            &runtime,
                        )
                        .await?;
                    execution_project_id = Some(created.0);
                    execution_thread_id = Some(created.1.id);
                    provider_instance_id = Some(created.1.instance_id());
                }
                provider = Some(runtime.provider.raw_value().to_string());
                model = Some(runtime.model.clone());
                effort = runtime.effort.clone();
                speed = runtime.speed.clone();
                profile_id = runtime.profile_id;
            }
        }
        let action = match (target_kind, request.prompt) {
            (AutomationKind::Notification, Some(prompt)) => {
                Some(ScheduleAction::Notification { message: prompt })
            }
            (AutomationKind::Notification, None) => Some(ScheduleAction::Notification {
                message: action_text(&current.action).to_string(),
            }),
            (AutomationKind::AgentTurn, Some(prompt)) => Some(ScheduleAction::AgentTurn { prompt }),
            (AutomationKind::AgentTurn, None) => Some(ScheduleAction::AgentTurn {
                prompt: action_text(&current.action).to_string(),
            }),
        };
        let update = ScheduleUpdate {
            name: request.title,
            source_project_id: None,
            source_thread_id: None,
            execution_project_id,
            execution_thread_id,
            provider_instance_id,
            provider,
            model,
            effort,
            speed,
            profile_id,
            kind,
            action,
            timezone,
            allow_overlap: None,
        };
        let mut schedule = self
            .store
            .update_schedule(id, update, now)
            .map_err(|error| error.to_string())?;
        if let Some(status) = request.status {
            schedule = match status {
                AutomationMutableStatus::Active => self.store.resume_schedule(id, now),
                AutomationMutableStatus::Paused => self.store.pause_schedule(id, now),
            }
            .map_err(|error| error.to_string())?;
        }
        self.changed(id, "updated");
        self.wakeup.notify_one();
        self.view(&schedule)
    }

    pub async fn delete(&self, id: Uuid) -> Result<(), String> {
        if !self
            .store
            .delete_schedule(id, now_ms())
            .map_err(|error| error.to_string())?
        {
            return Err("Automation not found.".into());
        }
        self.changed(id, "deleted");
        self.wakeup.notify_one();
        Ok(())
    }

    pub async fn run_now(self: &Arc<Self>, id: Uuid) -> Result<AutomationRunView, String> {
        let claimed = self
            .store
            .claim_now(id, now_ms(), &self.owner, RUN_LEASE_MS)
            .map_err(|error| error.to_string())?;
        let run = run_view(&claimed.run)?;
        let service = self.clone();
        tokio::spawn(async move { service.execute(claimed).await });
        self.changed(id, "run_queued");
        Ok(run)
    }

    pub fn schedule_owned_by(&self, id: Uuid, scope: &AutomationScope) -> Result<bool, String> {
        Ok(self
            .store
            .get_schedule(id)
            .map_err(|error| error.to_string())?
            .is_some_and(|schedule| schedule.source_thread_id == Some(scope.thread_id)))
    }

    pub async fn shutdown(&self) {
        self.cancellation.cancel();
        let tasks =
            std::mem::take(&mut *self.tasks.lock().expect("automation task mutex poisoned"));
        for task in tasks {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
    }

    fn app(&self) -> Result<Arc<AppState>, String> {
        self.app
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| "Automation service is not ready.".into())
    }

    async fn create_execution_thread(
        &self,
        app: &Arc<AppState>,
        source_project_id: Option<Uuid>,
        title: &str,
        runtime: &ResolvedRuntime,
    ) -> Result<(Uuid, ChatThread), String> {
        let title = format!("Automation: {}", title.trim());
        let project_exists = if let Some(project_id) = source_project_id {
            app.workspace
                .lock()
                .await
                .projects
                .iter()
                .any(|project| project.id == project_id)
        } else {
            false
        };
        let (project_id, mut thread) = if project_exists {
            let project_id = source_project_id.expect("checked above");
            let thread = crate::commands::add_thread_with_runtime(
                app.clone(),
                project_id,
                runtime.provider,
                runtime.model.clone(),
                title,
                runtime.effort.clone(),
                runtime.speed.clone(),
                None,
                Some(false),
            )
            .await?;
            (project_id, thread)
        } else {
            let thread = crate::commands::add_chat(
                app.clone(),
                runtime.provider,
                runtime.model.clone(),
                title,
                runtime.effort.clone(),
                runtime.speed.clone(),
            )
            .await?;
            (crate::commands::CHATS_PROJECT_ID, thread)
        };
        if let Some(profile_id) = runtime.profile_id {
            let mut workspace = app.workspace.lock().await;
            let stored = find_thread(&mut workspace, project_id, thread.id)
                .ok_or("Could not persist the automation runtime.")?;
            stored.provider_instance_id = Some(profile_id);
            stored.updated_at = AppleDate::now();
            thread.provider_instance_id = Some(profile_id);
            drop(workspace);
            app.save().await;
        }
        Ok((project_id, thread))
    }

    async fn resolve_enabled_profile(
        &self,
        app: &Arc<AppState>,
        runtime: &mut ResolvedRuntime,
    ) -> Result<(), String> {
        let workspace = app.workspace.lock().await;
        let requested = runtime.profile_id.and_then(|id| {
            workspace
                .provider_profiles
                .iter()
                .find(|profile| profile.id == id)
        });
        if requested
            .is_some_and(|profile| profile.provider == runtime.provider && profile.is_enabled)
        {
            return Ok(());
        }
        runtime.profile_id = workspace
            .provider_profiles
            .iter()
            .find(|profile| profile.provider == runtime.provider && profile.is_enabled)
            .map(|profile| profile.id)
            .or_else(|| Some(runtime.provider.default_instance_id()));
        Ok(())
    }

    async fn update_execution_thread(
        &self,
        app: &Arc<AppState>,
        project_id: Uuid,
        thread_id: Uuid,
        runtime: &ResolvedRuntime,
    ) -> Result<(), String> {
        let mut workspace = app.workspace.lock().await;
        let thread = find_thread(&mut workspace, project_id, thread_id)
            .ok_or("The dedicated automation chat no longer exists.")?;
        if thread.provider != runtime.provider {
            thread.provider_session_id = None;
            thread.provider_resume_cursor = None;
        }
        thread.provider = runtime.provider;
        thread.provider_instance_id = Some(
            runtime
                .profile_id
                .unwrap_or_else(|| runtime.provider.default_instance_id()),
        );
        thread.model = runtime.model.clone();
        thread.effort = runtime.effort.clone();
        thread.speed = runtime.speed.clone();
        thread.updated_at = AppleDate::now();
        drop(workspace);
        app.save().await;
        Ok(())
    }

    fn view(&self, schedule: &Schedule) -> Result<AutomationView, String> {
        let runs = self
            .store
            .list_runs(schedule.id)
            .map_err(|error| error.to_string())?;
        let last = runs.last();
        let status = if runs.iter().any(|run| {
            matches!(run.status, RunStatus::Claimed | RunStatus::Running)
                && run.lease_until_ms.unwrap_or(i64::MIN) > now_ms()
        }) {
            AutomationStatus::Running
        } else if schedule.status == ScheduleStatus::Paused {
            AutomationStatus::Paused
        } else if last.is_some_and(|run| run.status == RunStatus::NeedsAttention) {
            AutomationStatus::NeedsAttention
        } else if last.is_some_and(|run| run.status == RunStatus::Failed) {
            AutomationStatus::Failed
        } else {
            match schedule.status {
                ScheduleStatus::Paused => AutomationStatus::Paused,
                ScheduleStatus::Completed => AutomationStatus::Completed,
                ScheduleStatus::Active => AutomationStatus::Active,
            }
        };
        let (kind, prompt) = match &schedule.action {
            ScheduleAction::Notification { message } => {
                (AutomationKind::Notification, message.clone())
            }
            ScheduleAction::AgentTurn { prompt } => (AutomationKind::AgentTurn, prompt.clone()),
        };
        Ok(AutomationView {
            id: schedule.id,
            title: schedule.name.clone().unwrap_or_else(|| "Automation".into()),
            kind,
            prompt,
            schedule: schedule_view(schedule)?,
            status,
            runtime: (kind == AutomationKind::AgentTurn).then(|| AutomationRuntimeView {
                provider: schedule.provider.as_deref().and_then(parse_provider),
                model: schedule.model.clone(),
                profile_id: schedule.profile_id,
                project_id: schedule.execution_project_id,
                thread_id: schedule.execution_thread_id,
                effort: schedule.effort.clone(),
                speed: schedule.speed.clone(),
            }),
            next_run_at: schedule.next_run_ms.map(format_timestamp).transpose()?,
            last_run: last.map(run_view).transpose()?,
            created_at: format_timestamp(schedule.created_at_ms)?,
            updated_at: format_timestamp(schedule.updated_at_ms)?,
        })
    }

    async fn run_loop(self: Arc<Self>) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = self.cancellation.cancelled() => break,
                _ = self.wakeup.notified() => {},
                _ = interval.tick() => {},
            }
            let claimed =
                match self
                    .store
                    .claim_due(now_ms(), &self.owner, RUN_LEASE_MS, MAX_CLAIMS_PER_TICK)
                {
                    Ok(claimed) => claimed,
                    Err(error) => {
                        log::error!("automation scheduler tick failed: {error}");
                        continue;
                    }
                };
            for run in claimed {
                let service = self.clone();
                tokio::spawn(async move { service.execute(run).await });
            }
        }
    }

    async fn execute(self: Arc<Self>, claimed: ClaimedRun) {
        let run_id = claimed.run.id;
        let attempt = claimed.run.attempt;
        let schedule_id = claimed.schedule.id;
        if let Err(error) =
            self.store
                .mark_running(run_id, &self.owner, attempt, now_ms(), RUN_LEASE_MS)
        {
            log::warn!("automation run {run_id} lost its lease before start: {error}");
            return;
        }
        self.changed(schedule_id, "run_started");
        let heartbeat_stop = CancellationToken::new();
        let heartbeat = {
            let store = self.store.clone();
            let owner = self.owner.clone();
            let stop = heartbeat_stop.clone();
            tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(RUN_HEARTBEAT_SECONDS));
                interval.tick().await;
                loop {
                    tokio::select! {
                        _ = stop.cancelled() => break,
                        _ = interval.tick() => {
                            if store.renew_lease(run_id, &owner, attempt, now_ms(), RUN_LEASE_MS).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
        };
        let outcome = self.execute_action(&claimed.schedule).await;
        heartbeat_stop.cancel();
        let _ = heartbeat.await;
        let outcome = match outcome {
            Ok(ActionOutcome::Succeeded(summary)) => RunOutcome::Succeeded { result: summary },
            Ok(ActionOutcome::NeedsAttention(reason)) => RunOutcome::NeedsAttention { reason },
            Err(error) => RunOutcome::Failed { error },
        };
        if let Err(error) = self.store.finish_run(FinishRun {
            run_id,
            owner: self.owner.clone(),
            attempt,
            now_ms: now_ms(),
            outcome,
        }) {
            log::error!("automation run {run_id} could not be finished: {error}");
        }
        self.changed(schedule_id, "run_finished");
    }

    async fn execute_action(&self, schedule: &Schedule) -> Result<ActionOutcome, String> {
        match &schedule.action {
            ScheduleAction::Notification { message } => {
                let title = schedule.name.as_deref().unwrap_or("Maxx reminder");
                emit(
                    self.events.as_ref(),
                    "notification://automation",
                    &serde_json::json!({"title": title, "body": message, "automationID": schedule.id}),
                );
                if let (Some(project_id), Some(thread_id)) =
                    (schedule.source_project_id, schedule.source_thread_id)
                {
                    if let Ok(app) = self.app() {
                        let mut workspace = app.workspace.lock().await;
                        if let Some(thread) = find_thread(&mut workspace, project_id, thread_id) {
                            thread.messages.push(ChatMessage {
                                id: Uuid::new_v4(),
                                role: ChatRole::System,
                                content: format!("Reminder: {message}"),
                                attachments: Vec::new(),
                                annotations: Vec::new(),
                                text_selections: Vec::new(),
                                created_at: AppleDate::now(),
                                source_event_id: None,
                                agent_id: None,
                            });
                            thread.updated_at = AppleDate::now();
                            drop(workspace);
                            app.save().await;
                        }
                    }
                }
                Ok(ActionOutcome::Succeeded(Some(
                    "Notification delivered".into(),
                )))
            }
            ScheduleAction::AgentTurn { prompt } => {
                let Some(project_id) = schedule.execution_project_id else {
                    return Ok(ActionOutcome::NeedsAttention(
                        "This automation has no dedicated execution project. Edit it to repair the runtime."
                            .into(),
                    ));
                };
                let Some(thread_id) = schedule.execution_thread_id else {
                    return Ok(ActionOutcome::NeedsAttention(
                        "This automation has no dedicated execution chat. Edit it to repair the runtime."
                            .into(),
                    ));
                };
                let app = self.app()?;
                let outcome = match crate::commands::run_automation_prompt(
                    app,
                    project_id,
                    thread_id,
                    prompt.clone(),
                )
                .await
                {
                    Ok(outcome) => outcome,
                    Err(error) if error.contains("no longer exists") => {
                        return Ok(ActionOutcome::NeedsAttention(error));
                    }
                    Err(error) => return Err(error),
                };
                if let Some(reason) = outcome.needs_attention {
                    return Ok(ActionOutcome::NeedsAttention(reason));
                }
                match outcome.terminal_state {
                    Some(ProviderTurnTerminalState::Completed) => Ok(ActionOutcome::Succeeded(
                        (!outcome.assistant_text.trim().is_empty())
                            .then(|| outcome.assistant_text.trim().to_string()),
                    )),
                    Some(state) => Err(format!("Scheduled agent turn ended as {state:?}.")),
                    None => Err("Scheduled agent turn ended without a terminal state.".into()),
                }
            }
        }
    }

    fn changed(&self, id: Uuid, change: &str) {
        emit(
            self.events.as_ref(),
            "automation://changed",
            &serde_json::json!({"id": id, "change": change}),
        );
    }
}

#[derive(Debug, Clone)]
struct ResolvedRuntime {
    provider: ChatProvider,
    model: String,
    profile_id: Option<Uuid>,
    effort: Option<String>,
    speed: Option<String>,
}

enum ActionOutcome {
    Succeeded(Option<String>),
    NeedsAttention(String),
}

fn resolved_runtime(
    request: Option<&AutomationRuntimeRequest>,
    scope: Option<&AutomationScope>,
) -> ResolvedRuntime {
    let requested_provider = request.and_then(|runtime| runtime.provider);
    let provider = requested_provider
        .or_else(|| scope.map(|scope| scope.provider))
        .unwrap_or(ChatProvider::Codex);
    // A provider switch starts a new runtime binding. Do not silently carry
    // the source harness's model, profile, or tuning knobs into another
    // provider when the request leaves them unspecified.
    let scope_runtime = scope.filter(|scope| scope.provider == provider);
    ResolvedRuntime {
        provider,
        model: request
            .and_then(|runtime| runtime.model.clone())
            .or_else(|| scope_runtime.map(|scope| scope.model.clone()))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Default".into()),
        profile_id: request
            .and_then(|runtime| runtime.profile_id)
            .or_else(|| scope_runtime.map(|scope| scope.provider_instance_id)),
        effort: request
            .and_then(|runtime| runtime.effort.clone())
            .or_else(|| scope_runtime.and_then(|scope| scope.effort.clone())),
        speed: request
            .and_then(|runtime| runtime.speed.clone())
            .or_else(|| scope_runtime.and_then(|scope| scope.speed.clone())),
    }
}

fn schedule_view(schedule: &Schedule) -> Result<AutomationSchedule, String> {
    match &schedule.kind {
        ScheduleKind::Once { at_ms } => Ok(AutomationSchedule::Once {
            at: format_timestamp(*at_ms)?,
            timezone: schedule.timezone.clone(),
        }),
        ScheduleKind::Interval { every_ms, .. } => Ok(AutomationSchedule::Interval {
            every_seconds: u64::try_from(*every_ms / 1_000)
                .map_err(|_| "Invalid stored interval.".to_string())?,
            timezone: schedule.timezone.clone(),
        }),
        ScheduleKind::Cron { expression, .. } => Ok(AutomationSchedule::Cron {
            expression: expression.clone(),
            timezone: schedule.timezone.clone(),
        }),
    }
}

fn run_view(run: &RunRecord) -> Result<AutomationRunView, String> {
    Ok(AutomationRunView {
        id: run.id,
        scheduled_for: format_timestamp(run.scheduled_for_ms)?,
        started_at: run.started_at_ms.map(format_timestamp).transpose()?,
        finished_at: run.finished_at_ms.map(format_timestamp).transpose()?,
        status: match run.status {
            RunStatus::Claimed => AutomationRunStatus::Queued,
            RunStatus::Running => AutomationRunStatus::Running,
            RunStatus::Succeeded => AutomationRunStatus::Completed,
            RunStatus::NeedsAttention => AutomationRunStatus::NeedsAttention,
            RunStatus::Failed => AutomationRunStatus::Failed,
        },
        summary: run.result.clone(),
        error: run.error.clone(),
    })
}

fn automation_kind(action: &ScheduleAction) -> AutomationKind {
    match action {
        ScheduleAction::Notification { .. } => AutomationKind::Notification,
        ScheduleAction::AgentTurn { .. } => AutomationKind::AgentTurn,
    }
}

fn action_text(action: &ScheduleAction) -> &str {
    match action {
        ScheduleAction::Notification { message } => message,
        ScheduleAction::AgentTurn { prompt } => prompt,
    }
}

fn parse_provider(value: &str) -> Option<ChatProvider> {
    serde_json::from_value(serde_json::Value::String(value.to_string())).ok()
}

fn validate_text(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} cannot be empty."))
    } else {
        Ok(())
    }
}

fn parse_timestamp(value: &str) -> Result<i64, String> {
    value
        .parse::<Timestamp>()
        .map(|timestamp| timestamp.as_millisecond())
        .map_err(|error| format!("Invalid ISO timestamp `{value}`: {error}"))
}

fn format_timestamp(value: i64) -> Result<String, String> {
    Timestamp::from_millisecond(value)
        .map(|timestamp| timestamp.to_string())
        .map_err(|error| format!("Invalid stored timestamp `{value}`: {error}"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(provider: ChatProvider) -> AutomationScope {
        AutomationScope {
            project_id: Uuid::new_v4(),
            thread_id: Uuid::new_v4(),
            provider,
            provider_instance_id: provider.default_instance_id(),
            model: "source-model".into(),
            effort: Some("high".into()),
            speed: Some("fast".into()),
            mutations_allowed: true,
        }
    }

    #[test]
    fn provider_switch_does_not_inherit_source_runtime() {
        let source = scope(ChatProvider::Hermes);
        let request = AutomationRuntimeRequest {
            provider: Some(ChatProvider::Claude),
            ..Default::default()
        };
        let runtime = resolved_runtime(Some(&request), Some(&source));
        assert_eq!(runtime.provider, ChatProvider::Claude);
        assert_eq!(runtime.model, "Default");
        assert_eq!(runtime.profile_id, None);
        assert_eq!(runtime.effort, None);
        assert_eq!(runtime.speed, None);
    }

    #[test]
    fn same_provider_inherits_source_runtime_when_unspecified() {
        let source = scope(ChatProvider::Hermes);
        let request = AutomationRuntimeRequest::default();
        let runtime = resolved_runtime(Some(&request), Some(&source));
        assert_eq!(runtime.provider, ChatProvider::Hermes);
        assert_eq!(runtime.model, "source-model");
        assert_eq!(runtime.profile_id, Some(source.provider_instance_id));
        assert_eq!(runtime.effort, source.effort);
        assert_eq!(runtime.speed, source.speed);
    }

    #[test]
    fn unknown_runtime_fields_are_rejected_by_deserialization() {
        let value = serde_json::json!({
            "provider": "hermes",
            "untrustedField": "spoof",
        });
        assert!(serde_json::from_value::<AutomationRuntimeRequest>(value).is_err());
    }

    #[test]
    fn provider_access_key_separates_runtime_bindings() {
        let source = scope(ChatProvider::Hermes);
        let key = |model: &str| ProviderAccessKey {
            project_id: source.project_id,
            thread_id: source.thread_id,
            provider: source.provider,
            model: model.into(),
            effort: source.effort.clone(),
            speed: source.speed.clone(),
            profile_id: source.provider_instance_id,
            mutations_allowed: source.mutations_allowed,
        };
        assert_ne!(key("one"), key("two"));
    }
}
