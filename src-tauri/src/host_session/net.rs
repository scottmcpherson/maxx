use super::discovery::{is_protected_ip, resolve_endpoint};
use super::pairing::{credential_hash, credential_hash_is_valid, generate_device_credential};
use super::{Capability, EventJournal, JournalEvent, PROTOCOL_NAME, PROTOCOL_VERSION};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Error as IoError, ErrorKind};
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex as SyncMutex,
};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_HANDSHAKE_BYTES: usize = 8 * 1024;
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const OUTBOUND_CAPACITY: usize = 256;
const MAX_CONCURRENT_REQUESTS: usize = 32;

type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedPeer {
    pub id: String,
    pub name: String,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthRequest {
    Pairing {
        code: String,
        credential_hash: String,
    },
    Credential(String),
}

#[async_trait]
pub trait HostHandler: Send + Sync {
    async fn handle(
        &self,
        peer: &AuthenticatedPeer,
        method: &str,
        params: Value,
    ) -> Result<Value, String>;
}

pub trait HostAuthenticator: Send + Sync {
    fn authenticate(
        &self,
        source: SocketAddr,
        peer_id: &str,
        peer_name: &str,
        request: AuthRequest,
    ) -> Result<AuthenticatedPeer, String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientAuth {
    PairingCode(String),
    DeviceCredential(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteEvent {
    pub cursor: u64,
    pub event: String,
    pub payload: Value,
}

#[derive(Default)]
struct SessionRegistry {
    next_id: AtomicU64,
    sessions: SyncMutex<HashMap<String, HashMap<u64, CancellationToken>>>,
}

impl SessionRegistry {
    fn register(&self, peer_id: &str, shutdown: CancellationToken) -> u64 {
        let session_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions
                .entry(peer_id.to_string())
                .or_default()
                .insert(session_id, shutdown);
        }
        session_id
    }

    fn unregister(&self, peer_id: &str, session_id: u64) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(peer_sessions) = sessions.get_mut(peer_id) {
                peer_sessions.remove(&session_id);
                if peer_sessions.is_empty() {
                    sessions.remove(peer_id);
                }
            }
        }
    }

    fn disconnect(&self, peer_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(peer_sessions) = sessions.remove(peer_id) {
                for shutdown in peer_sessions.into_values() {
                    shutdown.cancel();
                }
            }
        }
    }
}

pub struct ListenHandle {
    pub bind: SocketAddr,
    share_address: String,
    shutdown: CancellationToken,
    task: JoinHandle<()>,
    sessions: Arc<SessionRegistry>,
}

impl ListenHandle {
    pub fn bind_address(&self) -> String {
        self.bind.to_string()
    }

    pub fn share_address(&self) -> String {
        self.share_address.clone()
    }

    pub fn disconnect_peer(&self, peer_id: &str) {
        self.sessions.disconnect(peer_id);
    }

    pub async fn stop(self) {
        self.shutdown.cancel();
        let _ = self.task.await;
    }
}

pub fn parse_bind_address(input: &str) -> Result<SocketAddr, String> {
    let address = input
        .trim()
        .parse::<SocketAddr>()
        .map_err(|_| format!("{} is not a valid IP address and port", input.trim()))?;
    if !is_protected_ip(address.ip()) {
        return Err("Maxx can listen only on a Tailscale or loopback address".into());
    }
    Ok(address)
}

