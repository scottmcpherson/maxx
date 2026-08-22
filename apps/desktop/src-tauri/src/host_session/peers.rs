use super::identity::write_private_json;
use super::pairing::{credential_hash, credential_hash_is_valid};
use super::Capability;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberedPeer {
    pub host_id: String,
    pub host_name: String,
    pub address: String,
    pub capabilities: Vec<Capability>,
    pub last_event_cursor: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub capabilities: Vec<Capability>,
    pub created_at: u64,
    pub last_seen_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncomingPeer {
    name: String,
    credential_hash: String,
    capabilities: Vec<Capability>,
    created_at: u64,
    last_seen_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerDocument {
    incoming: HashMap<String, IncomingPeer>,
    outgoing: HashMap<String, RememberedPeer>,
}

pub struct PeerStore {
    path: PathBuf,
    document: Mutex<PeerDocument>,
}

impl PeerStore {
    pub fn load_default() -> Self {
        Self::load(crate::state::workspace_path().with_file_name("host-peers.json"))
    }

    pub fn load(path: PathBuf) -> Self {
        let document = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            document: Mutex::new(document),
        }
    }

    pub fn register_incoming(
        &self,
        peer_id: &str,
        peer_name: &str,
        credential_hash: &str,
        capabilities: Vec<Capability>,
    ) -> Result<PairedDevice, String> {
        if !credential_hash_is_valid(credential_hash) {
            return Err("The connecting device credential hash is invalid".into());
        }
        let timestamp = unix_time();
        self.mutate(|document| {
            document.incoming.insert(
                peer_id.to_string(),
                IncomingPeer {
                    name: peer_name.to_string(),
                    credential_hash: credential_hash.to_string(),
                    capabilities: capabilities.clone(),
                    created_at: timestamp,
                    last_seen_at: timestamp,
                },
            );
        })?;
        Ok(PairedDevice {
            id: peer_id.to_string(),
            name: peer_name.to_string(),
            capabilities,
            created_at: timestamp,
            last_seen_at: timestamp,
        })
    }

    pub fn authenticate_incoming(
        &self,
        peer_id: &str,
        credential: &str,
    ) -> Result<Option<PairedDevice>, String> {
        let presented = credential_hash(credential);
        let mut document = self
            .document
            .lock()
            .map_err(|_| "Host credential store is unavailable".to_string())?;
        let Some(peer) = document.incoming.get(peer_id) else {
            return Ok(None);
        };
        if !constant_time_eq(peer.credential_hash.as_bytes(), presented.as_bytes()) {
            return Ok(None);
        }
        let mut next = document.clone();
        let timestamp = unix_time();
        if let Some(peer) = next.incoming.get_mut(peer_id) {
            peer.last_seen_at = timestamp;
        }
        self.save(&next)?;
        *document = next;
        Ok(document.incoming.get(peer_id).map(|peer| PairedDevice {
            id: peer_id.to_string(),
            name: peer.name.clone(),
            capabilities: peer.capabilities.clone(),
            created_at: peer.created_at,
            last_seen_at: peer.last_seen_at,
        }))
    }

    pub fn paired_devices(&self) -> Vec<PairedDevice> {
        let mut devices = self
            .document
            .lock()
            .map(|document| {
                document
                    .incoming
                    .iter()
                    .map(|(id, peer)| PairedDevice {
                        id: id.clone(),
                        name: peer.name.clone(),
                        capabilities: peer.capabilities.clone(),
                        created_at: peer.created_at,
                        last_seen_at: peer.last_seen_at,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        devices.sort_by_key(|device| std::cmp::Reverse(device.last_seen_at));
        devices
    }

    pub fn forget_incoming(&self, peer_id: &str) -> Result<(), String> {
        self.mutate(|document| {
            document.incoming.remove(peer_id);
        })
    }

    pub fn remember_outgoing(&self, peer: RememberedPeer) -> Result<(), String> {
        self.mutate(|document| {
            document.outgoing.insert(peer.host_id.clone(), peer);
        })
    }

    pub fn update_outgoing_cursor(&self, peer_id: &str, cursor: u64) -> Result<(), String> {
        self.mutate(|document| {
            if let Some(peer) = document.outgoing.get_mut(peer_id) {
                peer.last_event_cursor = peer.last_event_cursor.max(cursor);
            }
        })
    }

    pub fn forget_outgoing(&self, peer_id: &str) -> Result<(), String> {
        self.mutate(|document| {
            document.outgoing.remove(peer_id);
        })
    }

    pub fn outgoing(&self) -> Vec<RememberedPeer> {
        self.document
            .lock()
            .map(|document| document.outgoing.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn outgoing_peer(&self, peer_id: &str) -> Option<RememberedPeer> {
        self.document.lock().ok()?.outgoing.get(peer_id).cloned()
    }

    fn mutate(&self, mutate: impl FnOnce(&mut PeerDocument)) -> Result<(), String> {
        let mut document = self
            .document
            .lock()
            .map_err(|_| "Host credential store is unavailable".to_string())?;
        let mut next = document.clone();
        mutate(&mut next);
        self.save(&next)?;
        *document = next;
        Ok(())
    }

    fn save(&self, document: &PeerDocument) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create the Maxx data directory: {error}"))?;
        }
        write_private_json(&self.path, document)
    }
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn device_hashes_and_cursor_metadata_persist_without_raw_secrets() {
        let root = std::env::temp_dir().join(format!("maxx-peer-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("peers.json");
        let store = PeerStore::load(path.clone());
        let credential = super::super::generate_device_credential();
        store
            .register_incoming(
                "peer-a",
                "Peer A",
                &credential_hash(&credential),
                Capability::standard(),
            )
            .unwrap();
        assert!(store
            .authenticate_incoming("peer-a", &credential)
            .unwrap()
            .is_some());
        store
            .remember_outgoing(RememberedPeer {
                host_id: "host-b".into(),
                host_name: "Host B".into(),
                address: "mini.tail.ts.net:7422".into(),
                capabilities: Capability::standard(),
                last_event_cursor: 4,
            })
            .unwrap();
        store.update_outgoing_cursor("host-b", 9).unwrap();
        let bytes = fs::read_to_string(&path).unwrap();
        assert!(!bytes.contains(&credential));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let loaded = PeerStore::load(path);
        assert_eq!(loaded.outgoing_peer("host-b").unwrap().last_event_cursor, 9);
        fs::remove_dir_all(root).unwrap();
    }
}
