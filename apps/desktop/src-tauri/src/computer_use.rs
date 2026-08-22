//! Maxx-owned Computer Use lifecycle and authenticated MCP gateway.
//!
//! Electron owns the macOS permission identity and embedded Cua daemon. This
//! module exposes that daemon to every provider through the same ephemeral HTTP
//! MCP contract already used by Maxx Browser, while enforcing the user's
//! capability settings before requests reach Cua.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{AUTHORIZATION, HOST, ORIGIN};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use maxx_core::{ChatProvider, ComputerUseSettings};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::host::HostBridge;
use crate::host_tools::HostToolAccess;
use crate::state::AppState;

const MCP_PATH: &str = "/mcp";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUsePermissions {
    pub accessibility: bool,
    pub screen_recording: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseStatus {
    pub supported: bool,
    pub enabled: bool,
    pub running: bool,
    pub permissions: ComputerUsePermissions,
    pub driver_version: Option<String>,
    pub message: Option<String>,
}

impl ComputerUseStatus {
    fn unavailable(enabled: bool, message: impl Into<String>) -> Self {
        Self {
            supported: cfg!(target_os = "macos"),
            enabled,
            running: false,
            permissions: ComputerUsePermissions {
                accessibility: false,
                screen_recording: false,
            },
            driver_version: None,
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriverMcpLaunch {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    environment: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriverStartResult {
    ready: bool,
    status: ComputerUseStatus,
    mcp: Option<DriverMcpLaunch>,
}

pub struct ComputerUseService {
    host: Arc<dyn HostBridge>,
    settings: Arc<RwLock<ComputerUseSettings>>,
    launch: Mutex<Option<DriverMcpLaunch>>,
    gateway: Arc<ComputerGateway>,
}

impl ComputerUseService {
    pub async fn start(
        host: Arc<dyn HostBridge>,
        settings: ComputerUseSettings,
    ) -> Result<Arc<Self>, String> {
        let settings = Arc::new(RwLock::new(settings));
        let gateway = ComputerGateway::start(settings.clone()).await?;
        Ok(Arc::new(Self {
            host,
            settings,
            launch: Mutex::new(None),
            gateway,
        }))
    }

    pub fn settings(&self) -> ComputerUseSettings {
        self.settings
            .read()
            .expect("computer use settings lock poisoned")
            .clone()
    }

    pub async fn configure(
        &self,
        mut settings: ComputerUseSettings,
        request_permissions: bool,
    ) -> Result<ComputerUseSettings, String> {
        settings.normalize();
        self.gateway.revoke_all().await;
        *self.launch.lock().await = None;
        let _ = self.host.request("computer.stop", Value::Null).await;
        *self
            .settings
            .write()
            .expect("computer use settings lock poisoned") = settings.clone();
        if settings.enabled {
            let _ = self.ensure_launch(request_permissions).await?;
        }
        Ok(settings)
    }

    pub async fn status(&self) -> ComputerUseStatus {
        let enabled = self.settings().enabled;
        match self
            .host
            .request("computer.status", json!({ "enabled": enabled }))
            .await
        {
            Ok(value) => serde_json::from_value(value).unwrap_or_else(|error| {
                ComputerUseStatus::unavailable(enabled, format!("Invalid Cua status: {error}"))
            }),
            Err(error) => ComputerUseStatus::unavailable(enabled, error.to_string()),
        }
    }

    pub async fn open_settings(&self) -> Result<ComputerUseStatus, String> {
        let value = self
            .host
            .request("computer.open-settings", Value::Null)
            .await
            .map_err(|error| error.to_string())?;
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    async fn ensure_launch(
        &self,
        request_permissions: bool,
    ) -> Result<Option<DriverMcpLaunch>, String> {
        if let Some(launch) = self.launch.lock().await.clone() {
            return Ok(Some(launch));
        }
        let settings = self.settings();
        if !settings.enabled {
            return Ok(None);
        }
        let value = self
            .host
            .request(
                "computer.start",
                json!({
                    "requestPermissions": request_permissions,
                    "settings": settings,
                }),
            )
            .await
            .map_err(|error| error.to_string())?;
        let result: DriverStartResult = serde_json::from_value(value)
            .map_err(|error| format!("Invalid Cua launch: {error}"))?;
        if !result.ready {
            log::warn!(
                "computer use is enabled but unavailable: {}",
                result
                    .status
                    .message
                    .as_deref()
                    .unwrap_or("permissions are required")
            );
            return Ok(None);
        }
        let launch = result
            .mcp
            .ok_or_else(|| "Cua started without an MCP launch descriptor".to_string())?;
        *self.launch.lock().await = Some(launch.clone());
        Ok(Some(launch))
    }

    pub async fn access_for(
        &self,
        provider: ChatProvider,
        provider_instance_id: Uuid,
        thread_id: Uuid,
    ) -> Result<Option<Arc<HostToolAccess>>, String> {
        let settings = self.settings();
        if !settings.provider_enabled(provider) {
            return Ok(None);
        }
        let Some(launch) = self.ensure_launch(false).await? else {
            return Ok(None);
        };
        Ok(Some(Arc::new(
            self.gateway
                .issue(provider_instance_id, thread_id, launch)
                .await,
        )))
    }

    pub async fn revoke_thread(&self, thread_id: Uuid) {
        self.gateway.revoke_thread(thread_id).await;
    }

    pub async fn shutdown(&self) {
        self.gateway.revoke_all().await;
        *self.launch.lock().await = None;
        let _ = self.host.request("computer.stop", Value::Null).await;
    }
}

pub async fn update_computer_use_settings(
    state: Arc<AppState>,
    settings: ComputerUseSettings,
) -> Result<ComputerUseSettings, String> {
    let service = state
        .runtime
        .computer_use_service()
        .ok_or("Computer Use is not initialized")?;
    let settings = service.configure(settings, true).await?;
    {
        let mut workspace = state.workspace.lock().await;
        workspace.computer_use = settings.clone();
    }
    state.save().await;
    state.runtime.reload_host_tools().await;
    state.terminals.shutdown().await;
    Ok(settings)
}

pub async fn computer_use_status(state: Arc<AppState>) -> Result<ComputerUseStatus, String> {
    let service = state
        .runtime
        .computer_use_service()
        .ok_or("Computer Use is not initialized")?;
    Ok(service.status().await)
}

pub async fn computer_use_open_settings(state: Arc<AppState>) -> Result<ComputerUseStatus, String> {
    let service = state
        .runtime
        .computer_use_service()
        .ok_or("Computer Use is not initialized")?;
    service.open_settings().await
}

struct ComputerGateway {
    endpoint: String,
    sessions: Arc<Mutex<HashMap<String, GatewaySession>>>,
    cancellation: CancellationToken,
}

struct GatewaySession {
    provider_instance_id: Uuid,
    thread_id: Uuid,
    process: Arc<Mutex<CuaMcpProcess>>,
}

#[derive(Clone)]
struct GatewayState {
    sessions: Arc<Mutex<HashMap<String, GatewaySession>>>,
    settings: Arc<RwLock<ComputerUseSettings>>,
    allowed_hosts: HashSet<String>,
}

impl ComputerGateway {
    async fn start(settings: Arc<RwLock<ComputerUseSettings>>) -> Result<Arc<Self>, String> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("Could not bind Computer Use gateway: {error}"))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let allowed_hosts = [address.to_string(), format!("localhost:{}", address.port())]
            .into_iter()
            .collect::<HashSet<_>>();
        let state = GatewayState {
            sessions: sessions.clone(),
            settings,
            allowed_hosts: allowed_hosts.clone(),
        };
        let cancellation = CancellationToken::new();
        let shutdown = cancellation.clone();
        tokio::spawn(async move {
            let router = Router::new()
                .route(MCP_PATH, any(handle_mcp))
                .with_state(state);
            if let Err(error) = axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.cancelled_owned().await })
                .await
            {
                log::error!("Computer Use MCP gateway stopped: {error}");
            }
        });
        Ok(Arc::new(Self {
            endpoint: format!("http://{address}{MCP_PATH}"),
            sessions,
            cancellation,
        }))
    }

    async fn issue(
        &self,
        provider_instance_id: Uuid,
        thread_id: Uuid,
        launch: DriverMcpLaunch,
    ) -> HostToolAccess {
        if let Some((token, _)) = self
            .sessions
            .lock()
            .await
            .iter()
            .find(|(_, session)| {
                session.provider_instance_id == provider_instance_id
                    && session.thread_id == thread_id
            })
            .map(|(token, session)| (token.clone(), session.process.clone()))
        {
            return HostToolAccess::new("maxx_computer", self.endpoint.clone(), token);
        }
        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = URL_SAFE_NO_PAD.encode(bytes);
        self.sessions.lock().await.insert(
            token.clone(),
            GatewaySession {
                provider_instance_id,
                thread_id,
                process: Arc::new(Mutex::new(CuaMcpProcess::new(launch))),
            },
        );
        HostToolAccess::new("maxx_computer", self.endpoint.clone(), token)
    }

    async fn revoke_thread(&self, thread_id: Uuid) {
        self.sessions
            .lock()
            .await
            .retain(|_, session| session.thread_id != thread_id);
    }

    async fn revoke_all(&self) {
        self.sessions.lock().await.clear();
    }
}

impl Drop for ComputerGateway {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

async fn handle_mcp(State(state): State<GatewayState>, request: Request<Body>) -> Response {
    let host = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok());
    if !host.is_some_and(|host| state.allowed_hosts.contains(host)) {
        return (StatusCode::FORBIDDEN, "Computer Use gateway rejected Host").into_response();
    }
    if request.headers().contains_key(ORIGIN) {
        return (
            StatusCode::FORBIDDEN,
            "Computer Use gateway rejects web origins",
        )
            .into_response();
    }
    let token = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    let session = {
        let sessions = state.sessions.lock().await;
        sessions.get(&token).map(|session| session.process.clone())
    };
    let Some(session) = session else {
        return (StatusCode::UNAUTHORIZED, "Invalid Computer Use credential").into_response();
    };
    if request.method() == Method::DELETE {
        state.sessions.lock().await.remove(&token);
        return StatusCode::NO_CONTENT.into_response();
    }
    if request.method() != Method::POST {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let bytes = match axum::body::to_bytes(request.into_body(), 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    let message: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    let settings = state
        .settings
        .read()
        .expect("computer use settings lock poisoned")
        .clone();
    if let Some(error) = blocked_call(&message, &settings) {
        return json_rpc_error(&message, -32601, error);
    }
    let forwarded = session.lock().await.forward(message.clone()).await;
    match forwarded {
        Ok(None) => StatusCode::ACCEPTED.into_response(),
        Ok(Some(mut response)) => {
            if message.get("method").and_then(Value::as_str) == Some("tools/list") {
                filter_tools(&mut response, &settings);
            }
            let mut http = axum::Json(response).into_response();
            http.headers_mut().insert(
                "mcp-session-id",
                HeaderValue::from_str(&token).unwrap_or_else(|_| HeaderValue::from_static("maxx")),
            );
            http
        }
        Err(error) => json_rpc_error(&message, -32603, error),
    }
}

fn json_rpc_error(request: &Value, code: i64, message: String) -> Response {
    axum::Json(json!({
        "jsonrpc": "2.0",
        "id": request.get("id").cloned().unwrap_or(Value::Null),
        "error": { "code": code, "message": message },
    }))
    .into_response()
}

fn blocked_call(message: &Value, settings: &ComputerUseSettings) -> Option<String> {
    if message.get("method").and_then(Value::as_str) != Some("tools/call") {
        return None;
    }
    let params = message.get("params")?;
    let name = params.get("name")?.as_str()?;
    let arguments = params.get("arguments").unwrap_or(&Value::Null);
    if tool_allowed(name, settings) {
        if !settings.foreground_control
            && params
                .get("arguments")
                .and_then(|value| value.get("delivery_mode"))
                .and_then(Value::as_str)
                == Some("foreground")
        {
            return Some("Foreground delivery is disabled in Maxx Settings.".into());
        }
        if requests_existing_browser_profile(name, arguments) && !settings.existing_browser_profiles
        {
            return Some(
                "Attaching to existing browser profiles is disabled in Maxx Settings.".into(),
            );
        }
        return None;
    }
    Some(format!("{name} is disabled in Maxx Computer Use settings."))
}

fn filter_tools(response: &mut Value, settings: &ComputerUseSettings) {
    if let Some(tools) = response
        .get_mut("result")
        .and_then(|result| result.get_mut("tools"))
        .and_then(Value::as_array_mut)
    {
        tools.retain(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| tool_allowed(name, settings))
        });
    }
}

fn tool_allowed(name: &str, settings: &ComputerUseSettings) -> bool {
    match tool_capability(name) {
        ToolCapability::Core => true,
        ToolCapability::LaunchApplications => settings.launch_applications,
        ToolCapability::ForegroundControl => settings.foreground_control,
        ToolCapability::Clipboard => settings.clipboard,
        ToolCapability::BrowserAutomation => settings.browser_automation,
        ToolCapability::BrowserFileTransfer => {
            settings.browser_automation && settings.browser_file_transfer
        }
        ToolCapability::TrajectoryRecording => settings.trajectory_recording,
        ToolCapability::TrajectoryReplay => settings.trajectory_replay,
        ToolCapability::ProcessTermination => settings.process_termination,
        ToolCapability::Hidden | ToolCapability::Unknown => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolCapability {
    Core,
    LaunchApplications,
    ForegroundControl,
    Clipboard,
    BrowserAutomation,
    BrowserFileTransfer,
    TrajectoryRecording,
    TrajectoryReplay,
    ProcessTermination,
    Hidden,
    Unknown,
}

fn tool_capability(name: &str) -> ToolCapability {
    match name {
        "list_apps"
        | "list_windows"
        | "get_window_state"
        | "verify_state"
        | "set_window_frame"
        | "invoke_menu"
        | "click"
        | "double_click"
        | "right_click"
        | "drag"
        | "type_text"
        | "press_key"
        | "hotkey"
        | "set_value"
        | "scroll"
        | "get_screen_size"
        | "get_desktop_state"
        | "get_cursor_position"
        | "move_cursor"
        | "set_agent_cursor_enabled"
        | "set_agent_cursor_motion"
        | "set_agent_cursor_theme"
        | "get_agent_cursor_state"
        | "health_report"
        | "get_config"
        | "get_accessibility_tree"
        | "zoom"
        | "start_session"
        | "get_session"
        | "list_sessions"
        | "end_session" => ToolCapability::Core,
        "launch_app" => ToolCapability::LaunchApplications,
        "bring_to_front" => ToolCapability::ForegroundControl,
        "clipboard_read" | "clipboard_write" => ToolCapability::Clipboard,
        "get_browser_state" | "browser_prepare" | "browser_navigate" | "browser_click"
        | "browser_type" | "browser_dialog" | "browser_pointer" => {
            ToolCapability::BrowserAutomation
        }
        "browser_set_input_files" | "browser_download" => ToolCapability::BrowserFileTransfer,
        "start_recording" | "stop_recording" | "get_recording_state" => {
            ToolCapability::TrajectoryRecording
        }
        "replay_trajectory" => ToolCapability::TrajectoryReplay,
        "kill_app" => ToolCapability::ProcessTermination,
        "check_permissions" | "set_config" | "page" | "install_ffmpeg" | "escalate_session"
        | "get_session_state" | "check_for_update" => ToolCapability::Hidden,
        _ => ToolCapability::Unknown,
    }
}

fn requests_existing_browser_profile(name: &str, arguments: &Value) -> bool {
    match name {
        "browser_prepare" => {
            arguments.get("pid").is_some_and(|value| !value.is_null())
                || arguments
                    .get("strategy")
                    .and_then(|value| value.get("kind"))
                    .and_then(Value::as_str)
                    == Some("existing_profile")
        }
        "get_browser_state" => arguments.get("pid").is_some_and(|value| !value.is_null()),
        _ => false,
    }
}

struct CuaMcpProcess {
    launch: DriverMcpLaunch,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<BufReader<ChildStdout>>,
}

impl CuaMcpProcess {
    fn new(launch: DriverMcpLaunch) -> Self {
        Self {
            launch,
            child: None,
            stdin: None,
            stdout: None,
        }
    }

    async fn ensure_started(&mut self) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }
        let mut command = Command::new(&self.launch.command);
        command
            .args(&self.launch.args)
            .envs(&self.launch.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start Cua MCP: {error}"))?;
        self.stdin = child.stdin.take();
        self.stdout = child.stdout.take().map(BufReader::new);
        self.child = Some(child);
        Ok(())
    }

    async fn forward(&mut self, message: Value) -> Result<Option<Value>, String> {
        self.ensure_started().await?;
        let mut serialized = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        serialized.push(b'\n');
        self.stdin
            .as_mut()
            .ok_or_else(|| "Cua MCP stdin is unavailable".to_string())?
            .write_all(&serialized)
            .await
            .map_err(|error| format!("Could not write to Cua MCP: {error}"))?;
        self.stdin
            .as_mut()
            .unwrap()
            .flush()
            .await
            .map_err(|error| error.to_string())?;
        let Some(expected_id) = message.get("id").cloned() else {
            return Ok(None);
        };
        let stdout = self
            .stdout
            .as_mut()
            .ok_or_else(|| "Cua MCP stdout is unavailable".to_string())?;
        loop {
            let mut line = String::new();
            let read = stdout
                .read_line(&mut line)
                .await
                .map_err(|error| format!("Could not read Cua MCP: {error}"))?;
            if read == 0 {
                return Err("Cua MCP stopped before responding".into());
            }
            let response: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if response.get("id") == Some(&expected_id) {
                return Ok(Some(response));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CUA_DRIVER_0_21_TOOLS: &[&str] = &[
        "list_apps",
        "list_windows",
        "get_window_state",
        "verify_state",
        "launch_app",
        "kill_app",
        "bring_to_front",
        "set_window_frame",
        "invoke_menu",
        "click",
        "double_click",
        "right_click",
        "drag",
        "type_text",
        "press_key",
        "hotkey",
        "set_value",
        "scroll",
        "clipboard_read",
        "clipboard_write",
        "get_screen_size",
        "get_desktop_state",
        "get_cursor_position",
        "move_cursor",
        "set_agent_cursor_enabled",
        "set_agent_cursor_motion",
        "set_agent_cursor_theme",
        "get_agent_cursor_state",
        "check_permissions",
        "health_report",
        "get_config",
        "set_config",
        "get_accessibility_tree",
        "zoom",
        "page",
        "get_browser_state",
        "browser_prepare",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_dialog",
        "browser_set_input_files",
        "browser_download",
        "browser_pointer",
        "start_recording",
        "stop_recording",
        "get_recording_state",
        "replay_trajectory",
        "install_ffmpeg",
        "start_session",
        "escalate_session",
        "get_session",
        "list_sessions",
        "get_session_state",
        "end_session",
        "check_for_update",
    ];

    #[test]
    fn smart_defaults_keep_core_control_and_hide_sensitive_tools() {
        let settings = ComputerUseSettings::default();
        assert!(tool_allowed("click", &settings));
        assert!(tool_allowed("type_text", &settings));
        assert!(tool_allowed("launch_app", &settings));
        assert!(!tool_allowed("kill_app", &settings));
        assert!(!tool_allowed("clipboard_read", &settings));
        assert!(!tool_allowed("get_browser_state", &settings));
        assert!(!tool_allowed("check_for_update", &settings));
        assert!(!tool_allowed("future_unreviewed_tool", &settings));
    }

    #[test]
    fn pinned_cua_inventory_is_complete_and_explicitly_classified() {
        assert_eq!(CUA_DRIVER_0_21_TOOLS.len(), 56);
        assert_eq!(
            CUA_DRIVER_0_21_TOOLS
                .iter()
                .copied()
                .collect::<HashSet<_>>()
                .len(),
            CUA_DRIVER_0_21_TOOLS.len()
        );
        for name in CUA_DRIVER_0_21_TOOLS {
            assert_ne!(tool_capability(name), ToolCapability::Unknown, "{name}");
        }
    }

    #[test]
    fn optional_capabilities_map_to_the_exact_cua_tool_names() {
        let settings = ComputerUseSettings {
            clipboard: true,
            browser_automation: true,
            browser_file_transfer: true,
            trajectory_recording: true,
            trajectory_replay: true,
            process_termination: true,
            existing_browser_profiles: true,
            ..Default::default()
        };
        assert!(tool_allowed("clipboard_read", &settings));
        assert!(tool_allowed("clipboard_write", &settings));
        assert!(tool_allowed("browser_navigate", &settings));
        assert!(tool_allowed("browser_set_input_files", &settings));
        assert!(tool_allowed("get_recording_state", &settings));
        assert!(tool_allowed("replay_trajectory", &settings));
        assert!(tool_allowed("kill_app", &settings));
        assert!(!tool_allowed("page", &settings));
        assert!(!tool_allowed("set_config", &settings));
    }

    #[test]
    fn existing_profile_detection_does_not_block_isolated_browser_launches() {
        assert!(!requests_existing_browser_profile(
            "browser_prepare",
            &json!({ "allow_launch": true, "strategy": { "kind": "isolated_new" } })
        ));
        assert!(requests_existing_browser_profile(
            "browser_prepare",
            &json!({ "pid": 42, "strategy": { "kind": "existing_profile" } })
        ));
        assert!(requests_existing_browser_profile(
            "get_browser_state",
            &json!({ "pid": 42 })
        ));
    }
}