#[allow(clippy::too_many_arguments)]
pub async fn listen_host(
    bind: SocketAddr,
    share_address: String,
    authenticator: Arc<dyn HostAuthenticator>,
    host_id: String,
    host_name: String,
    handler: Arc<dyn HostHandler>,
    events: Arc<EventJournal>,
) -> Result<ListenHandle, String> {
    if !is_protected_ip(bind.ip()) {
        return Err("Maxx can listen only on a Tailscale or loopback address".into());
    }
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|error| {
            if error.kind() == ErrorKind::AddrInUse {
                format!(
                    "Port {} is already being used, usually by another Maxx build. Quit the duplicate build and try again.",
                    bind.port()
                )
            } else {
                format!("Could not listen on {bind}: {error}")
            }
        })?;
    let bound = listener
        .local_addr()
        .map_err(|error| format!("Could not read listen address: {error}"))?;
    let share_address = if bind.port() == 0 {
        share_address
            .strip_suffix(":0")
            .map(|host| format!("{host}:{}", bound.port()))
            .unwrap_or(share_address)
    } else {
        share_address
    };
    let shutdown = CancellationToken::new();
    let sessions = Arc::new(SessionRegistry::default());
    let task_shutdown = shutdown.clone();
    let task_sessions = sessions.clone();
    let task = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                _ = task_shutdown.cancelled() => break,
                Some(_) = connections.join_next(), if !connections.is_empty() => {},
                accepted = listener.accept() => {
                    let Ok((stream, source)) = accepted else { continue };
                    let authenticator = authenticator.clone();
                    let host_id = host_id.clone();
                    let host_name = host_name.clone();
                    let handler = handler.clone();
                    let events = events.clone();
                    let connection_shutdown = task_shutdown.child_token();
                    let sessions = task_sessions.clone();
                    connections.spawn(async move {
                        serve_connection(
                            stream,
                            source,
                            authenticator,
                            host_id,
                            host_name,
                            handler,
                            events,
                            sessions,
                            connection_shutdown,
                        )
                        .await;
                    });
                }
            }
        }
        task_shutdown.cancel();
        while connections.join_next().await.is_some() {}
    });
    Ok(ListenHandle {
        bind: bound,
        share_address,
        shutdown,
        task,
        sessions,
    })
}

pub struct HostClient {
    pub host_id: String,
    pub host_name: String,
    pub address: String,
    pub capabilities: Vec<Capability>,
    pub new_credential: Option<String>,
    pub resync_required: bool,
    pub server_cursor: u64,
    outbound: mpsc::Sender<Value>,
    pending: PendingRequests,
    next_id: AtomicU64,
    events: Mutex<mpsc::Receiver<RemoteEvent>>,
    shutdown: CancellationToken,
}

impl HostClient {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.shutdown.is_cancelled() {
            return Err("The remote Maxx disconnected".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if self
            .outbound
            .send(json!({"type":"request","id":id,"method":method,"params":params}))
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err("The remote Maxx disconnected".into());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The remote Maxx disconnected".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("{method} timed out"))
            }
        }
    }

    pub async fn next_event(&self) -> Option<RemoteEvent> {
        self.events.lock().await.recv().await
    }

    pub async fn close(&self) {
        self.shutdown.cancel();
        fail_pending(&self.pending, "The remote Maxx disconnected").await;
    }

    pub fn is_closed(&self) -> bool {
        self.shutdown.is_cancelled()
    }
}

impl Drop for HostClient {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

pub async fn connect_host(
    address: &str,
    auth: ClientAuth,
    local_id: &str,
    local_name: &str,
    after_cursor: u64,
) -> Result<Arc<HostClient>, String> {
    let (resolved, canonical_address) =
        resolve_endpoint(address, super::DEFAULT_LISTEN_PORT).await?;
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(resolved))
        .await
        .map_err(|_| format!("Connecting to {canonical_address} timed out"))?
        .map_err(|error| format!("Could not connect to {canonical_address}: {error}"))?;
    handshake_and_client(
        stream,
        canonical_address,
        auth,
        local_id,
        local_name,
        after_cursor,
    )
    .await
}

