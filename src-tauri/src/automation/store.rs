use super::cron::{next_cron_run_ms, CronExpression};
use jiff::Timestamp;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use thiserror::Error;
use uuid::Uuid;

pub type ScheduleId = Uuid;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("invalid schedule: {0}")]
    InvalidSchedule(String),
    #[error("schedule {0} was not found")]
    ScheduleNotFound(ScheduleId),
    #[error("run {0} was not found")]
    RunNotFound(Uuid),
    #[error("invalid cron expression `{expression}`: {reason}")]
    InvalidCron { expression: String, reason: String },
    #[error("invalid IANA timezone `{timezone}`: {reason}")]
    InvalidTimezone { timezone: String, reason: String },
    #[error("invalid timestamp `{value}`: {reason}")]
    InvalidTimestamp { value: String, reason: String },
    #[error("time calculation failed: {0}")]
    TimeCalculation(String),
    #[error("lease for run {0} is owned by another scheduler")]
    LeaseNotOwned(Uuid),
    #[error("invalid run outcome: {0}")]
    InvalidOutcome(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleStatus {
    Active,
    Paused,
    Completed,
}

impl ScheduleStatus {
    fn parse(value: &str) -> Result<Self, StoreError> {
        match value {
            "active" => Ok(Self::Active),
            "paused" => Ok(Self::Paused),
            "completed" => Ok(Self::Completed),
            _ => Err(StoreError::InvalidSchedule(format!(
                "unknown schedule status `{value}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Claimed,
    Running,
    Succeeded,
    Failed,
    NeedsAttention,
}

impl RunStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Claimed => "claimed",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::NeedsAttention => "needs_attention",
        }
    }

    fn parse(value: &str) -> Result<Self, StoreError> {
        match value {
            "claimed" => Ok(Self::Claimed),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "needs_attention" => Ok(Self::NeedsAttention),
            _ => Err(StoreError::InvalidSchedule(format!(
                "unknown run status `{value}`"
            ))),
        }
    }
}

/// Timing definition. Interval values are milliseconds to keep the on-disk
/// format and IPC representation deterministic. Cron's optional
/// `start_at_ms` is the first instant to consider when creating or resetting a
/// schedule; subsequent occurrences are computed from the IANA zone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScheduleKind {
    Once {
        at_ms: i64,
    },
    Interval {
        every_ms: i64,
        start_at_ms: Option<i64>,
    },
    Cron {
        expression: String,
        start_at_ms: Option<i64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScheduleAction {
    Notification { message: String },
    AgentTurn { prompt: String },
}

impl ScheduleAction {
    fn validate(&self) -> Result<(), StoreError> {
        let text = match self {
            Self::Notification { message } => message,
            Self::AgentTurn { prompt } => prompt,
        };
        if text.trim().is_empty() {
            return Err(StoreError::InvalidSchedule(
                "schedule action text cannot be empty".into(),
            ));
        }
        Ok(())
    }

    fn db_values(&self) -> (&'static str, &str) {
        match self {
            Self::Notification { message } => ("notification", message),
            Self::AgentTurn { prompt } => ("agent_turn", prompt),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRequest {
    pub name: Option<String>,
    pub source_project_id: Option<Uuid>,
    pub source_thread_id: Option<Uuid>,
    pub execution_project_id: Option<Uuid>,
    pub execution_thread_id: Option<Uuid>,
    pub provider_instance_id: Option<Uuid>,
    /// Provider name/profile binding is intentionally opaque to this module;
    /// provider adapters validate it when they execute an AgentTurn.
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub speed: Option<String>,
    pub profile_id: Option<Uuid>,
    pub kind: ScheduleKind,
    pub action: ScheduleAction,
    pub timezone: String,
    #[serde(default)]
    pub allow_overlap: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleUpdate {
    pub name: Option<String>,
    pub source_project_id: Option<Uuid>,
    pub source_thread_id: Option<Uuid>,
    pub execution_project_id: Option<Uuid>,
    pub execution_thread_id: Option<Uuid>,
    pub provider_instance_id: Option<Uuid>,
    pub provider: Option<String>,
    pub kind: Option<ScheduleKind>,
    pub action: Option<ScheduleAction>,
    pub timezone: Option<String>,
    pub allow_overlap: Option<bool>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub speed: Option<String>,
    pub profile_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: ScheduleId,
    pub name: Option<String>,
    pub source_project_id: Option<Uuid>,
    pub source_thread_id: Option<Uuid>,
    pub execution_project_id: Option<Uuid>,
    pub execution_thread_id: Option<Uuid>,
    pub provider_instance_id: Option<Uuid>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub speed: Option<String>,
    pub profile_id: Option<Uuid>,
    pub kind: ScheduleKind,
    pub action: ScheduleAction,
    pub timezone: String,
    pub allow_overlap: bool,
    pub status: ScheduleStatus,
    pub next_run_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl Schedule {
    pub fn is_recurring(&self) -> bool {
        matches!(
            self.kind,
            ScheduleKind::Interval { .. } | ScheduleKind::Cron { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: Uuid,
    pub schedule_id: ScheduleId,
    pub scheduled_for_ms: i64,
    pub status: RunStatus,
    pub attempt: u32,
    pub manual: bool,
    pub lease_owner: Option<String>,
    pub lease_until_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
    pub result: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedRun {
    pub run: RunRecord,
    pub schedule: Schedule,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    Succeeded { result: Option<String> },
    Failed { error: String },
    NeedsAttention { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishRun {
    pub run_id: Uuid,
    pub owner: String,
    /// Claim generation returned by `claim_due`/`claim_now`. Reclaims bump
    /// this value so a stale task cannot finish a newer attempt held by the
    /// same scheduler owner.
    pub attempt: u32,
    pub now_ms: i64,
    pub outcome: RunOutcome,
}

#[derive(Clone)]
pub struct AutomationStore {
    connection: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for AutomationStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AutomationStore").finish_non_exhaustive()
    }
}

impl AutomationStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        if let Some(parent) = path.as_ref().parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    StoreError::InvalidSchedule(format!(
                        "unable to create automation directory: {error}"
                    ))
                })?;
            }
        }
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    /// Validate timing inputs without creating a schedule. Callers that need
    /// to allocate related resources (for example, an execution chat) should
    /// use this before performing those side effects.
    pub fn validate_schedule(
        &self,
        kind: &ScheduleKind,
        timezone: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let request = ScheduleRequest {
            name: None,
            source_project_id: None,
            source_thread_id: None,
            execution_project_id: None,
            execution_thread_id: None,
            provider_instance_id: None,
            provider: None,
            model: None,
            effort: None,
            speed: None,
            profile_id: None,
            kind: kind.clone(),
            action: ScheduleAction::Notification {
                message: "validation".into(),
            },
            timezone: timezone.into(),
            allow_overlap: false,
        };
        validate_request(&request)?;
        first_run_ms(kind, timezone, now_ms)?;
        Ok(())
    }

    fn from_connection(connection: Connection) -> Result<Self, StoreError> {
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS schedules (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT,
                source_project_id TEXT,
                source_thread_id TEXT,
                execution_project_id TEXT,
                execution_thread_id TEXT,
                provider_instance_id TEXT,
                provider TEXT,
                model TEXT,
                effort TEXT,
                speed TEXT,
                profile_id TEXT,
                kind TEXT NOT NULL,
                action_kind TEXT NOT NULL,
                action_text TEXT NOT NULL,
                timezone TEXT NOT NULL,
                allow_overlap INTEGER NOT NULL DEFAULT 0 CHECK (allow_overlap IN (0, 1)),
                status TEXT NOT NULL,
                at_ms INTEGER,
                every_ms INTEGER,
                start_at_ms INTEGER,
                cron_expression TEXT,
                next_run_ms INTEGER,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS schedules_due_idx
                ON schedules(status, next_run_ms);
            CREATE TABLE IF NOT EXISTS schedule_runs (
                id TEXT PRIMARY KEY NOT NULL,
                schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
                scheduled_for_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                attempt INTEGER NOT NULL DEFAULT 1,
                manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
                lease_owner TEXT,
                lease_until_ms INTEGER,
                started_at_ms INTEGER,
                finished_at_ms INTEGER,
                result TEXT,
                error TEXT,
                UNIQUE(schedule_id, scheduled_for_ms)
            );
            CREATE INDEX IF NOT EXISTS schedule_runs_lease_idx
                ON schedule_runs(schedule_id, status, lease_until_ms);
            CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx
                ON schedule_runs(schedule_id, scheduled_for_ms);",
        )?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn create_schedule(
        &self,
        request: ScheduleRequest,
        now_ms: i64,
    ) -> Result<Schedule, StoreError> {
        validate_request(&request)?;
        let id = Uuid::new_v4();
        let next_run_ms = first_run_ms(&request.kind, &request.timezone, now_ms)?;
        let (kind, action_kind, action_text, at_ms, every_ms, start_at_ms, cron_expression) =
            encode_request(&request)?;
        let created_at_ms = now_ms;
        self.with_transaction(|tx| {
            tx.execute(
                "INSERT INTO schedules (
                    id, name, source_project_id, source_thread_id,
                    execution_project_id, execution_thread_id, provider_instance_id, provider,
                    model, effort, speed, profile_id, kind, action_kind, action_text, timezone, allow_overlap, status,
                    at_ms, every_ms, start_at_ms, cron_expression, next_run_ms,
                    created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id.to_string(),
                    request.name,
                    optional_uuid(request.source_project_id),
                    optional_uuid(request.source_thread_id),
                    optional_uuid(request.execution_project_id),
                    optional_uuid(request.execution_thread_id),
                    optional_uuid(request.provider_instance_id),
                    request.provider,
                    request.model,
                    request.effort,
                    request.speed,
                    optional_uuid(request.profile_id),
                    kind,
                    action_kind,
                    action_text,
                    request.timezone,
                    bool_i64(request.allow_overlap),
                    at_ms,
                    every_ms,
                    start_at_ms,
                    cron_expression,
                    next_run_ms,
                    created_at_ms,
                    now_ms,
                ],
            )?;
            load_schedule_tx(tx, id)
        })
    }

    pub fn get_schedule(&self, id: ScheduleId) -> Result<Option<Schedule>, StoreError> {
        self.with_connection(|connection| load_schedule(connection, id))
    }

    pub fn list_schedules(&self) -> Result<Vec<Schedule>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, name, source_project_id, source_thread_id,
                        execution_project_id, execution_thread_id, provider_instance_id, provider,
                        model, effort, speed, profile_id, kind, action_kind, action_text, timezone, allow_overlap, status,
                        at_ms, every_ms, start_at_ms, cron_expression, next_run_ms,
                        created_at_ms, updated_at_ms
                 FROM schedules ORDER BY created_at_ms, id",
            )?;
            let rows = statement.query_map([], schedule_from_row)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StoreError::from)
        })
    }

    pub fn update_schedule(
        &self,
        id: ScheduleId,
        update: ScheduleUpdate,
        now_ms: i64,
    ) -> Result<Schedule, StoreError> {
        self.with_transaction(|tx| {
            let current = load_schedule_tx(tx, id)?;
            let request = ScheduleRequest {
                name: update.name.or(current.name.clone()),
                source_project_id: update.source_project_id.or(current.source_project_id),
                source_thread_id: update.source_thread_id.or(current.source_thread_id),
                execution_project_id: update.execution_project_id.or(current.execution_project_id),
                execution_thread_id: update.execution_thread_id.or(current.execution_thread_id),
                provider_instance_id: update.provider_instance_id.or(current.provider_instance_id),
                provider: update.provider.clone().or_else(|| current.provider.clone()),
                model: update.model.clone().or_else(|| current.model.clone()),
                effort: update.effort.clone().or_else(|| current.effort.clone()),
                speed: update.speed.clone().or_else(|| current.speed.clone()),
                profile_id: update
                    .profile_id
                    .clone()
                    .or_else(|| current.profile_id.clone()),
                kind: update.kind.clone().unwrap_or_else(|| current.kind.clone()),
                action: update.action.unwrap_or_else(|| current.action.clone()),
                timezone: update
                    .timezone
                    .clone()
                    .unwrap_or_else(|| current.timezone.clone()),
                allow_overlap: update.allow_overlap.unwrap_or(current.allow_overlap),
            };
            validate_request(&request)?;
            let kind_changed = update.kind.is_some() || update.timezone.is_some();
            let next_run_ms = if kind_changed {
                first_run_ms(&request.kind, &request.timezone, now_ms)?
            } else {
                current.next_run_ms
            };
            let (kind, action_kind, action_text, at_ms, every_ms, start_at_ms, cron_expression) =
                encode_request(&request)?;
            tx.execute(
                "UPDATE schedules SET name=?, source_project_id=?, source_thread_id=?,
                    execution_project_id=?, execution_thread_id=?, provider_instance_id=?,
                    provider=?, model=?, effort=?, speed=?, profile_id=?, kind=?, action_kind=?, action_text=?,
                    timezone=?, allow_overlap=?, at_ms=?, every_ms=?, start_at_ms=?,
                    cron_expression=?, next_run_ms=?, updated_at_ms=? WHERE id=?",
                params![
                    request.name,
                    optional_uuid(request.source_project_id),
                    optional_uuid(request.source_thread_id),
                    optional_uuid(request.execution_project_id),
                    optional_uuid(request.execution_thread_id),
                    optional_uuid(request.provider_instance_id),
                    request.provider,
                    request.model,
                    request.effort,
                    request.speed,
                    optional_uuid(request.profile_id),
                    kind,
                    action_kind,
                    action_text,
                    request.timezone,
                    bool_i64(request.allow_overlap),
                    at_ms,
                    every_ms,
                    start_at_ms,
                    cron_expression,
                    next_run_ms,
                    now_ms,
                    id.to_string(),
                ],
            )?;
            load_schedule_tx(tx, id)
        })
    }

    pub fn pause_schedule(&self, id: ScheduleId, now_ms: i64) -> Result<Schedule, StoreError> {
        self.with_transaction(|tx| {
            ensure_schedule_exists(tx, id)?;
            tx.execute(
                "UPDATE schedules SET status='paused', updated_at_ms=? WHERE id=?",
                params![now_ms, id.to_string()],
            )?;
            load_schedule_tx(tx, id)
        })
    }

    pub fn resume_schedule(&self, id: ScheduleId, now_ms: i64) -> Result<Schedule, StoreError> {
        self.with_transaction(|tx| {
            let current = load_schedule_tx(tx, id)?;
            if current.status == ScheduleStatus::Completed {
                return Err(StoreError::InvalidSchedule(
                    "completed one-time automations cannot be resumed; use run now instead".into(),
                ));
            }
            let next = if current.next_run_ms.is_none() {
                first_run_ms(&current.kind, &current.timezone, now_ms)?
            } else {
                current.next_run_ms
            };
            tx.execute(
                "UPDATE schedules SET status='active', next_run_ms=?, updated_at_ms=? WHERE id=?",
                params![next, now_ms, id.to_string()],
            )?;
            load_schedule_tx(tx, id)
        })
    }

    /// Delete a schedule only when it has no currently leased execution.
    ///
    /// The active-run check and the delete share one transaction so a claim
    /// cannot race between the caller's check and the row removal.
    pub fn delete_schedule(&self, id: ScheduleId, now_ms: i64) -> Result<bool, StoreError> {
        self.with_transaction(|tx| {
            if has_active_run(tx, id, now_ms)? {
                return Err(StoreError::InvalidSchedule(
                    "Wait for the current automation run to finish before deleting it.".into(),
                ));
            }
            Ok(tx.execute("DELETE FROM schedules WHERE id=?", [id.to_string()])? > 0)
        })
    }

    /// Claim an immediate manual run without changing the schedule's normal
    /// cadence. Manual runs are allowed for paused and completed schedules,
    /// but still respect the schedule's no-overlap policy.
    pub fn claim_now(
        &self,
        id: ScheduleId,
        now_ms: i64,
        owner: &str,
        lease_ms: i64,
    ) -> Result<ClaimedRun, StoreError> {
        if owner.trim().is_empty() || lease_ms <= 0 {
            return Err(StoreError::InvalidSchedule(
                "manual run requires an owner and positive lease".into(),
            ));
        }
        self.with_transaction(|tx| {
            let schedule = load_schedule_tx(tx, id)?;
            if !schedule.allow_overlap && has_active_run(tx, id, now_ms)? {
                return Err(StoreError::InvalidSchedule(
                    "this automation already has a running execution".into(),
                ));
            }
            let last_scheduled: Option<i64> = tx.query_row(
                "SELECT MAX(scheduled_for_ms) FROM schedule_runs WHERE schedule_id=?",
                [id.to_string()],
                |row| row.get(0),
            )?;
            let scheduled_for_ms = last_scheduled.map_or(now_ms, |last| now_ms.max(last + 1));
            let run_id = Uuid::new_v4();
            tx.execute(
                "INSERT INTO schedule_runs
                    (id, schedule_id, scheduled_for_ms, status, attempt, manual,
                     lease_owner, lease_until_ms)
                 VALUES (?, ?, ?, 'claimed', 1, 1, ?, ?)",
                params![
                    run_id.to_string(),
                    id.to_string(),
                    scheduled_for_ms,
                    owner,
                    now_ms + lease_ms,
                ],
            )?;
            let run = load_run(tx, run_id)?.ok_or(StoreError::RunNotFound(run_id))?;
            Ok(ClaimedRun { run, schedule })
        })
    }

    /// Atomically claims due schedules. A claim is fenced by `owner` and
    /// expires after `lease_ms`; expired claims are reclaimed before new due
    /// occurrences, including claims carrying this scheduler's owner token.
    /// A live execution is kept out of this path by its heartbeat. Each
    /// schedule/run pair is deduplicated by the unique
    /// `(schedule_id, scheduled_for_ms)` constraint.
    pub fn claim_due(
        &self,
        now_ms: i64,
        owner: &str,
        lease_ms: i64,
        limit: usize,
    ) -> Result<Vec<ClaimedRun>, StoreError> {
        if owner.trim().is_empty() || lease_ms <= 0 || limit == 0 {
            return Ok(Vec::new());
        }
        self.with_transaction(|tx| {
            let mut statement = tx.prepare(
                "SELECT id FROM schedules
                 WHERE status='active' AND (
                    (next_run_ms IS NOT NULL AND next_run_ms <= ?)
                    OR EXISTS (
                        SELECT 1 FROM schedule_runs expired
                        WHERE expired.schedule_id = schedules.id
                          AND expired.status IN ('claimed', 'running')
                          AND COALESCE(expired.lease_until_ms, 0) <= ?
                    )
                 )
                 ORDER BY COALESCE(next_run_ms, 9223372036854775807), id LIMIT ?",
            )?;
            let ids: Vec<ScheduleId> = statement
                .query_map(params![now_ms, now_ms, limit as i64], |row| {
                    let id: String = row.get(0)?;
                    Uuid::parse_str(&id).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);

            let mut claimed = Vec::new();
            for id in ids {
                if claimed.len() >= limit {
                    break;
                }
                let schedule = load_schedule_tx(tx, id)?;
                if let Some(existing) = find_reclaimable_run(tx, id, now_ms)? {
                    // An expired lease is no longer proof that the original
                    // execution is alive, even when this scheduler has the
                    // same owner token. Heartbeats renew live executions well
                    // before expiry; once expired, reclaim and re-run instead
                    // of renewing a dead task forever.
                    let run = reclaim_run(tx, existing.id, owner, now_ms + lease_ms, now_ms)?;
                    let schedule = load_schedule_tx(tx, id)?;
                    claimed.push(ClaimedRun { run, schedule });
                    continue;
                }
                if !schedule.allow_overlap && has_active_run(tx, id, now_ms)? {
                    continue;
                }
                let scheduled_for_ms = schedule.next_run_ms.ok_or_else(|| {
                    StoreError::InvalidSchedule("active schedule has no next run".into())
                })?;
                let run_id = Uuid::new_v4();
                let inserted = tx.execute(
                    "INSERT OR IGNORE INTO schedule_runs
                        (id, schedule_id, scheduled_for_ms, status, attempt, manual,
                         lease_owner, lease_until_ms)
                     VALUES (?, ?, ?, 'claimed', 1, 0, ?, ?)",
                    params![
                        run_id.to_string(),
                        id.to_string(),
                        scheduled_for_ms,
                        owner,
                        now_ms + lease_ms,
                    ],
                )?;
                if inserted == 0 {
                    if let Some(existing) = load_run_for_schedule(tx, id, scheduled_for_ms)? {
                        if existing.lease_until_ms.unwrap_or(i64::MIN) <= now_ms {
                            let run =
                                reclaim_run(tx, existing.id, owner, now_ms + lease_ms, now_ms)?;
                            let schedule = load_schedule_tx(tx, id)?;
                            claimed.push(ClaimedRun { run, schedule });
                        }
                    }
                    continue;
                }
                let next = next_after_claim(&schedule, scheduled_for_ms, now_ms)?;
                tx.execute(
                    "UPDATE schedules SET next_run_ms=?, updated_at_ms=? WHERE id=?",
                    params![next, now_ms, id.to_string()],
                )?;
                let run = load_run(tx, run_id)?.ok_or(StoreError::RunNotFound(run_id))?;
                let schedule = load_schedule_tx(tx, id)?;
                claimed.push(ClaimedRun { run, schedule });
            }
            Ok(claimed)
        })
    }

    pub fn mark_running(
        &self,
        run_id: Uuid,
        owner: &str,
        attempt: u32,
        now_ms: i64,
        lease_ms: i64,
    ) -> Result<RunRecord, StoreError> {
        if lease_ms <= 0 {
            return Err(StoreError::InvalidSchedule(
                "run lease must be positive".into(),
            ));
        }
        self.with_connection(|connection| {
            let updated = connection.execute(
                "UPDATE schedule_runs SET status='running', started_at_ms=COALESCE(started_at_ms, ?),
                    lease_until_ms=? WHERE id=? AND lease_owner=?
                    AND attempt=? AND status IN ('claimed', 'running')",
                params![
                    now_ms,
                    now_ms + lease_ms,
                    run_id.to_string(),
                    owner,
                    i64::from(attempt)
                ],
            )?;
            if updated == 0 {
                return match load_run(connection, run_id)? {
                    Some(_) => Err(StoreError::LeaseNotOwned(run_id)),
                    None => Err(StoreError::RunNotFound(run_id)),
                };
            }
            load_run(connection, run_id)?.ok_or(StoreError::RunNotFound(run_id))
        })
    }

    /// Renew a live claim without changing its lifecycle state. The claim
    /// generation is part of the fence: after a reclaim, the old task's
    /// heartbeat cannot extend the new task's lease even when both use the
    /// same owner token.
    pub fn renew_lease(
        &self,
        run_id: Uuid,
        owner: &str,
        attempt: u32,
        now_ms: i64,
        lease_ms: i64,
    ) -> Result<RunRecord, StoreError> {
        if lease_ms <= 0 {
            return Err(StoreError::InvalidSchedule(
                "run lease must be positive".into(),
            ));
        }
        self.with_connection(|connection| {
            let updated = connection.execute(
                "UPDATE schedule_runs SET lease_until_ms=?
                    WHERE id=? AND lease_owner=? AND attempt=?
                    AND status IN ('claimed', 'running')",
                params![
                    now_ms + lease_ms,
                    run_id.to_string(),
                    owner,
                    i64::from(attempt)
                ],
            )?;
            if updated == 0 {
                return match load_run(connection, run_id)? {
                    Some(_) => Err(StoreError::LeaseNotOwned(run_id)),
                    None => Err(StoreError::RunNotFound(run_id)),
                };
            }
            load_run(connection, run_id)?.ok_or(StoreError::RunNotFound(run_id))
        })
    }

    pub fn finish_run(&self, finish: FinishRun) -> Result<RunRecord, StoreError> {
        let (status, result, error) = match finish.outcome {
            RunOutcome::Succeeded { result } => (RunStatus::Succeeded, result, None),
            RunOutcome::Failed { error } => {
                if error.trim().is_empty() {
                    return Err(StoreError::InvalidOutcome("failure error is empty".into()));
                }
                (RunStatus::Failed, None, Some(error))
            }
            RunOutcome::NeedsAttention { reason } => {
                if reason.trim().is_empty() {
                    return Err(StoreError::InvalidOutcome(
                        "attention reason is empty".into(),
                    ));
                }
                (RunStatus::NeedsAttention, None, Some(reason))
            }
        };
        self.with_transaction(|tx| {
            let updated = tx.execute(
                "UPDATE schedule_runs SET status=?, finished_at_ms=?, lease_until_ms=NULL,
                    result=?, error=? WHERE id=? AND lease_owner=?
                    AND attempt=? AND status IN ('claimed', 'running')",
                params![
                    status.as_str(),
                    finish.now_ms,
                    result,
                    error,
                    finish.run_id.to_string(),
                    finish.owner,
                    i64::from(finish.attempt),
                ],
            )?;
            if updated == 0 {
                return match load_run_tx(tx, finish.run_id)? {
                    Some(_) => Err(StoreError::LeaseNotOwned(finish.run_id)),
                    None => Err(StoreError::RunNotFound(finish.run_id)),
                };
            }
            let run =
                load_run_tx(tx, finish.run_id)?.ok_or(StoreError::RunNotFound(finish.run_id))?;
            let schedule_id = run.schedule_id;
            let schedule = load_schedule_tx(tx, schedule_id)?;
            if !run.manual
                && matches!(schedule.kind, ScheduleKind::Once { .. })
                && schedule.status == ScheduleStatus::Active
            {
                tx.execute(
                    "UPDATE schedules SET status='completed', updated_at_ms=? WHERE id=?",
                    params![finish.now_ms, schedule_id.to_string()],
                )?;
            }
            Ok(run)
        })
    }

    pub fn get_run(&self, run_id: Uuid) -> Result<Option<RunRecord>, StoreError> {
        self.with_connection(|connection| load_run(connection, run_id))
    }

    pub fn list_runs(&self, schedule_id: ScheduleId) -> Result<Vec<RunRecord>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, schedule_id, scheduled_for_ms, status, attempt, manual, lease_owner,
                        lease_until_ms, started_at_ms, finished_at_ms, result, error
                 FROM schedule_runs WHERE schedule_id=? ORDER BY scheduled_for_ms, id",
            )?;
            let rows = statement.query_map([schedule_id.to_string()], run_from_row)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StoreError::from)
        })
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let connection = lock_connection(&self.connection)?;
        operation(&connection)
    }

    fn with_transaction<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut connection = lock_connection(&self.connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = operation(&transaction)?;
        transaction.commit()?;
        Ok(value)
    }
}

