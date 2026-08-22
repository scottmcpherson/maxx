use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[derive(Default)]
pub struct FolderAuthorizations {
    known: Mutex<HashMap<String, HashSet<String>>>,
}

impl FolderAuthorizations {
    pub async fn remember_home(&self, peer_id: &str, path: &str) {
        self.remember(
            peer_id,
            Path::new(path)
                .ancestors()
                .map(|ancestor| ancestor.to_string_lossy().into_owned()),
        )
        .await;
    }

    pub async fn remember_listing(&self, peer_id: &str, root: String, entries: &[FolderEntry]) {
        self.remember(
            peer_id,
            std::iter::once(root).chain(
                entries
                    .iter()
                    .filter(|entry| entry.kind == "directory")
                    .map(|entry| entry.path.clone()),
            ),
        )
        .await;
    }

    pub async fn remember_created(&self, peer_id: &str, path: String) {
        self.remember(peer_id, [path]).await;
    }

    pub async fn authorize(&self, peer_id: &str, requested: &str) -> Result<String, String> {
        let known = self
            .known
            .lock()
            .await
            .get(peer_id)
            .map(|paths| paths.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        resolve_project_folder(requested, &known)
    }

    async fn remember(&self, peer_id: &str, paths: impl IntoIterator<Item = String>) {
        self.known
            .lock()
            .await
            .entry(peer_id.to_string())
            .or_default()
            .extend(paths);
    }
}

pub fn home_folder() -> Result<String, String> {
    dirs::home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| "The home folder is unavailable".into())
}

pub fn list_host_folder(path: &str) -> Result<Vec<FolderEntry>, String> {
    let root = canonicalize_dir(path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| format!("Could not read {path}: {error}"))? {
        let entry = entry.map_err(|error| format!("Could not read {path}: {error}"))?;
        let child = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect {}: {error}", child.display()))?;
        if file_type.is_symlink() {
            continue;
        }
        let kind = if file_type.is_dir() {
            "directory".to_string()
        } else if file_type.is_file() {
            "file".to_string()
        } else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        entries.push(FolderEntry {
            name,
            path: child.to_string_lossy().into_owned(),
            kind,
        });
    }
    entries.sort_by(|left, right| {
        left.kind.cmp(&right.kind).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        })
    });
    Ok(entries)
}

pub fn create_host_folder(parent: &str, name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
    {
        return Err("Choose a simple folder name".into());
    }
    let parent = canonicalize_dir(parent)?;
    let created = parent.join(trimmed);
    if created.exists() {
        return Err(format!("{trimmed} already exists"));
    }
    fs::create_dir(&created).map_err(|error| format!("Could not create {trimmed}: {error}"))?;
    Ok(created.to_string_lossy().into_owned())
}

/// A project folder must be a directory this host listed or just created.
pub fn resolve_project_folder(
    requested: &str,
    listed_or_created: &[String],
) -> Result<String, String> {
    let requested = canonicalize_dir(requested)?;
    let allowed = listed_or_created.iter().any(|candidate| {
        PathBuf::from(candidate)
            .canonicalize()
            .ok()
            .is_some_and(|canonical| canonical == requested)
    });
    if !allowed {
        return Err("Choose a folder on this host".into());
    }
    Ok(requested.to_string_lossy().into_owned())
}

fn canonicalize_dir(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let canonical = path
        .canonicalize()
        .map_err(|_| "The folder is not on this host".to_string())?;
    if !canonical.is_dir() {
        return Err("The path is not a folder".into());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn add_project_records_only_a_path_this_host_listed_or_created() {
        let root = std::env::temp_dir().join(format!("maxx-host-fs-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("listed")).unwrap();
        let created = create_host_folder(root.to_str().unwrap(), "created").unwrap();
        let listed = list_host_folder(root.to_str().unwrap()).unwrap();
        let listed_paths: Vec<String> = listed
            .into_iter()
            .map(|entry| entry.path)
            .chain(std::iter::once(created.clone()))
            .collect();

        let accepted = resolve_project_folder(&created, &listed_paths).unwrap();
        assert_eq!(
            PathBuf::from(&accepted).canonicalize().unwrap(),
            PathBuf::from(&created).canonicalize().unwrap()
        );

        let outsider = std::env::temp_dir().join(format!("maxx-host-other-{}", Uuid::new_v4()));
        fs::create_dir_all(&outsider).unwrap();
        assert!(resolve_project_folder(outsider.to_str().unwrap(), &listed_paths).is_err());

        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outsider).unwrap();
    }

    #[tokio::test]
    async fn folder_authorization_is_scoped_to_the_peer_that_navigated_there() {
        let root = std::env::temp_dir().join(format!("maxx-host-auth-{}", Uuid::new_v4()));
        let child = root.join("child");
        fs::create_dir_all(&child).unwrap();
        let entries = list_host_folder(root.to_str().unwrap()).unwrap();
        let authorizations = FolderAuthorizations::default();
        authorizations
            .remember_home("peer-a", root.to_str().unwrap())
            .await;
        let root_path = authorizations
            .authorize("peer-a", root.to_str().unwrap())
            .await
            .unwrap();
        authorizations
            .remember_listing("peer-a", root_path, &entries)
            .await;
        assert!(authorizations
            .authorize("peer-a", child.to_str().unwrap())
            .await
            .is_ok());
        assert!(authorizations
            .authorize("peer-b", child.to_str().unwrap())
            .await
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
