use super::{
    AuthenticatedBrowserSession, BrowserArtifactStore, BrowserBroker, BrowserCapability,
    BrowserCredential, BrowserEngine, BrowserOperation, BrowserOperationResult,
    BrowserRuntimeError, BrowserSessionRegistry, BrowserSessionScope, BrowserUiReveal,
};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{AUTHORIZATION, HOST, ORIGIN};
use axum::http::{request::Parts, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use maxx_core::contract::ChatProvider;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, Implementation, ListToolsResult,
    PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResult, ResourceContents,
    ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MCP_PATH: &str = "/mcp";

#[derive(Clone)]
pub struct BrowserProviderAccess {
    pub session_id: Uuid,
    pub endpoint: String,
    pub bearer_token: String,
}

impl fmt::Debug for BrowserProviderAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrowserProviderAccess")
            .field("session_id", &self.session_id)
            .field("endpoint", &self.endpoint)
            .field("bearer_token", &"[REDACTED]")
            .finish()
    }
}

pub struct BrowserRuntime {
    pub sessions: Arc<BrowserSessionRegistry>,
    pub broker: Arc<BrowserBroker>,
    pub artifacts: Arc<BrowserArtifactStore>,
    provider_access: Mutex<HashMap<(Uuid, Uuid), Arc<BrowserProviderAccess>>>,
    human_session: AsyncMutex<AuthenticatedBrowserSession>,
    ui_reveals: broadcast::Sender<BrowserUiReveal>,
    gateway: BrowserGateway,
}

impl BrowserRuntime {
    pub async fn start(
        engine: Arc<dyn BrowserEngine>,
        artifact_root: PathBuf,
    ) -> Result<Arc<Self>, BrowserRuntimeError> {
        let sessions = Arc::new(BrowserSessionRegistry::default());
        let artifacts = Arc::new(BrowserArtifactStore::new(artifact_root)?);
        let broker = Arc::new(BrowserBroker::new(engine, artifacts.clone()));
        let (ui_reveals, _) = broadcast::channel(32);
        let gateway = BrowserGateway::start(
            sessions.clone(),
            broker.clone(),
            artifacts.clone(),
            ui_reveals.clone(),
        )
        .await?;
        Ok(Arc::new(Self {
            sessions,
            broker,
            artifacts,
            provider_access: Mutex::new(HashMap::new()),
            human_session: AsyncMutex::new(AuthenticatedBrowserSession {
                session_id: Uuid::new_v4(),
                scope: BrowserSessionScope::full_access(
                    Uuid::nil(),
                    Uuid::nil(),
                    ChatProvider::Codex,
                    Uuid::nil(),
                ),
            }),
            ui_reveals,
            gateway,
        }))
    }

    pub fn issue_provider_access(&self, scope: BrowserSessionScope) -> BrowserProviderAccess {
        let BrowserCredential {
            session_id,
            bearer_token,
        } = self.sessions.issue(scope);
        BrowserProviderAccess {
            session_id,
            endpoint: self.gateway.endpoint().to_string(),
            bearer_token,
        }
    }

    /// Returns the one in-memory credential owned by a provider-native
    /// `(instance, thread)` session. The secret is never serialized, logged, or
    /// persisted; provider adapters pass it to their child through environment
    /// or protocol-native headers.
    pub fn access_for_scope(&self, scope: BrowserSessionScope) -> Arc<BrowserProviderAccess> {
        let key = (scope.provider_instance_id, scope.thread_id);
        let mut access = self
            .provider_access
            .lock()
            .expect("browser provider access mutex poisoned");
        access
            .entry(key)
            .or_insert_with(|| Arc::new(self.issue_provider_access(scope)))
            .clone()
    }

    pub fn bind_provider_session(
        &self,
        provider_instance_id: Uuid,
        thread_id: Uuid,
        provider_session_id: String,
    ) -> bool {
        let session_id = self
            .provider_access
            .lock()
            .expect("browser provider access mutex poisoned")
            .get(&(provider_instance_id, thread_id))
            .map(|access| access.session_id);
        session_id.is_some_and(|session_id| {
            self.sessions
                .bind_provider_session(session_id, provider_session_id)
        })
    }

