use super::{
    BrowserEngine, BrowserEngineContext, BrowserHumanInput, BrowserOperation,
    BrowserOperationResult, BrowserRenderedFrame, BrowserRuntimeError, BrowserTabId,
};
use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chromiumoxide::cdp::browser_protocol::browser::{
    EventDownloadProgress, EventDownloadWillBegin, SetDownloadBehaviorBehavior,
    SetDownloadBehaviorParams,
};
use chromiumoxide::cdp::browser_protocol::dom::SetFileInputFilesParams;
use chromiumoxide::cdp::browser_protocol::emulation::SetDeviceMetricsOverrideParams;
use chromiumoxide::cdp::browser_protocol::input::{
    DispatchKeyEventParams, DispatchKeyEventType, DispatchMouseEventParams, DispatchMouseEventType,
    InsertTextParams, MouseButton,
};
use chromiumoxide::cdp::browser_protocol::io::{CloseParams, ReadParams};
use chromiumoxide::cdp::browser_protocol::network::{
    DeleteCookiesParams, EnableParams as NetworkEnableParams, EventLoadingFailed,
    EventRequestWillBeSent, EventResponseReceived, GetCookiesParams, GetResponseBodyParams,
    SetCookieParams,
};
use chromiumoxide::cdp::browser_protocol::page::{
    CaptureScreenshotFormat, EventScreencastFrame, FrameTree, GetFrameTreeParams,
    GetNavigationHistoryParams, HandleJavaScriptDialogParams, ScreencastFrameAckParams,
    StartScreencastFormat, StartScreencastParams, StopScreencastParams,
};
use chromiumoxide::cdp::browser_protocol::tracing::{
    EndParams as TraceEndParams, EventTracingComplete, StartParams as TraceStartParams,
    StartTransferMode,
};
use chromiumoxide::cdp::js_protocol::runtime::{
    EnableParams as RuntimeEnableParams, EventConsoleApiCalled, EventExceptionThrown,
};
use chromiumoxide::layout::Point;
use chromiumoxide::page::ScreenshotParams;
use chromiumoxide::{Browser, BrowserConfig, Page};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Url;
use tokio::sync::{watch, Mutex, OnceCell};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const MAX_DIAGNOSTIC_ENTRIES: usize = 300;

#[derive(Debug, Clone)]
pub struct ManagedChromeConfig {
    pub executable: PathBuf,
    pub user_data_dir: PathBuf,
    pub headful: bool,
    pub window_width: u32,
    pub window_height: u32,
}

impl ManagedChromeConfig {
    pub fn bundled(
        resource_dir: PathBuf,
        user_data_dir: PathBuf,
    ) -> Result<Self, BrowserRuntimeError> {
        let executable = resource_dir
            .join("browser-runtime")
            .join(bundled_payload_name()?)
            .join("chrome-headless-shell");
        if !executable.is_file() {
            return Err(BrowserRuntimeError::new(
                "browser.runtime-not-bundled",
                format!(
                    "the Maxx browser payload is missing at {}; run script/prepare_browser_runtime.sh before building",
                    executable.display()
                ),
            ));
        }
        Ok(Self {
            executable,
            user_data_dir,
            headful: false,
            window_width: 800,
            window_height: 700,
        })
    }
}

fn bundled_payload_name() -> Result<&'static str, BrowserRuntimeError> {
    #[cfg(target_arch = "aarch64")]
    return Ok("chrome-headless-shell-mac-arm64");
    #[cfg(target_arch = "x86_64")]
    return Ok("chrome-headless-shell-mac-x64");
    #[allow(unreachable_code)]
    Err(BrowserRuntimeError::new(
        "browser.unsupported-platform",
        "the Maxx browser runtime supports Apple Silicon and Intel macOS builds",
    ))
}

#[derive(Default)]
struct ChromeDiagnostics {
    console: Mutex<VecDeque<Value>>,
    network: Mutex<VecDeque<Value>>,
}

struct ChromeTab {
    page: Page,
    diagnostics: Arc<ChromeDiagnostics>,
    generation: u64,
}

struct ChromeFrameStream {
    id: uuid::Uuid,
    cancellation: CancellationToken,
}

pub struct ManagedChromeEngine {
    browser: Mutex<Browser>,
    tabs: Mutex<HashMap<BrowserTabId, ChromeTab>>,
    frame_streams: Mutex<HashMap<BrowserTabId, ChromeFrameStream>>,
    active_trace: Mutex<Option<BrowserTabId>>,
    downloads: Arc<Mutex<HashMap<String, Value>>>,
    download_root: PathBuf,
    _handler: JoinHandle<()>,
    _user_data_dir: PathBuf,
}

/// Starts the managed Chromium reference only when the first browser tab is
/// requested. App startup still brings up the authenticated MCP gateway, while
/// ordinary Maxx sessions pay no Chrome process or window cost.
pub struct LazyManagedChromeEngine {
    config: ManagedChromeConfig,
    engine: OnceCell<Arc<ManagedChromeEngine>>,
}

impl LazyManagedChromeEngine {
    pub fn new(config: ManagedChromeConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            engine: OnceCell::new(),
        })
    }

    async fn engine(&self) -> Result<Arc<ManagedChromeEngine>, BrowserRuntimeError> {
        self.engine
            .get_or_try_init(|| ManagedChromeEngine::launch(self.config.clone()))
            .await
            .cloned()
    }
}

#[async_trait]
impl BrowserEngine for LazyManagedChromeEngine {
    fn name(&self) -> &'static str {
        "chromium_cdp"
    }

    async fn execute(
        &self,
        context: BrowserEngineContext,
        operation: BrowserOperation,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        self.engine().await?.execute(context, operation).await
    }

    async fn interrupt(&self, tab_id: BrowserTabId) {
        if let Some(engine) = self.engine.get() {
            engine.interrupt(tab_id).await;
        }
    }

    async fn start_frame_stream(
        &self,
        tab_id: BrowserTabId,
    ) -> Result<super::BrowserFrameStream, BrowserRuntimeError> {
        self.engine().await?.start_frame_stream(tab_id).await
    }

    async fn stop_frame_stream(&self, tab_id: BrowserTabId, stream_id: uuid::Uuid) {
        if let Some(engine) = self.engine.get() {
            engine.stop_frame_stream(tab_id, stream_id).await;
        }
    }

    async fn human_input(
        &self,
        tab_id: BrowserTabId,
        input: BrowserHumanInput,
    ) -> Result<(), BrowserRuntimeError> {
        self.engine().await?.human_input(tab_id, input).await
    }
}

impl ManagedChromeEngine {
    pub async fn launch(config: ManagedChromeConfig) -> Result<Arc<Self>, BrowserRuntimeError> {
        if !config.executable.is_file() {
            return Err(BrowserRuntimeError::new(
                "browser.chrome-not-found",
                format!(
                    "Chrome executable does not exist at {}",
                    config.executable.display()
                ),
            ));
        }
        std::fs::create_dir_all(&config.user_data_dir).map_err(|error| {
            BrowserRuntimeError::new(
                "browser.chrome-profile",
                format!("could not create the managed Chrome profile: {error}"),
            )
        })?;
        let mut builder = BrowserConfig::builder()
            .chrome_executable(&config.executable)
            .user_data_dir(&config.user_data_dir)
            .window_size(config.window_width, config.window_height)
            .viewport(None)
            .launch_timeout(Duration::from_secs(20))
            .request_timeout(Duration::from_secs(30));
        if config.headful {
            builder = builder.with_head();
        }
        let browser_config = builder.build().map_err(|error| {
            BrowserRuntimeError::new(
                "browser.chrome-config",
                format!("could not configure managed Chrome: {error}"),
            )
        })?;
        let (browser, mut handler) = Browser::launch(browser_config)
            .await
            .map_err(chrome_error)?;
        // chromiumoxide only services commands and subscriptions while its
        // handler stream is polled. Start it before any setup command.
        let handler_task = tokio::spawn(async move {
            while let Some(event) = handler.next().await {
                if let Err(error) = event {
                    log::warn!("managed Chrome handler event failed: {error}");
                }
            }
        });
        let download_root = config.user_data_dir.join("downloads");
        std::fs::create_dir_all(&download_root).map_err(|error| {
            BrowserRuntimeError::new(
                "browser.download-directory",
                format!("could not create the managed download directory: {error}"),
            )
        })?;
        browser
            .execute(
                SetDownloadBehaviorParams::builder()
                    .behavior(SetDownloadBehaviorBehavior::Allow)
                    .download_path(download_root.to_string_lossy().to_string())
                    .events_enabled(true)
                    .build()
                    .map_err(chrome_build_error)?,
            )
            .await
            .map_err(chrome_error)?;
        let downloads = Arc::new(Mutex::new(HashMap::new()));
        install_download_tracking(&browser, downloads.clone()).await?;
        Ok(Arc::new(Self {
            browser: Mutex::new(browser),
            tabs: Mutex::new(HashMap::new()),
            frame_streams: Mutex::new(HashMap::new()),
            active_trace: Mutex::new(None),
            downloads,
            download_root,
            _handler: handler_task,
            _user_data_dir: config.user_data_dir,
        }))
    }

