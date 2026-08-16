//! Provider-neutral, durable scheduling for Maxx chats.
//!
//! The automation store is deliberately independent from provider engines and
//! UI code. A caller creates a schedule, periodically calls [`Scheduler::tick`]
//! (or calls [`AutomationStore::claim_due`] directly), executes the returned
//! run, and records the outcome with [`AutomationStore::finish_run`]. All
//! timestamps are Unix milliseconds. Cron expressions use the five-field
//! standard (`minute hour day-of-month month day-of-week`) or an optional
//! six-field form with seconds first, and are evaluated in an IANA time zone.

mod clock;
mod cron;
mod store;

pub use clock::{Clock, ManualClock, SystemClock};
pub use cron::{next_cron_run_ms, CronExpression};
pub use store::{
    AutomationStore, ClaimedRun, FinishRun, RunOutcome, RunRecord, RunStatus, Schedule,
    ScheduleAction, ScheduleId, ScheduleKind, ScheduleRequest, ScheduleStatus, ScheduleUpdate,
    StoreError,
};

use std::sync::Arc;

/// Small orchestration shell around the durable store. It contains no
/// provider-specific code: the owner token is only used to fence leases when
/// the caller later marks a run started or finished.
#[derive(Clone)]
pub struct Scheduler<C = SystemClock> {
    store: AutomationStore,
    clock: Arc<C>,
    owner: String,
}

impl<C: Clock> Scheduler<C> {
    pub fn new(store: AutomationStore, clock: Arc<C>, owner: impl Into<String>) -> Self {
        Self {
            store,
            clock,
            owner: owner.into(),
        }
    }

    pub fn store(&self) -> &AutomationStore {
        &self.store
    }

    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// Claim up to `limit` due runs using the clock's current instant.
    pub fn tick(&self, limit: usize) -> Result<Vec<ClaimedRun>, StoreError> {
        self.store
            .claim_due(self.clock.now_ms(), &self.owner, 60_000, limit)
    }
}