    pub async fn revoke_thread(&self, thread_id: Uuid) -> usize {
        let tabs = self.sessions.tabs_for_thread(thread_id);
        self.provider_access
            .lock()
            .expect("browser provider access mutex poisoned")
            .retain(|(_, candidate_thread), _| *candidate_thread != thread_id);
        let revoked = self.sessions.revoke_thread(thread_id);
        for tab_id in tabs {
            let _ = self
                .human_execute(BrowserOperation::CloseTab { tab_id })
                .await;
        }
        revoked
    }

    /// Invalidates both running and already-queued mutations for a cancelled
    /// turn without destroying the thread's persistent browser tabs.
    pub async fn interrupt_thread(&self, thread_id: Uuid) {
        for tab_id in self.sessions.tabs_for_thread(thread_id) {
            let _ = self.broker.human_input(tab_id).await;
        }
    }

    pub fn revoke_provider_instance(&self, provider_instance_id: Uuid) -> usize {
        self.provider_access
            .lock()
            .expect("browser provider access mutex poisoned")
            .retain(|(candidate_provider, _), _| *candidate_provider != provider_instance_id);
        self.sessions.revoke_provider_instance(provider_instance_id)
    }

    pub fn endpoint(&self) -> &str {
        self.gateway.endpoint()
    }

    pub fn subscribe_ui_reveals(&self) -> broadcast::Receiver<BrowserUiReveal> {
        self.ui_reveals.subscribe()
    }

    pub async fn human_open_tab(
        &self,
        thread_id: Uuid,
        url: Option<String>,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let session = self.human_session.lock().await.clone();
        let result = self
            .broker
            .execute(&session, BrowserOperation::OpenTab { url })
            .await?;
        if let Some(tab_id) = result.tab_id {
            self.human_session
                .lock()
                .await
                .scope
                .assigned_tabs
                .insert(tab_id);
            self.sessions.assign_tab_to_thread(thread_id, tab_id);
            self.broker.release_to_human(tab_id).await;
        }
        Ok(result)
    }

    pub async fn human_execute(
        &self,
        operation: BrowserOperation,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        let tab_id = operation.target_tab();
        if let Some(tab_id) = tab_id {
            self.human_session
                .lock()
                .await
                .scope
                .assigned_tabs
                .insert(tab_id);
            if operation.is_mutating() {
                self.broker.human_input(tab_id).await?;
            }
        }
        let session = self.human_session.lock().await.clone();
        let close = matches!(operation, BrowserOperation::CloseTab { .. });
        let result = self.broker.execute(&session, operation).await?;
        if let Some(tab_id) = result.tab_id {
            self.broker.release_to_human(tab_id).await;
        }
        if close {
            if let Some(tab_id) = result.tab_id {
                self.human_session
                    .lock()
                    .await
                    .scope
                    .assigned_tabs
                    .remove(&tab_id);
                self.sessions.remove_tab(tab_id);
            }
        }
        Ok(result)
    }
}

struct BrowserGateway {
    endpoint: String,
    cancellation: CancellationToken,
    _server: JoinHandle<()>,
}

impl BrowserGateway {
    async fn start(
        sessions: Arc<BrowserSessionRegistry>,
        broker: Arc<BrowserBroker>,
        artifacts: Arc<BrowserArtifactStore>,
        ui_reveals: broadcast::Sender<BrowserUiReveal>,
    ) -> Result<Self, BrowserRuntimeError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| {
                BrowserRuntimeError::new(
                    "browser.gateway-bind",
                    format!("could not bind browser MCP gateway: {error}"),
                )
            })?;
        let address = listener.local_addr().map_err(|error| {
            BrowserRuntimeError::new(
                "browser.gateway-bind",
                format!("could not inspect browser MCP gateway address: {error}"),
            )
        })?;
        let cancellation = CancellationToken::new();
        let mcp_service: StreamableHttpService<BrowserMcpServer, LocalSessionManager> =
            StreamableHttpService::new(
                {
                    let sessions = sessions.clone();
                    let broker = broker.clone();
                    let artifacts = artifacts.clone();
                    move || {
                        Ok(BrowserMcpServer {
                            sessions: sessions.clone(),
                            broker: broker.clone(),
                            artifacts: artifacts.clone(),
                            ui_reveals: ui_reveals.clone(),
                        })
                    }
                },
                Default::default(),
                StreamableHttpServerConfig {
                    stateful_mode: true,
                    cancellation_token: cancellation.child_token(),
                    ..Default::default()
                },
            );
        let auth = GatewayAuthState {
            sessions,
            allowed_hosts: [address.to_string(), format!("localhost:{}", address.port())]
                .into_iter()
                .collect(),
        };
        let router = Router::new()
            .nest_service(MCP_PATH, mcp_service)
            .layer(middleware::from_fn_with_state(auth, authorize_request));
        let shutdown = cancellation.clone();
        let server = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.cancelled_owned().await })
                .await
            {
                log::error!("browser MCP gateway stopped: {error}");
            }
        });
        Ok(Self {
            endpoint: format!("http://{address}{MCP_PATH}"),
            cancellation,
            _server: server,
        })
    }

    fn endpoint(&self) -> &str {
        &self.endpoint
    }
}