    async fn page(&self, tab_id: BrowserTabId) -> Result<Page, BrowserRuntimeError> {
        self.tabs
            .lock()
            .await
            .get(&tab_id)
            .map(|tab| tab.page.clone())
            .ok_or_else(|| {
                BrowserRuntimeError::new("browser.tab-not-found", "managed Chrome tab not found")
            })
    }

    async fn diagnostics(
        &self,
        tab_id: BrowserTabId,
    ) -> Result<Arc<ChromeDiagnostics>, BrowserRuntimeError> {
        self.tabs
            .lock()
            .await
            .get(&tab_id)
            .map(|tab| tab.diagnostics.clone())
            .ok_or_else(|| {
                BrowserRuntimeError::new("browser.tab-not-found", "managed Chrome tab not found")
            })
    }

    async fn increment_generation(&self, tab_id: BrowserTabId) -> Result<u64, BrowserRuntimeError> {
        let mut tabs = self.tabs.lock().await;
        let tab = tabs.get_mut(&tab_id).ok_or_else(|| {
            BrowserRuntimeError::new("browser.tab-not-found", "managed Chrome tab not found")
        })?;
        tab.generation += 1;
        Ok(tab.generation)
    }

    async fn generation(&self, tab_id: BrowserTabId) -> Result<u64, BrowserRuntimeError> {
        self.tabs
            .lock()
            .await
            .get(&tab_id)
            .map(|tab| tab.generation)
            .ok_or_else(|| {
                BrowserRuntimeError::new("browser.tab-not-found", "managed Chrome tab not found")
            })
    }

    async fn stop_chrome_frame_stream(
        &self,
        tab_id: BrowserTabId,
        expected_id: Option<uuid::Uuid>,
    ) {
        let stream = {
            let mut streams = self.frame_streams.lock().await;
            let matches = streams
                .get(&tab_id)
                .is_some_and(|stream| expected_id.is_none_or(|id| stream.id == id));
            matches.then(|| streams.remove(&tab_id)).flatten()
        };
        let Some(stream) = stream else {
            return;
        };
        stream.cancellation.cancel();
        if let Ok(page) = self.page(tab_id).await {
            let _ = page.execute(StopScreencastParams::default()).await;
        }
    }

    async fn open_tab(
        &self,
        context: &BrowserEngineContext,
        url: Option<String>,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        context.control.ensure_current()?;
        let target = match url {
            Some(url) => validated_url(&url)?,
            None => "about:blank".into(),
        };
        let page = self
            .browser
            .lock()
            .await
            .new_page(target.clone())
            .await
            .map_err(chrome_error)?;
        let diagnostics = Arc::new(ChromeDiagnostics::default());
        install_diagnostics(&page, diagnostics.clone()).await?;
        self.tabs.lock().await.insert(
            context.tab_id,
            ChromeTab {
                page,
                diagnostics,
                generation: u64::from(target != "about:blank"),
            },
        );
        context.control.ensure_current()?;
        Ok(result(
            context,
            json!({"url": target, "engine": "chromium_cdp"}),
        ))
    }

