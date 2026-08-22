use super::identity::write_private_json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteWorkspaceDocument {
    workspaces: HashMap<String, Value>,
}

pub(crate) struct RemoteWorkspaceCache {
    path: PathBuf,
    document: Mutex<RemoteWorkspaceDocument>,
}

impl RemoteWorkspaceCache {
    pub(crate) fn load_default() -> Self {
        Self::load(crate::state::workspace_path().with_file_name("remote-workspaces.json"))
    }

    fn load(path: PathBuf) -> Self {
        let document = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            document: Mutex::new(document),
        }
    }

    pub(crate) fn get(&self, host_id: &str) -> Option<Value> {
        self.document.lock().ok()?.workspaces.get(host_id).cloned()
    }

    pub(crate) fn save(&self, host_id: &str, workspace: &Value) -> Result<(), String> {
        self.mutate(|document| {
            document
                .workspaces
                .insert(host_id.to_string(), workspace.clone());
        })
    }

    pub(crate) fn remove(&self, host_id: &str) -> Result<(), String> {
        self.mutate(|document| {
            document.workspaces.remove(host_id);
        })
    }

    fn mutate(&self, mutate: impl FnOnce(&mut RemoteWorkspaceDocument)) -> Result<(), String> {
        let mut document = self
            .document
            .lock()
            .map_err(|_| "Remote workspace cache is unavailable".to_string())?;
        let mut next = document.clone();
        mutate(&mut next);
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create the Maxx data directory: {error}"))?;
        }
        write_private_json(&self.path, &next)?;
        *document = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn cached_workspace_survives_restart_until_removed() {
        let root = std::env::temp_dir().join(format!("maxx-remote-cache-{}", Uuid::new_v4()));
        let path = root.join("remote-workspaces.json");
        let cache = RemoteWorkspaceCache::load(path.clone());
        let workspace = json!({"schemaVersion": 7, "projects": [{"id": "remote"}]});

        cache.save("mini", &workspace).unwrap();
        assert_eq!(
            RemoteWorkspaceCache::load(path.clone()).get("mini"),
            Some(workspace)
        );

        RemoteWorkspaceCache::load(path.clone())
            .remove("mini")
            .unwrap();
        assert_eq!(RemoteWorkspaceCache::load(path).get("mini"), None);
        fs::remove_dir_all(root).unwrap();
    }
}
