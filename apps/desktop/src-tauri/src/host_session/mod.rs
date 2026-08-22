//! Additive remote hosts: pairing, listen/connect, folder ownership, and
//! media-by-id. A remote session never writes into the local workspace
//! document; every mutation is addressed to one host.

mod catalog;
mod credentials;
mod discovery;
mod folders;
mod hub;
mod identity;
mod journal;
mod media;
mod net;
mod pairing;
mod peers;
mod protocol;
mod settings;
mod workspace_cache;

pub use catalog::{
    apply_add_project, deduplicate_project_folders, hosted_projects, HostCatalog, HostInfo,
    HostKind, HostedProject, LOCAL_HOST_ID,
};
pub use credentials::{CredentialStore, KeychainCredentialStore, MemoryCredentialStore};
pub use discovery::{
    is_protected_ip, resolve_endpoint, self_endpoint, tailscale_discovery, SelfEndpoint,
    TailscaleDiscovery, TailscaleNode,
};
pub use folders::{
    create_host_folder, home_folder, list_host_folder, resolve_project_folder,
    FolderAuthorizations, FolderEntry,
};
pub use hub::{HostHub, HostStatus, RemoteHostStatus};
pub use identity::HostIdentity;
pub use journal::{EventJournal, JournalEvent, JournalSubscription};
pub use media::{
    attachment_from_id, read_media_bytes, remove_media_bytes, store_media_bytes, write_attachment_metadata,
    MediaContent, DEFAULT_LISTEN_PORT,
};
pub use net::{
    connect_host, listen_host, parse_bind_address, AuthRequest, AuthenticatedPeer, ClientAuth,
    HostAuthenticator, HostClient, HostHandler, ListenHandle, RemoteEvent,
};
pub use pairing::{
    credential_hash, credential_hash_is_valid, generate_device_credential, normalize_pairing_code,
    PairingInvitation, PairingManager,
};
pub use peers::{PairedDevice, PeerStore, RememberedPeer};
pub use protocol::{
    has_capability, required_capability, AccessPreset, Capability, PROTOCOL_NAME, PROTOCOL_VERSION,
};
pub use settings::HostSettingsStore;