impl Drop for BrowserGateway {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[derive(Clone)]
struct GatewayAuthState {
    sessions: Arc<BrowserSessionRegistry>,
    allowed_hosts: HashSet<String>,
}

async fn authorize_request(
    State(state): State<GatewayAuthState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok());
    if !host.is_some_and(|host| state.allowed_hosts.contains(host)) {
        return (StatusCode::FORBIDDEN, "browser gateway rejected Host").into_response();
    }
    // Native provider clients do not send Origin. Refusing all browser-origin
    // requests prevents a hostile page from driving the loopback MCP endpoint.
    if request.headers().contains_key(ORIGIN) {
        return (StatusCode::FORBIDDEN, "browser gateway rejects web origins").into_response();
    }
    let authorization = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let session = match state.sessions.authenticate_any(authorization) {
        Ok(session) => session,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                "browser gateway authorization failed",
            )
                .into_response();
        }
    };
    request.extensions_mut().insert(session);
    next.run(request).await
}

#[derive(Clone)]
struct BrowserMcpServer {
    sessions: Arc<BrowserSessionRegistry>,
    broker: Arc<BrowserBroker>,
    artifacts: Arc<BrowserArtifactStore>,
    ui_reveals: broadcast::Sender<BrowserUiReveal>,
}

impl ServerHandler for BrowserMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
            server_info: Implementation {
                name: "maxx_browser".into(),
                title: Some("Maxx Browser".into()),
                version: env!("CARGO_PKG_VERSION").into(),
                description: Some("Shared visible browser and developer tools for Maxx agents".into()),
                icons: None,
                website_url: None,
            },
            instructions: Some(
                "These tools control the visible, built-in Maxx browser. Reuse known assigned tabs. To open a requested URL, call browser_open_tab directly; it selects and reveals the new tab. Call browser_status, browser_list_tabs, or browser_select_tab only when their information or behavior is actually needed. Do not search for a Maxx CLI, use a terminal browser skill, or control an external browser. Observe before acting; prefer semantic element references, with coordinates only as a fallback. Human input interrupts agent control.".into(),
            ),
            ..Default::default()
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let session = session_from_context(&context)?;
        let tools = TOOL_SPECS
            .iter()
            .filter(|spec| session.scope.capabilities.contains(&spec.capability))
            .map(tool_from_spec)
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        TOOL_SPECS
            .iter()
            .find(|spec| spec.name == name)
            .map(tool_from_spec)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let session = session_from_context(&context)?;
        let operation = operation_from_call(&request.name, request.arguments)?;
        let selected_tab = operation.target_tab();
        let reveal = matches!(
            operation,
            BrowserOperation::OpenTab { .. } | BrowserOperation::SelectTab { .. }
        );
        match self.broker.execute(&session, operation).await {
            Ok(result) => {
                if request.name == "browser_open_tab" {
                    if let Some(tab_id) = result.tab_id {
                        if let Err(error) = self.sessions.assign_tab(session.session_id, tab_id) {
                            return Ok(runtime_error_result(error));
                        }
                    }
                }
                if request.name == "browser_close_tab" {
                    if let Some(tab_id) = result.tab_id {
                        self.sessions.remove_tab(tab_id);
                    }
                }
                if reveal {
                    if let Some(tab_id) = result.tab_id.or(selected_tab) {
                        let _ = self.ui_reveals.send(BrowserUiReveal {
                            thread_id: session.scope.thread_id,
                            tab_id,
                        });
                    }
                }
                Ok(
                    match browser_call_tool_result(&self.artifacts, &session, &result) {
                        Ok(result) => result,
                        Err(error) => runtime_error_result(error),
                    },
                )
            }
            Err(error) => Ok(runtime_error_result(error)),
        }
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        let session = session_from_context(&context)?;
        if !session
            .scope
            .capabilities
            .contains(&BrowserCapability::Observe)
        {
            return Err(McpError::invalid_params(
                "browser session does not grant artifact observation",
                None,
            ));
        }
        let id = request
            .uri
            .strip_prefix("maxx-browser://artifact/")
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| McpError::invalid_params("invalid browser artifact URI", None))?;
        let (reference, bytes, _sha256) = self
            .artifacts
            .read(id, session.session_id, &session.scope.assigned_tabs)
            .map_err(|error| McpError::invalid_params(error.to_string(), None))?;
        Ok(ReadResourceResult {
            contents: vec![ResourceContents::BlobResourceContents {
                uri: reference.uri,
                mime_type: Some(reference.mime_type),
                blob: STANDARD.encode(bytes),
                meta: None,
            }],
        })
    }
}

