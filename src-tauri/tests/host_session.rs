use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use maxx_core::persist::{ChatImageAttachment, ChatProject, ChatThread, WorkspaceDocument};
use maxx_lib::host_session::{
    apply_add_project, connect_host, create_host_folder, credential_hash, hosted_projects,
    list_host_folder, listen_host, parse_bind_address, read_media_bytes, resolve_project_folder,
    store_media_bytes, AuthRequest, AuthenticatedPeer, Capability, ClientAuth, EventJournal,
    HostAuthenticator, HostCatalog, HostHandler, HostInfo, LOCAL_HOST_ID,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as SyncMutex};
use tokio::sync::Mutex;
use uuid::Uuid;

struct TestAuthenticator {
    code: String,
    credentials: SyncMutex<HashMap<String, String>>,
}

impl TestAuthenticator {
    fn new(token: &str) -> Arc<Self> {
        Arc::new(Self {
            code: token.into(),
            credentials: SyncMutex::new(HashMap::new()),
        })
    }
}

impl HostAuthenticator for TestAuthenticator {
    fn authenticate(
        &self,
        _source: SocketAddr,
        peer_id: &str,
        peer_name: &str,
        auth: AuthRequest,
    ) -> Result<AuthenticatedPeer, String> {
        match auth {
            AuthRequest::Pairing {
                code,
                credential_hash,
            } if code == self.code => {
                self.credentials
                    .lock()
                    .map_err(|_| "credential store unavailable".to_string())?
                    .insert(peer_id.to_string(), credential_hash);
            }
            AuthRequest::Credential(credential)
                if self
                    .credentials
                    .lock()
                    .map_err(|_| "credential store unavailable".to_string())?
                    .get(peer_id)
                    .is_some_and(|expected| *expected == credential_hash(&credential)) => {}
            _ => return Err("The pairing code or device credential was rejected".into()),
        }
        Ok(AuthenticatedPeer {
            id: peer_id.into(),
            name: peer_name.into(),
            capabilities: Capability::standard(),
        })
    }
}

struct TestHost {
    persist: PathBuf,
    media: PathBuf,
    known_folders: Mutex<HashSet<String>>,
    catalog: Mutex<HostCatalog>,
    events: Arc<EventJournal>,
}

impl TestHost {
    fn new(name: &str, root: PathBuf) -> Arc<Self> {
        std::fs::create_dir_all(&root).unwrap();
        let persist = root.join("workspace.json");
        let media = root.join("chat-images");
        std::fs::create_dir_all(&media).unwrap();
        let workspace = WorkspaceDocument::default();
        save_workspace(&persist, &workspace);
        Arc::new(Self {
            persist,
            media,
            known_folders: Mutex::new(HashSet::new()),
            catalog: Mutex::new(HostCatalog::new(HostInfo::local(name), workspace)),
            events: Arc::new(EventJournal::load(root.join("host-events.jsonl"))),
        })
    }

    fn local_bytes(&self) -> Vec<u8> {
        std::fs::read(&self.persist).unwrap()
    }

    async fn snapshot(&self) -> WorkspaceDocument {
        self.catalog.lock().await.local_workspace().clone()
    }

    async fn remember_folder(&self, path: String) -> String {
        let canonical = PathBuf::from(&path)
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        self.known_folders.lock().await.insert(canonical.clone());
        canonical
    }
}