    async fn snapshot(
        &self,
        context: &BrowserEngineContext,
        include_screenshot: bool,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let page = self.page(context.tab_id).await?;
        let mut value = evaluate_json(&page, SNAPSHOT_SCRIPT).await?;
        let diagnostics = self.diagnostics(context.tab_id).await?;
        let console = diagnostics.console.lock().await;
        let network = diagnostics.network.lock().await;
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "observationId".into(),
                Value::String(uuid::Uuid::new_v4().to_string()),
            );
            object.insert(
                "documentGeneration".into(),
                Value::from(self.generation(context.tab_id).await?),
            );
            object.insert("tabId".into(), Value::String(context.tab_id.to_string()));
            object.insert(
                "consoleErrors".into(),
                Value::Array(console.iter().rev().take(20).cloned().collect()),
            );
            object.insert(
                "failedRequests".into(),
                Value::Array(
                    network
                        .iter()
                        .rev()
                        .filter(|entry| entry.get("kind") == Some(&Value::String("failed".into())))
                        .take(20)
                        .cloned()
                        .collect(),
                ),
            );
        }
        drop(console);
        drop(network);
        let mut artifacts = Vec::new();
        if include_screenshot {
            let bytes = page
                .screenshot(
                    ScreenshotParams::builder()
                        .format(CaptureScreenshotFormat::Png)
                        .full_page(false)
                        .build(),
                )
                .await
                .map_err(chrome_error)?;
            let artifact = context.store_artifact(
                &bytes,
                "image/png",
                "png",
                Some("Browser snapshot".into()),
            )?;
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "screenshot".into(),
                    serde_json::to_value(&artifact).map_err(serialization_error)?,
                );
            }
            artifacts.push(artifact);
        }
        Ok(BrowserOperationResult {
            tab_id: Some(context.tab_id),
            control_epoch: context.control.expected_epoch(),
            observation_id: value
                .get("observationId")
                .and_then(Value::as_str)
                .and_then(|value| uuid::Uuid::parse_str(value).ok()),
            value,
            artifacts,
        })
    }

    async fn reference_action(
        &self,
        context: &BrowserEngineContext,
        script: String,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        context.control.ensure_current()?;
        let page = self.page(context.tab_id).await?;
        let value = evaluate_json(&page, script).await?;
        context.control.ensure_current()?;
        ensure_action_ok(&value)?;
        Ok(result(context, value))
    }

    async fn network_entry(
        &self,
        context: &BrowserEngineContext,
        request_id: &str,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let diagnostics = self.diagnostics(context.tab_id).await?;
        let mut value = {
            let network = diagnostics.network.lock().await;
            find_diagnostic(&network, request_id, "browser.network-not-found")?
        };
        let body = self
            .page(context.tab_id)
            .await?
            .execute(GetResponseBodyParams::new(request_id.to_string()))
            .await;
        if let Some(object) = value.as_object_mut() {
            match body {
                Ok(response) => {
                    object.insert("responseBody".into(), Value::String(response.result.body));
                    object.insert(
                        "responseBodyBase64Encoded".into(),
                        Value::Bool(response.result.base64_encoded),
                    );
                }
                Err(error) => {
                    object.insert(
                        "responseBodyUnavailable".into(),
                        Value::String(error.to_string()),
                    );
                }
            }
        }
        Ok(result(context, value))
    }

    async fn trace_start(
        &self,
        context: &BrowserEngineContext,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        context.control.ensure_current()?;
        let mut active = self.active_trace.lock().await;
        if let Some(tab_id) = *active {
            return Err(BrowserRuntimeError::new(
                "browser.trace-active",
                format!("a trace is already active for tab {tab_id}"),
            ));
        }
        self.browser
            .lock()
            .await
            .execute(
                TraceStartParams::builder()
                    .transfer_mode(StartTransferMode::ReturnAsStream)
                    .build(),
            )
            .await
            .map_err(chrome_error)?;
        *active = Some(context.tab_id);
        context.control.ensure_current()?;
        Ok(result(context, json!({"tracing": true})))
    }

    async fn trace_stop(
        &self,
        context: &BrowserEngineContext,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        context.control.ensure_current()?;
        {
            let active = self.active_trace.lock().await;
            match *active {
                Some(tab_id) if tab_id == context.tab_id => {}
                Some(tab_id) => {
                    return Err(BrowserRuntimeError::new(
                        "browser.trace-owned-by-other-tab",
                        format!("the active trace belongs to tab {tab_id}"),
                    ));
                }
                None => {
                    return Err(BrowserRuntimeError::new(
                        "browser.trace-not-active",
                        "no browser trace is active",
                    ));
                }
            }
        }

        let browser = self.browser.lock().await;
        let mut completion = browser
            .event_listener::<EventTracingComplete>()
            .await
            .map_err(chrome_error)?;
        if let Err(error) = browser.execute(TraceEndParams::default()).await {
            *self.active_trace.lock().await = None;
            return Err(chrome_error(error));
        }
        let completed = tokio::time::timeout(Duration::from_secs(30), completion.next())
            .await
            .map_err(|_| {
                BrowserRuntimeError::new("browser.trace-timeout", "trace flush timed out")
            })?
            .ok_or_else(|| {
                BrowserRuntimeError::new("browser.trace-closed", "trace event stream closed")
            })?;
        *self.active_trace.lock().await = None;
        let stream = completed.stream.clone().ok_or_else(|| {
            BrowserRuntimeError::new("browser.trace-empty", "Chrome returned no trace stream")
        })?;
        let mut bytes = Vec::new();
        loop {
            let chunk = browser
                .execute(ReadParams::new(stream.clone()))
                .await
                .map_err(chrome_error)?
                .result;
            if chunk.base64_encoded.unwrap_or(false) {
                bytes.extend(BASE64_STANDARD.decode(chunk.data).map_err(|error| {
                    BrowserRuntimeError::new(
                        "browser.trace-decode",
                        format!("could not decode Chrome trace data: {error}"),
                    )
                })?);
            } else {
                bytes.extend_from_slice(chunk.data.as_bytes());
            }
            if chunk.eof {
                break;
            }
        }
        let _ = browser.execute(CloseParams::new(stream)).await;
        drop(browser);
        context.control.ensure_current()?;
        let artifact = context.store_artifact(
            &bytes,
            "application/json",
            "json",
            Some("Chromium performance trace".into()),
        )?;
        Ok(BrowserOperationResult {
            artifacts: vec![artifact.clone()],
            value: json!({
                "trace": artifact,
                "dataLossOccurred": completed.data_loss_occurred
            }),
            ..result(context, Value::Null)
        })
    }

    async fn downloads(
        &self,
        context: &BrowserEngineContext,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let page = self.page(context.tab_id).await?;
        let tree = page
            .execute(GetFrameTreeParams::default())
            .await
            .map_err(chrome_error)?
            .result
            .frame_tree;
        let mut frame_ids = std::collections::HashSet::new();
        collect_frame_ids(&tree, &mut frame_ids);
        let entries = self.downloads.lock().await;
        let mut values = entries
            .values()
            .filter(|entry| {
                entry
                    .get("frameId")
                    .and_then(Value::as_str)
                    .is_some_and(|frame_id| frame_ids.contains(frame_id))
            })
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| {
            left.get("startedAtMs")
                .and_then(Value::as_u64)
                .cmp(&right.get("startedAtMs").and_then(Value::as_u64))
        });
        drop(entries);

        let mut artifacts = Vec::new();
        for entry in &mut values {
            let completed = entry.get("state").and_then(Value::as_str) == Some("completed");
            let Some(path) = entry.get("filePath").and_then(Value::as_str) else {
                continue;
            };
            if !completed {
                continue;
            }
            let path = PathBuf::from(path);
            if !path.starts_with(&self.download_root) || !path.is_file() {
                continue;
            }
            let bytes = std::fs::read(&path).map_err(|error| {
                BrowserRuntimeError::new(
                    "browser.download-read",
                    format!("could not read completed browser download: {error}"),
                )
            })?;
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin");
            let title = path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string);
            let artifact =
                context.store_artifact(&bytes, "application/octet-stream", extension, title)?;
            if let Some(object) = entry.as_object_mut() {
                object.remove("filePath");
                object.insert(
                    "artifact".into(),
                    serde_json::to_value(&artifact).map_err(serialization_error)?,
                );
            }
            artifacts.push(artifact);
        }
        Ok(BrowserOperationResult {
            value: Value::Array(values),
            artifacts,
            ..result(context, Value::Null)
        })
    }

    async fn storage(
        &self,
        context: &BrowserEngineContext,
        command: &str,
        value: Value,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let page = self.page(context.tab_id).await?;
        match command {
            "cookies_list" => {
                let cookies = page
                    .execute(GetCookiesParams::default())
                    .await
                    .map_err(chrome_error)?
                    .result
                    .cookies;
                Ok(result(
                    context,
                    serde_json::to_value(cookies).map_err(serialization_error)?,
                ))
            }
            "cookie_set" => {
                context.control.ensure_current()?;
                let name = required_string(&value, "name", "cookie_set")?;
                let stored = required_string(&value, "value", "cookie_set")?;
                let url = match value.get("url").and_then(Value::as_str) {
                    Some(url) => validated_url(url)?,
                    None => page.url().await.map_err(chrome_error)?.ok_or_else(|| {
                        BrowserRuntimeError::new(
                            "browser.cookie-url",
                            "the current page has no URL for this cookie",
                        )
                    })?,
                };
                let mut params = SetCookieParams::new(name, stored);
                params.url = Some(url);
                params.path = value
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                params.secure = value.get("secure").and_then(Value::as_bool);
                params.http_only = value.get("httpOnly").and_then(Value::as_bool);
                page.execute(params).await.map_err(chrome_error)?;
                context.control.ensure_current()?;
                Ok(result(context, json!({"ok": true})))
            }
            "cookie_remove" => {
                context.control.ensure_current()?;
                let name = required_string(&value, "name", "cookie_remove")?;
                let url = match value.get("url").and_then(Value::as_str) {
                    Some(url) => validated_url(url)?,
                    None => page.url().await.map_err(chrome_error)?.ok_or_else(|| {
                        BrowserRuntimeError::new(
                            "browser.cookie-url",
                            "the current page has no URL for this cookie",
                        )
                    })?,
                };
                let mut params = DeleteCookiesParams::new(name);
                params.url = Some(url);
                page.execute(params).await.map_err(chrome_error)?;
                context.control.ensure_current()?;
                Ok(result(context, json!({"ok": true})))
            }
            _ => {
                let expression = storage_script(command, value)?;
                let value = evaluate_json(&page, expression).await?;
                Ok(result(context, value))
            }
        }
    }
}