fn lock_connection(
    connection: &Arc<Mutex<Connection>>,
) -> Result<MutexGuard<'_, Connection>, StoreError> {
    connection
        .lock()
        .map_err(|_| StoreError::InvalidSchedule("automation database lock poisoned".into()))
}

fn validate_request(request: &ScheduleRequest) -> Result<(), StoreError> {
    if request.timezone.trim().is_empty() {
        return Err(StoreError::InvalidSchedule(
            "timezone cannot be empty".into(),
        ));
    }
    jiff::tz::TimeZone::get(&request.timezone).map_err(|error| StoreError::InvalidTimezone {
        timezone: request.timezone.clone(),
        reason: error.to_string(),
    })?;
    request.action.validate()?;
    match &request.kind {
        ScheduleKind::Once { at_ms } => validate_timestamp_ms(*at_ms, "once.at_ms")?,
        ScheduleKind::Interval {
            every_ms,
            start_at_ms,
        } if *every_ms > 0 => {
            if let Some(start_at_ms) = start_at_ms {
                validate_timestamp_ms(*start_at_ms, "interval.start_at_ms")?;
            }
        }
        ScheduleKind::Interval { .. } => {
            return Err(StoreError::InvalidSchedule(
                "interval must be positive".into(),
            ));
        }
        ScheduleKind::Cron { expression, .. } => {
            CronExpression::parse(expression)?;
            if let ScheduleKind::Cron { start_at_ms, .. } = &request.kind {
                if let Some(start_at_ms) = start_at_ms {
                    validate_timestamp_ms(*start_at_ms, "cron.start_at_ms")?;
                }
            }
        }
    }
    Ok(())
}