#[async_trait]
impl HostHandler for TestHost {
    async fn handle(
        &self,
        _peer: &AuthenticatedPeer,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        match method {
            "workspace_snapshot" => {
                serde_json::to_value(self.snapshot().await).map_err(|error| error.to_string())
            }
            "list_folder" => {
                let path = params
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("missing path")?;
                let entries = list_host_folder(path)?;
                let mut known = self.known_folders.lock().await;
                for entry in &entries {
                    if entry.kind == "directory" {
                        known.insert(entry.path.clone());
                    }
                }
                serde_json::to_value(entries).map_err(|error| error.to_string())
            }
            "create_folder" => {
                let parent = params
                    .get("parent")
                    .and_then(Value::as_str)
                    .ok_or("missing parent")?;
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("missing name")?;
                let created = create_host_folder(parent, name)?;
                self.known_folders.lock().await.insert(created.clone());
                Ok(json!({ "path": created }))
            }
            "add_project" => {
                let folder = params
                    .get("folderPath")
                    .and_then(Value::as_str)
                    .ok_or("missing folderPath")?;
                let known: Vec<String> = self.known_folders.lock().await.iter().cloned().collect();
                let folder = resolve_project_folder(folder, &known)?;
                let mut catalog = self.catalog.lock().await;
                let project = apply_add_project(catalog.local_workspace_mut(), folder);
                save_workspace(&self.persist, catalog.local_workspace());
                serde_json::to_value(project).map_err(|error| error.to_string())
            }
            "upload_media" => {
                let encoded = params
                    .get("dataBase64")
                    .and_then(Value::as_str)
                    .ok_or("missing dataBase64")?;
                let mime = params
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png");
                let name = params
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or("Image");
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|error| format!("invalid image: {error}"))?;
                let attachment = store_media_bytes(&self.media, &bytes, mime, name)?;
                serde_json::to_value(attachment).map_err(|error| error.to_string())
            }
            "read_media" => {
                let id = params
                    .get("attachmentId")
                    .and_then(Value::as_str)
                    .ok_or("missing attachmentId")?;
                let id = Uuid::parse_str(id).map_err(|_| "invalid attachmentId".to_string())?;
                let (bytes, mime, name) = read_media_bytes(&self.media, id)?;
                Ok(json!({
                    "id": id,
                    "mimeType": mime,
                    "displayName": name,
                    "dataBase64": STANDARD.encode(bytes),
                }))
            }
            "send_prompt" => {
                let project_id = params
                    .get("projectId")
                    .and_then(Value::as_str)
                    .ok_or("missing projectId")?;
                let thread_id = params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .ok_or("missing threadId")?;
                let attachment_ids = params
                    .get("attachmentIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut attachments = Vec::new();
                for value in attachment_ids {
                    let id = Uuid::parse_str(value.as_str().ok_or("invalid attachmentId")?)
                        .map_err(|_| "invalid attachmentId".to_string())?;
                    let (bytes, mime, name) = read_media_bytes(&self.media, id)?;
                    let _ = bytes;
                    attachments.push(ChatImageAttachment {
                        id,
                        path: format!("attachment:{id}"),
                        mime_type: mime,
                        display_name: name,
                    });
                }
                let mut catalog = self.catalog.lock().await;
                let workspace = catalog.local_workspace_mut();
                let project = workspace
                    .projects
                    .iter_mut()
                    .find(|project| project.id.to_string() == project_id)
                    .ok_or("Unknown project")?;
                let thread = project
                    .threads
                    .iter_mut()
                    .find(|thread| thread.id.to_string() == thread_id)
                    .ok_or("Unknown thread")?;
                let mut message = maxx_core::persist::ChatMessage {
                    id: Uuid::new_v4(),
                    role: maxx_core::persist::ChatRole::User,
                    content: params
                        .get("prompt")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    attachments,
                    annotations: Vec::new(),
                    text_selections: Vec::new(),
                    created_at: maxx_core::AppleDate::now(),
                    source_event_id: None,
                    agent_id: None,
                };
                let _ = &mut message;
                thread.messages.push(message);
                save_workspace(&self.persist, workspace);
                let turn_id = Uuid::new_v4();
                self.events.emit(
                    "turn://finished",
                    json!({
                        "projectID": project_id,
                        "threadID": thread_id,
                        "turnID": turn_id,
                        "terminalState": "completed",
                    }),
                )?;
                Ok(json!(turn_id))
            }
            other => Err(format!("unknown method {other}")),
        }
    }
}

fn save_workspace(path: &PathBuf, workspace: &WorkspaceDocument) {
    std::fs::write(path, serde_json::to_vec_pretty(workspace).unwrap()).unwrap();
}