#[async_trait]
impl BrowserEngine for ManagedChromeEngine {
    fn name(&self) -> &'static str {
        "chromium_cdp"
    }

    async fn execute(
        &self,
        context: BrowserEngineContext,
        operation: BrowserOperation,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        match operation {
            BrowserOperation::OpenTab { url } => self.open_tab(&context, url).await,
            BrowserOperation::SelectTab { .. } => {
                context.control.ensure_current()?;
                self.page(context.tab_id)
                    .await?
                    .bring_to_front()
                    .await
                    .map_err(chrome_error)?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"selected": true})))
            }
            BrowserOperation::CloseTab { .. } => {
                context.control.ensure_current()?;
                self.stop_chrome_frame_stream(context.tab_id, None).await;
                let tab = self
                    .tabs
                    .lock()
                    .await
                    .remove(&context.tab_id)
                    .ok_or_else(|| {
                        BrowserRuntimeError::new(
                            "browser.tab-not-found",
                            "managed Chrome tab not found",
                        )
                    })?;
                tab.page.close().await.map_err(chrome_error)?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"closed": true})))
            }
            BrowserOperation::Navigate { url, .. } => {
                context.control.ensure_current()?;
                let target = validated_url(&url)?;
                self.page(context.tab_id)
                    .await?
                    .goto(target.clone())
                    .await
                    .map_err(chrome_error)?;
                self.increment_generation(context.tab_id).await?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"url": target})))
            }
            BrowserOperation::GoBack { .. } => {
                self.reference_action(&context, "history.back(); ({ok:true})".into())
                    .await?;
                self.increment_generation(context.tab_id).await?;
                Ok(result(&context, json!({"navigated": true})))
            }
            BrowserOperation::GoForward { .. } => {
                self.reference_action(&context, "history.forward(); ({ok:true})".into())
                    .await?;
                self.increment_generation(context.tab_id).await?;
                Ok(result(&context, json!({"navigated": true})))
            }
            BrowserOperation::Reload { .. } => {
                context.control.ensure_current()?;
                self.page(context.tab_id)
                    .await?
                    .reload()
                    .await
                    .map_err(chrome_error)?;
                self.increment_generation(context.tab_id).await?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"reloaded": true})))
            }
            BrowserOperation::Snapshot {
                include_screenshot, ..
            } => self.snapshot(&context, include_screenshot).await,
            BrowserOperation::Click { reference, .. } => {
                self.reference_action(&context, reference_script("click", &reference, None))
                    .await
            }
            BrowserOperation::Fill {
                reference, value, ..
            } => {
                self.reference_action(&context, reference_script("fill", &reference, Some(&value)))
                    .await
            }
            BrowserOperation::Press { key, .. } => {
                context.control.ensure_current()?;
                let page = self.page(context.tab_id).await?;
                dispatch_key(&page, &key).await?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"key": key})))
            }
            BrowserOperation::Hover { reference, .. } => {
                let page = self.page(context.tab_id).await?;
                let point = reference_point(&page, &reference).await?;
                context.control.ensure_current()?;
                page.move_mouse(point).await.map_err(chrome_error)?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"reference": reference})))
            }
            BrowserOperation::Scroll {
                delta_x, delta_y, ..
            } => {
                self.reference_action(
                    &context,
                    format!("scrollBy({delta_x}, {delta_y}); ({{ok:true}})"),
                )
                .await
            }
            BrowserOperation::Drag {
                from_reference,
                to_reference,
                ..
            } => {
                self.reference_action(&context, drag_script(&from_reference, &to_reference))
                    .await
            }
            BrowserOperation::Wait {
                condition,
                timeout_ms,
                ..
            } => {
                wait_for_condition(
                    self.page(context.tab_id).await?,
                    &context,
                    condition,
                    timeout_ms,
                )
                .await
            }
            BrowserOperation::Evaluate { expression, .. } => {
                let page = self.page(context.tab_id).await?;
                let value = evaluate_json(&page, expression).await?;
                Ok(result(&context, value))
            }
            BrowserOperation::Screenshot { full_page, .. } => {
                let bytes = self
                    .page(context.tab_id)
                    .await?
                    .screenshot(
                        ScreenshotParams::builder()
                            .format(CaptureScreenshotFormat::Png)
                            .full_page(full_page)
                            .build(),
                    )
                    .await
                    .map_err(chrome_error)?;
                let artifact = context.store_artifact(
                    &bytes,
                    "image/png",
                    "png",
                    Some("Browser screenshot".into()),
                )?;
                Ok(BrowserOperationResult {
                    artifacts: vec![artifact.clone()],
                    value: serde_json::to_value(&artifact).map_err(serialization_error)?,
                    ..result(&context, Value::Null)
                })
            }
            BrowserOperation::ConsoleList { .. } => {
                let diagnostics = self.diagnostics(context.tab_id).await?;
                let console = diagnostics.console.lock().await;
                Ok(result(
                    &context,
                    Value::Array(console.iter().cloned().collect()),
                ))
            }
            BrowserOperation::ConsoleGet { entry_id, .. } => {
                let diagnostics = self.diagnostics(context.tab_id).await?;
                let console = diagnostics.console.lock().await;
                find_diagnostic(&console, &entry_id, "browser.console-not-found")
                    .map(|value| result(&context, value))
            }
            BrowserOperation::NetworkList { .. } => {
                let diagnostics = self.diagnostics(context.tab_id).await?;
                let network = diagnostics.network.lock().await;
                Ok(result(
                    &context,
                    Value::Array(network.iter().cloned().collect()),
                ))
            }
            BrowserOperation::NetworkGet { request_id, .. } => {
                self.network_entry(&context, &request_id).await
            }
            BrowserOperation::TraceStart { .. } => self.trace_start(&context).await,
            BrowserOperation::TraceStop { .. } => self.trace_stop(&context).await,
            BrowserOperation::Resize { width, height, .. } => {
                context.control.ensure_current()?;
                self.page(context.tab_id)
                    .await?
                    .execute(SetDeviceMetricsOverrideParams::new(
                        i64::from(width),
                        i64::from(height),
                        1.0,
                        false,
                    ))
                    .await
                    .map_err(chrome_error)?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"width": width, "height": height})))
            }
            BrowserOperation::Emulate { device, .. } => {
                let (width, height, scale, mobile) = device_metrics(&device)?;
                context.control.ensure_current()?;
                self.page(context.tab_id)
                    .await?
                    .execute(SetDeviceMetricsOverrideParams::new(
                        width, height, scale, mobile,
                    ))
                    .await
                    .map_err(chrome_error)?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"device": device})))
            }
            BrowserOperation::Storage { command, value, .. } => {
                self.storage(&context, &command, value).await
            }
            BrowserOperation::HandleDialog {
                accept,
                prompt_text,
                ..
            } => {
                context.control.ensure_current()?;
                let mut params = HandleJavaScriptDialogParams::new(accept);
                params.prompt_text = prompt_text;
                self.page(context.tab_id)
                    .await?
                    .execute(params)
                    .await
                    .map_err(chrome_error)?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"accepted": accept})))
            }
            BrowserOperation::Upload {
                reference, paths, ..
            } => {
                context.control.ensure_current()?;
                let paths = context.authorize_upload_paths(&paths)?;
                let page = self.page(context.tab_id).await?;
                let expression = format!(
                    "globalThis.__maxxBrowser?.refToElement.get({})",
                    serde_json::to_string(&reference).map_err(serialization_error)?
                );
                let evaluated = page
                    .evaluate_expression(expression)
                    .await
                    .map_err(chrome_error)?;
                let object_id = evaluated
                    .object()
                    .object_id
                    .clone()
                    .ok_or_else(|| stale_reference(&reference))?;
                page.execute(
                    SetFileInputFilesParams::builder()
                        .files(paths.clone())
                        .object_id(object_id)
                        .build()
                        .map_err(chrome_build_error)?,
                )
                .await
                .map_err(chrome_error)?;
                context.control.ensure_current()?;
                Ok(result(&context, json!({"paths": paths})))
            }
            BrowserOperation::Downloads { .. } => self.downloads(&context).await,
            BrowserOperation::Status | BrowserOperation::ListTabs => Err(BrowserRuntimeError::new(
                "browser.invalid-operation",
                "broker-owned operation reached the Chrome engine",
            )),
        }
    }

    async fn interrupt(&self, tab_id: BrowserTabId) {
        if let Ok(page) = self.page(tab_id).await {
            let _ = page.evaluate("window.stop()").await;
        }
    }

    async fn start_frame_stream(
        &self,
        tab_id: BrowserTabId,
    ) -> Result<super::BrowserFrameStream, BrowserRuntimeError> {
        let page = self.page(tab_id).await?;
        self.stop_chrome_frame_stream(tab_id, None).await;
        let mut events = page
            .event_listener::<EventScreencastFrame>()
            .await
            .map_err(chrome_error)?;
        let initial_metadata = rendered_frame_metadata(&page).await?;
        page.execute(
            StartScreencastParams::builder()
                .format(StartScreencastFormat::Jpeg)
                .quality(72)
                .max_width(3840)
                .max_height(2160)
                .every_nth_frame(1)
                .build(),
        )
        .await
        .map_err(chrome_error)?;

        let stream_id = uuid::Uuid::new_v4();
        let cancellation = CancellationToken::new();
        self.frame_streams.lock().await.insert(
            tab_id,
            ChromeFrameStream {
                id: stream_id,
                cancellation: cancellation.clone(),
            },
        );
        let (frames, receiver) = watch::channel(None);
        tokio::spawn(async move {
            let mut frame_metadata = initial_metadata;
            let mut metadata_refreshed_at = Instant::now();
            loop {
                let event = tokio::select! {
                    _ = cancellation.cancelled() => break,
                    event = events.next() => match event {
                        Some(event) => event,
                        None => break,
                    },
                };
                let _ = page
                    .execute(ScreencastFrameAckParams::new(event.session_id))
                    .await;
                if metadata_refreshed_at.elapsed() >= Duration::from_millis(500) {
                    if let Ok(updated) = rendered_frame_metadata(&page).await {
                        frame_metadata = updated;
                    }
                    metadata_refreshed_at = Instant::now();
                }
                let data_base64 = String::from(event.data.clone());
                frames.send_replace(Some(BrowserRenderedFrame {
                    tab_id,
                    url: frame_metadata.url.clone(),
                    title: frame_metadata.title.clone(),
                    loading: frame_metadata.loading,
                    can_go_back: frame_metadata.can_go_back,
                    can_go_forward: frame_metadata.can_go_forward,
                    viewport_width: event.metadata.device_width.max(1.0).round() as u32,
                    viewport_height: event.metadata.device_height.max(1.0).round() as u32,
                    mime_type: "image/jpeg".into(),
                    data_base64,
                }));
            }
        });

        Ok(super::BrowserFrameStream {
            id: stream_id,
            frames: receiver,
        })
    }

    async fn stop_frame_stream(&self, tab_id: BrowserTabId, stream_id: uuid::Uuid) {
        self.stop_chrome_frame_stream(tab_id, Some(stream_id)).await;
    }

    async fn human_input(
        &self,
        tab_id: BrowserTabId,
        input: BrowserHumanInput,
    ) -> Result<(), BrowserRuntimeError> {
        let page = self.page(tab_id).await?;
        page.bring_to_front().await.map_err(chrome_error)?;
        match input {
            BrowserHumanInput::PointerMove { x, y, buttons } => {
                page.execute(
                    DispatchMouseEventParams::builder()
                        .r#type(DispatchMouseEventType::MouseMoved)
                        .x(x)
                        .y(y)
                        .buttons(buttons as i64)
                        .build()
                        .map_err(chrome_build_error)?,
                )
                .await
                .map_err(chrome_error)?;
            }
            BrowserHumanInput::PointerDown { x, y, button } => {
                let button = mouse_button(&button)?;
                page.execute(
                    DispatchMouseEventParams::builder()
                        .r#type(DispatchMouseEventType::MousePressed)
                        .x(x)
                        .y(y)
                        .button(button.clone())
                        .buttons(mouse_button_mask(&button))
                        .click_count(1)
                        .build()
                        .map_err(chrome_build_error)?,
                )
                .await
                .map_err(chrome_error)?;
            }
            BrowserHumanInput::PointerUp { x, y, button } => {
                page.execute(
                    DispatchMouseEventParams::builder()
                        .r#type(DispatchMouseEventType::MouseReleased)
                        .x(x)
                        .y(y)
                        .button(mouse_button(&button)?)
                        .buttons(0)
                        .click_count(1)
                        .build()
                        .map_err(chrome_build_error)?,
                )
                .await
                .map_err(chrome_error)?;
            }
            BrowserHumanInput::Wheel {
                x,
                y,
                delta_x,
                delta_y,
            } => {
                page.execute(
                    DispatchMouseEventParams::builder()
                        .r#type(DispatchMouseEventType::MouseWheel)
                        .x(x)
                        .y(y)
                        .delta_x(delta_x)
                        .delta_y(delta_y)
                        .build()
                        .map_err(chrome_build_error)?,
                )
                .await
                .map_err(chrome_error)?;
            }
            BrowserHumanInput::Key {
                key,
                code,
                modifiers,
                text,
            } => {
                let virtual_key = key_definition(&key).2;
                let mut down = DispatchKeyEventParams::builder()
                    .r#type(DispatchKeyEventType::RawKeyDown)
                    .modifiers(modifiers)
                    .key(key.clone())
                    .code(code.clone())
                    .windows_virtual_key_code(virtual_key);
                if !text.is_empty() {
                    down = down.text(text.clone());
                }
                page.execute(down.build().map_err(chrome_build_error)?)
                    .await
                    .map_err(chrome_error)?;
                page.execute(
                    DispatchKeyEventParams::builder()
                        .r#type(DispatchKeyEventType::KeyUp)
                        .modifiers(modifiers)
                        .key(key)
                        .code(code)
                        .windows_virtual_key_code(virtual_key)
                        .build()
                        .map_err(chrome_build_error)?,
                )
                .await
                .map_err(chrome_error)?;
            }
            BrowserHumanInput::Text { text } => {
                page.execute(InsertTextParams::new(text))
                    .await
                    .map_err(chrome_error)?;
            }
        }
        Ok(())
    }
}

