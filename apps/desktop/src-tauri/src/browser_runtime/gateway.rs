use super::{
    AuthenticatedBrowserSession, BrowserArtifactStore, BrowserBroker, BrowserCapability,
    BrowserCredential, BrowserEngine, BrowserObservationId, BrowserOperation,
    BrowserOperationResult, BrowserRuntimeError, BrowserSessionRegistry, BrowserSessionScope,
    BrowserUiReveal,
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
use serde::Deserialize;
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

impl BrowserProviderAccess {
    /// Adapt the browser credential to the provider-neutral host-tool shape.
    /// The browser session binding remains owned by `BrowserRuntime`; adapters
    /// only need the authenticated MCP transport details.
    pub fn as_host_tool(&self) -> crate::host_tools::HostToolAccess {
        crate::host_tools::HostToolAccess::new(
            "maxx_browser",
            self.endpoint.clone(),
            self.bearer_token.clone(),
        )
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

    pub async fn shutdown(&self) -> Result<(), BrowserRuntimeError> {
        self.broker.shutdown().await
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserActRequest {
    tab_id: Uuid,
    observation_id: BrowserObservationId,
    document_generation: u64,
    control_epoch: u64,
    actions: Vec<BrowserActAction>,
    #[serde(default)]
    postconditions: Vec<BrowserPostcondition>,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum BrowserActAction {
    Click {
        reference: String,
    },
    Fill {
        reference: String,
        value: String,
    },
    Press {
        key: String,
    },
    Scroll {
        delta_x: f64,
        delta_y: f64,
    },
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    Wait {
        condition: String,
        #[serde(default = "default_wait_timeout_ms")]
        timeout_ms: u64,
    },
    Extract {
        expression: String,
    },
}

impl BrowserActAction {
    fn into_operation(self, tab_id: Uuid) -> BrowserOperation {
        match self {
            Self::Click { reference } => BrowserOperation::Click { tab_id, reference },
            Self::Fill { reference, value } => BrowserOperation::Fill {
                tab_id,
                reference,
                value,
            },
            Self::Press { key } => BrowserOperation::Press { tab_id, key },
            Self::Scroll { delta_x, delta_y } => BrowserOperation::Scroll {
                tab_id,
                delta_x,
                delta_y,
            },
            Self::Navigate { url } => BrowserOperation::Navigate { tab_id, url },
            Self::Back => BrowserOperation::GoBack { tab_id },
            Self::Forward => BrowserOperation::GoForward { tab_id },
            Self::Reload => BrowserOperation::Reload { tab_id },
            Self::Wait {
                condition,
                timeout_ms,
            } => BrowserOperation::Wait {
                tab_id,
                condition,
                timeout_ms,
            },
            Self::Extract { expression } => BrowserOperation::Evaluate { tab_id, expression },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPostcondition {
    condition: String,
    #[serde(default = "default_wait_timeout_ms")]
    timeout_ms: u64,
}

const fn default_wait_timeout_ms() -> u64 {
    10_000
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
                "Maxx Browser is the only browser-control surface for this session. Call browser_open once with the destination URL, then reuse the assigned tab. browser_open and browser_act return a fresh observation; pass its observationId and documentGeneration into the next browser_act. Batch related actions, waits, assertions, and extraction into one browser_act call. Wait conditions use text:<literal visible text> (preferred) or a JavaScript boolean expression. A stale observation is rejected. Do not launch Chrome, use terminal browser automation, or control an external browser. Human input interrupts agent control.".into(),
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
        let mut session = session_from_context(&context)?;
        let arguments = request.arguments.unwrap_or_default();
        match execute_core_tool(self, &mut session, &request.name, arguments).await {
            Ok(result) => Ok(
                match browser_call_tool_result(&self.artifacts, &session, &result) {
                    Ok(result) => result,
                    Err(error) => runtime_error_result(error),
                },
            ),
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

async fn execute_core_tool(
    server: &BrowserMcpServer,
    session: &mut AuthenticatedBrowserSession,
    name: &str,
    arguments: Map<String, Value>,
) -> Result<BrowserOperationResult, BrowserRuntimeError> {
    match name {
        "browser_open" => {
            let url = Some(required_string(&arguments, "url")?);
            let opened = server
                .broker
                .execute(session, BrowserOperation::OpenTab { url })
                .await?;
            let tab_id = opened.tab_id.ok_or_else(|| {
                BrowserRuntimeError::new("browser.missing-tab", "opened tab has no identifier")
            })?;
            server.sessions.assign_tab(session.session_id, tab_id)?;
            session.scope.assigned_tabs.insert(tab_id);
            let _ = server.ui_reveals.send(BrowserUiReveal {
                thread_id: session.scope.thread_id,
                tab_id,
            });
            let observed = server
                .broker
                .execute(
                    session,
                    BrowserOperation::Snapshot {
                        tab_id,
                        include_screenshot: optional_bool(&arguments, "includeScreenshot", false)?,
                        since_observation_id: None,
                    },
                )
                .await?;
            Ok(add_result_metadata(observed, "opened", opened.value))
        }
        "browser_observe" => {
            let tab_id = resolve_tab(server, session, &arguments).await?;
            server
                .broker
                .execute(
                    session,
                    BrowserOperation::Snapshot {
                        tab_id,
                        include_screenshot: optional_bool(&arguments, "includeScreenshot", false)?,
                        since_observation_id: optional_uuid(&arguments, "sinceObservationId")?,
                    },
                )
                .await
        }
        "browser_act" => execute_browser_act(server, session, arguments).await,
        "browser_wait" => {
            let tab_id = resolve_tab(server, session, &arguments).await?;
            let waited = server
                .broker
                .execute(
                    session,
                    BrowserOperation::Wait {
                        tab_id,
                        condition: required_string(&arguments, "condition")?,
                        timeout_ms: optional_u64(
                            &arguments,
                            "timeoutMs",
                            default_wait_timeout_ms(),
                        )?,
                    },
                )
                .await?;
            let observed = server
                .broker
                .execute(
                    session,
                    BrowserOperation::Snapshot {
                        tab_id,
                        include_screenshot: false,
                        since_observation_id: None,
                    },
                )
                .await?;
            Ok(add_result_metadata(observed, "wait", waited.value))
        }
        "browser_extract" => {
            let tab_id = resolve_tab(server, session, &arguments).await?;
            let extracted = server
                .broker
                .execute(
                    session,
                    BrowserOperation::Evaluate {
                        tab_id,
                        expression: required_string(&arguments, "expression")?,
                    },
                )
                .await?;
            let observed = server
                .broker
                .execute(
                    session,
                    BrowserOperation::Snapshot {
                        tab_id,
                        include_screenshot: false,
                        since_observation_id: None,
                    },
                )
                .await?;
            Ok(add_result_metadata(observed, "extracted", extracted.value))
        }
        "browser_screenshot" => {
            let tab_id = resolve_tab(server, session, &arguments).await?;
            server
                .broker
                .execute(
                    session,
                    BrowserOperation::Screenshot {
                        tab_id,
                        full_page: optional_bool(&arguments, "fullPage", false)?,
                    },
                )
                .await
        }
        _ => Err(BrowserRuntimeError::new(
            "browser.unknown-tool",
            format!("unknown browser tool {name}"),
        )),
    }
}

async fn execute_browser_act(
    server: &BrowserMcpServer,
    session: &AuthenticatedBrowserSession,
    arguments: Map<String, Value>,
) -> Result<BrowserOperationResult, BrowserRuntimeError> {
    let request: BrowserActRequest =
        serde_json::from_value(Value::Object(arguments)).map_err(|error| {
            BrowserRuntimeError::new(
                "browser.invalid-arguments",
                format!("invalid arguments for browser_act: {error}"),
            )
        })?;
    if request.actions.is_empty() || request.actions.len() > 20 {
        return Err(BrowserRuntimeError::new(
            "browser.invalid-batch",
            "browser_act requires between 1 and 20 actions",
        ));
    }
    if request.postconditions.len() > 8 {
        return Err(BrowserRuntimeError::new(
            "browser.invalid-batch",
            "browser_act accepts at most 8 postconditions",
        ));
    }
    server
        .broker
        .validate_observation(
            session,
            request.tab_id,
            request.observation_id,
            request.document_generation,
        )
        .await?;
    server
        .broker
        .validate_control_epoch(session, request.tab_id, request.control_epoch)
        .await?;

    let mut results = Vec::new();
    for action in request.actions {
        server
            .broker
            .validate_control_epoch(session, request.tab_id, request.control_epoch)
            .await?;
        let operation = action.into_operation(request.tab_id);
        let tool = operation.tool_name();
        let result = server.broker.execute(session, operation).await?;
        results.push(json!({"operation": tool, "value": result.value}));
    }
    for postcondition in request.postconditions {
        server
            .broker
            .validate_control_epoch(session, request.tab_id, request.control_epoch)
            .await?;
        let result = server
            .broker
            .execute(
                session,
                BrowserOperation::Wait {
                    tab_id: request.tab_id,
                    condition: postcondition.condition,
                    timeout_ms: postcondition.timeout_ms,
                },
            )
            .await?;
        results.push(json!({"operation": "postcondition", "value": result.value}));
    }
    let observed = server
        .broker
        .execute(
            session,
            BrowserOperation::Snapshot {
                tab_id: request.tab_id,
                include_screenshot: false,
                since_observation_id: None,
            },
        )
        .await?;
    Ok(add_result_metadata(
        observed,
        "actionResults",
        Value::Array(results),
    ))
}

async fn resolve_tab(
    server: &BrowserMcpServer,
    session: &AuthenticatedBrowserSession,
    arguments: &Map<String, Value>,
) -> Result<Uuid, BrowserRuntimeError> {
    if let Some(tab_id) = optional_uuid(arguments, "tabId")? {
        return Ok(tab_id);
    }
    server
        .broker
        .selected_tab_for(session)
        .await
        .ok_or_else(|| {
            BrowserRuntimeError::new(
                "browser.tab-required",
                "no assigned tab is selected; call browser_open first",
            )
        })
}

fn add_result_metadata(
    mut result: BrowserOperationResult,
    key: &str,
    value: Value,
) -> BrowserOperationResult {
    if let Some(object) = result.value.as_object_mut() {
        object.insert(key.into(), value);
    }
    result
}

fn required_string(
    arguments: &Map<String, Value>,
    name: &str,
) -> Result<String, BrowserRuntimeError> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            BrowserRuntimeError::new(
                "browser.invalid-arguments",
                format!("{name} must be a non-empty string"),
            )
        })
}

fn optional_string(
    arguments: &Map<String, Value>,
    name: &str,
) -> Result<Option<String>, BrowserRuntimeError> {
    match arguments.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(BrowserRuntimeError::new(
            "browser.invalid-arguments",
            format!("{name} must be a string"),
        )),
    }
}

fn optional_uuid(
    arguments: &Map<String, Value>,
    name: &str,
) -> Result<Option<Uuid>, BrowserRuntimeError> {
    optional_string(arguments, name)?
        .map(|value| {
            Uuid::parse_str(&value).map_err(|_| {
                BrowserRuntimeError::new(
                    "browser.invalid-arguments",
                    format!("{name} must be a UUID"),
                )
            })
        })
        .transpose()
}

fn optional_bool(
    arguments: &Map<String, Value>,
    name: &str,
    default: bool,
) -> Result<bool, BrowserRuntimeError> {
    match arguments.get(name) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(BrowserRuntimeError::new(
            "browser.invalid-arguments",
            format!("{name} must be a boolean"),
        )),
    }
}

fn optional_u64(
    arguments: &Map<String, Value>,
    name: &str,
    default: u64,
) -> Result<u64, BrowserRuntimeError> {
    match arguments.get(name) {
        None => Ok(default),
        Some(value) => value.as_u64().ok_or_else(|| {
            BrowserRuntimeError::new(
                "browser.invalid-arguments",
                format!("{name} must be a non-negative integer"),
            )
        }),
    }
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
    spec("browser_open", "Open, select, reveal, and observe a new isolated Maxx browser tab.", BrowserCapability::Navigate, false, false),
    spec("browser_observe", "Return a compact semantic observation, optionally as changes since the prior observation.", BrowserCapability::Observe, true, false),
    spec("browser_act", "Run a guarded batch of browser actions, waits, postconditions, and extraction, then return a fresh observation.", BrowserCapability::Interact, false, true),
    spec("browser_wait", "Wait for a page condition without model polling, then return a fresh observation.", BrowserCapability::Interact, true, false),
    spec("browser_extract", "Evaluate a JSON-returning expression in the assigned page, then return a fresh observation.", BrowserCapability::Evaluate, false, true),
    spec("browser_screenshot", "Capture the assigned Maxx browser tab and return the image directly.", BrowserCapability::Observe, true, false),
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
        "browser_open" => (
            properties(&[
                (
                    "url",
                    json!({
                        "type": "string",
                        "description": "Absolute HTTP or HTTPS destination URL to open."
                    }),
                ),
                ("includeScreenshot", bool_schema()),
            ]),
            vec!["url"],
        ),
        "browser_observe" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("sinceObservationId", uuid_schema()),
                ("includeScreenshot", bool_schema()),
            ]),
            vec![],
        ),
        "browser_act" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("observationId", uuid_schema()),
                ("documentGeneration", integer_schema()),
                ("controlEpoch", integer_schema()),
                (
                    "actions",
                    json!({
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "items": browser_action_schema(),
                    }),
                ),
                (
                    "postconditions",
                    json!({
                        "type": "array",
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "properties": {
                                "condition": wait_condition_schema(),
                                "timeoutMs": {"type": "integer", "minimum": 0}
                            },
                            "required": ["condition"],
                            "additionalProperties": false
                        }
                    }),
                ),
            ]),
            vec![
                "tabId",
                "observationId",
                "documentGeneration",
                "controlEpoch",
                "actions",
            ],
        ),
        "browser_wait" => (
            properties(&[
                ("tabId", uuid_schema()),
                ("condition", wait_condition_schema()),
                ("timeoutMs", integer_schema()),
            ]),
            vec!["condition"],
        ),
        "browser_extract" => (
            properties(&[("tabId", uuid_schema()), ("expression", string_schema())]),
            vec!["expression"],
        ),
        "browser_screenshot" => (
            properties(&[("tabId", uuid_schema()), ("fullPage", bool_schema())]),
            vec![],
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

fn browser_action_schema() -> Value {
    json!({
        "oneOf": [
            action_schema("click", json!({"reference": {"type": "string"}}), &["reference"]),
            action_schema(
                "fill",
                json!({"reference": {"type": "string"}, "value": {"type": "string"}}),
                &["reference", "value"],
            ),
            action_schema("press", json!({"key": {"type": "string"}}), &["key"]),
            action_schema(
                "scroll",
                json!({"deltaX": {"type": "number"}, "deltaY": {"type": "number"}}),
                &["deltaX", "deltaY"],
            ),
            action_schema("navigate", json!({"url": {"type": "string"}}), &["url"]),
            action_schema("back", json!({}), &[]),
            action_schema("forward", json!({}), &[]),
            action_schema("reload", json!({}), &[]),
            action_schema(
                "wait",
                json!({
                    "condition": wait_condition_schema(),
                    "timeoutMs": {"type": "integer", "minimum": 0}
                }),
                &["condition"],
            ),
            action_schema(
                "extract",
                json!({"expression": {"type": "string"}}),
                &["expression"],
            ),
        ]
    })
}

fn action_schema(kind: &str, properties: Value, required: &[&str]) -> Value {
    let mut properties = properties.as_object().cloned().unwrap_or_default();
    properties.insert("type".into(), json!({"const": kind}));
    let mut required = required
        .iter()
        .map(|name| Value::String((*name).into()))
        .collect::<Vec<_>>();
    required.insert(0, Value::String("type".into()));
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn properties(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(name, schema)| ((*name).into(), schema.clone()))
        .collect()
}

fn uuid_schema() -> Value {
    json!({"type": "string", "format": "uuid"})
}

fn string_schema() -> Value {
    json!({"type": "string"})
}

fn wait_condition_schema() -> Value {
    json!({
        "type": "string",
        "description": "Use text:<literal visible text> (preferred), or a JavaScript expression that returns a boolean. Example: text:Selected: Spring Hill"
    })
}

fn bool_schema() -> Value {
    json!({"type": "boolean"})
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
    fn normal_agent_surface_is_six_compact_tools() {
        assert_eq!(TOOL_SPECS.len(), 6);
        assert_eq!(
            TOOL_SPECS.iter().map(|tool| tool.name).collect::<Vec<_>>(),
            vec![
                "browser_open",
                "browser_observe",
                "browser_act",
                "browser_wait",
                "browser_extract",
                "browser_screenshot",
            ]
        );
        assert!(TOOL_SPECS
            .iter()
            .all(|tool| input_schema(tool.name).contains_key("type")));
        let act = input_schema("browser_act");
        let open = input_schema("browser_open");
        assert_eq!(open["required"], json!(["url"]));
        assert_eq!(act["properties"]["actions"]["maxItems"], 20);
        assert_eq!(
            input_schema("browser_wait")["properties"]["condition"]["description"],
            "Use text:<literal visible text> (preferred), or a JavaScript expression that returns a boolean. Example: text:Selected: Spring Hill"
        );
        assert!(act["required"]
            .as_array()
            .unwrap()
            .contains(&Value::String("observationId".into())));
    }

    #[tokio::test]
    async fn batch_requires_a_fresh_observation_and_returns_another() {
        let root = std::env::temp_dir().join(format!("maxx-gateway-test-{}", Uuid::new_v4()));
        let sessions = Arc::new(BrowserSessionRegistry::default());
        let artifacts = Arc::new(BrowserArtifactStore::new(root.clone()).expect("artifacts"));
        let engine = Arc::new(FakeBrowserEngine::default());
        let broker = Arc::new(BrowserBroker::new(engine.clone(), artifacts.clone()));
        let (ui_reveals, _) = broadcast::channel(4);
        let server = BrowserMcpServer {
            sessions: sessions.clone(),
            broker,
            artifacts,
            ui_reveals,
        };
        let credential = sessions.issue(scope());
        let mut session = sessions
            .authenticate_any(&format!("Bearer {}", credential.bearer_token))
            .expect("authenticate");
        let opened = execute_core_tool(
            &server,
            &mut session,
            "browser_open",
            json!({"url": "https://example.com"})
                .as_object()
                .unwrap()
                .clone(),
        )
        .await
        .expect("open and observe");
        let tab_id = opened.tab_id.expect("tab id");
        let observation_id = opened.observation_id.expect("observation id");
        let act = json!({
            "tabId": tab_id,
            "observationId": observation_id,
            "documentGeneration": 0,
            "controlEpoch": 0,
            "actions": [{"type": "click", "reference": "e1"}],
            "postconditions": [{"condition": "true", "timeoutMs": 1}],
        });
        let acted = execute_core_tool(
            &server,
            &mut session,
            "browser_act",
            act.as_object().unwrap().clone(),
        )
        .await
        .expect("guarded batch");
        assert_ne!(acted.observation_id, Some(observation_id));
        assert_eq!(
            engine
                .calls()
                .iter()
                .map(|(_, name)| name.as_str())
                .collect::<Vec<_>>(),
            vec![
                "browser_open_tab",
                "browser_snapshot",
                "browser_click",
                "browser_wait",
                "browser_snapshot",
            ]
        );

        let stale = execute_core_tool(
            &server,
            &mut session,
            "browser_act",
            act.as_object().unwrap().clone(),
        )
        .await
        .expect_err("old observation must be rejected");
        assert_eq!(stale.code, "browser.stale-observation");
        std::fs::remove_dir_all(root).expect("cleanup");
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
        assert!(body.contains("browser_observe"), "{body}");
        assert!(body.contains("browser_act"), "{body}");
        assert!(!body.contains("browser_exec"), "{body}");
        assert!(!body.contains("browser_network_get"), "{body}");

        drop(runtime);
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
