use maxx_core::persist::ChatImageAttachment;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const DEFAULT_LISTEN_PORT: u16 = 7422;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaContent {
    pub id: Uuid,
    pub mime_type: String,
    pub display_name: String,
    pub data_base64: String,
}

pub fn store_media_bytes(
    directory: &Path,
    bytes: &[u8],
    mime_type: &str,
    display_name: &str,
) -> Result<ChatImageAttachment, String> {
    if bytes.is_empty() {
        return Err("The image is empty".into());
    }
    let extension = extension_for_mime(mime_type)?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the chat image store: {error}"))?;
    let id = Uuid::new_v4();
    let destination = directory.join(format!("{id}.{extension}"));
    fs::write(&destination, bytes)
        .map_err(|error| format!("Could not store {display_name}: {error}"))?;
    Ok(ChatImageAttachment {
        id,
        path: destination.to_string_lossy().into_owned(),
        mime_type: mime_type.to_string(),
        display_name: display_name.to_string(),
    })
}

pub fn read_media_bytes(directory: &Path, id: Uuid) -> Result<(Vec<u8>, String, String), String> {
    let Some(path) = find_attachment_path(directory, id) else {
        return Err("The image is unavailable".into());
    };
    let bytes = fs::read(&path).map_err(|error| format!("Could not read the image: {error}"))?;
    let mime_type = mime_for_extension(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default(),
    )
    .unwrap_or("application/octet-stream")
    .to_string();
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Image".into());
    Ok((bytes, mime_type, display_name))
}

pub fn attachment_from_id(
    directory: &Path,
    id: Uuid,
    display_name: Option<String>,
    mime_type: Option<String>,
) -> Result<ChatImageAttachment, String> {
    let (bytes, detected_mime, detected_name) = read_media_bytes(directory, id)?;
    let path = find_attachment_path(directory, id).ok_or("The image is unavailable")?;
    let _ = bytes;
    Ok(ChatImageAttachment {
        id,
        path: path.to_string_lossy().into_owned(),
        mime_type: mime_type.unwrap_or(detected_mime),
        display_name: display_name.unwrap_or(detected_name),
    })
}

fn find_attachment_path(directory: &Path, id: Uuid) -> Option<PathBuf> {
    let prefix = format!("{id}.");
    fs::read_dir(directory)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix))
        })
}

fn extension_for_mime(mime_type: &str) -> Result<&'static str, String> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        _ => Err("Unsupported image type. Choose PNG, JPEG, GIF, or WebP.".into()),
    }
}

fn mime_for_extension(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    #[test]
    fn media_round_trip_is_addressed_by_id_not_a_peer_path() {
        let directory = std::env::temp_dir().join(format!("maxx-host-media-{}", Uuid::new_v4()));
        let stored = store_media_bytes(&directory, b"png-bytes", "image/png", "shot.png").unwrap();
        assert!(stored
            .path
            .starts_with(directory.to_string_lossy().as_ref()));
        let (bytes, mime, _) = read_media_bytes(&directory, stored.id).unwrap();
        assert_eq!(bytes, b"png-bytes");
        assert_eq!(mime, "image/png");
        let encoded = STANDARD.encode(&bytes);
        assert_eq!(encoded, "cG5nLWJ5dGVz");
        let outsider =
            std::env::temp_dir().join(format!("maxx-host-media-other-{}", Uuid::new_v4()));
        assert!(read_media_bytes(&outsider, stored.id).is_err());
        fs::remove_dir_all(&directory).unwrap();
    }
}