struct RenderedFrameMetadata {
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

async fn rendered_frame_metadata(
    page: &Page,
) -> Result<RenderedFrameMetadata, BrowserRuntimeError> {
    let metadata = evaluate_json(
        page,
        "({url:location.href,title:document.title||location.hostname||'Browser',loading:document.readyState!=='complete'})",
    )
    .await?;
    let history = page
        .execute(GetNavigationHistoryParams::default())
        .await
        .map_err(chrome_error)?
        .result;
    let current = usize::try_from(history.current_index.max(0)).unwrap_or_default();
    Ok(RenderedFrameMetadata {
        url: metadata
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        title: metadata
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Browser")
            .to_string(),
        loading: metadata
            .get("loading")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        can_go_back: current > 0,
        can_go_forward: current + 1 < history.entries.len(),
    })
}

async fn install_diagnostics(
    page: &Page,
    diagnostics: Arc<ChromeDiagnostics>,
) -> Result<(), BrowserRuntimeError> {
    page.execute(RuntimeEnableParams::default())
        .await
        .map_err(chrome_error)?;
    page.execute(NetworkEnableParams::default())
        .await
        .map_err(chrome_error)?;

    let mut console = page
        .event_listener::<EventConsoleApiCalled>()
        .await
        .map_err(chrome_error)?;
    let console_log = diagnostics.clone();
    tokio::spawn(async move {
        while let Some(event) = console.next().await {
            push_diagnostic(&console_log.console, "console", &event).await;
        }
    });
    let mut exceptions = page
        .event_listener::<EventExceptionThrown>()
        .await
        .map_err(chrome_error)?;
    let exception_log = diagnostics.clone();
    tokio::spawn(async move {
        while let Some(event) = exceptions.next().await {
            push_diagnostic(&exception_log.console, "exception", &event).await;
        }
    });
    let mut requests = page
        .event_listener::<EventRequestWillBeSent>()
        .await
        .map_err(chrome_error)?;
    let request_log = diagnostics.clone();
    tokio::spawn(async move {
        while let Some(event) = requests.next().await {
            push_diagnostic(&request_log.network, "request", &event).await;
        }
    });
    let mut responses = page
        .event_listener::<EventResponseReceived>()
        .await
        .map_err(chrome_error)?;
    let response_log = diagnostics.clone();
    tokio::spawn(async move {
        while let Some(event) = responses.next().await {
            push_diagnostic(&response_log.network, "response", &event).await;
        }
    });
    let mut failures = page
        .event_listener::<EventLoadingFailed>()
        .await
        .map_err(chrome_error)?;
    tokio::spawn(async move {
        while let Some(event) = failures.next().await {
            push_diagnostic(&diagnostics.network, "failed", &event).await;
        }
    });
    Ok(())
}

async fn install_download_tracking(
    browser: &Browser,
    downloads: Arc<Mutex<HashMap<String, Value>>>,
) -> Result<(), BrowserRuntimeError> {
    let mut starts = browser
        .event_listener::<EventDownloadWillBegin>()
        .await
        .map_err(chrome_error)?;
    let started_downloads = downloads.clone();
    tokio::spawn(async move {
        while let Some(event) = starts.next().await {
            started_downloads.lock().await.insert(
                event.guid.clone(),
                json!({
                    "guid": event.guid,
                    "frameId": event.frame_id.as_ref(),
                    "url": event.url,
                    "suggestedFilename": event.suggested_filename,
                    "state": "inProgress",
                    "receivedBytes": 0,
                    "totalBytes": 0,
                    "startedAtMs": system_time_ms()
                }),
            );
        }
    });

    let mut progress = browser
        .event_listener::<EventDownloadProgress>()
        .await
        .map_err(chrome_error)?;
    tokio::spawn(async move {
        while let Some(event) = progress.next().await {
            let mut downloads = downloads.lock().await;
            let entry = downloads
                .entry(event.guid.clone())
                .or_insert_with(|| json!({"guid": event.guid}));
            if let Some(object) = entry.as_object_mut() {
                object.insert("state".into(), Value::String(event.state.as_ref().into()));
                object.insert("receivedBytes".into(), Value::from(event.received_bytes));
                object.insert("totalBytes".into(), Value::from(event.total_bytes));
                if let Some(path) = &event.file_path {
                    object.insert("filePath".into(), Value::String(path.clone()));
                }
            }
        }
    });
    Ok(())
}

fn collect_frame_ids(tree: &FrameTree, ids: &mut std::collections::HashSet<String>) {
    ids.insert(tree.frame.id.as_ref().to_string());
    if let Some(children) = &tree.child_frames {
        for child in children {
            collect_frame_ids(child, ids);
        }
    }
}

fn system_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn push_diagnostic<T: Serialize>(buffer: &Mutex<VecDeque<Value>>, kind: &str, event: &T) {
    let mut value = serde_json::to_value(event).unwrap_or(Value::Null);
    redact_json(&mut value);
    if let Some(object) = value.as_object_mut() {
        object.insert("kind".into(), Value::String(kind.into()));
        let id = object
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        object.insert("id".into(), Value::String(id));
    }
    let mut buffer = buffer.lock().await;
    buffer.push_back(value);
    while buffer.len() > MAX_DIAGNOSTIC_ENTRIES {
        buffer.pop_front();
    }
}

fn redact_json(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.to_ascii_lowercase().as_str(),
                    "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
                ) {
                    *value = Value::String("[REDACTED]".into());
                } else {
                    redact_json(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact_json),
        _ => {}
    }
}