fn validate_timestamp_ms(value: i64, field: &str) -> Result<(), StoreError> {
    Timestamp::from_millisecond(value).map_err(|error| StoreError::InvalidTimestamp {
        value: format!("{field}={value}"),
        reason: error.to_string(),
    })?;
    Ok(())
}

fn first_run_ms(
    kind: &ScheduleKind,
    timezone: &str,
    now_ms: i64,
) -> Result<Option<i64>, StoreError> {
    match kind {
        ScheduleKind::Once { at_ms } => Ok(Some(*at_ms)),
        ScheduleKind::Interval {
            every_ms,
            start_at_ms,
        } => {
            if *every_ms <= 0 {
                return Err(StoreError::InvalidSchedule(
                    "interval must be positive".into(),
                ));
            }
            Ok(Some(start_at_ms.unwrap_or(now_ms)))
        }
        ScheduleKind::Cron {
            expression,
            start_at_ms,
        } => {
            let expression = CronExpression::parse(expression)?;
            let after = start_at_ms
                .unwrap_or(now_ms)
                .checked_sub(1)
                .ok_or_else(|| StoreError::InvalidTimestamp {
                    value: now_ms.to_string(),
                    reason: "timestamp underflow".into(),
                })?;
            next_cron_run_ms(&expression, after, timezone)
        }
    }
}