fn session_from_context(
    context: &RequestContext<RoleServer>,
) -> Result<AuthenticatedBrowserSession, McpError> {
    let parts = context.extensions.get::<Parts>().ok_or_else(|| {
        McpError::internal_error("browser gateway request context is missing", None)
    })?;
    parts
        .extensions
        .get::<AuthenticatedBrowserSession>()
        .cloned()
        .ok_or_else(|| McpError::internal_error("browser session identity is missing", None))
}

fn operation_from_call(
    name: &str,
    arguments: Option<Map<String, Value>>,
) -> Result<BrowserOperation, McpError> {
    if !TOOL_SPECS.iter().any(|spec| spec.name == name) {
        return Err(McpError::invalid_params(
            format!("unknown browser tool {name}"),
            None,
        ));
    }
    let operation_name = name
        .strip_prefix("browser_")
        .expect("tool catalog only contains browser tools");
    let mut value = arguments.unwrap_or_default();
    value.insert("operation".into(), Value::String(operation_name.into()));
    serde_json::from_value(Value::Object(value)).map_err(|error| {
        McpError::invalid_params(format!("invalid arguments for {name}: {error}"), None)
    })
}

fn runtime_error_result(error: BrowserRuntimeError) -> CallToolResult {
    CallToolResult::structured_error(json!({
        "code": error.code,
        "message": error.message,
    }))
}

fn browser_call_tool_result(
    artifacts: &BrowserArtifactStore,
    session: &AuthenticatedBrowserSession,
    result: &BrowserOperationResult,
) -> Result<CallToolResult, BrowserRuntimeError> {
    let value = serde_json::to_value(result).map_err(|error| {
        BrowserRuntimeError::new(
            "browser.serialization",
            format!("could not serialize browser operation result: {error}"),
        )
    })?;
    let mut content = vec![Content::text(value.to_string())];
    for artifact in &result.artifacts {
        if !artifact.mime_type.starts_with("image/") {
            continue;
        }
        let (_, bytes, _) = artifacts.read(
            artifact.id,
            session.session_id,
            &session.scope.assigned_tabs,
        )?;
        content.push(Content::image(
            STANDARD.encode(bytes),
            artifact.mime_type.clone(),
        ));
    }
    Ok(CallToolResult {
        content,
        structured_content: None,
        is_error: Some(false),
        meta: None,
    })
}

#[derive(Clone, Copy)]
struct ToolSpec {
    name: &'static str,
    description: &'static str,
    capability: BrowserCapability,
    read_only: bool,
    destructive: bool,
}

