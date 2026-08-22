use crate::state::AppState;
use maxx_core::contract::ChatProvider;
use maxx_core::persist::WorkspaceDocument;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMediaSource {
    pub path: String,
    pub kind: &'static str,
    pub mime_type: &'static str,
    pub display_name: String,
}

pub async fn resolve_media_source(
    state: Arc<AppState>,
    project_id: Uuid,
    thread_id: Uuid,
    destination: String,
) -> Result<ResolvedMediaSource, String> {
    let resolved = {
        let workspace = state.workspace.lock().await;
        resolve_media_path(
            &workspace,
            project_id,
            thread_id,
            &destination,
            dirs::home_dir().as_deref(),
        )?
    };

    Ok(resolved)
}

fn resolve_media_path(
    workspace: &WorkspaceDocument,
    project_id: Uuid,
    thread_id: Uuid,
    destination: &str,
    home_directory: Option<&Path>,
) -> Result<ResolvedMediaSource, String> {
    let project = workspace
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| "Unknown project".to_string())?;
    let thread = project
        .threads
        .iter()
        .find(|thread| thread.id == thread_id)
        .ok_or_else(|| "Unknown thread".to_string())?;

    let working_directory = thread
        .working_directory
        .as_deref()
        .unwrap_or(&project.folder_path);
    let project_root = PathBuf::from(working_directory)
        .canonicalize()
        .map_err(|_| "The project folder is unavailable".to_string())?;
    let mut roots = vec![project_root.clone()];
    if let Ok(chat_images) = crate::state::chat_images_dir().canonicalize() {
        roots.push(chat_images);
    }
    if thread.provider == ChatProvider::Grok {
        if let (Some(home), Some(session_id)) = (home_directory, &thread.provider_session_id) {
            if Uuid::parse_str(session_id).is_ok() {
                let session_root = home
                    .join(".grok")
                    .join("sessions")
                    .join(encoded_path_component(working_directory))
                    .join(session_id);
                if let Ok(canonical) = session_root.canonicalize() {
                    roots.push(canonical);
                }
            }
        }
    }

    let decoded = percent_decode(destination.trim())?;
    if decoded.is_empty() || decoded.contains('\0') {
        return Err("The media path is invalid".into());
    }
    let requested = local_path(&decoded, home_directory)?;
    let candidates: Vec<PathBuf> = if requested.is_absolute() {
        vec![requested]
    } else {
        roots.iter().map(|root| root.join(&requested)).collect()
    };

    for candidate in candidates {
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !canonical.is_file() || !roots.iter().any(|root| canonical.starts_with(root)) {
            continue;
        }
        let extension = canonical
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let Some((kind, mime_type)) = media_type(&extension) else {
            return Err("This file type cannot be displayed as media".into());
        };
        let display_name = canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Media".into());
        return Ok(ResolvedMediaSource {
            path: canonical.to_string_lossy().into_owned(),
            kind,
            mime_type,
            display_name,
        });
    }
    Err("The media file is unavailable".into())
}

fn local_path(destination: &str, home_directory: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = destination.strip_prefix("file://") {
        let path = path.strip_prefix("localhost").unwrap_or(path);
        return Ok(PathBuf::from(path));
    }
    if destination.starts_with("~/") {
        return home_directory
            .map(|home| home.join(&destination[2..]))
            .ok_or_else(|| "The home folder is unavailable".into());
    }
    if has_url_scheme(destination) {
        return Err("Remote media does not use the local media resolver".into());
    }
    Ok(PathBuf::from(destination))
}