fn next_after_claim(
    schedule: &Schedule,
    due_ms: i64,
    now_ms: i64,
) -> Result<Option<i64>, StoreError> {
    match &schedule.kind {
        ScheduleKind::Once { .. } => Ok(None),
        ScheduleKind::Interval { every_ms, .. } => {
            let next = due_ms
                .checked_add(*every_ms)
                .ok_or_else(|| StoreError::TimeCalculation("interval timestamp overflow".into()))?;
            if next <= now_ms {
                now_ms.checked_add(*every_ms).map(Some).ok_or_else(|| {
                    StoreError::TimeCalculation("interval timestamp overflow".into())
                })
            } else {
                Ok(Some(next))
            }
        }
        ScheduleKind::Cron { expression, .. } => {
            let expression = CronExpression::parse(expression)?;
            next_cron_run_ms(&expression, now_ms, &schedule.timezone)
        }
    }
}

fn encode_request(
    request: &ScheduleRequest,
) -> Result<
    (
        &'static str,
        &'static str,
        &str,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<&str>,
    ),
    StoreError,
> {
    let (kind, at, every, start, cron) = match &request.kind {
        ScheduleKind::Once { at_ms } => ("once", Some(*at_ms), None, None, None),
        ScheduleKind::Interval {
            every_ms,
            start_at_ms,
        } => ("interval", None, Some(*every_ms), *start_at_ms, None),
        ScheduleKind::Cron {
            expression,
            start_at_ms,
        } => ("cron", None, None, *start_at_ms, Some(expression.as_str())),
    };
    let (action_kind, action_text) = request.action.db_values();
    Ok((kind, action_kind, action_text, at, every, start, cron))
}