const TOOL_SPECS: &[ToolSpec] = &[
    spec("browser_status", "Report the browser engine and tabs assigned to this agent session.", BrowserCapability::Observe, true, false),
    spec("browser_list_tabs", "List tabs assigned to this agent session.", BrowserCapability::Observe, true, false),
    spec("browser_open_tab", "Open, select, and reveal a new isolated browser tab assigned to this agent session.", BrowserCapability::Navigate, false, false),
    spec("browser_select_tab", "Reveal an assigned browser tab in Maxx.", BrowserCapability::Navigate, false, false),
    spec("browser_close_tab", "Close an assigned browser tab.", BrowserCapability::Navigate, false, true),
    spec("browser_navigate", "Navigate an assigned tab to an HTTP or HTTPS URL.", BrowserCapability::Navigate, false, true),
    spec("browser_go_back", "Go back in an assigned tab's history.", BrowserCapability::Navigate, false, true),
    spec("browser_go_forward", "Go forward in an assigned tab's history.", BrowserCapability::Navigate, false, true),
    spec("browser_reload", "Reload an assigned browser tab.", BrowserCapability::Navigate, false, true),
    spec("browser_snapshot", "Observe page state, visible text, accessibility elements, console errors, and failed requests.", BrowserCapability::Observe, true, false),
    spec("browser_click", "Click an element from the latest semantic snapshot.", BrowserCapability::Interact, false, true),
    spec("browser_fill", "Replace the value of an editable element.", BrowserCapability::Interact, false, true),
    spec("browser_press", "Send a keyboard key or shortcut to the page.", BrowserCapability::Interact, false, true),
    spec("browser_hover", "Hover an element from the latest semantic snapshot.", BrowserCapability::Interact, false, false),
    spec("browser_scroll", "Scroll the assigned browser tab.", BrowserCapability::Interact, false, false),
    spec("browser_drag", "Drag one referenced element onto another.", BrowserCapability::Interact, false, true),
    spec("browser_wait", "Wait for a page condition without polling in model context.", BrowserCapability::Interact, true, false),
    spec("browser_evaluate", "Evaluate JavaScript in the assigned page and return a JSON result.", BrowserCapability::Evaluate, false, true),
    spec("browser_screenshot", "Capture the assigned browser tab and return the image directly to the model and Maxx conversation.", BrowserCapability::Observe, true, false),
    spec("browser_console_list", "List buffered browser console entries.", BrowserCapability::Debug, true, false),
    spec("browser_console_get", "Read one console entry including source and stack.", BrowserCapability::Debug, true, false),
    spec("browser_network_list", "List buffered browser network requests and failures.", BrowserCapability::Debug, true, false),
    spec("browser_network_get", "Read one redacted network request and response.", BrowserCapability::Debug, true, false),
    spec("browser_trace_start", "Start a browser performance trace.", BrowserCapability::Trace, false, false),
    spec("browser_trace_stop", "Stop a performance trace and return an artifact URI.", BrowserCapability::Trace, false, false),
    spec("browser_resize", "Resize the tab viewport.", BrowserCapability::Emulate, false, false),
    spec("browser_emulate", "Apply a named browser device emulation profile.", BrowserCapability::Emulate, false, false),
    spec("browser_storage", "Read or modify storage in the assigned tab.", BrowserCapability::Storage, false, true),
    spec("browser_handle_dialog", "Accept or dismiss the page's pending dialog.", BrowserCapability::Interact, false, true),
    spec("browser_upload", "Attach approved project files to a referenced file input.", BrowserCapability::Files, false, true),
    spec("browser_downloads", "List downloads owned by the assigned tab.", BrowserCapability::Files, true, false),
];

const fn spec(
    name: &'static str,
    description: &'static str,
    capability: BrowserCapability,
    read_only: bool,
    destructive: bool,
) -> ToolSpec {
    ToolSpec {
        name,
        description,
        capability,
        read_only,
        destructive,
    }
}

fn tool_from_spec(spec: &ToolSpec) -> Tool {
    Tool::new(spec.name, spec.description, input_schema(spec.name)).annotate(
        ToolAnnotations::new()
            .read_only(spec.read_only)
            .destructive(spec.destructive)
            .open_world(true),
    )
}