fn has_url_scheme(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let scheme = &value[..colon];
    !scheme.is_empty()
        && scheme.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphabetic()
                || (index > 0
                    && (character.is_ascii_digit() || matches!(character, '+' | '-' | '.')))
        })
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("The media path contains invalid percent encoding".into());
            }
            let high = hex_value(bytes[index + 1]);
            let low = hex_value(bytes[index + 2]);
            let (Some(high), Some(low)) = (high, low) else {
                return Err("The media path contains invalid percent encoding".into());
            };
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "The media path is not valid UTF-8".into())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn encoded_path_component(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

fn media_type(extension: &str) -> Option<(&'static str, &'static str)> {
    let value = match extension {
        "avif" => ("image", "image/avif"),
        "bmp" => ("image", "image/bmp"),
        "gif" => ("image", "image/gif"),
        "heic" => ("image", "image/heic"),
        "heif" => ("image", "image/heif"),
        "ico" => ("image", "image/x-icon"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "png" => ("image", "image/png"),
        "svg" => ("image", "image/svg+xml"),
        "tif" | "tiff" => ("image", "image/tiff"),
        "webp" => ("image", "image/webp"),
        "avi" => ("video", "video/x-msvideo"),
        "m4v" => ("video", "video/x-m4v"),
        "mkv" => ("video", "video/x-matroska"),
        "mov" => ("video", "video/quicktime"),
        "mp4" => ("video", "video/mp4"),
        "mpeg" | "mpg" => ("video", "video/mpeg"),
        "webm" => ("video", "video/webm"),
        "aac" => ("audio", "audio/aac"),
        "flac" => ("audio", "audio/flac"),
        "m4a" => ("audio", "audio/mp4"),
        "mp3" => ("audio", "audio/mpeg"),
        "oga" | "ogg" => ("audio", "audio/ogg"),
        "opus" => ("audio", "audio/opus"),
        "wav" => ("audio", "audio/wav"),
        _ => return None,
    };
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maxx_core::persist::{ChatProject, ChatThread};
    use std::fs;

    fn fixture(provider: ChatProvider, project_root: &Path) -> (WorkspaceDocument, Uuid, Uuid) {
        let project_id = Uuid::new_v4();
        let mut thread = ChatThread::new("Media".into(), provider, "default".into());
        let thread_id = thread.id;
        thread.provider_session_id = Some("019fb814-4785-74e2-bb1f-7882991059dc".into());
        let mut workspace = WorkspaceDocument::default();
        workspace.projects.push(ChatProject {
            id: project_id,
            folder_path: project_root.to_string_lossy().into_owned(),
            threads: vec![thread],
        });
        (workspace, project_id, thread_id)
    }

    #[test]
    fn resolves_project_media_and_rejects_path_traversal() {
        let container = std::env::temp_dir().join(format!("maxx-media-{}", Uuid::new_v4()));
        let project_root = container.join("project");
        fs::create_dir_all(project_root.join("images")).unwrap();
        fs::write(project_root.join("images/test.png"), b"png").unwrap();
        fs::write(container.join("outside.png"), b"png").unwrap();
        let (workspace, project_id, thread_id) = fixture(ChatProvider::Codex, &project_root);

        let resolved = resolve_media_path(
            &workspace,
            project_id,
            thread_id,
            "images/test.png",
            Some(&container),
        )
        .unwrap();
        assert_eq!(resolved.kind, "image");
        assert_eq!(resolved.display_name, "test.png");
        assert!(resolve_media_path(
            &workspace,
            project_id,
            thread_id,
            "../outside.png",
            Some(&container),
        )
        .is_err());

        fs::remove_dir_all(&container).unwrap();
    }

    #[test]
    fn resolves_grok_session_media_fallback() {
        let home = std::env::temp_dir().join(format!("maxx-grok-media-{}", Uuid::new_v4()));
        let project_root = home.join("Developer/movae");
        fs::create_dir_all(&project_root).unwrap();
        let (workspace, project_id, thread_id) = fixture(ChatProvider::Grok, &project_root);
        let session_id = workspace.projects[0].threads[0]
            .provider_session_id
            .as_deref()
            .unwrap();
        let media = home
            .join(".grok/sessions")
            .join(encoded_path_component(&project_root.to_string_lossy()))
            .join(session_id)
            .join("images/1.jpg");
        fs::create_dir_all(media.parent().unwrap()).unwrap();
        fs::write(&media, b"jpg").unwrap();

        let resolved = resolve_media_path(
            &workspace,
            project_id,
            thread_id,
            "images/1.jpg",
            Some(&home),
        )
        .unwrap();
        assert_eq!(
            resolved.path,
            media.canonicalize().unwrap().to_string_lossy()
        );

        fs::remove_dir_all(&home).unwrap();
    }
}
