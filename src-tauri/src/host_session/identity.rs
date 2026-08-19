use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostIdentity {
    pub id: String,
    pub name: String,
}

impl HostIdentity {
    pub fn path() -> PathBuf {
        crate::state::workspace_path().with_file_name("host-identity.json")
    }

    pub fn load_or_create() -> Self {
        let path = Self::path();
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(identity) = serde_json::from_slice::<HostIdentity>(&bytes) {
                if !identity.id.is_empty() && !identity.name.is_empty() {
                    let _ = identity.save();
                    return identity;
                }
            }
        }
        let identity = Self {
            id: Uuid::new_v4().to_string(),
            name: default_host_name(),
        };
        let _ = identity.save();
        identity
    }

    pub fn save(&self) -> Result<(), String> {
        if let Some(parent) = Self::path().parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create the Maxx data directory: {error}"))?;
        }
        write_private_json(&Self::path(), self)
    }
}

pub(crate) fn write_private_json<T: Serialize>(
    path: &std::path::Path,
    value: &T,
) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not encode protected Maxx data: {error}"))?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Could not store protected Maxx data: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect Maxx data: {error}"))?;
    }
    file.write_all(&json)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not store protected Maxx data: {error}"))
}

fn default_host_name() -> String {
    if let Ok(output) = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
    {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    "This computer".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_lives_outside_the_workspace_document() {
        assert_eq!(
            HostIdentity::path()
                .file_name()
                .and_then(|name| name.to_str()),
            Some("host-identity.json")
        );
    }
}
