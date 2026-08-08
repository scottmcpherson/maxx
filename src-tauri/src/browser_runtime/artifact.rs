use super::{BrowserArtifactRef, BrowserRuntimeError};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone)]
struct ArtifactRecord {
    reference: BrowserArtifactRef,
    path: PathBuf,
    sha256: String,
    owner_session_id: Uuid,
    tab_id: Uuid,
}

/// Content-addressed browser artifacts rooted outside the remote page. MCP
/// results carry `maxx-browser://artifact/<id>` references instead of base64.
pub struct BrowserArtifactStore {
    root: PathBuf,
    records: Mutex<HashMap<Uuid, ArtifactRecord>>,
}

impl BrowserArtifactStore {
    pub fn new(root: PathBuf) -> Result<Self, BrowserRuntimeError> {
        fs::create_dir_all(&root).map_err(|error| {
            BrowserRuntimeError::new(
                "browser.artifact-io",
                format!("could not create browser artifact directory: {error}"),
            )
        })?;
        Ok(Self {
            root,
            records: Mutex::new(HashMap::new()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn store(
        &self,
        owner_session_id: Uuid,
        tab_id: Uuid,
        bytes: &[u8],
        mime_type: impl Into<String>,
        extension: &str,
        title: Option<String>,
    ) -> Result<BrowserArtifactRef, BrowserRuntimeError> {
        let id = Uuid::new_v4();
        let safe_extension = sanitize_extension(extension)?;
        let filename = format!("{id}.{safe_extension}");
        let path = self.root.join(filename);
        fs::write(&path, bytes).map_err(|error| {
            BrowserRuntimeError::new(
                "browser.artifact-io",
                format!("could not write browser artifact: {error}"),
            )
        })?;
        let reference = BrowserArtifactRef {
            id,
            uri: format!("maxx-browser://artifact/{id}"),
            mime_type: mime_type.into(),
            byte_length: bytes.len() as u64,
            title,
        };
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        self.records
            .lock()
            .expect("browser artifact mutex poisoned")
            .insert(
                id,
                ArtifactRecord {
                    reference: reference.clone(),
                    path,
                    sha256,
                    owner_session_id,
                    tab_id,
                },
            );
        Ok(reference)
    }

    pub fn read(
        &self,
        id: Uuid,
        owner_session_id: Uuid,
        assigned_tabs: &HashSet<Uuid>,
    ) -> Result<(BrowserArtifactRef, Vec<u8>, String), BrowserRuntimeError> {
        let record = self
            .records
            .lock()
            .expect("browser artifact mutex poisoned")
            .get(&id)
            .cloned()
            .ok_or_else(|| {
                BrowserRuntimeError::new(
                    "browser.artifact-not-found",
                    "browser artifact does not exist",
                )
            })?;
        if record.owner_session_id != owner_session_id || !assigned_tabs.contains(&record.tab_id) {
            return Err(BrowserRuntimeError::new(
                "browser.artifact-denied",
                "browser artifact belongs to a different provider session",
            ));
        }
        let bytes = fs::read(&record.path).map_err(|error| {
            BrowserRuntimeError::new(
                "browser.artifact-io",
                format!("could not read browser artifact: {error}"),
            )
        })?;
        Ok((record.reference, bytes, record.sha256))
    }

    /// Reads a durable artifact after the caller has independently verified
    /// that its canonical runtime event belongs to the requesting thread.
    pub fn read_persisted_image(
        &self,
        id: Uuid,
        mime_type: &str,
        expected_byte_length: u64,
    ) -> Result<Vec<u8>, BrowserRuntimeError> {
        let extension = match mime_type {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => {
                return Err(BrowserRuntimeError::new(
                    "browser.artifact-denied",
                    "browser artifact is not a supported image",
                ));
            }
        };
        let path = self.root.join(format!("{id}.{extension}"));
        let bytes = fs::read(path).map_err(|error| {
            BrowserRuntimeError::new(
                "browser.artifact-io",
                format!("could not read browser artifact: {error}"),
            )
        })?;
        if bytes.len() as u64 != expected_byte_length {
            return Err(BrowserRuntimeError::new(
                "browser.artifact-integrity",
                "browser artifact size does not match its persisted reference",
            ));
        }
        Ok(bytes)
    }
}

fn sanitize_extension(extension: &str) -> Result<&str, BrowserRuntimeError> {
    let extension = extension.trim_start_matches('.');
    if extension.is_empty()
        || extension.len() > 12
        || !extension
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(BrowserRuntimeError::new(
            "browser.invalid-artifact-extension",
            "artifact extension must be 1-12 ASCII letters or digits",
        ));
    }
    Ok(extension)
}

pub fn redact_header(name: &str, value: &str) -> String {
    if matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
    ) {
        "[REDACTED]".into()
    } else {
        value.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifacts_are_referenced_and_integrity_checked() {
        let root = std::env::temp_dir().join(format!("maxx-artifact-test-{}", Uuid::new_v4()));
        let store = BrowserArtifactStore::new(root.clone()).expect("store");
        let reference = store
            .store(
                Uuid::nil(),
                Uuid::nil(),
                b"png-data",
                "image/png",
                "png",
                Some("Screenshot".into()),
            )
            .expect("artifact");
        assert!(reference.uri.starts_with("maxx-browser://artifact/"));
        assert_eq!(reference.byte_length, 8);
        let (stored, bytes, sha256) = store
            .read(
                reference.id,
                Uuid::nil(),
                &[Uuid::nil()].into_iter().collect(),
            )
            .expect("read");
        assert_eq!(stored, reference);
        assert_eq!(bytes, b"png-data");
        assert_eq!(sha256.len(), 64);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn persisted_images_are_read_by_scoped_reference_without_session_state() {
        let root = std::env::temp_dir().join(format!("maxx-artifact-test-{}", Uuid::new_v4()));
        let store = BrowserArtifactStore::new(root.clone()).expect("store");
        let reference = store
            .store(
                Uuid::new_v4(),
                Uuid::new_v4(),
                b"png-data",
                "image/png",
                "png",
                Some("Screenshot".into()),
            )
            .expect("artifact");

        assert_eq!(
            store
                .read_persisted_image(reference.id, &reference.mime_type, reference.byte_length)
                .expect("persisted read"),
            b"png-data"
        );
        assert_eq!(
            store
                .read_persisted_image(
                    reference.id,
                    &reference.mime_type,
                    reference.byte_length + 1
                )
                .expect_err("length mismatch")
                .code,
            "browser.artifact-integrity"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn artifacts_are_scoped_to_the_creating_provider_session() {
        let root = std::env::temp_dir().join(format!("maxx-artifact-test-{}", Uuid::new_v4()));
        let store = BrowserArtifactStore::new(root.clone()).expect("store");
        let owner = Uuid::new_v4();
        let reference = store
            .store(
                owner,
                Uuid::new_v4(),
                b"trace",
                "application/json",
                "json",
                None,
            )
            .expect("artifact");
        assert_eq!(
            store
                .read(
                    reference.id,
                    Uuid::new_v4(),
                    &[Uuid::new_v4()].into_iter().collect()
                )
                .expect_err("cross-session read denied")
                .code,
            "browser.artifact-denied"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn path_traversal_extensions_and_secret_headers_are_rejected() {
        assert!(sanitize_extension("../json").is_err());
        assert_eq!(
            redact_header("Authorization", "Bearer secret"),
            "[REDACTED]"
        );
        assert_eq!(redact_header("set-cookie", "session=secret"), "[REDACTED]");
        assert_eq!(
            redact_header("content-type", "application/json"),
            "application/json"
        );
    }
}
