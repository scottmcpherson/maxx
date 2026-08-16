use super::credentials::{CredentialStore, KeychainCredentialStore};
use super::discovery::{self_endpoint, tailscale_discovery, TailscaleDiscovery};
use super::identity::HostIdentity;
use super::net::{
    connect_host, listen_host, parse_bind_address, AuthRequest, AuthenticatedPeer, ClientAuth,
    HostAuthenticator, HostClient, HostHandler, ListenHandle,
};
use super::pairing::{PairingInvitation, PairingManager};
use super::{
    AccessPreset, Capability, EventJournal, HostInfo, HostSettingsStore, PairedDevice, PeerStore,
    RememberedPeer, LOCAL_HOST_ID, PROTOCOL_VERSION,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;

struct HubAuthenticator {
    pairing: Arc<PairingManager>,
    peers: Arc<PeerStore>,
}

impl HostAuthenticator for HubAuthenticator {
    fn authenticate(
        &self,
        source: SocketAddr,
        peer_id: &str,
        peer_name: &str,
        request: AuthRequest,
    ) -> Result<AuthenticatedPeer, String> {
        match request {
            AuthRequest::Credential(credential) => {
                let device = self
                    .peers
                    .authenticate_incoming(peer_id, &credential)?
                    .ok_or_else(|| "The device credential was rejected".to_string())?;
                Ok(AuthenticatedPeer {
                    id: peer_id.to_string(),
                    name: device.name,
                    capabilities: device.capabilities,
                })
            }
            AuthRequest::Pairing {
                code,
                credential_hash,
            } => {
                let capabilities = self.pairing.redeem(source.ip(), &code)?;
                self.peers.register_incoming(
                    peer_id,
                    peer_name,
                    &credential_hash,
                    capabilities.clone(),
                )?;
                Ok(AuthenticatedPeer {
                    id: peer_id.to_string(),
                    name: peer_name.to_string(),
                    capabilities,
                })
            }
        }
    }
}

pub struct HostHub {
    identity: HostIdentity,
    peers: Arc<PeerStore>,
    credentials: Arc<dyn CredentialStore>,
    pairing: Arc<PairingManager>,
    settings: Arc<HostSettingsStore>,
    pub events: Arc<EventJournal>,
    listen: Mutex<Option<ListenHandle>>,
    listen_port: u16,
    remotes: Mutex<HashMap<String, Arc<HostClient>>>,
    connection_errors: Mutex<HashMap<String, String>>,
}

impl Default for HostHub {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostStatus {
    pub id: String,
    pub name: String,
    pub address: String,
    pub capabilities: Vec<Capability>,
    pub connected: bool,
    pub last_event_cursor: u64,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub id: String,
    pub name: String,
    pub protocol_version: u32,
    pub listening: bool,
    pub bind_address: Option<String>,
    pub share_address: Option<String>,
    pub pairing: Option<PairingInvitation>,
    pub remotes: Vec<RemoteHostStatus>,
    pub paired_devices: Vec<PairedDevice>,
}

impl HostHub {
    pub fn new() -> Self {
        Self::with_stores_at_port(
            HostIdentity::load_or_create(),
            Arc::new(PeerStore::load_default()),
            Arc::new(KeychainCredentialStore),
            Arc::new(EventJournal::load_default()),
            Arc::new(HostSettingsStore::load_default()),
            configured_listen_port(),
        )
    }

    pub fn with_stores(
        identity: HostIdentity,
        peers: Arc<PeerStore>,
        credentials: Arc<dyn CredentialStore>,
        events: Arc<EventJournal>,
        settings: Arc<HostSettingsStore>,
    ) -> Self {
        Self::with_stores_at_port(
            identity,
            peers,
            credentials,
            events,
            settings,
            super::DEFAULT_LISTEN_PORT,
        )
    }

    fn with_stores_at_port(
        identity: HostIdentity,
        peers: Arc<PeerStore>,
        credentials: Arc<dyn CredentialStore>,
        events: Arc<EventJournal>,
        settings: Arc<HostSettingsStore>,
        listen_port: u16,
    ) -> Self {
        Self {
            identity,
            peers,
            credentials,
            pairing: Arc::new(PairingManager::default()),
            settings,
            events,
            listen: Mutex::new(None),
            listen_port,
            remotes: Mutex::new(HashMap::new()),
            connection_errors: Mutex::new(HashMap::new()),
        }
    }

    pub fn local_info(&self) -> HostInfo {
        HostInfo::local(self.identity.name.clone())
    }

    pub async fn status(&self) -> HostStatus {
        let listen = self.listen.lock().await;
        let remotes = self.remotes.lock().await;
        let errors = self.connection_errors.lock().await;
        let mut remote_statuses = self
            .peers
            .outgoing()
            .into_iter()
            .map(|peer| {
                let connected = remotes
                    .get(&peer.host_id)
                    .is_some_and(|client| !client.is_closed());
                RemoteHostStatus {
                    id: peer.host_id.clone(),
                    name: peer.host_name,
                    address: peer.address,
                    capabilities: peer.capabilities,
                    connected,
                    last_event_cursor: peer.last_event_cursor,
                    error: errors.get(&peer.host_id).cloned().unwrap_or_default(),
                }
            })
            .collect::<Vec<_>>();
        remote_statuses.sort_by_key(|remote| remote.name.to_lowercase());
        HostStatus {
            id: self.identity.id.clone(),
            name: self.identity.name.clone(),
            protocol_version: PROTOCOL_VERSION,
            listening: listen.is_some(),
            bind_address: listen.as_ref().map(ListenHandle::bind_address),
            share_address: listen.as_ref().map(ListenHandle::share_address),
            pairing: self.pairing.current(),
            remotes: remote_statuses,
            paired_devices: self.peers.paired_devices(),
        }
    }

    pub async fn discovery(&self) -> TailscaleDiscovery {
        tokio::task::spawn_blocking(tailscale_discovery)
            .await
            .unwrap_or_else(|error| TailscaleDiscovery {
                error: format!("Could not inspect Tailscale: {error}"),
                ..TailscaleDiscovery::default()
            })
    }

    pub async fn start_listen(
        &self,
        bind: Option<&str>,
        handler: Arc<dyn HostHandler>,
    ) -> Result<String, String> {
        self.open_listener(bind, handler, true).await
    }

    pub async fn restore_listen(&self, handler: Arc<dyn HostHandler>) -> Result<String, String> {
        if !self.settings.listen_enabled() {
            return Err("Environment connections are disabled".into());
        }
        self.open_listener(None, handler, false).await
    }

    async fn open_listener(
        &self,
        bind: Option<&str>,
        handler: Arc<dyn HostHandler>,
        persist_enabled: bool,
    ) -> Result<String, String> {
        let (address, share_address) = match bind.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => {
                let address = parse_bind_address(value)?;
                (address, address.to_string())
            }
            None => {
                let listen_port = self.listen_port;
                let endpoint = tokio::task::spawn_blocking(move || self_endpoint(listen_port))
                    .await
                    .map_err(|error| format!("Could not inspect Tailscale: {error}"))??;
                (endpoint.bind, endpoint.share_address)
            }
        };
        let mut listen = self.listen.lock().await;
        if listen.is_some() {
            return Err("Already listening for other Maxx environments".into());
        }
        if !persist_enabled && !self.settings.listen_enabled() {
            return Err("Environment connections are disabled".into());
        }
        let authenticator = Arc::new(HubAuthenticator {
            pairing: self.pairing.clone(),
            peers: self.peers.clone(),
        });
        let handle = listen_host(
            address,
            share_address,
            authenticator,
            self.identity.id.clone(),
            self.identity.name.clone(),
            handler,
            self.events.clone(),
        )
        .await?;
        let bound = handle.bind_address();
        if persist_enabled {
            if let Err(error) = self.settings.set_listen_enabled(true) {
                handle.stop().await;
                return Err(error);
            }
        }
        *listen = Some(handle);
        Ok(bound)
    }

    pub async fn stop_listen(&self) -> Result<(), String> {
        self.settings.set_listen_enabled(false)?;
        self.pairing.cancel()?;
        if let Some(handle) = self.listen.lock().await.take() {
            handle.stop().await;
        }
        Ok(())
    }

    pub fn listen_enabled(&self) -> bool {
        self.settings.listen_enabled()
    }

    pub async fn is_listening(&self) -> bool {
        self.listen.lock().await.is_some()
    }

    pub async fn create_pairing(&self, preset: AccessPreset) -> Result<PairingInvitation, String> {
        if self.listen.lock().await.is_none() {
            return Err("Allow environment connections before generating a pairing code".into());
        }
        self.pairing.create(preset)
    }

    pub fn cancel_pairing(&self) -> Result<(), String> {
        self.pairing.cancel()
    }

    pub async fn connect(&self, address: &str, code: &str) -> Result<RemoteHostStatus, String> {
        let client = connect_host(
            address,
            ClientAuth::PairingCode(code.to_string()),
            &self.identity.id,
            &self.identity.name,
            0,
        )
        .await?;
        self.reject_self(&client).await?;
        let Some(credential) = client.new_credential.as_deref() else {
            revoke_remote_pairing(&client).await;
            client.close().await;
            return Err("The pairing handshake did not retain its device credential".into());
        };
        if let Err(error) = self.credentials.save(&client.host_id, credential) {
            revoke_remote_pairing(&client).await;
            client.close().await;
            return Err(error);
        }
        let remembered = RememberedPeer {
            host_id: client.host_id.clone(),
            host_name: client.host_name.clone(),
            address: client.address.clone(),
            capabilities: client.capabilities.clone(),
            last_event_cursor: 0,
        };
        if let Err(error) = self.peers.remember_outgoing(remembered.clone()) {
            let _ = self.credentials.remove(&client.host_id);
            revoke_remote_pairing(&client).await;
            client.close().await;
            return Err(error);
        }
        self.install_client(client.clone()).await;
        self.connection_errors.lock().await.remove(&client.host_id);
        Ok(remote_status(&remembered, true, ""))
    }

    pub async fn reconnect(&self, host_id: &str) -> Result<Arc<HostClient>, String> {
        let peer = self
            .peers
            .outgoing_peer(host_id)
            .ok_or_else(|| "This environment is no longer remembered".to_string())?;
        let credential = self
            .credentials
            .load(host_id)?
            .ok_or_else(|| "The environment credential is missing from Keychain".to_string())?;
        let client = connect_host(
            &peer.address,
            ClientAuth::DeviceCredential(credential),
            &self.identity.id,
            &self.identity.name,
            peer.last_event_cursor,
        )
        .await?;
        self.reject_self(&client).await?;
        self.install_client(client.clone()).await;
        self.connection_errors.lock().await.remove(host_id);
        Ok(client)
    }

    async fn reject_self(&self, client: &Arc<HostClient>) -> Result<(), String> {
        if client.host_id == self.identity.id {
            revoke_remote_pairing(client).await;
            client.close().await;
            Err("That environment is this Mac".into())
        } else {
            Ok(())
        }
    }

    async fn install_client(&self, client: Arc<HostClient>) {
        let replaced = self
            .remotes
            .lock()
            .await
            .insert(client.host_id.clone(), client);
        if let Some(replaced) = replaced {
            replaced.close().await;
        }
    }

    pub async fn disconnect(&self, host_id: &str) -> Result<(), String> {
        if host_id == LOCAL_HOST_ID || self.identity.id == host_id {
            return Err("The local environment cannot be detached".into());
        }
        let credential = self.credentials.load(host_id)?;
        self.credentials.remove(host_id)?;
        if let Err(error) = self.peers.forget_outgoing(host_id) {
            if let Some(credential) = credential {
                let _ = self.credentials.save(host_id, &credential);
            }
            return Err(error);
        }
        self.connection_errors.lock().await.remove(host_id);
        if let Some(client) = self.remotes.lock().await.remove(host_id) {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client.request("host_forget_peer", Value::Null),
            )
            .await;
            client.close().await;
        }
        Ok(())
    }

    pub async fn revoke_paired_device(&self, peer_id: &str) -> Result<(), String> {
        self.peers.forget_incoming(peer_id)?;
        if let Some(listener) = self.listen.lock().await.as_ref() {
            listener.disconnect_peer(peer_id);
        }
        Ok(())
    }

    pub async fn remove_if_same(&self, host_id: &str, client: &Arc<HostClient>) {
        let mut remotes = self.remotes.lock().await;
        if remotes
            .get(host_id)
            .is_some_and(|current| Arc::ptr_eq(current, client))
        {
            remotes.remove(host_id);
        }
    }

    pub fn forget_incoming(&self, peer_id: &str) -> Result<(), String> {
        self.peers.forget_incoming(peer_id)
    }

    pub async fn client(&self, host_id: &str) -> Result<Arc<HostClient>, String> {
        self.remotes
            .lock()
            .await
            .get(host_id)
            .filter(|client| !client.is_closed())
            .cloned()
            .ok_or_else(|| format!("Environment {host_id} is offline"))
    }

    pub async fn connected_client(&self, host_id: &str) -> Option<Arc<HostClient>> {
        self.client(host_id).await.ok()
    }

    pub fn is_local(&self, host_id: &str) -> bool {
        host_id.is_empty() || host_id == LOCAL_HOST_ID || self.identity.id == host_id
    }

    pub async fn invoke_remote(
        &self,
        host_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.client(host_id).await?.request(method, params).await
    }

    pub fn remembered_ids(&self) -> Vec<String> {
        self.peers
            .outgoing()
            .into_iter()
            .map(|peer| peer.host_id)
            .collect()
    }

    pub fn is_remembered(&self, host_id: &str) -> bool {
        self.peers.outgoing_peer(host_id).is_some()
    }

    pub fn record_event_cursor(&self, host_id: &str, cursor: u64) -> Result<(), String> {
        self.peers.update_outgoing_cursor(host_id, cursor)
    }

    pub async fn set_connection_error(&self, host_id: &str, error: String) {
        self.connection_errors
            .lock()
            .await
            .insert(host_id.to_string(), error);
    }
}

fn configured_listen_port() -> u16 {
    std::env::var("MAXX_LISTEN_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(super::DEFAULT_LISTEN_PORT)
}

fn remote_status(peer: &RememberedPeer, connected: bool, error: &str) -> RemoteHostStatus {
    RemoteHostStatus {
        id: peer.host_id.clone(),
        name: peer.host_name.clone(),
        address: peer.address.clone(),
        capabilities: peer.capabilities.clone(),
        connected,
        last_event_cursor: peer.last_event_cursor,
        error: error.to_string(),
    }
}

async fn revoke_remote_pairing(client: &HostClient) {
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        client.request("host_forget_peer", Value::Null),
    )
    .await;
}
