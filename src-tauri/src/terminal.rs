//! Provider-native terminal sessions. Rust owns the PTY and process lifecycle;
//! renderers consume bounded, cursor-addressed output through long polling so
//! the same contract works locally and over a paired Maxx host.

use crate::browser_runtime::{BrowserRuntime, BrowserSessionScope};
use crate::engine::{launch, TurnRequest};
use crate::state::{find_thread, AppState};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use maxx_core::contract::{AppleDate, ChatProvider};
use maxx_core::persist::{ChatMessage, ChatRole, ChatSurface, ProviderProfile, TerminalArchive};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

const DEFAULT_ROWS: u16 = 32;
const DEFAULT_COLS: u16 = 120;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_READ_BYTES: usize = 256 * 1024;
const RETAINED_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ARCHIVE_CHARS: usize = 512 * 1024;
const MAX_TERMINAL_ARCHIVES: usize = 12;
const GROK_MAXX_BROWSER_POLICY: &str = "Maxx Browser is the browser-control surface for this session. Use the injected Maxx Browser MCP server for browser actions, reuse its assigned tab, observe before acting, and require an observed state change after each interaction.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalProcessState {
    Running,
    Exited,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalSupport {
    pub supported: bool,
    #[serde(rename = "browserAvailable")]
    pub browser_available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalStatus {
    #[serde(rename = "threadID")]
    pub thread_id: Uuid,
    pub state: TerminalProcessState,
    pub cursor: u64,
    #[serde(rename = "firstCursor")]
    pub first_cursor: u64,
    #[serde(rename = "browserAvailable")]
    pub browser_available: bool,
    #[serde(rename = "startedAt")]
    pub started_at: AppleDate,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalRead {
    pub chunks: Vec<TerminalChunk>,
    pub cursor: u64,
    #[serde(rename = "firstCursor")]
    pub first_cursor: u64,
    pub gap: bool,
    pub state: TerminalProcessState,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalChunk {
    pub cursor: u64,
    #[serde(rename = "dataBase64")]
    pub data_base64: String,
}

struct OutputChunk {
    cursor: u64,
    bytes: Vec<u8>,
}

struct OutputBuffer {
    chunks: VecDeque<OutputChunk>,
    retained_bytes: usize,
    next_cursor: u64,
    state: TerminalProcessState,
}

impl Default for OutputBuffer {
    fn default() -> Self {
        Self {
            chunks: VecDeque::new(),
            retained_bytes: 0,
            next_cursor: 1,
            state: TerminalProcessState::Running,
        }
    }
}

impl OutputBuffer {
    fn push(&mut self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let cursor = self.next_cursor;
        self.next_cursor = self.next_cursor.saturating_add(1);
        self.retained_bytes = self.retained_bytes.saturating_add(bytes.len());
        self.chunks.push_back(OutputChunk { cursor, bytes });
        while self.retained_bytes > RETAINED_OUTPUT_BYTES {
            let Some(removed) = self.chunks.pop_front() else {
                break;
            };
            self.retained_bytes = self.retained_bytes.saturating_sub(removed.bytes.len());
        }
    }

    fn latest_cursor(&self) -> u64 {
        self.next_cursor.saturating_sub(1)
    }

    fn first_cursor(&self) -> u64 {
        self.chunks
            .front()
            .map(|chunk| chunk.cursor)
            .unwrap_or(self.next_cursor)
    }

    fn read(&self, after: u64, max_bytes: usize) -> TerminalRead {
        let first_cursor = self.first_cursor();
        let gap = after.saturating_add(1) < first_cursor;
        let effective_after = if gap {
            first_cursor.saturating_sub(1)
        } else {
            after
        };
        let mut used = 0usize;
        let mut chunks = Vec::new();
        for chunk in self
            .chunks
            .iter()
            .filter(|chunk| chunk.cursor > effective_after)
        {
            if !chunks.is_empty() && used.saturating_add(chunk.bytes.len()) > max_bytes {
                break;
            }
            used = used.saturating_add(chunk.bytes.len());
            chunks.push(TerminalChunk {
                cursor: chunk.cursor,
                data_base64: STANDARD.encode(&chunk.bytes),
            });
        }
        let cursor = chunks
            .last()
            .map(|chunk| chunk.cursor)
            .unwrap_or(effective_after.min(self.latest_cursor()));
        TerminalRead {
            chunks,
            cursor,
            first_cursor,
            gap,
            state: self.state,
        }
    }
}

struct TerminalSession {
    thread_id: Uuid,
    browser_available: bool,
    started_at: AppleDate,
    baseline_turn_ids: Option<HashSet<String>>,
    submitted_inputs: AtomicU64,
    master: StdMutex<Box<dyn MasterPty + Send>>,
    writer: StdMutex<Box<dyn Write + Send>>,
    killer: StdMutex<Box<dyn ChildKiller + Send + Sync>>,
    output: StdMutex<OutputBuffer>,
    notify: Notify,
    temporary_resources: StdMutex<Vec<TemporaryResource>>,
    temporary_removal_paths: Vec<PathBuf>,
}

impl TerminalSession {
    fn status(&self) -> TerminalStatus {
        let output = self.output.lock().expect("terminal output mutex poisoned");
        TerminalStatus {
            thread_id: self.thread_id,
            state: output.state,
            cursor: output.latest_cursor(),
            first_cursor: output.first_cursor(),
            browser_available: self.browser_available,
            started_at: self.started_at,
        }
    }

    fn mark_exited(&self) {
        self.output
            .lock()
            .expect("terminal output mutex poisoned")
            .state = TerminalProcessState::Exited;
        self.notify.notify_waiters();
    }

    fn cleanup_temporary_resources(&self) {
        cleanup_terminal_resources(&self.temporary_resources, "terminal configuration");
    }

    fn retry_temporary_removals(&self) {
        for path in &self.temporary_removal_paths {
            cleanup_temporary_path(path, "terminal configuration retry");
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.cleanup_temporary_resources();
        self.retry_temporary_removals();
    }
}

pub struct TerminalBroker {
    browser: Arc<BrowserRuntime>,
    sessions: Mutex<HashMap<Uuid, Arc<TerminalSession>>>,
}

impl TerminalBroker {
    pub fn new(browser: Arc<BrowserRuntime>) -> Self {
        Self {
            browser,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn support(provider: ChatProvider) -> TerminalSupport {
        let browser_available = matches!(
            provider,
            ChatProvider::Codex
                | ChatProvider::Claude
                | ChatProvider::Grok
                | ChatProvider::Cursor
                | ChatProvider::Opencode
                | ChatProvider::Pi
                | ChatProvider::Hermes
        );
        TerminalSupport {
            supported: true,
            browser_available,
            reason: (!browser_available).then(|| {
                format!(
                    "{} terminal mode cannot receive Maxx Browser authority yet.",
                    provider.display_name()
                )
            }),
        }
    }

    pub async fn start(
        &self,
        state: Arc<AppState>,
        project_id: Uuid,
        thread_id: Uuid,
        rows: Option<u16>,
        cols: Option<u16>,
    ) -> Result<TerminalStatus, String> {
        // Keep one short critical section across launch so concurrent local or
        // remote start requests can never create two writers for one provider session.
        let mut sessions = self.sessions.lock().await;
        if let Some(existing) = sessions.get(&thread_id).cloned() {
            if existing.status().state == TerminalProcessState::Running {
                return Ok(existing.status());
            }
            sessions.remove(&thread_id);
        }

        let (thread, folder_path, profile) = {
            let workspace = state.workspace.lock().await;
            let project = workspace
                .projects
                .iter()
                .find(|project| project.id == project_id)
                .ok_or("Unknown project")?;
            let thread = project
                .threads
                .iter()
                .find(|thread| thread.id == thread_id)
                .cloned()
                .ok_or("Unknown thread")?;
            if thread.parent_thread_id.is_some() || thread.agent_id.is_some() {
                return Err("Terminal mode is unavailable for @agent side threads.".into());
            }
            let profile = workspace
                .provider_profiles
                .iter()
                .find(|profile| profile.id == thread.instance_id())
                .cloned()
                .unwrap_or_else(|| {
                    let mut profile = ProviderProfile::default_for(thread.provider);
                    profile.id = thread.instance_id();
                    profile
                });
            let folder_path = thread
                .working_directory
                .clone()
                .unwrap_or_else(|| project.folder_path.clone());
            (thread, folder_path, profile)
        };
        let session_id = thread
            .provider_session_id
            .clone()
            .ok_or("Finish the first GUI turn before terminal mode can resume this session.")?;
        let support = Self::support(thread.provider);
        let mut scope = BrowserSessionScope::full_access(
            project_id,
            thread.id,
            thread.provider,
            thread.instance_id(),
        );
        scope.provider_session_id = Some(session_id.clone());
        scope.file_roots = vec![folder_path.clone().into()];
        let browser_access = support
            .browser_available
            .then(|| self.browser.access_for_scope(scope));
        // Prove the structured runtime is idle and relinquish its connection
        // before using a short-lived reader to establish the native boundary.
        state
            .runtime
            .release_thread(thread.provider, thread.instance_id(), thread.id)
            .await?;
        let baseline = state
            .runtime
            .reconcile_session(reconciliation_request(
                &thread,
                &folder_path,
                &profile,
                browser_access.clone(),
            ))
            .await;
        let release = state
            .runtime
            .release_thread(thread.provider, thread.instance_id(), thread.id)
            .await;
        let baseline_turn_ids =
            baseline?.map(|turns| turns.into_iter().map(|turn| turn.native_id).collect());
        release?;
        let mut launch = terminal_launch(
            &profile,
            &thread,
            &folder_path,
            &session_id,
            browser_access.as_deref(),
        )?;

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: rows.unwrap_or(DEFAULT_ROWS).clamp(2, 500),
                cols: cols.unwrap_or(DEFAULT_COLS).clamp(2, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Could not create terminal: {error}"))?;
        let mut command = CommandBuilder::new(&launch.executable);
        command.args(&launch.arguments);
        command.cwd(&folder_path);
        for (key, value) in &launch.environment {
            command.env(key, value);
        }
        // CommandBuilder starts with its own copy of the parent environment,
        // independently of `launch.environment`. Remove the automation-facing
        // color suppression from that final child environment as well.
        command.env_remove("NO_COLOR");
        let child = pair.slave.spawn_command(command).map_err(|error| {
            format!(
                "Could not start {} terminal: {error}",
                thread.provider.display_name()
            )
        })?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Could not read terminal output: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Could not write terminal input: {error}"))?;
        let temporary_removal_paths = if thread.provider == ChatProvider::Hermes {
            launch
                .temporary_resources
                .iter()
                .filter_map(|resource| match resource {
                    TemporaryResource::Remove(path) => Some(path.clone()),
                    TemporaryResource::RestoreFile { .. } => None,
                })
                .collect()
        } else {
            Vec::new()
        };
        let session = Arc::new(TerminalSession {
            thread_id,
            browser_available: support.browser_available,
            started_at: AppleDate::now(),
            baseline_turn_ids,
            submitted_inputs: AtomicU64::new(0),
            master: StdMutex::new(pair.master),
            writer: StdMutex::new(writer),
            killer: StdMutex::new(killer),
            output: StdMutex::new(OutputBuffer::default()),
            notify: Notify::new(),
            temporary_resources: StdMutex::new(std::mem::take(&mut launch.temporary_resources)),
            temporary_removal_paths,
        });

        let reader_session = session.clone();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("maxx-terminal-{thread_id}"))
            .spawn(move || {
                let mut buffer = vec![0u8; 32 * 1024];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            reader_session
                                .output
                                .lock()
                                .expect("terminal output mutex poisoned")
                                .push(buffer[..read].to_vec());
                            reader_session.notify.notify_waiters();
                        }
                        Err(error) => {
                            log::debug!("terminal reader ended: {error}");
                            break;
                        }
                    }
                }
            })
        {
            let _ = session
                .killer
                .lock()
                .expect("terminal killer mutex poisoned")
                .kill();
            return Err(format!("Could not start terminal reader: {error}"));
        }

        let waiter_session = session.clone();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("maxx-terminal-waiter-{thread_id}"))
            .spawn(move || {
                let mut child = child;
                if let Err(error) = child.wait() {
                    log::warn!("could not wait for terminal process: {error}");
                }
                waiter_session.cleanup_temporary_resources();
                // Some CLIs detach short-lived shutdown helpers that can
                // recreate their private home after the parent exits. Retry
                // only app-owned removal paths; restored user files remain
                // strictly one-shot.
                if !waiter_session.temporary_removal_paths.is_empty() {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    waiter_session.retry_temporary_removals();
                    std::thread::sleep(std::time::Duration::from_millis(1_500));
                    waiter_session.retry_temporary_removals();
                }
                waiter_session.mark_exited();
            })
        {
            let _ = session
                .killer
                .lock()
                .expect("terminal killer mutex poisoned")
                .kill();
            return Err(format!("Could not start terminal process waiter: {error}"));
        }

        {
            let mut workspace = state.workspace.lock().await;
            let Some(thread) = find_thread(&mut workspace, project_id, thread_id) else {
                let _ = session
                    .killer
                    .lock()
                    .expect("terminal killer mutex poisoned")
                    .kill();
                return Err("The thread was removed while its terminal was starting.".into());
            };
            thread.surface = ChatSurface::Terminal;
            thread.updated_at = AppleDate::now();
        }
        sessions.insert(thread_id, session.clone());
        state.save().await;
        Ok(session.status())
    }

    pub async fn status(&self, thread_id: Uuid) -> Option<TerminalStatus> {
        self.sessions
            .lock()
            .await
            .get(&thread_id)
            .map(|session| session.status())
    }

    pub async fn input(&self, thread_id: Uuid, data_base64: String) -> Result<(), String> {
        let bytes = STANDARD
            .decode(data_base64)
            .map_err(|error| format!("Terminal input is invalid: {error}"))?;
        if bytes.len() > MAX_INPUT_BYTES {
            return Err("Terminal input exceeds 64 KiB.".into());
        }
        let session = self
            .sessions
            .lock()
            .await
            .get(&thread_id)
            .cloned()
            .ok_or("Terminal session is not running")?;
        if session.status().state != TerminalProcessState::Running {
            return Err("Terminal session has exited".into());
        }
        if submits_terminal_input(&bytes) {
            session.submitted_inputs.fetch_add(1, Ordering::Relaxed);
        }
        let mut writer = session
            .writer
            .lock()
            .expect("terminal writer mutex poisoned");
        writer
            .write_all(&bytes)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Could not write terminal input: {error}"))
    }

    pub async fn resize(&self, thread_id: Uuid, rows: u16, cols: u16) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .await
            .get(&thread_id)
            .cloned()
            .ok_or("Terminal session is not running")?;
        let result = session
            .master
            .lock()
            .expect("terminal master mutex poisoned")
            .resize(PtySize {
                rows: rows.clamp(2, 500),
                cols: cols.clamp(2, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Could not resize terminal: {error}"));
        result
    }

    pub async fn read(
        &self,
        thread_id: Uuid,
        after: u64,
        max_bytes: Option<usize>,
    ) -> Result<TerminalRead, String> {
        let session = self
            .sessions
            .lock()
            .await
            .get(&thread_id)
            .cloned()
            .ok_or("Terminal session is not running")?;
        let limit = max_bytes.unwrap_or(MAX_READ_BYTES).clamp(1, MAX_READ_BYTES);
        // Register the notification future before checking the buffer. A
        // `notify_waiters` between those operations would otherwise be lost.
        let notified = session.notify.notified();
        let immediate = session
            .output
            .lock()
            .expect("terminal output mutex poisoned")
            .read(after, limit);
        if !immediate.chunks.is_empty() || immediate.state == TerminalProcessState::Exited {
            return Ok(immediate);
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(20), notified).await;
        let read = session
            .output
            .lock()
            .expect("terminal output mutex poisoned")
            .read(after, limit);
        Ok(read)
    }

    pub async fn stop(
        &self,
        state: Arc<AppState>,
        project_id: Uuid,
        thread_id: Uuid,
        archive: Option<String>,
    ) -> Result<(), String> {
        let (thread_snapshot, folder_path, profile) = {
            let workspace = state.workspace.lock().await;
            let project = workspace
                .projects
                .iter()
                .find(|project| project.id == project_id)
                .ok_or("Unknown project")?;
            let thread = project
                .threads
                .iter()
                .find(|thread| thread.id == thread_id)
                .cloned()
                .ok_or("Unknown thread")?;
            let profile = workspace
                .provider_profiles
                .iter()
                .find(|profile| profile.id == thread.instance_id())
                .cloned()
                .unwrap_or_else(|| {
                    let mut profile = ProviderProfile::default_for(thread.provider);
                    profile.id = thread.instance_id();
                    profile
                });
            let folder_path = thread
                .working_directory
                .clone()
                .unwrap_or_else(|| project.folder_path.clone());
            (thread, folder_path, profile)
        };
        let session = self.sessions.lock().await.get(&thread_id).cloned();
        if let Some(session) = &session {
            if session.status().state == TerminalProcessState::Running {
                let exited = session.notify.notified();
                if let Err(error) = session
                    .killer
                    .lock()
                    .expect("terminal killer mutex poisoned")
                    .kill()
                {
                    log::debug!("terminal process had already stopped: {error}");
                }
                if session.status().state == TerminalProcessState::Running {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), exited).await;
                }
            }
        }
        let reconciled = if let Some(baseline) = session
            .as_ref()
            .and_then(|session| session.baseline_turn_ids.as_ref())
        {
            let support = Self::support(thread_snapshot.provider);
            let mut scope = BrowserSessionScope::full_access(
                project_id,
                thread_snapshot.id,
                thread_snapshot.provider,
                thread_snapshot.instance_id(),
            );
            scope.provider_session_id = thread_snapshot.provider_session_id.clone();
            scope.file_roots = vec![folder_path.clone().into()];
            let browser_access = support
                .browser_available
                .then(|| self.browser.access_for_scope(scope));
            let request =
                reconciliation_request(&thread_snapshot, &folder_path, &profile, browser_access);
            let submitted = session
                .as_ref()
                .is_some_and(|session| session.submitted_inputs.load(Ordering::Relaxed) > 0);
            let attempts = if submitted { 20 } else { 1 };
            let mut turns = Vec::new();
            for attempt in 0..attempts {
                turns = state
                    .runtime
                    .reconcile_session(request.clone())
                    .await?
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|turn| !baseline.contains(&turn.native_id))
                    .collect();
                if !submitted
                    || (!turns.is_empty()
                        && turns.iter().all(|turn| !turn.assistant_content.is_empty()))
                    || attempt + 1 == attempts
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            turns
        } else {
            Vec::new()
        };
        {
            let mut workspace = state.workspace.lock().await;
            let thread =
                find_thread(&mut workspace, project_id, thread_id).ok_or("Unknown thread")?;
            for turn in reconciled {
                if !turn.user_content.is_empty() {
                    thread.messages.push(ChatMessage {
                        id: Uuid::new_v4(),
                        role: ChatRole::User,
                        content: turn.user_content,
                        attachments: Vec::new(),
                        annotations: Vec::new(),
                        created_at: turn.started_at,
                        source_event_id: None,
                        agent_id: None,
                    });
                }
                if !turn.assistant_content.is_empty() {
                    thread.messages.push(ChatMessage {
                        id: Uuid::new_v4(),
                        role: ChatRole::Assistant,
                        content: turn.assistant_content,
                        attachments: Vec::new(),
                        annotations: Vec::new(),
                        created_at: turn.started_at,
                        source_event_id: None,
                        agent_id: None,
                    });
                }
            }
            if session
                .as_ref()
                .is_none_or(|session| session.baseline_turn_ids.is_none())
            {
                if let Some(content) = archive.and_then(clean_archive) {
                    thread.terminal_archives.push(TerminalArchive {
                        id: Uuid::new_v4(),
                        content,
                        started_at: session
                            .as_ref()
                            .map(|session| session.started_at)
                            .unwrap_or_else(AppleDate::now),
                        ended_at: AppleDate::now(),
                    });
                    if thread.terminal_archives.len() > MAX_TERMINAL_ARCHIVES {
                        let remove = thread.terminal_archives.len() - MAX_TERMINAL_ARCHIVES;
                        thread.terminal_archives.drain(..remove);
                    }
                }
            }
            thread.surface = ChatSurface::Gui;
            thread.updated_at = AppleDate::now();
        }
        if let Some(session) = &session {
            if !session.temporary_removal_paths.is_empty() {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                session.retry_temporary_removals();
            }
        }
        self.sessions.lock().await.remove(&thread_id);
        state.save().await;
        Ok(())
    }

    pub async fn terminate(&self, thread_id: Uuid) {
        if let Some(session) = self.sessions.lock().await.remove(&thread_id) {
            let _ = session
                .killer
                .lock()
                .expect("terminal killer mutex poisoned")
                .kill();
            if !session.temporary_removal_paths.is_empty() {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                session.cleanup_temporary_resources();
                session.retry_temporary_removals();
            }
        }
    }

    pub async fn shutdown(&self) {
        let sessions = self
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in &sessions {
            let _ = session
                .killer
                .lock()
                .expect("terminal killer mutex poisoned")
                .kill();
        }
        if sessions
            .iter()
            .any(|session| !session.temporary_removal_paths.is_empty())
        {
            tokio::time::sleep(std::time::Duration::from_millis(3_100)).await;
            for session in &sessions {
                session.cleanup_temporary_resources();
                session.retry_temporary_removals();
            }
        }
    }
}

struct TerminalLaunch {
    executable: String,
    arguments: Vec<String>,
    environment: HashMap<String, String>,
    temporary_resources: Vec<TemporaryResource>,
}

impl Drop for TerminalLaunch {
    fn drop(&mut self) {
        for resource in &self.temporary_resources {
            resource.cleanup("unused terminal configuration");
        }
    }
}

enum TemporaryResource {
    Remove(PathBuf),
    RestoreFile {
        path: PathBuf,
        previous: Option<Vec<u8>>,
        previous_permissions: Option<std::fs::Permissions>,
        remove_parent_if_empty: Option<PathBuf>,
    },
}

fn cleanup_terminal_resources(resources: &StdMutex<Vec<TemporaryResource>>, description: &str) {
    let resources =
        std::mem::take(&mut *resources.lock().expect("terminal resource mutex poisoned"));
    for resource in &resources {
        resource.cleanup(description);
    }
}

impl TemporaryResource {
    fn cleanup(&self, description: &str) {
        match self {
            Self::Remove(path) => cleanup_temporary_path(path, description),
            Self::RestoreFile {
                path,
                previous,
                previous_permissions,
                remove_parent_if_empty,
            } => {
                let result = match previous {
                    Some(contents) => std::fs::write(path, contents).and_then(|_| {
                        if let Some(permissions) = previous_permissions {
                            std::fs::set_permissions(path, permissions.clone())?;
                        }
                        Ok(())
                    }),
                    None => match std::fs::remove_file(path) {
                        Ok(()) => Ok(()),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                        Err(error) => Err(error),
                    },
                };
                if let Err(error) = result {
                    log::warn!(
                        "could not restore {description} {}: {error}",
                        path.display()
                    );
                    return;
                }
                if let Some(parent) = remove_parent_if_empty {
                    if let Err(error) = std::fs::remove_dir(parent) {
                        let directory_has_contents = std::fs::read_dir(parent)
                            .map(|mut entries| entries.next().is_some())
                            .unwrap_or(false);
                        if error.kind() != std::io::ErrorKind::NotFound && !directory_has_contents {
                            log::warn!(
                                "could not remove empty {description} directory {}: {error}",
                                parent.display()
                            );
                        }
                    }
                }
            }
        }
    }
}

fn cleanup_temporary_path(path: &std::path::Path, description: &str) {
    let result = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        log::warn!("could not remove {description} {}: {error}", path.display());
    }
}

fn terminal_launch(
    profile: &ProviderProfile,
    thread: &maxx_core::persist::ChatThread,
    cwd: &str,
    session_id: &str,
    browser: Option<&crate::browser_runtime::BrowserProviderAccess>,
) -> Result<TerminalLaunch, String> {
    let configuration = launch::launch_configuration(profile)?;
    let profile_home = configuration.home.clone();
    let mut arguments = Vec::new();
    let mut environment = configuration.environment;
    // Electron is commonly launched without a real parent terminal and can
    // inherit TERM=dumb. The PTY below implements an xterm-compatible surface,
    // so advertise that explicitly before starting an interactive provider UI.
    // Maxx may itself be launched by an automation host that sets NO_COLOR for
    // machine-readable logs; that host preference must not suppress colors in
    // the user-facing terminal emulator.
    environment.remove("NO_COLOR");
    environment.insert("TERM".into(), "xterm-256color".into());
    environment.insert("COLORTERM".into(), "truecolor".into());
    environment.insert("TERM_PROGRAM".into(), "Maxx".into());
    let mut temporary_resources = Vec::new();
    match thread.provider {
        ChatProvider::Codex => {
            arguments.extend(["resume".into(), session_id.into()]);
            arguments.extend(["-C".into(), cwd.into()]);
            if !thread.model.eq_ignore_ascii_case("default") {
                arguments.extend(["--model".into(), thread.model.clone()]);
            }
            if let Some(effort) = nonempty(thread.effort.as_deref()) {
                arguments.extend([
                    "-c".into(),
                    format!(
                        "model_reasoning_effort={}",
                        serde_json::to_string(effort).map_err(|error| error.to_string())?
                    ),
                ]);
            }
            if let Some(browser) = browser {
                environment.insert("MAXX_BROWSER_TOKEN".into(), browser.bearer_token.clone());
                arguments.extend([
                    "-c".into(),
                    format!(
                        "mcp_servers.maxx_browser.url={}",
                        serde_json::to_string(&browser.endpoint)
                            .map_err(|error| error.to_string())?
                    ),
                    "-c".into(),
                    "mcp_servers.maxx_browser.bearer_token_env_var=\"MAXX_BROWSER_TOKEN\"".into(),
                    "-c".into(),
                    "mcp_servers.maxx_browser.default_tools_approval_mode=\"approve\"".into(),
                ]);
            }
        }
        ChatProvider::Claude => {
            arguments.extend(["--resume".into(), session_id.into()]);
            if !thread.model.eq_ignore_ascii_case("default") {
                arguments.extend(["--model".into(), thread.model.clone()]);
            }
            if let Some(effort) = nonempty(thread.effort.as_deref()) {
                arguments.extend(["--effort".into(), effort.into()]);
            }
            if let Some(browser) = browser {
                let path = write_private_temp(
                    "maxx-claude-terminal-mcp",
                    "json",
                    serde_json::to_vec(&crate::engine::claude::browser_mcp_config(browser))
                        .map_err(|error| error.to_string())?,
                )?;
                arguments.extend([
                    "--mcp-config".into(),
                    path.to_string_lossy().into_owned(),
                    "--allowedTools".into(),
                    crate::engine::claude::MAXX_BROWSER_TOOL_RULE.into(),
                ]);
                temporary_resources.push(TemporaryResource::Remove(path));
            }
        }
        ChatProvider::Grok => {
            arguments.extend([
                "--resume".into(),
                session_id.into(),
                "--cwd".into(),
                cwd.into(),
            ]);
            if !thread.model.eq_ignore_ascii_case("default") {
                arguments.extend(["--model".into(), thread.model.clone()]);
            }
            if let Some(effort) = nonempty(thread.effort.as_deref()) {
                arguments.extend(["--reasoning-effort".into(), effort.into()]);
            }
            if let Some(browser) = browser {
                let (overlay_home, server_name) =
                    prepare_grok_terminal_home(&profile_home, &environment, browser)?;
                environment.insert(
                    "GROK_HOME".into(),
                    overlay_home.to_string_lossy().into_owned(),
                );
                arguments.extend([
                    "--rules".into(),
                    format!("{GROK_MAXX_BROWSER_POLICY} The server name is {server_name}."),
                ]);
                temporary_resources.push(TemporaryResource::Remove(overlay_home));
            }
        }
        ChatProvider::Cursor => {
            arguments.extend(["--resume".into(), session_id.into()]);
            if !thread.model.eq_ignore_ascii_case("default") {
                arguments.extend(["--model".into(), thread.model.clone()]);
            }
            if let Some(browser) = browser {
                let resource = prepare_cursor_project_mcp(cwd, &mut environment, browser)?;
                temporary_resources.push(resource);
            }
        }
        ChatProvider::Opencode => {
            arguments.extend([cwd.into(), "--session".into(), session_id.into()]);
            if !thread.model.eq_ignore_ascii_case("default") {
                arguments.extend(["--model".into(), thread.model.clone()]);
            }
            if let Some(browser) = browser {
                crate::engine::opencode::inject_browser_mcp_config(&mut environment, browser)?;
            }
        }
        ChatProvider::Pi => {
            arguments.extend(["--session".into(), session_id.into()]);
            if !thread.model.eq_ignore_ascii_case("default") {
                arguments.extend(["--model".into(), thread.model.clone()]);
            }
            if let Some(effort) = nonempty(thread.effort.as_deref()) {
                arguments.extend(["--thinking".into(), effort.into()]);
            }
            if let Some(browser) = browser {
                let path = write_private_temp(
                    "maxx-pi-terminal-browser",
                    "ts",
                    include_bytes!("../resources/pi-browser-mcp.ts").to_vec(),
                )?;
                environment.insert("MAXX_BROWSER_ENDPOINT".into(), browser.endpoint.clone());
                environment.insert("MAXX_BROWSER_TOKEN".into(), browser.bearer_token.clone());
                arguments.extend(["--extension".into(), path.to_string_lossy().into_owned()]);
                temporary_resources.push(TemporaryResource::Remove(path));
            }
        }
        ChatProvider::Hermes => {
            arguments.extend([
                "--tui".into(),
                "--resume".into(),
                session_id.into(),
                "--in".into(),
                cwd.into(),
            ]);
            if !thread.model.eq_ignore_ascii_case("default") {
                arguments.extend(["--model".into(), thread.model.clone()]);
            }
            if let Some(effort) = nonempty(thread.effort.as_deref()) {
                arguments.extend(["--reasoning".into(), effort.into()]);
            }
            if let Some(browser) = browser {
                let overlay_home =
                    prepare_hermes_terminal_home(&profile_home, &environment, browser)?;
                environment.insert(
                    "HERMES_HOME".into(),
                    overlay_home.to_string_lossy().into_owned(),
                );
                environment.insert(
                    "MAXX_BROWSER_AUTHORIZATION".into(),
                    format!("Bearer {}", browser.bearer_token),
                );
                temporary_resources.push(TemporaryResource::Remove(overlay_home));
            }
        }
    }
    Ok(TerminalLaunch {
        executable: configuration.executable.to_string_lossy().into_owned(),
        arguments,
        environment,
        temporary_resources,
    })
}

fn reconciliation_request(
    thread: &maxx_core::persist::ChatThread,
    working_directory: &str,
    profile: &ProviderProfile,
    browser_access: Option<Arc<crate::browser_runtime::BrowserProviderAccess>>,
) -> TurnRequest {
    TurnRequest {
        turn_id: Uuid::new_v4(),
        thread_id: thread.id,
        provider_instance_id: thread.instance_id(),
        provider: thread.provider,
        model: thread.model.clone(),
        effort: thread.effort.clone(),
        speed: thread.speed.clone(),
        agent_instructions: None,
        prompt: String::new(),
        attachments: Vec::new(),
        working_directory: working_directory.to_string(),
        session_id: thread.provider_session_id.clone(),
        profile: profile.clone(),
        agent_id: thread.agent_id,
        browser_access,
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn submits_terminal_input(bytes: &[u8]) -> bool {
    bytes.iter().any(|byte| matches!(byte, b'\r' | b'\n'))
}

fn write_private_temp(prefix: &str, extension: &str, bytes: Vec<u8>) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!(
        "{prefix}-{}.{}",
        Uuid::new_v4().simple(),
        extension
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Could not create terminal configuration: {error}"))?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("Could not write terminal configuration: {error}"));
    }
    Ok(path)
}

fn prepare_grok_terminal_home(
    profile_home: &std::path::Path,
    environment: &HashMap<String, String>,
    browser: &crate::browser_runtime::BrowserProviderAccess,
) -> Result<(PathBuf, String), String> {
    let original_home = environment
        .get("GROK_HOME")
        .map(|path| resolve_profile_path(path, profile_home))
        .unwrap_or_else(|| profile_home.join(".grok"));
    let overlay_home =
        std::env::temp_dir().join(format!("maxx-grok-home-{}", Uuid::new_v4().simple()));
    let result = (|| -> Result<String, String> {
        let mut directory = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory
            .create(&overlay_home)
            .map_err(|error| format!("Could not create Grok terminal configuration: {error}"))?;

        if original_home.is_dir() {
            for entry in std::fs::read_dir(&original_home)
                .map_err(|error| format!("Could not read Grok configuration: {error}"))?
            {
                let entry = entry
                    .map_err(|error| format!("Could not inspect Grok configuration: {error}"))?;
                if entry.file_name() == "config.toml" {
                    continue;
                }
                #[cfg(unix)]
                std::os::unix::fs::symlink(entry.path(), overlay_home.join(entry.file_name()))
                    .map_err(|error| {
                        format!("Could not mirror Grok terminal configuration: {error}")
                    })?;
                #[cfg(not(unix))]
                return Err("Grok terminal browser configuration requires Unix symlinks.".into());
            }
        }

        let existing = match std::fs::read_to_string(original_home.join("config.toml")) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(format!("Could not read Grok config.toml: {error}")),
        };
        let server_name = format!("maxx_browser_{}", Uuid::new_v4().simple());
        let url = serde_json::to_string(&browser.endpoint).map_err(|error| error.to_string())?;
        let authorization = serde_json::to_string(&format!("Bearer {}", browser.bearer_token))
            .map_err(|error| error.to_string())?;
        let injected = format!(
            "[mcp_servers.{server_name}]\nurl = {url}\nheaders = {{ Authorization = {authorization} }}\nenabled = true\n\n{existing}"
        );
        let config_path = overlay_home.join("config.toml");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&config_path)
            .map_err(|error| format!("Could not create Grok terminal config.toml: {error}"))?;
        file.write_all(injected.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not write Grok terminal config.toml: {error}"))?;
        Ok(server_name)
    })();

    match result {
        Ok(server_name) => Ok((overlay_home, server_name)),
        Err(error) => {
            cleanup_temporary_path(&overlay_home, "incomplete Grok terminal configuration");
            Err(error)
        }
    }
}

fn prepare_hermes_terminal_home(
    profile_home: &std::path::Path,
    environment: &HashMap<String, String>,
    browser: &crate::browser_runtime::BrowserProviderAccess,
) -> Result<PathBuf, String> {
    use serde_yaml_ng::{Mapping, Value};

    let original_home = environment
        .get("HERMES_HOME")
        .map(|path| resolve_profile_path(path, profile_home))
        .unwrap_or_else(|| profile_home.join(".hermes"));
    let overlay_home =
        std::env::temp_dir().join(format!("maxx-hermes-home-{}", Uuid::new_v4().simple()));
    let result = (|| -> Result<(), String> {
        let mut directory = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory
            .create(&overlay_home)
            .map_err(|error| format!("Could not create Hermes terminal configuration: {error}"))?;

        if original_home.is_dir() {
            for entry in std::fs::read_dir(&original_home)
                .map_err(|error| format!("Could not read Hermes configuration: {error}"))?
            {
                let entry = entry
                    .map_err(|error| format!("Could not inspect Hermes configuration: {error}"))?;
                if entry.file_name() == "config.yaml" {
                    continue;
                }
                #[cfg(unix)]
                std::os::unix::fs::symlink(entry.path(), overlay_home.join(entry.file_name()))
                    .map_err(|error| {
                        format!("Could not mirror Hermes terminal configuration: {error}")
                    })?;
                #[cfg(not(unix))]
                return Err("Hermes terminal browser configuration requires Unix symlinks.".into());
            }
        }

        let mut config = match std::fs::read(original_home.join("config.yaml")) {
            Ok(contents) => serde_yaml_ng::from_slice::<Value>(&contents)
                .map_err(|error| format!("Could not parse Hermes config.yaml: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Value::Mapping(Mapping::new())
            }
            Err(error) => return Err(format!("Could not read Hermes config.yaml: {error}")),
        };
        let root = config
            .as_mapping_mut()
            .ok_or("Hermes config.yaml must contain a YAML object.")?;
        let server_name = format!("maxx_browser_{}", Uuid::new_v4().simple());

        let mcp_servers = root
            .entry(Value::String("mcp_servers".into()))
            .or_insert_with(|| Value::Mapping(Mapping::new()))
            .as_mapping_mut()
            .ok_or("Hermes config.yaml mcp_servers must be a YAML object.")?;
        let mut headers = Mapping::new();
        headers.insert(
            Value::String("Authorization".into()),
            Value::String("${MAXX_BROWSER_AUTHORIZATION}".into()),
        );
        let mut server = Mapping::new();
        server.insert(
            Value::String("url".into()),
            Value::String(browser.endpoint.clone()),
        );
        server.insert(Value::String("headers".into()), Value::Mapping(headers));
        server.insert(Value::String("enabled".into()), Value::Bool(true));
        mcp_servers.insert(Value::String(server_name.clone()), Value::Mapping(server));

        let agent = root
            .entry(Value::String("agent".into()))
            .or_insert_with(|| Value::Mapping(Mapping::new()))
            .as_mapping_mut()
            .ok_or("Hermes config.yaml agent must be a YAML object.")?;
        let disabled = agent
            .entry(Value::String("disabled_toolsets".into()))
            .or_insert_with(|| Value::Sequence(Vec::new()))
            .as_sequence_mut()
            .ok_or("Hermes agent.disabled_toolsets must be a YAML list.")?;
        for toolset in ["browser", "computer_use"] {
            let value = Value::String(toolset.into());
            if !disabled.contains(&value) {
                disabled.push(value);
            }
        }

        if let Some(platform_toolsets) = root
            .get_mut(Value::String("platform_toolsets".into()))
            .and_then(Value::as_mapping_mut)
        {
            if let Some(cli) = platform_toolsets
                .get_mut(Value::String("cli".into()))
                .and_then(Value::as_sequence_mut)
            {
                let value = Value::String(server_name);
                if !cli.contains(&value) {
                    cli.push(value);
                }
            }
        }

        let bytes = serde_yaml_ng::to_string(&config)
            .map_err(|error| format!("Could not encode Hermes config.yaml: {error}"))?;
        let config_path = overlay_home.join("config.yaml");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&config_path)
            .map_err(|error| format!("Could not create Hermes terminal config.yaml: {error}"))?;
        file.write_all(bytes.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not write Hermes terminal config.yaml: {error}"))?;
        Ok(())
    })();

    match result {
        Ok(()) => Ok(overlay_home),
        Err(error) => {
            cleanup_temporary_path(&overlay_home, "incomplete Hermes terminal configuration");
            Err(error)
        }
    }
}

fn prepare_cursor_project_mcp(
    cwd: &str,
    environment: &mut HashMap<String, String>,
    browser: &crate::browser_runtime::BrowserProviderAccess,
) -> Result<TemporaryResource, String> {
    let cursor_directory = PathBuf::from(cwd).join(".cursor");
    let created_directory = if cursor_directory.exists() {
        if !cursor_directory.is_dir() {
            return Err(format!(
                "Cursor project configuration path is not a directory: {}",
                cursor_directory.display()
            ));
        }
        false
    } else {
        std::fs::create_dir(&cursor_directory).map_err(|error| {
            format!(
                "Could not create Cursor project configuration {}: {error}",
                cursor_directory.display()
            )
        })?;
        true
    };
    let path = cursor_directory.join("mcp.json");
    let previous_metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            if created_directory {
                let _ = std::fs::remove_dir(&cursor_directory);
            }
            return Err("Cursor .cursor/mcp.json must not be a symbolic link.".into());
        }
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Could not inspect Cursor mcp.json: {error}")),
    };
    let previous = match &previous_metadata {
        Some(_) => Some(
            std::fs::read(&path)
                .map_err(|error| format!("Could not read Cursor mcp.json: {error}"))?,
        ),
        None => None,
    };
    let mut config = match &previous {
        Some(contents) => serde_json::from_slice::<serde_json::Value>(contents)
            .map_err(|error| format!("Could not parse Cursor mcp.json: {error}"))?,
        None => serde_json::json!({}),
    };
    let root = config
        .as_object_mut()
        .ok_or("Cursor .cursor/mcp.json must contain a JSON object.")?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("Cursor .cursor/mcp.json mcpServers must be a JSON object.")?;
    let server_name = format!("maxx_browser_{}", Uuid::new_v4().simple());
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the Maxx browser bridge: {error}"))?;
    servers.insert(
        server_name,
        serde_json::json!({
            "command": executable.to_string_lossy(),
            "args": [crate::browser_runtime::BRIDGE_ARGUMENT]
        }),
    );
    environment.insert(
        crate::browser_runtime::ENDPOINT_ENV.into(),
        browser.endpoint.clone(),
    );
    environment.insert(
        crate::browser_runtime::TOKEN_ENV.into(),
        browser.bearer_token.clone(),
    );

    let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|error| format!("Could not encode Cursor mcp.json: {error}"))?;
    let temporary = cursor_directory.join(format!(".maxx-mcp-{}.json", Uuid::new_v4().simple()));
    let write_result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("Could not create Cursor terminal mcp.json: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not write Cursor terminal mcp.json: {error}"))?;
        std::fs::rename(&temporary, &path)
            .map_err(|error| format!("Could not activate Cursor terminal mcp.json: {error}"))?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary);
        if created_directory {
            let _ = std::fs::remove_dir(&cursor_directory);
        }
        return Err(error);
    }

    Ok(TemporaryResource::RestoreFile {
        path,
        previous,
        previous_permissions: previous_metadata.map(|metadata| metadata.permissions()),
        remove_parent_if_empty: created_directory.then_some(cursor_directory),
    })
}