async fn handshake_and_client(
    stream: TcpStream,
    address: String,
    auth: ClientAuth,
    local_id: &str,
    local_name: &str,
    after_cursor: u64,
) -> Result<Arc<HostClient>, String> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let (auth_value, new_credential) = match auth {
        ClientAuth::PairingCode(code) => {
            let credential = generate_device_credential();
            (
                json!({
                    "type":"pairing",
                    "code":code,
                    "credentialHash":credential_hash(&credential),
                }),
                Some(credential),
            )
        }
        ClientAuth::DeviceCredential(credential) => {
            (json!({"type":"credential","credential":credential}), None)
        }
    };
    let hello = json!({
        "type":"hello",
        "protocol":{"name":PROTOCOL_NAME,"version":PROTOCOL_VERSION},
        "client":{"id":local_id,"name":local_name},
        "auth":auth_value,
        "afterCursor":after_cursor,
    });
    write_json(&mut writer, &hello)
        .await
        .map_err(|_| "Could not send host credentials".to_string())?;
    let welcome_line = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        read_limited_line(&mut reader, MAX_HANDSHAKE_BYTES),
    )
    .await
    .map_err(|_| "The host pairing response timed out".to_string())?
    .map_err(|error| format!("The host closed the connection: {error}"))?
    .ok_or_else(|| "The host closed the connection".to_string())?;
    let welcome: Value = serde_json::from_str(&welcome_line)
        .map_err(|_| "The host sent an invalid pairing response".to_string())?;
    if welcome.get("type").and_then(Value::as_str) == Some("error") {
        return Err(welcome
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The host credentials were rejected")
            .to_string());
    }
    if welcome.get("type").and_then(Value::as_str) != Some("welcome")
        || welcome.get("protocolVersion").and_then(Value::as_u64)
            != Some(u64::from(PROTOCOL_VERSION))
    {
        return Err("The remote Maxx uses an incompatible environment protocol".into());
    }
    let host = welcome
        .get("host")
        .and_then(Value::as_object)
        .ok_or("The host did not identify itself")?;
    let host_id = host
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("The host did not identify itself")?
        .to_string();
    let host_name = host
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Remote Mac")
        .to_string();
    let capabilities: Vec<Capability> = serde_json::from_value(
        welcome
            .get("capabilities")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|_| "The host sent invalid permissions".to_string())?;
    let resync_required = welcome
        .get("resyncRequired")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let server_cursor = welcome
        .get("eventCursor")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let (outbound, mut output) = mpsc::channel::<Value>(OUTBOUND_CAPACITY);
    let (event_tx, event_rx) = mpsc::channel(OUTBOUND_CAPACITY);
    let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
    let shutdown = CancellationToken::new();
    let writer_shutdown = shutdown.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_shutdown.cancelled() => break,
                message = output.recv() => {
                    let Some(message) = message else { break };
                    if write_json(&mut writer, &message).await.is_err() { break; }
                }
            }
        }
        writer_shutdown.cancel();
    });
    let reader_pending = pending.clone();
    let reader_shutdown = shutdown.clone();
    tokio::spawn(async move {
        loop {
            let line = tokio::select! {
                _ = reader_shutdown.cancelled() => break,
                line = read_limited_line(&mut reader, MAX_FRAME_BYTES) => line,
            };
            let Ok(Some(line)) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match message.get("type").and_then(Value::as_str) {
                Some("response") => {
                    let Some(id) = message.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    if let Some(sender) = reader_pending.lock().await.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Remote command failed")
                                .to_string())
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                }
                Some("event") => {
                    let Some(event) = message.get("event").and_then(Value::as_str) else {
                        continue;
                    };
                    let remote = RemoteEvent {
                        cursor: message.get("cursor").and_then(Value::as_u64).unwrap_or(0),
                        event: event.to_string(),
                        payload: message.get("payload").cloned().unwrap_or(Value::Null),
                    };
                    if event_tx.send(remote).await.is_err() {
                        break;
                    }
                }
                _ => {}
            }
        }
        reader_shutdown.cancel();
        fail_pending(&reader_pending, "The remote Maxx disconnected").await;
    });
    Ok(Arc::new(HostClient {
        host_id,
        host_name,
        address,
        capabilities,
        new_credential,
        resync_required,
        server_cursor,
        outbound,
        pending,
        next_id: AtomicU64::new(1),
        events: Mutex::new(event_rx),
        shutdown,
    }))
}

async fn fail_pending(pending: &PendingRequests, message: &str) {
    let pending = std::mem::take(&mut *pending.lock().await);
    for sender in pending.into_values() {
        let _ = sender.send(Err(message.to_string()));
    }
}