#[tokio::test]
async fn loopback_two_sessions_keep_workspaces_distinct() {
    let root = std::env::temp_dir().join(format!("maxx-loopback-{}", Uuid::new_v4()));
    let host_a_dir = root.join("a");
    let host_b_dir = root.join("b");
    let project_a = host_a_dir.join("code");
    let project_b = host_b_dir.join("notes");
    std::fs::create_dir_all(&project_a).unwrap();
    std::fs::create_dir_all(&project_b).unwrap();

    let host_a = TestHost::new("Mac mini", host_a_dir.clone());
    let host_b = TestHost::new("MacBook Pro", host_b_dir.clone());
    host_a
        .remember_folder(project_a.to_string_lossy().into_owned())
        .await;
    host_b
        .remember_folder(project_b.to_string_lossy().into_owned())
        .await;
    apply_add_project(
        host_a.catalog.lock().await.local_workspace_mut(),
        host_a
            .remember_folder(project_a.to_string_lossy().into_owned())
            .await,
    );
    apply_add_project(
        host_b.catalog.lock().await.local_workspace_mut(),
        host_b
            .remember_folder(project_b.to_string_lossy().into_owned())
            .await,
    );
    save_workspace(
        &host_a.persist,
        host_a.catalog.lock().await.local_workspace(),
    );
    save_workspace(
        &host_b.persist,
        host_b.catalog.lock().await.local_workspace(),
    );

    let local_a_before = host_a.local_bytes();
    let local_b_before = host_b.local_bytes();

    let token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    let bind = parse_bind_address("127.0.0.1:0").unwrap();
    assert_eq!(bind.ip().to_string(), "127.0.0.1");
    let tailnet_bind = parse_bind_address("100.64.0.12:7422").unwrap();
    assert_eq!(tailnet_bind.to_string(), "100.64.0.12:7422");

    let listener = listen_host(
        bind,
        "127.0.0.1:0".into(),
        TestAuthenticator::new(token),
        "host-a".into(),
        "Mac mini".into(),
        host_a.clone(),
        host_a.events.clone(),
    )
    .await
    .unwrap();
    let address = listener.bind_address();

    let unauthenticated = connect_host(
        &address,
        ClientAuth::PairingCode("wrong-token".into()),
        "host-b",
        "MacBook Pro",
        0,
    )
    .await;
    assert!(
        unauthenticated.is_err(),
        "missing/wrong token must be rejected"
    );
    let missing = connect_host(
        &address,
        ClientAuth::PairingCode(String::new()),
        "host-b",
        "MacBook Pro",
        0,
    )
    .await;
    assert!(missing.is_err(), "empty token must be rejected");

    let client = connect_host(
        &address,
        ClientAuth::PairingCode(token.into()),
        "host-b",
        "MacBook Pro",
        0,
    )
    .await
    .expect("valid token is accepted");
    assert_eq!(client.host_name, "Mac mini");

    let remote_snapshot: WorkspaceDocument = serde_json::from_value(
        client
            .request("workspace_snapshot", json!({}))
            .await
            .unwrap(),
    )
    .unwrap();
    let mut catalog_b = host_b.catalog.lock().await;
    catalog_b
        .attach_remote(
            HostInfo::remote(
                client.host_id.clone(),
                client.host_name.clone(),
                address.clone(),
            ),
            remote_snapshot.clone(),
        )
        .unwrap();
    let together = hosted_projects(&catalog_b);
    assert!(together.iter().any(|item| item.host_id == LOCAL_HOST_ID));
    assert!(together.iter().any(|item| item.host_id == client.host_id));
    drop(catalog_b);

    assert_eq!(
        host_b.local_bytes(),
        local_b_before,
        "attaching a remote must not rewrite the local document"
    );

    let listed: Vec<maxx_lib::host_session::FolderEntry> = serde_json::from_value(
        client
            .request(
                "list_folder",
                json!({ "path": host_a_dir.to_string_lossy() }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    let created = client
        .request(
            "create_folder",
            json!({ "parent": host_a_dir.to_string_lossy(), "name": "imported" }),
        )
        .await
        .unwrap();
    let created_path = created
        .get("path")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    assert!(
        listed.iter().any(|entry| entry.path.contains("code"))
            || PathBuf::from(&created_path).exists()
    );
    let added = client
        .request("add_project", json!({ "folderPath": created_path }))
        .await
        .unwrap();
    let added_path = added.get("folderPath").and_then(Value::as_str).unwrap();
    assert!(added_path.contains("imported"));
    assert!(
        client
            .request(
                "add_project",
                json!({ "folderPath": project_b.to_string_lossy() })
            )
            .await
            .is_err(),
        "host A must not store a folder that only exists on host B"
    );

    let uploaded = client
        .request(
            "upload_media",
            json!({
                "dataBase64": STANDARD.encode(b"png-bytes"),
                "mimeType": "image/png",
                "displayName": "shot.png",
            }),
        )
        .await
        .unwrap();
    let attachment_id = uploaded
        .get("id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    let read = client
        .request("read_media", json!({ "attachmentId": attachment_id }))
        .await
        .unwrap();
    assert_eq!(
        STANDARD
            .decode(read.get("dataBase64").and_then(Value::as_str).unwrap())
            .unwrap(),
        b"png-bytes"
    );

    let remote_after: WorkspaceDocument = serde_json::from_value(
        client
            .request("workspace_snapshot", json!({}))
            .await
            .unwrap(),
    )
    .unwrap();
    let project = remote_after
        .projects
        .iter()
        .find(|project| project.folder_path.contains("imported"))
        .cloned()
        .unwrap();
    let thread = ChatThread::new(
        "Loopback".into(),
        maxx_core::contract::ChatProvider::Codex,
        "default".into(),
    );
    let thread_id = thread.id;
    {
        let mut catalog = host_a.catalog.lock().await;
        if let Some(target) = catalog
            .local_workspace_mut()
            .projects
            .iter_mut()
            .find(|item| item.id == project.id)
        {
            target.threads.push(thread);
        }
        save_workspace(&host_a.persist, catalog.local_workspace());
    }
    let _ = thread_id;
    client
        .request(
            "send_prompt",
            json!({
                "projectId": project.id,
                "threadId": thread_id,
                "prompt": "see image",
                "attachmentIds": [attachment_id],
            }),
        )
        .await
        .unwrap();
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), client.next_event())
        .await
        .expect("peer should receive a host-emitted event")
        .expect("event stream should stay open");
    assert_eq!(event.event, "turn://finished");
    let expected_thread = thread_id.to_string();
    assert_eq!(
        event.payload.get("threadID").and_then(Value::as_str),
        Some(expected_thread.as_str())
    );
    let prompted: WorkspaceDocument = serde_json::from_value(
        client
            .request("workspace_snapshot", json!({}))
            .await
            .unwrap(),
    )
    .unwrap();
    let stored = prompted
        .projects
        .iter()
        .flat_map(|item| &item.threads)
        .flat_map(|item| &item.messages)
        .flat_map(|item| &item.attachments)
        .next()
        .expect("prompt should leave a host-owned attachment");
    assert_eq!(
        stored.id.to_string(),
        uploaded.get("id").and_then(Value::as_str).unwrap()
    );

    host_b
        .catalog
        .lock()
        .await
        .detach_remote(&client.host_id)
        .unwrap();
    assert_eq!(
        host_b.local_bytes(),
        local_b_before,
        "detaching the remote must leave the local document byte-for-byte unchanged"
    );
    assert_ne!(
        host_a.local_bytes(),
        local_a_before,
        "host A should have its own mutations"
    );
    assert!(!host_b
        .snapshot()
        .await
        .projects
        .iter()
        .any(|item| item.folder_path.contains("imported")));

    listener.stop().await;
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn hosted_project_paths_stay_on_their_own_host() {
    let mut catalog = HostCatalog::new(HostInfo::local("This Mac"), WorkspaceDocument::default());
    apply_add_project(catalog.local_workspace_mut(), "/Users/scott/macbook".into());
    let mut remote = WorkspaceDocument::default();
    remote.projects.push(ChatProject {
        id: Uuid::new_v4(),
        folder_path: "/Users/scott/mini".into(),
        threads: Vec::new(),
    });
    catalog
        .attach_remote(
            HostInfo::remote("mini", "Mac mini", "100.64.0.2:7422"),
            remote,
        )
        .unwrap();
    let projects = hosted_projects(&catalog);
    assert_eq!(projects[0].project.folder_path, "/Users/scott/macbook");
    assert_eq!(projects[1].project.folder_path, "/Users/scott/mini");
    catalog.detach_remote("mini").unwrap();
    assert_eq!(
        catalog.local_workspace().projects[0].folder_path,
        "/Users/scott/macbook"
    );
}

struct EchoHost;

#[async_trait]
impl HostHandler for EchoHost {
    async fn handle(
        &self,
        _peer: &AuthenticatedPeer,
        method: &str,
        _params: Value,
    ) -> Result<Value, String> {
        Ok(json!({ "method": method }))
    }
}

struct SlowHost;

#[async_trait]
impl HostHandler for SlowHost {
    async fn handle(
        &self,
        _peer: &AuthenticatedPeer,
        _method: &str,
        _params: Value,
    ) -> Result<Value, String> {
        std::future::pending().await
    }
}

fn test_journal() -> (Arc<EventJournal>, PathBuf) {
    let root = std::env::temp_dir().join(format!("maxx-host-events-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    (
        Arc::new(EventJournal::load(root.join("events.jsonl"))),
        root,
    )
}

#[tokio::test]
async fn listen_connection_receives_events_the_host_emits() {
    let (events, root) = test_journal();
    let listener = listen_host(
        parse_bind_address("127.0.0.1:0").unwrap(),
        "127.0.0.1:0".into(),
        TestAuthenticator::new("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        "host-a".into(),
        "Mac mini".into(),
        Arc::new(EchoHost),
        events.clone(),
    )
    .await
    .unwrap();
    let client = connect_host(
        &listener.bind_address(),
        ClientAuth::PairingCode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
        "host-b",
        "MacBook Pro",
        0,
    )
    .await
    .unwrap();
    let _ = client
        .request("workspace_snapshot", json!({}))
        .await
        .unwrap();
    events
        .emit(
            "runtime://event",
            json!({"projectID": "p", "threadID": "t", "kind": "assistant.text.delta"}),
        )
        .unwrap();
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), client.next_event())
        .await
        .expect("HostClient.next_event must see a frame the host emitted")
        .expect("event stream should stay open");
    assert_eq!(event.event, "runtime://event");
    assert_eq!(event.cursor, 1);
    assert_eq!(
        event.payload.get("threadID").and_then(Value::as_str),
        Some("t")
    );
    listener.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn listener_stop_closes_existing_sessions_and_fails_pending_requests() {
    let token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let (events, root) = test_journal();
    let listener = listen_host(
        parse_bind_address("127.0.0.1:0").unwrap(),
        "127.0.0.1:0".into(),
        TestAuthenticator::new(token),
        "host-a".into(),
        "Mac mini".into(),
        Arc::new(SlowHost),
        events,
    )
    .await
    .unwrap();
    let client = connect_host(
        &listener.bind_address(),
        ClientAuth::PairingCode(token.into()),
        "host-b",
        "MacBook Pro",
        0,
    )
    .await
    .unwrap();
    let pending_client = client.clone();
    let pending = tokio::spawn(async move { pending_client.request("slow", json!({})).await });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    listener.stop().await;
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), pending)
        .await
        .expect("listener shutdown should wake a pending request")
        .unwrap();
    assert!(result.is_err());
    assert!(client.is_closed());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn duplicate_listener_reports_the_duplicate_build_remedy() {
    let (events, root) = test_journal();
    let listener = listen_host(
        parse_bind_address("127.0.0.1:0").unwrap(),
        "127.0.0.1:0".into(),
        TestAuthenticator::new("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        "host-a".into(),
        "Mac mini".into(),
        Arc::new(EchoHost),
        events.clone(),
    )
    .await
    .unwrap();
    assert_eq!(listener.share_address(), listener.bind_address());
    assert!(!listener.share_address().ends_with(":0"));
    let duplicate = listen_host(
        parse_bind_address(&listener.bind_address()).unwrap(),
        listener.share_address(),
        TestAuthenticator::new("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        "host-b".into(),
        "Duplicate Mac mini".into(),
        Arc::new(EchoHost),
        events,
    )
    .await;
    let duplicate = match duplicate {
        Ok(handle) => {
            handle.stop().await;
            panic!("a duplicate listener must not bind the same address");
        }
        Err(error) => error,
    };

    assert!(duplicate.contains("another Maxx build"));
    assert!(duplicate.contains("Quit the duplicate build"));
    listener.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn client_credential_reconnects_and_replays_from_the_last_cursor() {
    let token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let (events, root) = test_journal();
    let listener = listen_host(
        parse_bind_address("127.0.0.1:0").unwrap(),
        "127.0.0.1:0".into(),
        TestAuthenticator::new(token),
        "host-a".into(),
        "Mac mini".into(),
        Arc::new(EchoHost),
        events.clone(),
    )
    .await
    .unwrap();
    let first = connect_host(
        &listener.bind_address(),
        ClientAuth::PairingCode(token.into()),
        "host-b",
        "MacBook Pro",
        0,
    )
    .await
    .unwrap();
    let credential = first
        .new_credential
        .clone()
        .expect("the connecting client should retain its credential");
    events.emit("one", json!({"n":1})).unwrap();
    let first_event = first.next_event().await.unwrap();
    assert_eq!(first_event.cursor, 1);
    first.close().await;
    events.emit("two", json!({"n":2})).unwrap();
    let restored = connect_host(
        &listener.bind_address(),
        ClientAuth::DeviceCredential(credential),
        "host-b",
        "MacBook Pro",
        first_event.cursor,
    )
    .await
    .unwrap();
    assert!(restored.new_credential.is_none());
    let replayed = restored.next_event().await.unwrap();
    assert_eq!(replayed.event, "two");
    assert_eq!(replayed.cursor, 2);
    listener.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}