async fn evaluate_json(
    page: &Page,
    expression: impl Into<String>,
) -> Result<Value, BrowserRuntimeError> {
    page.evaluate_expression(expression.into())
        .await
        .map_err(chrome_error)?
        .into_value::<Value>()
        .map_err(|error| {
            BrowserRuntimeError::new(
                "browser.javascript-result",
                format!("page result was not JSON-serializable: {error}"),
            )
        })
}

fn result(context: &BrowserEngineContext, value: Value) -> BrowserOperationResult {
    BrowserOperationResult {
        tab_id: Some(context.tab_id),
        control_epoch: context.control.expected_epoch(),
        observation_id: None,
        value,
        artifacts: Vec::new(),
    }
}

fn validated_url(url: &str) -> Result<String, BrowserRuntimeError> {
    let parsed = Url::parse(url).map_err(|error| {
        BrowserRuntimeError::new(
            "browser.invalid-url",
            format!("invalid browser URL: {error}"),
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(BrowserRuntimeError::new(
            "browser.invalid-url",
            "browser navigation accepts only absolute HTTP or HTTPS URLs",
        ));
    }
    Ok(parsed.to_string())
}

fn reference_script(action: &str, reference: &str, value: Option<&str>) -> String {
    let reference = serde_json::to_string(reference).expect("reference serialization");
    let value = serde_json::to_string(value.unwrap_or_default()).expect("value serialization");
    match action {
        "click" => format!(
            r#"(() => {{
                const el = globalThis.__maxxBrowser?.refToElement.get({reference});
                if (!el || !el.isConnected) return {{ok:false,error:"stale"}};
                el.scrollIntoView({{block:"center",inline:"center"}});
                el.click();
                return {{ok:true}};
            }})()"#
        ),
        "fill" => format!(
            r#"(() => {{
                const el = globalThis.__maxxBrowser?.refToElement.get({reference});
                if (!el || !el.isConnected) return {{ok:false,error:"stale"}};
                el.focus();
                const view = el.ownerDocument.defaultView;
                if (el.isContentEditable) {{
                    el.textContent = {value};
                }} else {{
                    const proto = el instanceof view.HTMLSelectElement
                        ? view.HTMLSelectElement.prototype
                        : el instanceof view.HTMLTextAreaElement
                            ? view.HTMLTextAreaElement.prototype
                            : view.HTMLInputElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                    if (setter) setter.call(el, {value}); else el.value = {value};
                }}
                const Input = view.InputEvent || InputEvent;
                el.dispatchEvent(new Input("input", {{bubbles:true,inputType:"insertText",data:{value}}}));
                el.dispatchEvent(new view.Event("change", {{bubbles:true}}));
                return {{ok:true,value:"value" in el ? el.value : el.textContent}};
            }})()"#
        ),
        _ => "({ok:false,error:'unknown-action'})".into(),
    }
}

fn drag_script(from: &str, to: &str) -> String {
    let from = serde_json::to_string(from).expect("reference serialization");
    let to = serde_json::to_string(to).expect("reference serialization");
    format!(
        r#"(() => {{
            const source = globalThis.__maxxBrowser?.refToElement.get({from});
            const target = globalThis.__maxxBrowser?.refToElement.get({to});
            if (!source?.isConnected || !target?.isConnected) return {{ok:false,error:"stale"}};
            const data = new DataTransfer();
            for (const type of ["dragstart","dragenter","dragover","drop","dragend"]) {{
                const node = type === "dragstart" || type === "dragend" ? source : target;
                node.dispatchEvent(new DragEvent(type, {{bubbles:true,cancelable:true,dataTransfer:data}}));
            }}
            return {{ok:true}};
        }})()"#
    )
}

async fn reference_point(page: &Page, reference: &str) -> Result<Point, BrowserRuntimeError> {
    let reference = serde_json::to_string(reference).map_err(serialization_error)?;
    let value = evaluate_json(
        page,
        format!(
            r#"(() => {{
                const el = globalThis.__maxxBrowser?.refToElement.get({reference});
                if (!el?.isConnected) return null;
                const r = el.getBoundingClientRect();
                let x = r.left + r.width / 2;
                let y = r.top + r.height / 2;
                let view = el.ownerDocument.defaultView;
                while (view?.frameElement) {{
                    const frame = view.frameElement.getBoundingClientRect();
                    x += frame.left;
                    y += frame.top;
                    view = view.parent;
                }}
                return {{x,y}};
            }})()"#
        ),
    )
    .await?;
    let x = value
        .get("x")
        .and_then(Value::as_f64)
        .ok_or_else(|| stale_reference(reference.trim_matches('"')))?;
    let y = value
        .get("y")
        .and_then(Value::as_f64)
        .ok_or_else(|| stale_reference(reference.trim_matches('"')))?;
    Ok(Point::new(x, y))
}

fn ensure_action_ok(value: &Value) -> Result<(), BrowserRuntimeError> {
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        if value.get("error").and_then(Value::as_str) == Some("stale") {
            return Err(BrowserRuntimeError::new(
                "browser.stale-reference",
                "element reference is stale; request a fresh browser_snapshot",
            ));
        }
        return Err(BrowserRuntimeError::new(
            "browser.action-failed",
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("browser action failed"),
        ));
    }
    Ok(())
}

fn stale_reference(reference: &str) -> BrowserRuntimeError {
    BrowserRuntimeError::new(
        "browser.stale-reference",
        format!("element reference {reference} is stale; request a fresh browser_snapshot"),
    )
}

async fn dispatch_key(page: &Page, shortcut: &str) -> Result<(), BrowserRuntimeError> {
    let mut modifiers = 0_i64;
    let mut key = "";
    for part in shortcut.split('+') {
        match part.trim().to_ascii_lowercase().as_str() {
            "alt" | "option" => modifiers |= 1,
            "ctrl" | "control" => modifiers |= 2,
            "meta" | "cmd" | "command" => modifiers |= 4,
            "shift" => modifiers |= 8,
            _ => key = part.trim(),
        }
    }
    if key.is_empty() {
        return Err(BrowserRuntimeError::new(
            "browser.invalid-key",
            "keyboard shortcut must include a non-modifier key",
        ));
    }
    let (dom_key, code, virtual_key) = key_definition(key);
    let down = DispatchKeyEventParams::builder()
        .r#type(DispatchKeyEventType::RawKeyDown)
        .modifiers(modifiers)
        .key(dom_key)
        .code(code)
        .windows_virtual_key_code(virtual_key)
        .build()
        .map_err(chrome_build_error)?;
    page.execute(down).await.map_err(chrome_error)?;
    if modifiers == 0 && dom_key.chars().count() == 1 {
        let character = DispatchKeyEventParams::builder()
            .r#type(DispatchKeyEventType::Char)
            .text(dom_key)
            .key(dom_key)
            .build()
            .map_err(chrome_build_error)?;
        page.execute(character).await.map_err(chrome_error)?;
    }
    let up = DispatchKeyEventParams::builder()
        .r#type(DispatchKeyEventType::KeyUp)
        .modifiers(modifiers)
        .key(dom_key)
        .code(code)
        .windows_virtual_key_code(virtual_key)
        .build()
        .map_err(chrome_build_error)?;
    page.execute(up).await.map_err(chrome_error)?;
    Ok(())
}

