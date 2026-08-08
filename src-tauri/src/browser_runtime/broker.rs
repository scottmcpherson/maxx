use super::{
    AuthenticatedBrowserSession, BrowserArtifactStore, BrowserHumanInput, BrowserOperation,
    BrowserOperationResult, BrowserRenderedFrame, BrowserRuntimeError, BrowserTabId,
    BrowserTabSummary,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

const MAX_ACTION_TIMELINE: usize = 200;

#[derive(Clone)]
pub struct BrowserControlGuard {
    epoch: Arc<AtomicU64>,
    expected: u64,
}

impl BrowserControlGuard {
    pub fn expected_epoch(&self) -> u64 {
        self.expected
    }

    /// Engines call this immediately before each mutation and after each
    /// awaited operation. It is intentionally cheap enough to use repeatedly.
    pub fn ensure_current(&self) -> Result<(), BrowserRuntimeError> {
        let actual = self.epoch.load(Ordering::SeqCst);
        if actual != self.expected {
            return Err(BrowserRuntimeError::new(
                "browser.human-takeover",
                format!(
                    "browser control changed from epoch {} to {actual}; the agent action stopped",
                    self.expected
                ),
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct BrowserEngineContext {
    pub session_id: Uuid,
    pub action_id: Uuid,
    pub tab_id: BrowserTabId,
    pub control: BrowserControlGuard,
    pub artifacts: Arc<BrowserArtifactStore>,
    pub file_roots: Vec<PathBuf>,
}

impl BrowserEngineContext {
    pub fn store_artifact(
        &self,
        bytes: &[u8],
        mime_type: impl Into<String>,
        extension: &str,
        title: Option<String>,
    ) -> Result<super::BrowserArtifactRef, BrowserRuntimeError> {
        self.artifacts.store(
            self.session_id,
            self.tab_id,
            bytes,
            mime_type,
            extension,
            title,
        )
    }

    pub fn authorize_upload_paths(
        &self,
        requested: &[String],
    ) -> Result<Vec<String>, BrowserRuntimeError> {
        let roots = self
            .file_roots
            .iter()
            .filter_map(|root| std::fs::canonicalize(root).ok())
            .collect::<Vec<_>>();
        if roots.is_empty() {
            return Err(BrowserRuntimeError::new(
                "browser.upload-denied",
                "this browser session has no authorized upload root",
            ));
        }
        requested
            .iter()
            .map(|raw| {
                let path = std::fs::canonicalize(raw).map_err(|error| {
                    BrowserRuntimeError::new(
                        "browser.upload-path",
                        format!("could not resolve upload path {raw}: {error}"),
                    )
                })?;
                if !path.is_file() || !roots.iter().any(|root| path.starts_with(root)) {
                    return Err(BrowserRuntimeError::new(
                        "browser.upload-denied",
                        format!("upload path is outside this session's project: {raw}"),
                    ));
                }
                Ok(path.to_string_lossy().to_string())
            })
            .collect()
    }
}

#[async_trait]
pub trait BrowserEngine: Send + Sync {
    fn name(&self) -> &'static str;

    async fn execute(
        &self,
        context: BrowserEngineContext,
        operation: BrowserOperation,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError>;

    async fn interrupt(&self, _tab_id: BrowserTabId) {}

    async fn start_frame_stream(
        &self,
        _tab_id: BrowserTabId,
    ) -> Result<BrowserFrameStream, BrowserRuntimeError> {
        Err(BrowserRuntimeError::new(
            "browser.visual-unavailable",
            "this browser engine does not provide a visual frame stream",
        ))
    }

    async fn stop_frame_stream(&self, _tab_id: BrowserTabId, _stream_id: Uuid) {}

    async fn human_input(
        &self,
        _tab_id: BrowserTabId,
        _input: BrowserHumanInput,
    ) -> Result<(), BrowserRuntimeError> {
        Err(BrowserRuntimeError::new(
            "browser.human-input-unavailable",
            "this browser engine does not accept human input",
        ))
    }
}

pub struct BrowserFrameStream {
    pub id: Uuid,
    pub frames: watch::Receiver<Option<BrowserRenderedFrame>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserActionState {
    Running,
    Succeeded,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionRecord {
    pub id: Uuid,
    pub session_id: Uuid,
    pub tab_id: BrowserTabId,
    pub tool: String,
    pub state: BrowserActionState,
    pub started_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub finished_at_ms: Option<u64>,
    pub initial_control_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub final_control_epoch: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error_code: Option<String>,
}

struct TabRuntime {
    summary: BrowserTabSummary,
    document_generation: u64,
    epoch: Arc<AtomicU64>,
    queue: Arc<Mutex<()>>,
    active_action_id: Option<Uuid>,
}

#[derive(Default)]
struct BrokerState {
    tabs: HashMap<BrowserTabId, TabRuntime>,
    selected_tab: Option<BrowserTabId>,
    timeline: VecDeque<BrowserActionRecord>,
}

pub struct BrowserBroker {
    engine: Arc<dyn BrowserEngine>,
    artifacts: Arc<BrowserArtifactStore>,
    state: Mutex<BrokerState>,
}

impl BrowserBroker {
    pub fn new(engine: Arc<dyn BrowserEngine>, artifacts: Arc<BrowserArtifactStore>) -> Self {
        Self {
            engine,
            artifacts,
            state: Mutex::new(BrokerState::default()),
        }
    }

    pub fn engine_name(&self) -> &'static str {
        self.engine.name()
    }

    pub async fn execute(
        &self,
        session: &AuthenticatedBrowserSession,
        operation: BrowserOperation,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let required = operation.required_capability();
        if !session.scope.capabilities.contains(&required) {
            return Err(BrowserRuntimeError::new(
                "browser.capability-denied",
                format!("the browser session does not grant {required:?}"),
            ));
        }

        match operation {
            BrowserOperation::Status => self.status(session).await,
            BrowserOperation::ListTabs => self.list_tabs(session).await,
            BrowserOperation::OpenTab { url } => self.open_tab(session, url).await,
            operation => self.execute_on_tab(session, operation).await,
        }
    }

    pub async fn tab_summaries(&self) -> Vec<BrowserTabSummary> {
        let state = self.state.lock().await;
        ordered_summaries(&state)
    }

    pub async fn timeline(&self) -> Vec<BrowserActionRecord> {
        self.state.lock().await.timeline.iter().cloned().collect()
    }

    pub async fn human_input(&self, tab_id: BrowserTabId) -> Result<u64, BrowserRuntimeError> {
        let next = {
            let mut state = self.state.lock().await;
            let tab = state.tabs.get_mut(&tab_id).ok_or_else(|| {
                BrowserRuntimeError::new("browser.tab-not-found", "browser tab does not exist")
            })?;
            let next = tab.epoch.fetch_add(1, Ordering::SeqCst) + 1;
            tab.summary.control_epoch = next;
            tab.summary.controller_session_id = None;
            next
        };
        self.engine.interrupt(tab_id).await;
        Ok(next)
    }

    pub async fn start_frame_stream(
        &self,
        tab_id: BrowserTabId,
    ) -> Result<BrowserFrameStream, BrowserRuntimeError> {
        {
            let state = self.state.lock().await;
            if !state.tabs.contains_key(&tab_id) {
                return Err(BrowserRuntimeError::new(
                    "browser.tab-not-found",
                    "browser tab does not exist",
                ));
            }
        }
        self.engine.start_frame_stream(tab_id).await
    }

    pub async fn stop_frame_stream(&self, tab_id: BrowserTabId, stream_id: Uuid) {
        self.engine.stop_frame_stream(tab_id, stream_id).await;
    }

    pub async fn observe_frame(&self, frame: &BrowserRenderedFrame) {
        let mut state = self.state.lock().await;
        if let Some(tab) = state.tabs.get_mut(&frame.tab_id) {
            tab.summary.url = frame.url.clone();
            tab.summary.title = frame.title.clone();
            tab.summary.loading = frame.loading;
        }
    }

    pub async fn dispatch_human_input(
        &self,
        tab_id: BrowserTabId,
        input: BrowserHumanInput,
    ) -> Result<u64, BrowserRuntimeError> {
        let epoch = self.human_input(tab_id).await?;
        self.engine.human_input(tab_id, input).await?;
        Ok(epoch)
    }

    pub async fn release_to_human(&self, tab_id: BrowserTabId) {
        if let Some(tab) = self.state.lock().await.tabs.get_mut(&tab_id) {
            tab.summary.controller_session_id = None;
        }
    }

    async fn status(
        &self,
        session: &AuthenticatedBrowserSession,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let state = self.state.lock().await;
        let assigned_tabs = ordered_summaries(&state)
            .into_iter()
            .filter(|tab| session.scope.assigned_tabs.contains(&tab.id))
            .collect::<Vec<_>>();
        Ok(BrowserOperationResult {
            tab_id: state
                .selected_tab
                .filter(|tab| session.scope.assigned_tabs.contains(tab)),
            control_epoch: 0,
            observation_id: None,
            value: json!({
                "engine": self.engine.name(),
                "sessionId": session.session_id,
                "tabs": assigned_tabs,
            }),
            artifacts: Vec::new(),
        })
    }

    async fn list_tabs(
        &self,
        session: &AuthenticatedBrowserSession,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let state = self.state.lock().await;
        let tabs = ordered_summaries(&state)
            .into_iter()
            .filter(|tab| session.scope.assigned_tabs.contains(&tab.id))
            .collect::<Vec<_>>();
        Ok(BrowserOperationResult {
            tab_id: None,
            control_epoch: 0,
            observation_id: None,
            value: serde_json::to_value(tabs).map_err(|error| {
                BrowserRuntimeError::new(
                    "browser.serialization",
                    format!("could not serialize browser tabs: {error}"),
                )
            })?,
            artifacts: Vec::new(),
        })
    }

    async fn open_tab(
        &self,
        session: &AuthenticatedBrowserSession,
        url: Option<String>,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let tab_id = Uuid::new_v4();
        let epoch = Arc::new(AtomicU64::new(0));
        {
            let mut state = self.state.lock().await;
            state.selected_tab = Some(tab_id);
            state.tabs.insert(
                tab_id,
                TabRuntime {
                    summary: BrowserTabSummary {
                        id: tab_id,
                        url: url.clone().unwrap_or_default(),
                        title: "Browser".into(),
                        loading: url.is_some(),
                        selected: true,
                        control_epoch: 0,
                        controller_session_id: Some(session.session_id),
                    },
                    document_generation: 0,
                    epoch: epoch.clone(),
                    queue: Arc::new(Mutex::new(())),
                    active_action_id: None,
                },
            );
            sync_selected(&mut state);
        }

        let action_id = Uuid::new_v4();
        let operation = BrowserOperation::OpenTab { url };
        let result = self
            .engine
            .execute(
                BrowserEngineContext {
                    session_id: session.session_id,
                    action_id,
                    tab_id,
                    control: BrowserControlGuard { epoch, expected: 0 },
                    artifacts: self.artifacts.clone(),
                    file_roots: session.scope.file_roots.clone(),
                },
                operation,
            )
            .await;
        match result {
            Ok(mut result) => {
                result.tab_id = Some(tab_id);
                result.control_epoch = 0;
                if result.value.is_null() {
                    result.value = json!({"tabId": tab_id, "selected": true});
                }
                Ok(result)
            }
            Err(error) => {
                let mut state = self.state.lock().await;
                state.tabs.remove(&tab_id);
                if state.selected_tab == Some(tab_id) {
                    state.selected_tab = state.tabs.keys().next().copied();
                    sync_selected(&mut state);
                }
                Err(error)
            }
        }
    }

    async fn execute_on_tab(
        &self,
        session: &AuthenticatedBrowserSession,
        operation: BrowserOperation,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let tab_id = operation.target_tab().ok_or_else(|| {
            BrowserRuntimeError::new("browser.invalid-operation", "operation requires a tab")
        })?;
        if !session.scope.assigned_tabs.contains(&tab_id) {
            return Err(BrowserRuntimeError::new(
                "browser.tab-denied",
                "the browser tab is not assigned to this provider session",
            ));
        }

        let (queue, epoch) = {
            let state = self.state.lock().await;
            let tab = state.tabs.get(&tab_id).ok_or_else(|| {
                BrowserRuntimeError::new("browser.tab-not-found", "browser tab does not exist")
            })?;
            (tab.queue.clone(), tab.epoch.clone())
        };
        // Capture before entering the queue. Human input or turn cancellation
        // must invalidate actions that are waiting as well as the one running.
        let initial_epoch = epoch.load(Ordering::SeqCst);
        let _queue_guard = queue.lock().await;
        let control = BrowserControlGuard {
            epoch: epoch.clone(),
            expected: initial_epoch,
        };
        control.ensure_current()?;

        let action_id = Uuid::new_v4();
        let started_at_ms = unix_time_ms();
        let tool = operation.tool_name().to_string();
        {
            let mut state = self.state.lock().await;
            let tab = state.tabs.get_mut(&tab_id).ok_or_else(|| {
                BrowserRuntimeError::new("browser.tab-not-found", "browser tab does not exist")
            })?;
            tab.active_action_id = Some(action_id);
            tab.summary.controller_session_id = Some(session.session_id);
            push_timeline(
                &mut state,
                BrowserActionRecord {
                    id: action_id,
                    session_id: session.session_id,
                    tab_id,
                    tool: tool.clone(),
                    state: BrowserActionState::Running,
                    started_at_ms,
                    finished_at_ms: None,
                    initial_control_epoch: initial_epoch,
                    final_control_epoch: None,
                    error_code: None,
                },
            );
        }

        let mutation = operation.is_mutating();
        let select = matches!(operation, BrowserOperation::SelectTab { .. });
        let close = matches!(operation, BrowserOperation::CloseTab { .. });
        let navigation = matches!(
            operation,
            BrowserOperation::Navigate { .. }
                | BrowserOperation::GoBack { .. }
                | BrowserOperation::GoForward { .. }
                | BrowserOperation::Reload { .. }
        );
        let execution = self
            .engine
            .execute(
                BrowserEngineContext {
                    session_id: session.session_id,
                    action_id,
                    tab_id,
                    control: control.clone(),
                    artifacts: self.artifacts.clone(),
                    file_roots: session.scope.file_roots.clone(),
                },
                operation,
            )
            .await
            .and_then(|mut result| {
                if mutation {
                    control.ensure_current()?;
                }
                result.tab_id = Some(tab_id);
                result.control_epoch = epoch.load(Ordering::SeqCst);
                Ok(result)
            });

        let final_epoch = epoch.load(Ordering::SeqCst);
        let mut state = self.state.lock().await;
        if close && execution.is_ok() {
            state.tabs.remove(&tab_id);
            if state.selected_tab == Some(tab_id) {
                state.selected_tab = state.tabs.keys().next().copied();
            }
            sync_selected(&mut state);
        } else if let Some(tab) = state.tabs.get_mut(&tab_id) {
            tab.active_action_id = None;
            tab.summary.control_epoch = final_epoch;
            if navigation && execution.is_ok() {
                tab.document_generation += 1;
            }
            if let Ok(result) = &execution {
                update_summary(&mut tab.summary, &result.value);
            }
            if select && execution.is_ok() {
                state.selected_tab = Some(tab_id);
                sync_selected(&mut state);
            }
        }
        if let Some(record) = state
            .timeline
            .iter_mut()
            .find(|record| record.id == action_id)
        {
            record.finished_at_ms = Some(unix_time_ms());
            record.final_control_epoch = Some(final_epoch);
            match &execution {
                Ok(_) => record.state = BrowserActionState::Succeeded,
                Err(error) if error.code == "browser.human-takeover" => {
                    record.state = BrowserActionState::Interrupted;
                    record.error_code = Some(error.code.clone());
                }
                Err(error) => {
                    record.state = BrowserActionState::Failed;
                    record.error_code = Some(error.code.clone());
                }
            }
        }
        execution
    }
}

fn update_summary(summary: &mut BrowserTabSummary, value: &Value) {
    if let Some(url) = value.get("url").and_then(Value::as_str) {
        summary.url = url.to_string();
    }
    if let Some(title) = value.get("title").and_then(Value::as_str) {
        summary.title = title.to_string();
    }
    if let Some(loading) = value.get("loading").and_then(Value::as_bool) {
        summary.loading = loading;
    }
}

fn ordered_summaries(state: &BrokerState) -> Vec<BrowserTabSummary> {
    let mut tabs = state
        .tabs
        .values()
        .map(|tab| tab.summary.clone())
        .collect::<Vec<_>>();
    tabs.sort_by_key(|tab| tab.id);
    tabs
}

fn sync_selected(state: &mut BrokerState) {
    for tab in state.tabs.values_mut() {
        tab.summary.selected = Some(tab.summary.id) == state.selected_tab;
    }
}

fn push_timeline(state: &mut BrokerState, record: BrowserActionRecord) {
    state.timeline.push_back(record);
    while state.timeline.len() > MAX_ACTION_TIMELINE {
        state.timeline.pop_front();
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Deterministic engine for broker and MCP conformance tests. It deliberately
/// implements the typed contract without emulating a browser.
#[derive(Default)]
pub struct FakeBrowserEngine {
    calls: std::sync::Mutex<Vec<(BrowserTabId, String)>>,
}

impl FakeBrowserEngine {
    pub fn calls(&self) -> Vec<(BrowserTabId, String)> {
        self.calls.lock().expect("fake engine mutex").clone()
    }
}

#[async_trait]
impl BrowserEngine for FakeBrowserEngine {
    fn name(&self) -> &'static str {
        "fake"
    }

    async fn execute(
        &self,
        context: BrowserEngineContext,
        operation: BrowserOperation,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        context.control.ensure_current()?;
        self.calls
            .lock()
            .expect("fake engine mutex")
            .push((context.tab_id, operation.tool_name().into()));
        context.control.ensure_current()?;
        Ok(BrowserOperationResult {
            tab_id: Some(context.tab_id),
            control_epoch: context.control.expected_epoch(),
            observation_id: matches!(operation, BrowserOperation::Snapshot { .. })
                .then(Uuid::new_v4),
            value: Value::Null,
            artifacts: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_runtime::{BrowserCapability, BrowserSessionScope};
    use maxx_core::contract::ChatProvider;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::time::Duration;

    fn artifacts() -> Arc<BrowserArtifactStore> {
        let root = std::env::temp_dir().join(format!("maxx-broker-test-{}", Uuid::new_v4()));
        Arc::new(BrowserArtifactStore::new(root).expect("artifact store"))
    }

    fn session(tabs: impl IntoIterator<Item = BrowserTabId>) -> AuthenticatedBrowserSession {
        AuthenticatedBrowserSession {
            session_id: Uuid::new_v4(),
            scope: BrowserSessionScope {
                project_id: Uuid::new_v4(),
                thread_id: Uuid::new_v4(),
                provider: ChatProvider::Codex,
                provider_instance_id: Uuid::new_v4(),
                provider_session_id: None,
                agent_id: None,
                capabilities: BrowserCapability::ALL.into_iter().collect(),
                assigned_tabs: tabs.into_iter().collect(),
                file_roots: Vec::new(),
            },
        }
    }

    #[test]
    fn upload_paths_are_canonicalized_and_confined_to_session_roots() {
        let root = std::env::temp_dir().join(format!("maxx-upload-root-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("maxx-upload-outside-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).expect("project root");
        std::fs::create_dir_all(&outside).expect("outside root");
        let allowed = root.join("nested/file.txt");
        let denied = outside.join("secret.txt");
        std::fs::write(&allowed, b"allowed").expect("allowed fixture");
        std::fs::write(&denied, b"denied").expect("denied fixture");
        let context = BrowserEngineContext {
            session_id: Uuid::new_v4(),
            action_id: Uuid::new_v4(),
            tab_id: Uuid::new_v4(),
            control: BrowserControlGuard {
                epoch: Arc::new(AtomicU64::new(0)),
                expected: 0,
            },
            artifacts: artifacts(),
            file_roots: vec![root],
        };

        let authorized = context
            .authorize_upload_paths(&[allowed.to_string_lossy().to_string()])
            .expect("project file is allowed");
        assert_eq!(
            authorized,
            vec![allowed
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .to_string()]
        );
        let error = context
            .authorize_upload_paths(&[denied.to_string_lossy().to_string()])
            .expect_err("outside path is denied");
        assert_eq!(error.code, "browser.upload-denied");
    }

    #[tokio::test]
    async fn tab_scope_is_enforced_by_the_broker_too() {
        let broker = BrowserBroker::new(Arc::new(FakeBrowserEngine::default()), artifacts());
        let session = session(HashSet::new());
        let denied = broker
            .execute(
                &session,
                BrowserOperation::Snapshot {
                    tab_id: Uuid::new_v4(),
                    include_screenshot: false,
                },
            )
            .await
            .expect_err("tab must be denied");
        assert_eq!(denied.code, "browser.tab-denied");
    }

    #[tokio::test]
    async fn open_assign_execute_and_close_are_consistent() {
        let engine = Arc::new(FakeBrowserEngine::default());
        let broker = BrowserBroker::new(engine.clone(), artifacts());
        let bootstrap = session(HashSet::new());
        let opened = broker
            .execute(
                &bootstrap,
                BrowserOperation::OpenTab {
                    url: Some("https://example.com".into()),
                },
            )
            .await
            .expect("open");
        let tab_id = opened.tab_id.expect("tab id");
        let assigned = session([tab_id]);
        broker
            .execute(
                &assigned,
                BrowserOperation::Snapshot {
                    tab_id,
                    include_screenshot: false,
                },
            )
            .await
            .expect("snapshot");
        broker
            .execute(&assigned, BrowserOperation::CloseTab { tab_id })
            .await
            .expect("close");
        assert!(broker.tab_summaries().await.is_empty());
        assert_eq!(engine.calls().len(), 3);
    }

    #[tokio::test]
    async fn opening_a_tab_selects_it_and_deselects_the_previous_tab() {
        let broker = BrowserBroker::new(Arc::new(FakeBrowserEngine::default()), artifacts());
        let session = session(HashSet::new());
        let first = broker
            .execute(&session, BrowserOperation::OpenTab { url: None })
            .await
            .expect("first tab")
            .tab_id
            .expect("first tab id");
        let second = broker
            .execute(&session, BrowserOperation::OpenTab { url: None })
            .await
            .expect("second tab")
            .tab_id
            .expect("second tab id");

        let tabs = broker.tab_summaries().await;
        assert!(
            !tabs
                .iter()
                .find(|tab| tab.id == first)
                .expect("first")
                .selected
        );
        assert!(
            tabs.iter()
                .find(|tab| tab.id == second)
                .expect("second")
                .selected
        );
    }

    struct BlockingEngine {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        active: AtomicUsize,
        maximum: AtomicUsize,
    }

    #[async_trait]
    impl BrowserEngine for BlockingEngine {
        fn name(&self) -> &'static str {
            "blocking"
        }

        async fn execute(
            &self,
            context: BrowserEngineContext,
            _operation: BrowserOperation,
        ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
            context.control.ensure_current()?;
            let active = self.active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
            self.maximum.fetch_max(active, AtomicOrdering::SeqCst);
            self.entered.notify_waiters();
            self.release.notified().await;
            self.active.fetch_sub(1, AtomicOrdering::SeqCst);
            context.control.ensure_current()?;
            Ok(BrowserOperationResult {
                tab_id: Some(context.tab_id),
                control_epoch: context.control.expected_epoch(),
                observation_id: None,
                value: Value::Null,
                artifacts: Vec::new(),
            })
        }
    }

    async fn insert_test_tab(broker: &BrowserBroker, tab_id: BrowserTabId) {
        let mut state = broker.state.lock().await;
        state.tabs.insert(
            tab_id,
            TabRuntime {
                summary: BrowserTabSummary {
                    id: tab_id,
                    url: String::new(),
                    title: "Browser".into(),
                    loading: false,
                    selected: false,
                    control_epoch: 0,
                    controller_session_id: None,
                },
                document_generation: 0,
                epoch: Arc::new(AtomicU64::new(0)),
                queue: Arc::new(Mutex::new(())),
                active_action_id: None,
            },
        );
    }

    async fn wait_for_active(engine: &BlockingEngine, expected: usize) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while engine.active.load(AtomicOrdering::SeqCst) != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("engine reached expected concurrency");
    }

    #[tokio::test]
    async fn separate_tabs_run_concurrently_while_shared_tabs_serialize() {
        let engine = Arc::new(BlockingEngine {
            entered: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
            active: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
        });
        let broker = Arc::new(BrowserBroker::new(engine.clone(), artifacts()));
        let first_tab = Uuid::new_v4();
        let second_tab = Uuid::new_v4();
        insert_test_tab(&broker, first_tab).await;
        insert_test_tab(&broker, second_tab).await;

        let first_broker = broker.clone();
        let first_session = session([first_tab]);
        let first = tokio::spawn(async move {
            first_broker
                .execute(
                    &first_session,
                    BrowserOperation::Click {
                        tab_id: first_tab,
                        reference: "e1".into(),
                    },
                )
                .await
        });
        let second_broker = broker.clone();
        let second_session = session([second_tab]);
        let second = tokio::spawn(async move {
            second_broker
                .execute(
                    &second_session,
                    BrowserOperation::Click {
                        tab_id: second_tab,
                        reference: "e2".into(),
                    },
                )
                .await
        });

        wait_for_active(&engine, 2).await;
        assert_eq!(engine.maximum.load(AtomicOrdering::SeqCst), 2);
        engine.release.notify_waiters();
        first.await.expect("first join").expect("first action");
        second.await.expect("second join").expect("second action");

        engine.maximum.store(0, AtomicOrdering::SeqCst);
        let shared_first_broker = broker.clone();
        let shared_first_session = session([first_tab]);
        let shared_first = tokio::spawn(async move {
            shared_first_broker
                .execute(
                    &shared_first_session,
                    BrowserOperation::Click {
                        tab_id: first_tab,
                        reference: "e3".into(),
                    },
                )
                .await
        });
        wait_for_active(&engine, 1).await;
        let shared_second_broker = broker.clone();
        let shared_second_session = session([first_tab]);
        let shared_second = tokio::spawn(async move {
            shared_second_broker
                .execute(
                    &shared_second_session,
                    BrowserOperation::Click {
                        tab_id: first_tab,
                        reference: "e4".into(),
                    },
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(engine.maximum.load(AtomicOrdering::SeqCst), 1);

        engine.release.notify_waiters();
        shared_first
            .await
            .expect("shared first join")
            .expect("shared first action");
        wait_for_active(&engine, 1).await;
        engine.release.notify_waiters();
        shared_second
            .await
            .expect("shared second join")
            .expect("shared second action");
        assert_eq!(engine.maximum.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn human_input_interrupts_an_in_flight_mutation() {
        let engine = Arc::new(BlockingEngine {
            entered: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
            active: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
        });
        let broker = Arc::new(BrowserBroker::new(engine.clone(), artifacts()));
        let bootstrap = session(HashSet::new());

        // Avoid blocking the setup open on this engine.
        let tab_id = Uuid::new_v4();
        insert_test_tab(&broker, tab_id).await;
        let assigned = AuthenticatedBrowserSession {
            session_id: bootstrap.session_id,
            scope: BrowserSessionScope {
                assigned_tabs: [tab_id].into_iter().collect(),
                ..bootstrap.scope
            },
        };
        let running_broker = broker.clone();
        let running_session = assigned.clone();
        let handle = tokio::spawn(async move {
            running_broker
                .execute(
                    &running_session,
                    BrowserOperation::Click {
                        tab_id,
                        reference: "e1".into(),
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), engine.entered.notified())
            .await
            .expect("engine entered");
        let queued_broker = broker.clone();
        let queued_session = assigned.clone();
        let queued = tokio::spawn(async move {
            queued_broker
                .execute(
                    &queued_session,
                    BrowserOperation::Click {
                        tab_id,
                        reference: "e2".into(),
                    },
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        broker.human_input(tab_id).await.expect("human input");
        engine.release.notify_waiters();
        let error = handle.await.expect("join").expect_err("interrupted");
        assert_eq!(error.code, "browser.human-takeover");
        let queued_error = queued
            .await
            .expect("queued join")
            .expect_err("queued action interrupted");
        assert_eq!(queued_error.code, "browser.human-takeover");
        assert_eq!(
            broker.timeline().await.last().expect("timeline").state,
            BrowserActionState::Interrupted
        );
    }
}
