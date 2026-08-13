use super::identity::write_private_json;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostSettingsDocument {
    listen_enabled: bool,
}

pub struct HostSettingsStore {
    path: PathBuf,
    document: Mutex<HostSettingsDocument>,
}

impl HostSettingsStore {
    pub fn load_default() -> Self {
        Self::load(crate::state::workspace_path().with_file_name("host-settings.json"))
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

    pub fn listen_enabled(&self) -> bool {
        self.document
            .lock()
            .map(|document| document.listen_enabled)
            .unwrap_or(false)
    }

    pub fn set_listen_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut document = self
            .document
            .lock()
            .map_err(|_| "Host settings are unavailable".to_string())?;
        let next = HostSettingsDocument {
            listen_enabled: enabled,
        };
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
    use uuid::Uuid;

    #[test]
    fn listen_preference_persists_privately() {
        let root = std::env::temp_dir().join(format!("maxx-host-settings-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        let settings = HostSettingsStore::load(path.clone());
        assert!(!settings.listen_enabled());
        settings.set_listen_enabled(true).unwrap();
        assert!(HostSettingsStore::load(path.clone()).listen_enabled());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