fn key_definition(key: &str) -> (&str, &str, i64) {
    match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => ("Enter", "Enter", 13),
        "tab" => ("Tab", "Tab", 9),
        "escape" | "esc" => ("Escape", "Escape", 27),
        "backspace" => ("Backspace", "Backspace", 8),
        "delete" => ("Delete", "Delete", 46),
        "arrowup" | "up" => ("ArrowUp", "ArrowUp", 38),
        "arrowdown" | "down" => ("ArrowDown", "ArrowDown", 40),
        "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft", 37),
        "arrowright" | "right" => ("ArrowRight", "ArrowRight", 39),
        _ => (key, key, key.chars().next().map(|c| c as i64).unwrap_or(0)),
    }
}

fn mouse_button(value: &str) -> Result<MouseButton, BrowserRuntimeError> {
    match value.to_ascii_lowercase().as_str() {
        "left" | "primary" => Ok(MouseButton::Left),
        "middle" | "auxiliary" => Ok(MouseButton::Middle),
        "right" | "secondary" => Ok(MouseButton::Right),
        "back" => Ok(MouseButton::Back),
        "forward" => Ok(MouseButton::Forward),
        _ => Err(BrowserRuntimeError::new(
            "browser.invalid-mouse-button",
            "mouse button must be left, middle, right, back, or forward",
        )),
    }
}

fn mouse_button_mask(button: &MouseButton) -> i64 {
    match button {
        MouseButton::Left => 1,
        MouseButton::Right => 2,
        MouseButton::Middle => 4,
        MouseButton::Back => 8,
        MouseButton::Forward => 16,
        MouseButton::None => 0,
    }
}

async fn wait_for_condition(
    page: Page,
    context: &BrowserEngineContext,
    condition: String,
    timeout_ms: u64,
) -> Result<BrowserOperationResult, BrowserRuntimeError> {
    let timeout = Duration::from_millis(timeout_ms.min(60_000));
    let started = Instant::now();
    loop {
        context.control.ensure_current()?;
        let matched = if let Some(text) = condition.strip_prefix("text:") {
            let text = serde_json::to_string(text).map_err(serialization_error)?;
            evaluate_json(
                &page,
                format!("document.body?.innerText.includes({text}) ?? false"),
            )
            .await?
            .as_bool()
            .unwrap_or(false)
        } else {
            evaluate_json(&page, format!("Boolean({condition})"))
                .await?
                .as_bool()
                .unwrap_or(false)
        };
        if matched {
            return Ok(result(context, json!({"matched": true})));
        }
        if started.elapsed() >= timeout {
            return Err(BrowserRuntimeError::new(
                "browser.wait-timeout",
                format!(
                    "browser condition did not match within {} ms",
                    timeout.as_millis()
                ),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn storage_script(command: &str, value: Value) -> Result<String, BrowserRuntimeError> {
    match command {
        "list" => {
            Ok("({localStorage:{...localStorage},sessionStorage:{...sessionStorage}})".into())
        }
        "clear" => Ok("localStorage.clear(); sessionStorage.clear(); ({ok:true})".into()),
        "set" => {
            let area = value.get("area").and_then(Value::as_str).unwrap_or("local");
            let key = value.get("key").and_then(Value::as_str).ok_or_else(|| {
                BrowserRuntimeError::new(
                    "browser.invalid-storage",
                    "storage set requires value.key",
                )
            })?;
            let stored = value
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let target = if area == "session" {
                "sessionStorage"
            } else {
                "localStorage"
            };
            Ok(format!(
                "{target}.setItem({}, {}); ({{ok:true}})",
                serde_json::to_string(key).map_err(serialization_error)?,
                serde_json::to_string(stored).map_err(serialization_error)?
            ))
        }
        "remove" => {
            let key = value.get("key").and_then(Value::as_str).ok_or_else(|| {
                BrowserRuntimeError::new(
                    "browser.invalid-storage",
                    "storage remove requires value.key",
                )
            })?;
            Ok(format!(
                "localStorage.removeItem({}); sessionStorage.removeItem({}); ({{ok:true}})",
                serde_json::to_string(key).map_err(serialization_error)?,
                serde_json::to_string(key).map_err(serialization_error)?
            ))
        }
        _ => Err(BrowserRuntimeError::new(
            "browser.invalid-storage",
            "storage command must be list, clear, set, remove, cookies_list, cookie_set, or cookie_remove",
        )),
    }
}

fn required_string<'a>(
    value: &'a Value,
    field: &str,
    command: &str,
) -> Result<&'a str, BrowserRuntimeError> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        BrowserRuntimeError::new(
            "browser.invalid-storage",
            format!("storage {command} requires value.{field}"),
        )
    })
}

fn device_metrics(device: &str) -> Result<(i64, i64, f64, bool), BrowserRuntimeError> {
    match device.to_ascii_lowercase().as_str() {
        "iphone 15" | "iphone" => Ok((393, 852, 3.0, true)),
        "pixel 8" | "pixel" | "android" => Ok((412, 915, 2.625, true)),
        "ipad" | "tablet" => Ok((820, 1180, 2.0, true)),
        "desktop" => Ok((1280, 800, 1.0, false)),
        _ => Err(BrowserRuntimeError::new(
            "browser.unknown-device",
            "device must be iPhone 15, Pixel 8, iPad, or Desktop",
        )),
    }
}

fn find_diagnostic(
    entries: &VecDeque<Value>,
    id: &str,
    code: &str,
) -> Result<Value, BrowserRuntimeError> {
    entries
        .iter()
        .rev()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        .cloned()
        .ok_or_else(|| BrowserRuntimeError::new(code, format!("diagnostic entry {id} not found")))
}

fn chrome_error(error: impl std::fmt::Display) -> BrowserRuntimeError {
    BrowserRuntimeError::new("browser.chrome", error.to_string())
}

fn chrome_build_error(error: impl std::fmt::Display) -> BrowserRuntimeError {
    BrowserRuntimeError::new("browser.chrome-command", error.to_string())
}

fn serialization_error(error: impl std::fmt::Display) -> BrowserRuntimeError {
    BrowserRuntimeError::new("browser.serialization", error.to_string())
}

