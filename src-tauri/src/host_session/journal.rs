use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::sync::broadcast;

const RETAINED_EVENTS: usize = 4_096;
const COMPACT_AT_EVENTS: usize = RETAINED_EVENTS * 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEvent {
    pub cursor: u64,
    pub event: String,
    pub payload: Value,
}

struct JournalState {
    cursor: u64,
    records: VecDeque<JournalEvent>,
}

pub struct EventJournal {
    path: PathBuf,
    state: Mutex<JournalState>,
    live: broadcast::Sender<JournalEvent>,
}

pub struct JournalSubscription {
    replay: VecDeque<JournalEvent>,
    live: broadcast::Receiver<JournalEvent>,
    pub resync_required: bool,
    pub current_cursor: u64,
}

impl EventJournal {
    pub fn load_default() -> Self {
        Self::load(crate::state::workspace_path().with_file_name("host-events.jsonl"))
    }

    pub fn load(path: PathBuf) -> Self {
        let mut records = read_records(&path);
        while records.len() > RETAINED_EVENTS {
            records.pop_front();
        }
        let cursor = records.back().map(|record| record.cursor).unwrap_or(0);
        let (live, _) = broadcast::channel(512);
        Self {
            path,
            state: Mutex::new(JournalState { cursor, records }),
            live,
        }
    }

    pub fn emit(&self, event: &str, payload: Value) -> Result<u64, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Host event journal is unavailable".to_string())?;
        state.cursor = state.cursor.saturating_add(1);
        let record = JournalEvent {
            cursor: state.cursor,
            event: event.to_string(),
            payload,
        };
        append_record(&self.path, &record)?;
        state.records.push_back(record.clone());
        if state.records.len() >= COMPACT_AT_EVENTS {
            while state.records.len() > RETAINED_EVENTS {
                state.records.pop_front();
            }
            compact(&self.path, &state.records)?;
        }
        let _ = self.live.send(record);
        Ok(state.cursor)
    }

    pub fn subscribe(&self, after_cursor: u64) -> Result<JournalSubscription, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Host event journal is unavailable".to_string())?;
        let live = self.live.subscribe();
        let oldest = state.records.front().map(|record| record.cursor);
        let resync_required = oldest.is_some_and(|oldest| after_cursor.saturating_add(1) < oldest);
        let replay = state
            .records
            .iter()
            .filter(|record| record.cursor > after_cursor)
            .cloned()
            .collect();
        Ok(JournalSubscription {
            replay,
            live,
            resync_required,
            current_cursor: state.cursor,
        })
    }

    pub fn current_cursor(&self) -> u64 {
        self.state.lock().map(|state| state.cursor).unwrap_or(0)
    }
}

impl JournalSubscription {
    pub async fn recv(&mut self) -> Option<JournalEvent> {
        if let Some(record) = self.replay.pop_front() {
            return Some(record);
        }
        self.live.recv().await.ok()
    }
}

fn read_records(path: &Path) -> VecDeque<JournalEvent> {
    let Ok(file) = fs::File::open(path) else {
        return VecDeque::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<JournalEvent>(&line).ok())
        .collect()
}

fn append_record(path: &Path, record: &JournalEvent) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the Maxx data directory: {error}"))?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Could not open the host event journal: {error}"))?;
    #[cfg(unix)]
    protect_file(&file)?;
    let mut encoded = serde_json::to_vec(record)
        .map_err(|error| format!("Could not encode a host event: {error}"))?;
    encoded.push(b'\n');
    file.write_all(&encoded)
        .and_then(|_| file.flush())
        .map_err(|error| format!("Could not write the host event journal: {error}"))
}

fn compact(path: &Path, records: &VecDeque<JournalEvent>) -> Result<(), String> {
    let temporary = path.with_extension("jsonl.tmp");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Could not compact the host event journal: {error}"))?;
    #[cfg(unix)]
    protect_file(&file)?;
    for record in records {
        serde_json::to_writer(&mut file, record)
            .map_err(|error| format!("Could not compact a host event: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("Could not compact the host event journal: {error}"))?;
    }
    file.sync_all()
        .map_err(|error| format!("Could not sync the host event journal: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not replace the host event journal: {error}"))
}

#[cfg(unix)]
fn protect_file(file: &fs::File) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not protect the host event journal: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    async fn journal_replays_after_a_cursor_across_reloads() {
        let root = std::env::temp_dir().join(format!("maxx-journal-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("events.jsonl");
        let journal = EventJournal::load(path.clone());
        assert_eq!(journal.emit("one", serde_json::json!({"n":1})).unwrap(), 1);
        assert_eq!(journal.emit("two", serde_json::json!({"n":2})).unwrap(), 2);
        drop(journal);

        let loaded = EventJournal::load(path);
        let mut subscription = loaded.subscribe(1).unwrap();
        let event = subscription.recv().await.unwrap();
        assert_eq!(event.cursor, 2);
        assert_eq!(event.event, "two");
        assert!(!subscription.resync_required);
        fs::remove_dir_all(root).unwrap();
    }
}