fn input_schema(name: &str) -> Map<String, Value> {
    let (properties, required): (Map<String, Value>, Vec<&str>) = match name {
        "browser_status" | "browser_list_tabs" => (Map::new(), vec![]),
        "browser_open_tab" => (properties(&[("url", string_schema())]), vec![]),
        "browser_select_tab"
        | "browser_close_tab"
        | "browser_go_back"
        | "browser_go_forward"
        | "browser_reload"
        | "browser_console_list"
        | "browser_network_list"
        | "browser_trace_start"
        | "browser_trace_stop"
        | "browser_downloads" => (tab_properties(), vec!["tabId"]),
        "browser_navigate" => (
            properties(&[("tabId", uuid_schema()), ("url", string_schema())]),
            vec!["tabId", "url"],
        ),
        "browser_snapshot" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("includeScreenshot", bool_schema()),
            ]),
            vec!["tabId"],
        ),
        "browser_click" | "browser_hover" => (
            properties(&[("tabId", uuid_schema()), ("reference", string_schema())]),
            vec!["tabId", "reference"],
        ),
        "browser_fill" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("reference", string_schema()),
                ("value", string_schema()),
            ]),
            vec!["tabId", "reference", "value"],
        ),
        "browser_press" => (
            properties(&[("tabId", uuid_schema()), ("key", string_schema())]),
            vec!["tabId", "key"],
        ),
        "browser_scroll" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("deltaX", number_schema()),
                ("deltaY", number_schema()),
            ]),
            vec!["tabId", "deltaX", "deltaY"],
        ),
        "browser_drag" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("fromReference", string_schema()),
                ("toReference", string_schema()),
            ]),
            vec!["tabId", "fromReference", "toReference"],
        ),
        "browser_wait" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("condition", string_schema()),
                ("timeoutMs", integer_schema()),
            ]),
            vec!["tabId", "condition", "timeoutMs"],
        ),
        "browser_evaluate" => (
            properties(&[("tabId", uuid_schema()), ("expression", string_schema())]),
            vec!["tabId", "expression"],
        ),
        "browser_screenshot" => (
            properties(&[("tabId", uuid_schema()), ("fullPage", bool_schema())]),
            vec!["tabId", "fullPage"],
        ),
        "browser_console_get" => (
            properties(&[("tabId", uuid_schema()), ("entryId", string_schema())]),
            vec!["tabId", "entryId"],
        ),
        "browser_network_get" => (
            properties(&[("tabId", uuid_schema()), ("requestId", string_schema())]),
            vec!["tabId", "requestId"],
        ),
        "browser_resize" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("width", integer_schema()),
                ("height", integer_schema()),
            ]),
            vec!["tabId", "width", "height"],
        ),
        "browser_emulate" => (
            properties(&[("tabId", uuid_schema()), ("device", string_schema())]),
            vec!["tabId", "device"],
        ),
        "browser_storage" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("command", string_schema()),
                ("value", json!({})),
            ]),
            vec!["tabId", "command"],
        ),
        "browser_handle_dialog" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("accept", bool_schema()),
                ("promptText", string_schema()),
            ]),
            vec!["tabId", "accept"],
        ),
        "browser_upload" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("reference", string_schema()),
                (
                    "paths",
                    json!({"type": "array", "items": {"type": "string"}}),
                ),
            ]),
            vec!["tabId", "reference", "paths"],
        ),
        _ => (Map::new(), vec![]),
    };
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
    .as_object()
    .expect("object schema")
    .clone()
}

fn properties(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(name, schema)| ((*name).into(), schema.clone()))
        .collect()
}

fn tab_properties() -> Map<String, Value> {
    properties(&[("tabId", uuid_schema())])
}

fn uuid_schema() -> Value {
    json!({"type": "string", "format": "uuid"})
}

fn string_schema() -> Value {
    json!({"type": "string"})
}

fn bool_schema() -> Value {
    json!({"type": "boolean"})
}

fn number_schema() -> Value {
    json!({"type": "number"})
}

