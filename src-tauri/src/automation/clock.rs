use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Time source used by the scheduler. Keeping it as a tiny trait makes wake,
/// lease, and DST behavior deterministic in tests.
pub trait Clock: Send + Sync + 'static {
    fn now_ms(&self) -> i64;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_millis()
            .try_into()
            .expect("system clock exceeds i64 milliseconds")
    }
}

#[derive(Debug, Default)]
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(now_ms: i64) -> Self {
        Self(AtomicI64::new(now_ms))
    }

    pub fn set_ms(&self, now_ms: i64) {
        self.0.store(now_ms, Ordering::SeqCst);
    }

    pub fn advance_ms(&self, amount_ms: i64) {
        self.0.fetch_add(amount_ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