fn decode_kind(
    kind: &str,
    at_ms: Option<i64>,
    every_ms: Option<i64>,
    start_at_ms: Option<i64>,
    cron_expression: Option<String>,
) -> Result<ScheduleKind, StoreError> {
    match kind {
        "once" => Ok(ScheduleKind::Once {
            at_ms: at_ms.ok_or_else(|| missing_column("once.at_ms"))?,
        }),
        "interval" => Ok(ScheduleKind::Interval {
            every_ms: every_ms.ok_or_else(|| missing_column("interval.every_ms"))?,
            start_at_ms,
        }),
        "cron" => Ok(ScheduleKind::Cron {
            expression: cron_expression.ok_or_else(|| missing_column("cron.expression"))?,
            start_at_ms,
        }),
        _ => Err(StoreError::InvalidSchedule(format!(
            "unknown schedule kind `{kind}`"
        ))),
    }
}

fn schedule_from_row(row: &Row<'_>) -> rusqlite::Result<Schedule> {
    let id: String = row.get(0)?;
    let kind: String = row.get(12)?;
    let action_kind: String = row.get(13)?;
    let action_text: String = row.get(14)?;
    let schedule = Schedule {
        id: Uuid::parse_str(&id).map_err(uuid_sql_error)?,
        name: row.get(1)?,
        source_project_id: parse_optional_uuid(row.get(2)?)?,
        source_thread_id: parse_optional_uuid(row.get(3)?)?,
        execution_project_id: parse_optional_uuid(row.get(4)?)?,
        execution_thread_id: parse_optional_uuid(row.get(5)?)?,
        provider_instance_id: parse_optional_uuid(row.get(6)?)?,
        provider: row.get(7)?,
        model: row.get(8)?,
        effort: row.get(9)?,
        speed: row.get(10)?,
        profile_id: parse_optional_uuid(row.get(11)?)?,
        kind: decode_kind(
            &kind,
            row.get(18)?,
            row.get(19)?,
            row.get(20)?,
            row.get(21)?,
        )
        .map_err(store_sql_error)?,
        action: match action_kind.as_str() {
            "notification" => ScheduleAction::Notification {
                message: action_text,
            },
            "agent_turn" => ScheduleAction::AgentTurn {
                prompt: action_text,
            },
            _ => {
                return Err(store_sql_error(StoreError::InvalidSchedule(format!(
                    "unknown action kind `{action_kind}`"
                ))))
            }
        },
        timezone: row.get(15)?,
        allow_overlap: row.get::<_, i64>(16)? != 0,
        status: ScheduleStatus::parse(&row.get::<_, String>(17)?).map_err(store_sql_error)?,
        next_run_ms: row.get(22)?,
        created_at_ms: row.get(23)?,
        updated_at_ms: row.get(24)?,
    };
    Ok(schedule)
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<RunRecord> {
    let id: String = row.get(0)?;
    let schedule_id: String = row.get(1)?;
    Ok(RunRecord {
        id: Uuid::parse_str(&id).map_err(uuid_sql_error)?,
        schedule_id: Uuid::parse_str(&schedule_id).map_err(uuid_sql_error)?,
        scheduled_for_ms: row.get(2)?,
        status: RunStatus::parse(&row.get::<_, String>(3)?).map_err(store_sql_error)?,
        attempt: row.get::<_, i64>(4)?.try_into().map_err(|_| {
            store_sql_error(StoreError::InvalidSchedule(
                "run attempt is negative".into(),
            ))
        })?,
        manual: row.get::<_, i64>(5)? != 0,
        lease_owner: row.get(6)?,
        lease_until_ms: row.get(7)?,
        started_at_ms: row.get(8)?,
        finished_at_ms: row.get(9)?,
        result: row.get(10)?,
        error: row.get(11)?,
    })
}

fn load_schedule(connection: &Connection, id: ScheduleId) -> Result<Option<Schedule>, StoreError> {
    connection
        .query_row(
            "SELECT id, name, source_project_id, source_thread_id,
                    execution_project_id, execution_thread_id, provider_instance_id, provider,
                    model, effort, speed, profile_id, kind, action_kind, action_text, timezone, allow_overlap, status,
                    at_ms, every_ms, start_at_ms, cron_expression, next_run_ms,
                    created_at_ms, updated_at_ms FROM schedules WHERE id=?",
            [id.to_string()],
            schedule_from_row,
        )
        .optional()
        .map_err(StoreError::from)
}

fn load_schedule_tx(tx: &Transaction<'_>, id: ScheduleId) -> Result<Schedule, StoreError> {
    load_schedule(tx, id)?.ok_or(StoreError::ScheduleNotFound(id))
}

fn ensure_schedule_exists(tx: &Transaction<'_>, id: ScheduleId) -> Result<(), StoreError> {
    if load_schedule(tx, id)?.is_some() {
        Ok(())
    } else {
        Err(StoreError::ScheduleNotFound(id))
    }
}

fn load_run(connection: &Connection, id: Uuid) -> Result<Option<RunRecord>, StoreError> {
    connection
        .query_row(
            "SELECT id, schedule_id, scheduled_for_ms, status, attempt, manual, lease_owner,
                    lease_until_ms, started_at_ms, finished_at_ms, result, error
             FROM schedule_runs WHERE id=?",
            [id.to_string()],
            run_from_row,
        )
        .optional()
        .map_err(StoreError::from)
}

fn load_run_tx(tx: &Transaction<'_>, id: Uuid) -> Result<Option<RunRecord>, StoreError> {
    load_run(tx, id)
}

fn load_run_for_schedule(
    tx: &Transaction<'_>,
    schedule_id: ScheduleId,
    scheduled_for_ms: i64,
) -> Result<Option<RunRecord>, StoreError> {
    tx.query_row(
        "SELECT id, schedule_id, scheduled_for_ms, status, attempt, manual, lease_owner,
                lease_until_ms, started_at_ms, finished_at_ms, result, error
         FROM schedule_runs WHERE schedule_id=? AND scheduled_for_ms=?",
        params![schedule_id.to_string(), scheduled_for_ms],
        run_from_row,
    )
    .optional()
    .map_err(StoreError::from)
}

fn find_reclaimable_run(
    tx: &Transaction<'_>,
    schedule_id: ScheduleId,
    now_ms: i64,
) -> Result<Option<RunRecord>, StoreError> {
    tx.query_row(
        "SELECT id, schedule_id, scheduled_for_ms, status, attempt, manual, lease_owner,
                lease_until_ms, started_at_ms, finished_at_ms, result, error
         FROM schedule_runs
         WHERE schedule_id=? AND status IN ('claimed', 'running')
           AND COALESCE(lease_until_ms, 0) <= ?
         ORDER BY scheduled_for_ms, id LIMIT 1",
        params![schedule_id.to_string(), now_ms],
        run_from_row,
    )
    .optional()
    .map_err(StoreError::from)
}

fn has_active_run(
    tx: &Transaction<'_>,
    schedule_id: ScheduleId,
    now_ms: i64,
) -> Result<bool, StoreError> {
    Ok(tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM schedule_runs
            WHERE schedule_id=? AND status IN ('claimed', 'running')
              AND COALESCE(lease_until_ms, 0) > ?
        )",
        params![schedule_id.to_string(), now_ms],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

fn reclaim_run(
    tx: &Transaction<'_>,
    run_id: Uuid,
    owner: &str,
    lease_until_ms: i64,
    now_ms: i64,
) -> Result<RunRecord, StoreError> {
    tx.execute(
        "UPDATE schedule_runs SET status='claimed', attempt=attempt+1,
            lease_owner=?, lease_until_ms=?, started_at_ms=NULL, finished_at_ms=NULL,
            result=NULL, error=NULL WHERE id=? AND status IN ('claimed','running')",
        params![owner, lease_until_ms, run_id.to_string()],
    )?;
    let _ = now_ms;
    load_run_tx(tx, run_id)?.ok_or(StoreError::RunNotFound(run_id))
}

fn optional_uuid(value: Option<Uuid>) -> Option<String> {
    value.map(|value| value.to_string())
}

fn parse_optional_uuid(value: Option<String>) -> rusqlite::Result<Option<Uuid>> {
    value
        .map(|value| Uuid::parse_str(&value).map_err(uuid_sql_error))
        .transpose()
}

fn bool_i64(value: bool) -> i64 {
    i64::from(value)
}

fn uuid_sql_error(error: uuid::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn store_sql_error(error: StoreError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn missing_column(name: &str) -> StoreError {
    StoreError::InvalidSchedule(format!("missing {name} value"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::{Clock, ManualClock, Scheduler};
    use std::sync::Arc;

    fn interval_request(start_at_ms: i64) -> ScheduleRequest {
        ScheduleRequest {
            name: Some("test".into()),
            source_project_id: None,
            source_thread_id: None,
            execution_project_id: None,
            execution_thread_id: None,
            provider_instance_id: None,
            provider: Some("hermes".into()),
            model: Some("default".into()),
            effort: None,
            speed: None,
            profile_id: None,
            kind: ScheduleKind::Interval {
                every_ms: 60_000,
                start_at_ms: Some(start_at_ms),
            },
            action: ScheduleAction::AgentTurn {
                prompt: "check status".into(),
            },
            timezone: "America/New_York".into(),
            allow_overlap: false,
        }
    }

    #[test]
    fn creates_and_lists_schedule() {
        let store = AutomationStore::open_in_memory().unwrap();
        let schedule = store.create_schedule(interval_request(1000), 1000).unwrap();
        assert_eq!(schedule.next_run_ms, Some(1000));
        assert_eq!(store.list_schedules().unwrap(), vec![schedule]);
    }

    #[test]
    fn validates_timing_without_persisting_a_schedule() {
        let store = AutomationStore::open_in_memory().unwrap();
        let valid = ScheduleKind::Cron {
            expression: "0 9 * * 1-5".into(),
            start_at_ms: None,
        };
        store
            .validate_schedule(&valid, "America/New_York", 1_000)
            .unwrap();
        assert!(store.list_schedules().unwrap().is_empty());

        let invalid = ScheduleKind::Cron {
            expression: "not a cron".into(),
            start_at_ms: None,
        };
        assert!(store
            .validate_schedule(&invalid, "America/New_York", 1_000)
            .is_err());
        assert!(store.list_schedules().unwrap().is_empty());
    }

    #[test]
    fn persists_schedules_and_runs_across_reopen() {
        let path =
            std::env::temp_dir().join(format!("maxx-automation-reopen-{}.sqlite3", Uuid::new_v4()));
        let schedule = {
            let store = AutomationStore::open(&path).unwrap();
            let schedule = store.create_schedule(interval_request(1000), 1000).unwrap();
            let claimed = store.claim_due(1000, "worker-a", 1000, 1).unwrap();
            store
                .finish_run(FinishRun {
                    run_id: claimed[0].run.id,
                    owner: "worker-a".into(),
                    attempt: claimed[0].run.attempt,
                    now_ms: 1100,
                    outcome: RunOutcome::Succeeded {
                        result: Some("persisted".into()),
                    },
                })
                .unwrap();
            store.get_schedule(schedule.id).unwrap().unwrap()
        };

        let reopened = AutomationStore::open(&path).unwrap();
        let schedule_id = schedule.id;
        assert_eq!(reopened.get_schedule(schedule_id).unwrap(), Some(schedule));
        let runs = reopened.list_runs(schedule_id).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::Succeeded);
        assert_eq!(runs[0].result.as_deref(), Some("persisted"));

        drop(reopened);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn claims_deduplicates_and_finishes() {
        let store = AutomationStore::open_in_memory().unwrap();
        let schedule = store.create_schedule(interval_request(1000), 1000).unwrap();
        let first = store.claim_due(1000, "worker-a", 1000, 10).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].run.scheduled_for_ms, 1000);
        assert_eq!(first[0].schedule.next_run_ms, Some(61_000));
        assert!(store
            .claim_due(1000, "worker-b", 1000, 10)
            .unwrap()
            .is_empty());
        let run = store
            .mark_running(
                first[0].run.id,
                "worker-a",
                first[0].run.attempt,
                1000,
                1000,
            )
            .unwrap();
        assert_eq!(run.status, RunStatus::Running);
        let run = store
            .finish_run(FinishRun {
                run_id: run.id,
                owner: "worker-a".into(),
                attempt: run.attempt,
                now_ms: 1100,
                outcome: RunOutcome::Succeeded {
                    result: Some("ok".into()),
                },
            })
            .unwrap();
        assert_eq!(run.status, RunStatus::Succeeded);
        assert_eq!(store.list_runs(schedule.id).unwrap().len(), 1);
    }

    #[test]
    fn reclaims_expired_lease_and_fences_owner() {
        let store = AutomationStore::open_in_memory().unwrap();
        store.create_schedule(interval_request(1000), 1000).unwrap();
        let first = store.claim_due(1000, "worker-a", 1000, 10).unwrap();
        let second = store.claim_due(2001, "worker-b", 1000, 10).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].run.id, first[0].run.id);
        assert_eq!(second[0].run.attempt, 2);
        assert!(matches!(
            store.mark_running(
                first[0].run.id,
                "worker-a",
                first[0].run.attempt,
                2001,
                1000
            ),
            Err(StoreError::LeaseNotOwned(_))
        ));
    }

    #[test]
    fn reclaims_expired_lease_even_when_owner_token_is_unchanged() {
        let store = AutomationStore::open_in_memory().unwrap();
        store.create_schedule(interval_request(1000), 1000).unwrap();
        let first = store.claim_due(1000, "worker-a", 1000, 10).unwrap();
        let second = store.claim_due(2001, "worker-a", 1000, 10).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].run.id, first[0].run.id);
        assert_eq!(second[0].run.attempt, 2);
        assert_eq!(second[0].run.lease_owner.as_deref(), Some("worker-a"));
    }

    #[test]
    fn stale_same_owner_attempt_cannot_mutate_reclaimed_run() {
        let store = AutomationStore::open_in_memory().unwrap();
        store.create_schedule(interval_request(1000), 1000).unwrap();
        let first = store.claim_due(1000, "worker-a", 1000, 1).unwrap();
        let second = store.claim_due(2001, "worker-a", 1000, 1).unwrap();
        let run_id = first[0].run.id;
        let stale_attempt = first[0].run.attempt;
        let current_attempt = second[0].run.attempt;

        assert!(matches!(
            store.mark_running(run_id, "worker-a", stale_attempt, 2001, 1000),
            Err(StoreError::LeaseNotOwned(_))
        ));
        assert!(matches!(
            store.renew_lease(run_id, "worker-a", stale_attempt, 2001, 1000),
            Err(StoreError::LeaseNotOwned(_))
        ));
        assert!(matches!(
            store.finish_run(FinishRun {
                run_id,
                owner: "worker-a".into(),
                attempt: stale_attempt,
                now_ms: 2001,
                outcome: RunOutcome::Succeeded { result: None },
            }),
            Err(StoreError::LeaseNotOwned(_))
        ));
        let current = store.get_run(run_id).unwrap().unwrap();
        assert_eq!(current.attempt, current_attempt);
        assert_eq!(current.lease_until_ms, Some(3_001));

        let running = store
            .mark_running(run_id, "worker-a", current_attempt, 2001, 1000)
            .unwrap();
        assert_eq!(running.status, RunStatus::Running);
        let finished = store
            .finish_run(FinishRun {
                run_id,
                owner: "worker-a".into(),
                attempt: current_attempt,
                now_ms: 2002,
                outcome: RunOutcome::Succeeded {
                    result: Some("new attempt".into()),
                },
            })
            .unwrap();
        assert_eq!(finished.status, RunStatus::Succeeded);
        assert_eq!(finished.result.as_deref(), Some("new attempt"));
    }

    #[test]
    fn delete_schedule_rejects_active_run_atomically_then_deletes_after_expiry() {
        let store = AutomationStore::open_in_memory().unwrap();
        let schedule = store.create_schedule(interval_request(1000), 1000).unwrap();
        let claimed = store.claim_due(1000, "worker-a", 1000, 1).unwrap();

        assert!(matches!(
            store.delete_schedule(schedule.id, 1_500),
            Err(StoreError::InvalidSchedule(message))
                if message.contains("current automation run")
        ));
        assert!(store.get_schedule(schedule.id).unwrap().is_some());

        assert!(store.delete_schedule(schedule.id, 2_001).unwrap());
        assert!(store.get_schedule(schedule.id).unwrap().is_none());
        assert!(store.list_runs(schedule.id).unwrap().is_empty());
        // Keep the claimed run referenced so this test also makes it clear
        // that deletion removes its cascading history only after the lease is
        // no longer active.
        assert_eq!(claimed[0].run.schedule_id, schedule.id);
    }

    #[test]
    fn no_overlap_blocks_until_current_run_finishes() {
        let store = AutomationStore::open_in_memory().unwrap();
        store.create_schedule(interval_request(1000), 1000).unwrap();
        let first = store.claim_due(1000, "worker-a", 100_000, 10).unwrap();
        assert!(store
            .claim_due(61_000, "worker-b", 1000, 10)
            .unwrap()
            .is_empty());
        store
            .finish_run(FinishRun {
                run_id: first[0].run.id,
                owner: "worker-a".into(),
                attempt: first[0].run.attempt,
                now_ms: 62_000,
                outcome: RunOutcome::Succeeded { result: None },
            })
            .unwrap();
        let next = store.claim_due(62_000, "worker-b", 1000, 10).unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].run.scheduled_for_ms, 61_000);
    }

    #[test]
    fn once_completes_after_terminal_outcome() {
        let store = AutomationStore::open_in_memory().unwrap();
        let schedule = store
            .create_schedule(
                ScheduleRequest {
                    name: None,
                    source_project_id: None,
                    source_thread_id: None,
                    execution_project_id: None,
                    execution_thread_id: None,
                    provider_instance_id: None,
                    provider: None,
                    model: None,
                    effort: None,
                    speed: None,
                    profile_id: None,
                    kind: ScheduleKind::Once { at_ms: 500 },
                    action: ScheduleAction::Notification {
                        message: "walk the dog".into(),
                    },
                    timezone: "UTC".into(),
                    allow_overlap: false,
                },
                100,
            )
            .unwrap();
        let claimed = store.claim_due(500, "worker", 1000, 1).unwrap();
        store
            .finish_run(FinishRun {
                run_id: claimed[0].run.id,
                owner: "worker".into(),
                attempt: claimed[0].run.attempt,
                now_ms: 501,
                outcome: RunOutcome::Failed {
                    error: "offline".into(),
                },
            })
            .unwrap();
        assert_eq!(
            store.get_schedule(schedule.id).unwrap().unwrap().status,
            ScheduleStatus::Completed
        );
        assert!(store
            .claim_due(100_000, "worker", 1000, 1)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn manual_run_preserves_one_time_schedule_cadence() {
        let store = AutomationStore::open_in_memory().unwrap();
        let mut request = interval_request(5_000);
        request.kind = ScheduleKind::Once { at_ms: 5_000 };
        request.action = ScheduleAction::Notification {
            message: "walk the dog".into(),
        };
        let schedule = store.create_schedule(request, 100).unwrap();
        let claimed = store.claim_now(schedule.id, 200, "worker", 1_000).unwrap();
        assert!(claimed.run.manual);
        store
            .mark_running(claimed.run.id, "worker", claimed.run.attempt, 201, 1_000)
            .unwrap();
        store
            .finish_run(FinishRun {
                run_id: claimed.run.id,
                owner: "worker".into(),
                attempt: claimed.run.attempt,
                now_ms: 202,
                outcome: RunOutcome::Succeeded { result: None },
            })
            .unwrap();
        let unchanged = store.get_schedule(schedule.id).unwrap().unwrap();
        assert_eq!(unchanged.status, ScheduleStatus::Active);
        assert_eq!(unchanged.next_run_ms, Some(5_000));
    }

    #[test]
    fn scheduler_uses_injected_clock() {
        let store = AutomationStore::open_in_memory().unwrap();
        store.create_schedule(interval_request(1000), 1000).unwrap();
        let clock = Arc::new(ManualClock::new(999));
        let scheduler = Scheduler::new(store, clock.clone(), "test");
        assert!(scheduler.tick(10).unwrap().is_empty());
        clock.advance_ms(1);
        assert_eq!(scheduler.tick(10).unwrap().len(), 1);
        assert_eq!(clock.now_ms(), 1000);
    }
}