#[allow(clippy::too_many_arguments)]
async fn serve_connection(
    stream: TcpStream,
    source: SocketAddr,
    authenticator: Arc<dyn HostAuthenticator>,
    host_id: String,
    host_name: String,
    handler: Arc<dyn HostHandler>,
    events: Arc<EventJournal>,
    sessions: Arc<SessionRegistry>,
    shutdown: CancellationToken,
) {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let first = tokio::select! {
        _ = shutdown.cancelled() => return,
        result = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_limited_line(&mut reader, MAX_HANDSHAKE_BYTES)) => result,
    };
    let Ok(Ok(Some(first))) = first else { return };
    let Ok(hello) = serde_json::from_str::<Value>(&first) else {
        let _ = write_protocol_error(
            &mut writer,
            "protocol.invalid",
            "Invalid environment handshake",
        )
        .await;
        return;
    };
    if hello.get("type").and_then(Value::as_str) != Some("hello") {
        let _ = write_protocol_error(
            &mut writer,
            "protocol.invalid",
            "Environment credentials are required",
        )
        .await;
        return;
    }
    if !protocol_is_supported(&hello) {
        let _ = write_protocol_error(
            &mut writer,
            "protocol.incompatible",
            &format!("This Maxx requires environment protocol {PROTOCOL_VERSION}"),
        )
        .await;
        return;
    }
    let client = hello.get("client").and_then(Value::as_object);
    let Some(peer_id) = client
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
    else {
        let _ = write_protocol_error(
            &mut writer,
            "auth.identity",
            "The connecting Maxx did not identify itself",
        )
        .await;
        return;
    };
    let peer_name = client
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .unwrap_or("Remote Mac");
    let Some(auth) = hello.get("auth").and_then(Value::as_object) else {
        let _ = write_protocol_error(
            &mut writer,
            "auth.missing",
            "Environment credentials are required",
        )
        .await;
        return;
    };
    let auth_request = match auth.get("type").and_then(Value::as_str) {
        Some("pairing") => {
            let code = auth.get("code").and_then(Value::as_str).unwrap_or_default();
            let credential_hash = auth
                .get("credentialHash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !credential_hash_is_valid(credential_hash) {
                let _ = write_protocol_error(
                    &mut writer,
                    "auth.credential",
                    "The device credential hash is invalid",
                )
                .await;
                return;
            }
            AuthRequest::Pairing {
                code: code.to_string(),
                credential_hash: credential_hash.to_string(),
            }
        }
        Some("credential") => AuthRequest::Credential(
            auth.get("credential")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
        _ => {
            let _ = write_protocol_error(
                &mut writer,
                "auth.invalid",
                "The authentication method is invalid",
            )
            .await;
            return;
        }
    };
    let authenticated = match authenticator.authenticate(source, peer_id, peer_name, auth_request) {
        Ok(peer) => peer,
        Err(message) => {
            let _ = write_protocol_error(&mut writer, "auth.rejected", &message).await;
            return;
        }
    };
    let after_cursor = hello
        .get("afterCursor")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let Ok(mut subscription) = events.subscribe(after_cursor) else {
        let _ = write_protocol_error(
            &mut writer,
            "events.unavailable",
            "The host event journal is unavailable",
        )
        .await;
        return;
    };
    let welcome = json!({
        "type":"welcome",
        "protocolVersion":PROTOCOL_VERSION,
        "host":{"id":host_id,"name":host_name},
        "capabilities":authenticated.capabilities,
        "eventCursor":subscription.current_cursor,
        "resyncRequired":subscription.resync_required,
    });
    if write_json(&mut writer, &welcome).await.is_err() {
        return;
    }

    let session_id = sessions.register(&authenticated.id, shutdown.clone());
    let (outbound, mut output) = mpsc::channel::<Value>(OUTBOUND_CAPACITY);
    let writer_shutdown = shutdown.clone();
    let writer_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_shutdown.cancelled() => break,
                message = output.recv() => {
                    let Some(message) = message else { break };
                    if write_json(&mut writer, &message).await.is_err() { break; }
                }
            }
        }
        writer_shutdown.cancel();
    });
    let event_out = outbound.clone();
    let event_shutdown = shutdown.clone();
    let event_task = tokio::spawn(async move {
        loop {
            let record = tokio::select! {
                _ = event_shutdown.cancelled() => break,
                record = subscription.recv() => record,
            };
            let Some(JournalEvent {
                cursor,
                event,
                payload,
            }) = record
            else {
                event_shutdown.cancel();
                break;
            };
            if event_out
                .send(json!({"type":"event","cursor":cursor,"event":event,"payload":payload}))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let request_limit = Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS));
    loop {
        let line = tokio::select! {
            _ = shutdown.cancelled() => break,
            line = read_limited_line(&mut reader, MAX_FRAME_BYTES) => line,
        };
        let Ok(Some(line)) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("type").and_then(Value::as_str) != Some("request") {
            continue;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let handler = handler.clone();
        let outbound = outbound.clone();
        let peer = authenticated.clone();
        let request_limit = request_limit.clone();
        let request_shutdown = shutdown.clone();
        tokio::spawn(async move {
            let Ok(permit) = request_limit.acquire_owned().await else {
                return;
            };
            let response = tokio::select! {
                _ = request_shutdown.cancelled() => return,
                response = handler.handle(&peer, &method, params) => response,
            };
            drop(permit);
            let frame = match response {
                Ok(result) => json!({"type":"response","id":id,"result":result}),
                Err(message) => {
                    json!({"type":"response","id":id,"error":{"code":"runtime.command","message":message}})
                }
            };
            let _ = outbound.send(frame).await;
        });
    }
    shutdown.cancel();
    sessions.unregister(&authenticated.id, session_id);
    let _ = writer_task.await;
    let _ = event_task.await;
}

fn protocol_is_supported(hello: &Value) -> bool {
    let protocol = hello.get("protocol").and_then(Value::as_object);
    protocol
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        == Some(PROTOCOL_NAME)
        && protocol
            .and_then(|value| value.get("version"))
            .and_then(Value::as_u64)
            == Some(u64::from(PROTOCOL_VERSION))
}

async fn write_protocol_error<W: AsyncWrite + Unpin>(
    writer: &mut W,
    code: &str,
    message: &str,
) -> Result<(), ()> {
    write_json(
        writer,
        &json!({"type":"error","code":code,"message":message}),
    )
    .await
}

async fn write_json<W: AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> Result<(), ()> {
    let mut serialized = value.to_string();
    serialized.push('\n');
    writer
        .write_all(serialized.as_bytes())
        .await
        .map_err(|_| ())?;
    writer.flush().await.map_err(|_| ())
}

async fn read_limited_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            break;
        }
        if let Some(position) = available.iter().position(|byte| *byte == b'\n') {
            if bytes.len() + position > max_bytes {
                return Err(IoError::new(
                    ErrorKind::InvalidData,
                    "host frame is too large",
                ));
            }
            bytes.extend_from_slice(&available[..position]);
            reader.consume(position + 1);
            break;
        }
        if bytes.len() + available.len() > max_bytes {
            return Err(IoError::new(
                ErrorKind::InvalidData,
                "host frame is too large",
            ));
        }
        let consumed = available.len();
        bytes.extend_from_slice(available);
        reader.consume(consumed);
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| IoError::new(ErrorKind::InvalidData, "host frame is not UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listener_accepts_only_tailscale_and_loopback_addresses() {
        assert!(parse_bind_address("127.0.0.1:7422").is_ok());
        assert!(parse_bind_address("100.64.0.12:7422").is_ok());
        assert!(parse_bind_address("0.0.0.0:9000").is_err());
        assert!(parse_bind_address("192.168.1.8:7422").is_err());
    }

    #[tokio::test]
    async fn limited_line_rejects_oversized_handshakes() {
        let bytes = vec![b'a'; MAX_HANDSHAKE_BYTES + 1];
        let mut reader = BufReader::new(bytes.as_slice());
        assert_eq!(
            read_limited_line(&mut reader, MAX_HANDSHAKE_BYTES)
                .await
                .unwrap_err()
                .kind(),
            ErrorKind::InvalidData
        );
    }

    #[test]
    fn protocol_negotiation_rejects_missing_and_future_versions() {
        assert!(protocol_is_supported(&json!({
            "protocol":{"name":PROTOCOL_NAME,"version":PROTOCOL_VERSION}
        })));
        assert!(!protocol_is_supported(&json!({
            "protocol":{"name":PROTOCOL_NAME,"version":PROTOCOL_VERSION + 1}
        })));
        assert!(!protocol_is_supported(
            &json!({"protocol":{"version":PROTOCOL_VERSION}})
        ));
    }
}