const SNAPSHOT_SCRIPT: &str = r#"
(() => {
  const state = globalThis.__maxxBrowser ??= {
    next: 1,
    refToElement: new Map(),
    elementToRef: new WeakMap()
  };
  const referenceFor = (element) => {
    let reference = state.elementToRef.get(element);
    if (!reference) {
      reference = `e${state.next++}`;
      state.elementToRef.set(element, reference);
      state.refToElement.set(reference, element);
    }
    return reference;
  };
  const visible = (element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const roleFor = (element) => {
    if (element.getAttribute("role")) return element.getAttribute("role");
    if (element.tagName === "INPUT") return ({
      button: "button", submit: "button", reset: "button", checkbox: "checkbox",
      radio: "radio", range: "slider", number: "spinbutton", search: "searchbox"
    })[element.type] || "textbox";
    return ({ A: "link", BUTTON: "button", TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button" })[element.tagName]
      || element.tagName.toLowerCase();
  };
  const nameFor = (element) => {
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/).filter(Boolean)
      .map((id) => element.ownerDocument.getElementById(id)?.innerText || "")
      .join(" ").trim();
    return labelledBy || element.getAttribute("aria-label") || element.getAttribute("title")
      || element.labels?.[0]?.innerText || element.innerText
      || element.getAttribute("placeholder") || element.getAttribute("alt") || "";
  };
  const selector = [
    "a[href]", "button", "input", "textarea", "select", "summary",
    "[role]", "[contenteditable=true]", "[tabindex]"
  ].join(",");
  const elements = [];
  const text = [];
  const visit = (root) => {
    if (!root || elements.length >= 500) return;
    const documentForRoot = root.nodeType === Node.DOCUMENT_NODE ? root : root.ownerDocument;
    const textNode = root.nodeType === Node.DOCUMENT_NODE ? root.body : root;
    if (textNode?.innerText) text.push(textNode.innerText);
    else if (root instanceof ShadowRoot && root.textContent) text.push(root.textContent);
    for (const element of root.querySelectorAll("*")) {
      if (elements.length < 500 && element.matches(selector) && visible(element)) {
        elements.push({
          reference: referenceFor(element),
          role: roleFor(element),
          name: nameFor(element).trim().slice(0, 500) || null,
          value: "value" in element ? String(element.value).slice(0, 1000)
            : element.isContentEditable ? String(element.textContent || "").slice(0, 1000) : null,
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
          focused: element === documentForRoot.activeElement
        });
      }
      if (element.shadowRoot) visit(element.shadowRoot);
      if (element.tagName === "IFRAME") {
        try { visit(element.contentDocument); } catch (_) { /* cross-origin frames remain isolated */ }
      }
      if (elements.length >= 500) break;
    }
  };
  visit(document);
  return {
    url: location.href,
    title: document.title || location.hostname || "Browser",
    loading: document.readyState !== "complete",
    viewport: {
      width: innerWidth,
      height: innerHeight,
      deviceScaleFactor: devicePixelRatio,
      mobile: matchMedia("(pointer: coarse)").matches
    },
    focusedElement: document.activeElement && document.activeElement !== document.body
      ? referenceFor(document.activeElement) : null,
    visibleText: text.join("\n").slice(0, 30000),
    elements
  };
})()
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_runtime::{
        AuthenticatedBrowserSession, BrowserArtifactStore, BrowserBroker, BrowserCapability,
        BrowserSessionScope,
    };
    use maxx_core::contract::ChatProvider;
    use std::collections::HashSet;

    #[test]
    fn navigation_and_device_inputs_fail_closed() {
        assert!(validated_url("https://example.com").is_ok());
        assert!(validated_url("javascript:alert(1)").is_err());
        assert!(validated_url("file:///etc/passwd").is_err());
        assert!(device_metrics("iPhone 15").is_ok());
        assert!(device_metrics("unknown").is_err());
    }

    #[test]
    fn diagnostics_redact_sensitive_headers_recursively() {
        let mut value = json!({
            "headers": {
                "Authorization": "Bearer secret",
                "Cookie": "session=secret",
                "Accept": "application/json"
            }
        });
        redact_json(&mut value);
        assert_eq!(value["headers"]["Authorization"], "[REDACTED]");
        assert_eq!(value["headers"]["Cookie"], "[REDACTED]");
        assert_eq!(value["headers"]["Accept"], "application/json");
    }

    #[tokio::test]
    #[ignore = "launches the bundled Chrome Headless Shell application"]
    async fn live_chrome_snapshot_reference_action_and_artifact() {
        let run_id = uuid::Uuid::new_v4();
        let runtime_root = std::env::temp_dir().join(format!("maxx-browser-live-{run_id}"));
        let config = ManagedChromeConfig::bundled(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            runtime_root.join("profile"),
        )
        .expect("bundled browser config");
        let engine = ManagedChromeEngine::launch(config)
            .await
            .expect("launch managed Chrome");
        eprintln!("live browser: launched");
        let artifacts = Arc::new(
            BrowserArtifactStore::new(runtime_root.join("artifacts")).expect("artifact store"),
        );
        let broker = BrowserBroker::new(engine, artifacts);
        let mut session = AuthenticatedBrowserSession {
            session_id: uuid::Uuid::new_v4(),
            scope: BrowserSessionScope {
                project_id: uuid::Uuid::new_v4(),
                thread_id: uuid::Uuid::new_v4(),
                provider: ChatProvider::Codex,
                provider_instance_id: uuid::Uuid::new_v4(),
                provider_session_id: None,
                agent_id: None,
                capabilities: BrowserCapability::ALL.into_iter().collect::<HashSet<_>>(),
                assigned_tabs: HashSet::new(),
                file_roots: vec![runtime_root.clone()],
            },
        };

        let opened = broker
            .execute(&session, BrowserOperation::OpenTab { url: None })
            .await
            .expect("open tab");
        let tab_id = opened.tab_id.expect("tab id");
        eprintln!("live browser: tab opened");
        session.scope.assigned_tabs.insert(tab_id);
        broker
            .execute(&session, BrowserOperation::TraceStart { tab_id })
            .await
            .expect("start trace");
        eprintln!("live browser: trace started");
        broker
            .execute(
                &session,
                BrowserOperation::Evaluate {
                    tab_id,
                    expression: r#"(() => {
                        document.body.innerHTML = '<button id="run">Run live test</button>';
                        document.querySelector('#run').addEventListener('click', () => {
                            document.body.dataset.clicked = 'yes';
                        });
                        return {ready: true};
                    })()"#
                        .into(),
                },
            )
            .await
            .expect("install fixture");
        let snapshot = broker
            .execute(
                &session,
                BrowserOperation::Snapshot {
                    tab_id,
                    include_screenshot: true,
                },
            )
            .await
            .expect("snapshot");
        let reference = snapshot.value["elements"]
            .as_array()
            .expect("snapshot elements")
            .iter()
            .find(|element| element["name"] == "Run live test")
            .and_then(|element| element["reference"].as_str())
            .expect("button reference")
            .to_string();
        assert_eq!(snapshot.artifacts.len(), 1);
        eprintln!("live browser: snapshot captured");

        let mut frame_stream = broker
            .start_frame_stream(tab_id)
            .await
            .expect("start shared frame stream");
        let frame = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                frame_stream
                    .frames
                    .changed()
                    .await
                    .expect("frame stream remains open");
                if let Some(frame) = frame_stream.frames.borrow_and_update().clone() {
                    break frame;
                }
            }
        })
        .await
        .expect("shared frame arrives");
        assert_eq!(frame.tab_id, tab_id);
        assert!(frame.viewport_width > 0 && frame.viewport_height > 0);
        assert!(!frame.data_base64.is_empty());
        broker.stop_frame_stream(tab_id, frame_stream.id).await;
        eprintln!("live browser: shared frame rendered");

        broker
            .execute(&session, BrowserOperation::Click { tab_id, reference })
            .await
            .expect("click by semantic reference");
        let clicked = broker
            .execute(
                &session,
                BrowserOperation::Evaluate {
                    tab_id,
                    expression: "document.body.dataset.clicked".into(),
                },
            )
            .await
            .expect("read clicked state");
        assert_eq!(clicked.value, "yes");
        eprintln!("live browser: semantic action verified");

        let trace = broker
            .execute(&session, BrowserOperation::TraceStop { tab_id })
            .await
            .expect("stop trace");
        assert_eq!(trace.artifacts.len(), 1);
        assert!(trace.artifacts[0].byte_length > 0);
        eprintln!("live browser: trace stored");

        broker
            .execute(
                &session,
                BrowserOperation::Evaluate {
                    tab_id,
                    expression: r#"(() => {
                        const link = document.createElement('a');
                        link.href = URL.createObjectURL(new Blob(['maxx download proof'], {type:'text/plain'}));
                        link.download = 'maxx-browser-proof.txt';
                        document.body.append(link);
                        link.click();
                        return {started:true};
                    })()"#
                        .into(),
                },
            )
            .await
            .expect("start download");
        eprintln!("live browser: download started");
        let mut completed_download = None;
        for _ in 0..50 {
            let downloads = broker
                .execute(&session, BrowserOperation::Downloads { tab_id })
                .await
                .expect("list downloads");
            completed_download = downloads
                .value
                .as_array()
                .and_then(|entries| entries.iter().find(|entry| entry["state"] == "completed"))
                .cloned();
            if completed_download.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(
            completed_download
                .as_ref()
                .and_then(|entry| entry["suggestedFilename"].as_str()),
            Some("maxx-browser-proof.txt")
        );
        eprintln!("live browser: download verified");
    }
}