fn integer_schema() -> Value {
    json!({"type": "integer", "minimum": 0})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_runtime::FakeBrowserEngine;
    use maxx_core::contract::ChatProvider;

    fn scope() -> BrowserSessionScope {
        BrowserSessionScope::full_access(
            Uuid::new_v4(),
            Uuid::new_v4(),
            ChatProvider::Codex,
            Uuid::new_v4(),
        )
    }

    #[test]
    fn all_tools_round_trip_to_typed_operations() {
        let tab_id = Uuid::new_v4();
        let cases = [
            ("browser_status", json!({})),
            ("browser_open_tab", json!({"url": "https://example.com"})),
            ("browser_select_tab", json!({"tabId": tab_id})),
            (
                "browser_snapshot",
                json!({"tabId": tab_id, "includeScreenshot": true}),
            ),
            (
                "browser_fill",
                json!({"tabId": tab_id, "reference": "e1", "value": "hello"}),
            ),
            (
                "browser_scroll",
                json!({"tabId": tab_id, "deltaX": 0, "deltaY": 100}),
            ),
            (
                "browser_upload",
                json!({"tabId": tab_id, "reference": "e2", "paths": ["/tmp/a"]}),
            ),
        ];
        for (name, arguments) in cases {
            let operation = operation_from_call(name, arguments.as_object().cloned())
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(operation.tool_name(), name);
        }
        assert_eq!(TOOL_SPECS.len(), 31);
        assert!(TOOL_SPECS
            .iter()
            .all(|tool| input_schema(tool.name).contains_key("type")));
    }

    #[test]
    fn image_artifacts_are_returned_as_mcp_image_content() {
        let root = std::env::temp_dir().join(format!("maxx-gateway-test-{}", Uuid::new_v4()));
        let artifacts = BrowserArtifactStore::new(root.clone()).expect("artifact store");
        let tab_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let artifact = artifacts
            .store(
                session_id,
                tab_id,
                b"png-data",
                "image/png",
                "png",
                Some("Browser screenshot".into()),
            )
            .expect("stored image");
        let mut session_scope = scope();
        session_scope.assigned_tabs.insert(tab_id);
        let session = AuthenticatedBrowserSession {
            session_id,
            scope: session_scope,
        };
        let result = BrowserOperationResult {
            tab_id: Some(tab_id),
            control_epoch: 0,
            observation_id: None,
            value: serde_json::to_value(&artifact).expect("artifact value"),
            artifacts: vec![artifact],
        };

        let call_result =
            browser_call_tool_result(&artifacts, &session, &result).expect("MCP image result");
        let json = serde_json::to_value(call_result).expect("serialized call result");
        assert_eq!(json["content"][1]["type"], "image");
        assert_eq!(json["content"][1]["mimeType"], "image/png");
        assert_eq!(json["content"][1]["data"], STANDARD.encode(b"png-data"));
        assert!(json.get("structuredContent").is_none());
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test]
    #[ignore = "requires loopback socket permission"]
    async fn gateway_rejects_missing_tokens_and_exposes_scoped_tools() {
        let root = std::env::temp_dir().join(format!("maxx-gateway-test-{}", Uuid::new_v4()));
        let runtime = BrowserRuntime::start(Arc::new(FakeBrowserEngine::default()), root.clone())
            .await
            .expect("runtime");
        let access = runtime.issue_provider_access(scope());
        let client = reqwest::Client::new();
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "maxx-test", "version": "1"}
            }
        });

        let denied = client
            .post(runtime.endpoint())
            .header("Accept", "application/json, text/event-stream")
            .json(&initialize)
            .send()
            .await
            .expect("denied response");
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let initialized = client
            .post(runtime.endpoint())
            .bearer_auth(&access.bearer_token)
            .header("Accept", "application/json, text/event-stream")
            .json(&initialize)
            .send()
            .await
            .expect("initialize");
        assert_eq!(initialized.status(), StatusCode::OK);
        let mcp_session_id = initialized
            .headers()
            .get("mcp-session-id")
            .expect("MCP session")
            .to_str()
            .expect("session header")
            .to_string();
        let initialize_body = initialized.text().await.expect("initialize body");
        assert!(
            initialize_body.contains("maxx_browser"),
            "{initialize_body}"
        );

        let initialized_notification = client
            .post(runtime.endpoint())
            .bearer_auth(&access.bearer_token)
            .header("mcp-session-id", &mcp_session_id)
            .header("Accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .send()
            .await
            .expect("initialized notification");
        assert_eq!(initialized_notification.status(), StatusCode::ACCEPTED);

        let listed = client
            .post(runtime.endpoint())
            .bearer_auth(&access.bearer_token)
            .header("mcp-session-id", mcp_session_id)
            .header("Accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}))
            .send()
            .await
            .expect("tools list");
        assert_eq!(listed.status(), StatusCode::OK);
        let body = listed.text().await.expect("tools body");
        assert!(body.contains("browser_snapshot"), "{body}");
        assert!(body.contains("browser_network_get"), "{body}");

        drop(runtime);
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