fn resolve_profile_path(path: &str, profile_home: &std::path::Path) -> PathBuf {
    if path == "~" {
        return profile_home.to_path_buf();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return profile_home.join(rest);
    }
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        profile_home.join(path)
    }
}

fn clean_archive(value: String) -> Option<String> {
    let sanitized = value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .collect::<String>();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        return None;
    }
    let content = trimmed.chars().take(MAX_ARCHIVE_CHARS).collect::<String>();
    Some(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch_for(provider: ChatProvider) -> TerminalLaunch {
        let mut profile = ProviderProfile::default_for(provider);
        profile.executable_path = Some("/bin/echo".into());
        profile.environment.insert("NO_COLOR".into(), "1".into());
        let mut thread =
            maxx_core::persist::ChatThread::new("terminal".into(), provider, "Default".into());
        thread.provider_session_id = Some("native-session".into());
        terminal_launch(&profile, &thread, "/tmp", "native-session", None).unwrap()
    }

    #[test]
    fn output_reads_are_cursor_addressed_and_report_eviction() {
        let mut output = OutputBuffer::default();
        output.push(b"one".to_vec());
        output.push(b"two".to_vec());
        let read = output.read(0, 1024);
        assert_eq!(read.chunks.len(), 2);
        assert_eq!(read.cursor, 2);
        assert!(!read.gap);
        assert_eq!(
            STANDARD.decode(&read.chunks[1].data_base64).unwrap(),
            b"two"
        );

        output.chunks.pop_front();
        let read = output.read(0, 1024);
        assert!(read.gap);
        assert_eq!(read.first_cursor, 2);
    }

    #[test]
    fn enter_input_requests_a_settled_provider_reconciliation() {
        assert!(submits_terminal_input(b"prompt\r"));
        assert!(submits_terminal_input(b"prompt\n"));
        assert!(!submits_terminal_input(b"prompt"));
    }

    #[test]
    fn support_is_explicit_about_browser_authority() {
        assert!(TerminalBroker::support(ChatProvider::Codex).browser_available);
        assert!(TerminalBroker::support(ChatProvider::Grok).browser_available);
        assert!(TerminalBroker::support(ChatProvider::Hermes).browser_available);
        assert!(TerminalBroker::support(ChatProvider::Cursor).browser_available);
    }

    #[test]
    fn every_provider_resumes_its_native_interactive_surface() {
        let expected = [
            (ChatProvider::Codex, vec!["resume", "native-session"]),
            (ChatProvider::Claude, vec!["--resume", "native-session"]),
            (ChatProvider::Grok, vec!["--resume", "native-session"]),
            (ChatProvider::Cursor, vec!["--resume", "native-session"]),
            (ChatProvider::Opencode, vec!["--session", "native-session"]),
            (ChatProvider::Pi, vec!["--session", "native-session"]),
            (
                ChatProvider::Hermes,
                vec!["--tui", "--resume", "native-session"],
            ),
        ];
        for (provider, required) in expected {
            let launch = launch_for(provider);
            assert_eq!(
                launch.environment.get("TERM").map(String::as_str),
                Some("xterm-256color")
            );
            assert_eq!(
                launch.environment.get("COLORTERM").map(String::as_str),
                Some("truecolor")
            );
            assert!(
                !launch.environment.contains_key("NO_COLOR"),
                "{} terminal inherited NO_COLOR",
                provider.display_name()
            );
            for argument in required {
                assert!(
                    launch.arguments.iter().any(|value| value == argument),
                    "{} launch omitted {argument}: {:?}",
                    provider.display_name(),
                    launch.arguments
                );
            }
            assert!(
                !launch
                    .arguments
                    .iter()
                    .any(|value| value == "--minimal" || value == "--no-alt-screen"),
                "{} should use its full native TUI: {:?}",
                provider.display_name(),
                launch.arguments
            );
            if provider == ChatProvider::Opencode {
                assert!(
                    !launch.arguments.iter().any(|value| value == "--mini"),
                    "OpenCode should use its full responsive TUI: {:?}",
                    launch.arguments
                );
            }
        }
    }

    #[test]
    fn claude_launches_the_full_native_tui_with_scoped_browser_access() {
        let mut profile = ProviderProfile::default_for(ChatProvider::Claude);
        profile.executable_path = Some("/bin/echo".into());
        let mut thread = maxx_core::persist::ChatThread::new(
            "Claude terminal".into(),
            ChatProvider::Claude,
            "sonnet".into(),
        );
        thread.effort = Some("high".into());
        let access = crate::browser_runtime::BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "claude-terminal-secret".into(),
        };

        let launch =
            terminal_launch(&profile, &thread, "/tmp", "native-session", Some(&access)).unwrap();

        assert_eq!(
            &launch.arguments[..6],
            [
                "--resume",
                "native-session",
                "--model",
                "sonnet",
                "--effort",
                "high"
            ]
        );
        for noninteractive in [
            "--print",
            "--bare",
            "--input-format",
            "--output-format",
            "--no-session-persistence",
            "--ax-screen-reader",
        ] {
            assert!(
                !launch
                    .arguments
                    .iter()
                    .any(|argument| argument == noninteractive),
                "Claude terminal unexpectedly used {noninteractive}: {:?}",
                launch.arguments
            );
        }
        let config_index = launch
            .arguments
            .iter()
            .position(|argument| argument == "--mcp-config")
            .unwrap();
        let config_path = std::path::PathBuf::from(&launch.arguments[config_index + 1]);
        assert_eq!(
            launch.arguments.get(config_index + 2).map(String::as_str),
            Some("--allowedTools")
        );
        assert_eq!(
            launch.arguments.get(config_index + 3).map(String::as_str),
            Some(crate::engine::claude::MAXX_BROWSER_TOOL_RULE)
        );
        assert!(!launch
            .arguments
            .join(" ")
            .contains("claude-terminal-secret"));
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(config["mcpServers"]["maxx_browser"]["type"], "http");
        assert_eq!(
            config["mcpServers"]["maxx_browser"]["url"],
            "http://127.0.0.1:43123/mcp"
        );
        assert_eq!(
            config["mcpServers"]["maxx_browser"]["headers"]["Authorization"],
            "Bearer claude-terminal-secret"
        );
        drop(launch);
        assert!(!config_path.exists());
    }

    #[test]
    fn grok_uses_a_private_overlay_for_scoped_browser_access() {
        use std::os::unix::fs::PermissionsExt;

        let original_home = std::env::temp_dir().join(format!(
            "maxx-grok-original-test-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(original_home.join("sessions")).unwrap();
        std::fs::write(
            original_home.join("config.toml"),
            "[ui]\ncompact_mode = true\n",
        )
        .unwrap();
        let mut profile = ProviderProfile::default_for(ChatProvider::Grok);
        profile.executable_path = Some("/bin/echo".into());
        profile.environment.insert(
            "GROK_HOME".into(),
            original_home.to_string_lossy().into_owned(),
        );
        let thread = maxx_core::persist::ChatThread::new(
            "Grok terminal".into(),
            ChatProvider::Grok,
            "Default".into(),
        );
        let access = crate::browser_runtime::BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "grok-terminal-secret".into(),
        };

        let launch =
            terminal_launch(&profile, &thread, "/tmp", "native-session", Some(&access)).unwrap();
        let overlay_home = PathBuf::from(launch.environment.get("GROK_HOME").unwrap());
        assert_ne!(overlay_home, original_home);
        assert_eq!(
            std::fs::metadata(&overlay_home)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(overlay_home.join("config.toml"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let config = std::fs::read_to_string(overlay_home.join("config.toml")).unwrap();
        assert!(config.contains("http://127.0.0.1:43123/mcp"));
        assert!(config.contains("Bearer grok-terminal-secret"));
        assert!(config.contains("compact_mode = true"));
        assert!(overlay_home.join("sessions").is_symlink());
        assert!(launch
            .arguments
            .iter()
            .any(|argument| argument == "--rules"));
        assert!(launch
            .arguments
            .join(" ")
            .contains("server name is maxx_browser_"));
        assert!(!launch.arguments.join(" ").contains("grok-terminal-secret"));
        assert_eq!(
            std::fs::read_to_string(original_home.join("config.toml")).unwrap(),
            "[ui]\ncompact_mode = true\n"
        );

        drop(launch);
        assert!(!overlay_home.exists());
        assert!(original_home.join("sessions").exists());
        std::fs::remove_dir_all(original_home).unwrap();
    }

    #[test]
    fn hermes_uses_a_private_overlay_with_only_maxx_browser_authority() {
        use std::os::unix::fs::PermissionsExt;

        let original_home = std::env::temp_dir().join(format!(
            "maxx-hermes-original-test-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&original_home).unwrap();
        std::fs::write(original_home.join("state.db"), b"sqlite fixture").unwrap();
        let original_config =
            b"model:\n  default: local\nplatform_toolsets:\n  cli:\n    - hermes-cli\n";
        std::fs::write(original_home.join("config.yaml"), original_config).unwrap();
        let mut profile = ProviderProfile::default_for(ChatProvider::Hermes);
        profile.executable_path = Some("/bin/echo".into());
        profile.environment.insert(
            "HERMES_HOME".into(),
            original_home.to_string_lossy().into_owned(),
        );
        let thread = maxx_core::persist::ChatThread::new(
            "Hermes terminal".into(),
            ChatProvider::Hermes,
            "Default".into(),
        );
        let access = crate::browser_runtime::BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "hermes-terminal-secret".into(),
        };

        let launch =
            terminal_launch(&profile, &thread, "/tmp", "native-session", Some(&access)).unwrap();
        let overlay_home = PathBuf::from(launch.environment.get("HERMES_HOME").unwrap());
        assert_ne!(overlay_home, original_home);
        assert!(overlay_home.join("state.db").is_symlink());
        assert_eq!(
            std::fs::metadata(&overlay_home)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(overlay_home.join("config.yaml"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let config: serde_yaml_ng::Value =
            serde_yaml_ng::from_slice(&std::fs::read(overlay_home.join("config.yaml")).unwrap())
                .unwrap();
        let encoded = serde_yaml_ng::to_string(&config).unwrap();
        assert!(encoded.contains("http://127.0.0.1:43123/mcp"));
        assert!(encoded.contains("${MAXX_BROWSER_AUTHORIZATION}"));
        assert!(!encoded.contains("hermes-terminal-secret"));
        assert!(encoded.contains("browser"));
        assert!(encoded.contains("computer_use"));
        assert!(encoded.contains("maxx_browser_"));
        assert_eq!(
            launch
                .environment
                .get("MAXX_BROWSER_AUTHORIZATION")
                .map(String::as_str),
            Some("Bearer hermes-terminal-secret")
        );
        assert_eq!(
            std::fs::read(original_home.join("config.yaml")).unwrap(),
            original_config
        );

        drop(launch);
        assert!(!overlay_home.exists());
        assert!(original_home.join("state.db").exists());
        std::fs::remove_dir_all(original_home).unwrap();
    }

    #[test]
    fn cursor_temporarily_merges_project_mcp_and_restores_it_exactly() {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let root = std::env::temp_dir().join(format!(
            "maxx-cursor-project-test-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(root.join(".cursor")).unwrap();
        let config_path = root.join(".cursor/mcp.json");
        let original = b"{\n  \"mcpServers\": {\"existing\": {\"command\": \"true\"}},\n  \"other\": true\n}\n";
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).mode(0o640);
        options
            .open(&config_path)
            .unwrap()
            .write_all(original)
            .unwrap();
        let mut profile = ProviderProfile::default_for(ChatProvider::Cursor);
        profile.executable_path = Some("/bin/echo".into());
        let thread = maxx_core::persist::ChatThread::new(
            "Cursor terminal".into(),
            ChatProvider::Cursor,
            "Default".into(),
        );
        let access = crate::browser_runtime::BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "cursor-terminal-secret".into(),
        };

        let launch = terminal_launch(
            &profile,
            &thread,
            &root.to_string_lossy(),
            "native-session",
            Some(&access),
        )
        .unwrap();
        let injected: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(injected["other"], true);
        assert_eq!(injected["mcpServers"]["existing"]["command"], "true");
        assert!(injected["mcpServers"]
            .as_object()
            .unwrap()
            .keys()
            .any(|name| name.starts_with("maxx_browser_")));
        assert!(!std::fs::read_to_string(&config_path)
            .unwrap()
            .contains("cursor-terminal-secret"));
        assert_eq!(
            launch
                .environment
                .get(crate::browser_runtime::TOKEN_ENV)
                .map(String::as_str),
            Some("cursor-terminal-secret")
        );
        assert_eq!(
            launch
                .environment
                .get(crate::browser_runtime::ENDPOINT_ENV)
                .map(String::as_str),
            Some("http://127.0.0.1:43123/mcp")
        );

        drop(launch);
        assert_eq!(std::fs::read(&config_path).unwrap(), original);
        assert_eq!(
            std::fs::metadata(&config_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        std::fs::remove_dir_all(root).unwrap();

        let clean_root = std::env::temp_dir().join(format!(
            "maxx-cursor-clean-project-test-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&clean_root).unwrap();
        let launch = terminal_launch(
            &profile,
            &thread,
            &clean_root.to_string_lossy(),
            "native-session",
            Some(&access),
        )
        .unwrap();
        assert!(clean_root.join(".cursor/mcp.json").exists());
        drop(launch);
        assert!(!clean_root.join(".cursor").exists());
        std::fs::remove_dir(clean_root).unwrap();
    }

    #[test]
    fn terminal_resource_cleanup_is_immediate_and_runs_only_once() {
        let root = std::env::temp_dir().join(format!(
            "maxx-terminal-cleanup-test-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("mcp.json");
        std::fs::write(&path, b"injected").unwrap();
        let resources = StdMutex::new(vec![TemporaryResource::RestoreFile {
            path: path.clone(),
            previous: Some(b"original".to_vec()),
            previous_permissions: None,
            remove_parent_if_empty: None,
        }]);

        cleanup_terminal_resources(&resources, "test terminal configuration");
        assert_eq!(std::fs::read(&path).unwrap(), b"original");

        std::fs::write(&path, b"user edit after handoff").unwrap();
        cleanup_terminal_resources(&resources, "test terminal configuration");
        assert_eq!(std::fs::read(&path).unwrap(), b"user edit after handoff");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn multi_megabyte_terminal_bursts_keep_memory_bounded() {
        let mut output = OutputBuffer::default();
        let line = b"\x1b[38;2;117;167;232magent output with ansi styling and enough text to wrap\x1b[0m\r\n";
        for batch in 0..1_000 {
            let mut bytes = Vec::with_capacity(line.len() * 100);
            for _ in 0..100 {
                bytes.extend_from_slice(line);
            }
            output.push(bytes);
            assert!(output.retained_bytes <= RETAINED_OUTPUT_BYTES);
            assert!(output.chunks.len() <= batch + 1);
        }
        assert_eq!(output.latest_cursor(), 1_000);
        assert!(output.first_cursor() > 1);
        let read = output.read(0, MAX_READ_BYTES);
        assert!(read.gap);
        assert!(!read.chunks.is_empty());
    }

    #[test]
    fn browser_secrets_use_scoped_channels_and_ephemeral_files_cleanup() {
        use std::os::unix::fs::PermissionsExt;

        let access = crate::browser_runtime::BrowserProviderAccess {
            session_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:43123/mcp".into(),
            bearer_token: "terminal-test-secret".into(),
        };
        for provider in [
            ChatProvider::Codex,
            ChatProvider::Claude,
            ChatProvider::Opencode,
            ChatProvider::Pi,
        ] {
            let mut profile = ProviderProfile::default_for(provider);
            profile.executable_path = Some("/bin/echo".into());
            let thread =
                maxx_core::persist::ChatThread::new("terminal".into(), provider, "Default".into());
            let launch =
                terminal_launch(&profile, &thread, "/tmp", "native-session", Some(&access))
                    .unwrap();
            assert!(
                launch.environment.contains_key("MAXX_BROWSER_TOKEN")
                    || provider == ChatProvider::Claude
            );
            assert!(!launch.arguments.join(" ").contains("terminal-test-secret"));
            let temporary_paths = launch
                .temporary_resources
                .iter()
                .filter_map(|resource| match resource {
                    TemporaryResource::Remove(path) if path.is_file() => Some(path.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            for path in &temporary_paths {
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            drop(launch);
            assert!(temporary_paths.iter().all(|path| !path.exists()));
        }
    }

    #[test]
    fn archives_are_bounded_and_blank_archives_are_dropped() {
        assert!(clean_archive("  \n".into()).is_none());
        assert_eq!(clean_archive(" hello \n".into()).unwrap(), "hello");
        assert_eq!(
            clean_archive("x".repeat(MAX_ARCHIVE_CHARS + 10))
                .unwrap()
                .len(),
            MAX_ARCHIVE_CHARS
        );
        assert_eq!(
            clean_archive("safe\u{1b}[31m text".into()).unwrap(),
            "safe[31m text"
        );
    }
}
