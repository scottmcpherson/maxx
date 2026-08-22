use maxx_core::persist::ChatAttachment;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const DEFAULT_LISTEN_PORT: u16 = 7422;
const MAX_MEDIA_BYTES: usize = crate::attachments::MAX_ATTACHMENT_BYTES as usize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaContent {
    pub id: Uuid,
    pub mime_type: String,
    pub display_name: String,
    pub data_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentMetadata {
    mime_type: String,
    display_name: String,
}

pub fn store_media_bytes(
    directory: &Path,
    bytes: &[u8],
    mime_type: &str,
    display_name: &str,
) -> Result<ChatAttachment, String> {
    if bytes.is_empty() {
        return Err("The attachment is empty".into());
    }
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err("Attachments must be 20 MB or smaller".into());
    }
    let extension = extension_for_mime(mime_type)?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the chat attachment store: {error}"))?;
    let id = Uuid::new_v4();
    let destination = directory.join(format!("{id}.{extension}"));
    fs::write(&destination, bytes)
        .map_err(|error| format!("Could not store {display_name}: {error}"))?;
    if let Err(error) = write_attachment_metadata(directory, id, mime_type, display_name) {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Ok(ChatAttachment {
        id,
        path: destination.to_string_lossy().into_owned(),
        mime_type: mime_type.to_string(),
        display_name: display_name.to_string(),
    })
}

pub fn read_media_bytes(directory: &Path, id: Uuid) -> Result<(Vec<u8>, String, String), String> {
    let Some(path) = find_attachment_path(directory, id) else {
        return Err("The attachment is unavailable".into());
    };
    let bytes =
        fs::read(&path).map_err(|error| format!("Could not read the attachment: {error}"))?;
    let mime_type = mime_for_extension(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default(),
    )
    .unwrap_or("application/octet-stream")
    .to_string();
    let metadata = read_attachment_metadata(directory, id);
    Ok((
        bytes,
        metadata.as_ref().map(|value| value.mime_type.clone()).unwrap_or(mime_type),
        metadata.map(|value| value.display_name).unwrap_or_else(|| "Attachment".into()),
    ))
}

pub fn remove_media_bytes(directory: &Path, id: Uuid) -> Result<(), String> {
    let path = find_attachment_path(directory, id).ok_or("The attachment is unavailable")?;
    fs::remove_file(path).map_err(|error| format!("Could not remove the attachment: {error}"))?;
    let metadata = directory.join(format!("{id}.metadata.json"));
    if metadata.exists() {
        fs::remove_file(metadata)
            .map_err(|error| format!("Could not remove attachment metadata: {error}"))?;
    }
    Ok(())
}

pub fn attachment_from_id(
    directory: &Path,
    id: Uuid,
    display_name: Option<String>,
    mime_type: Option<String>,
) -> Result<ChatAttachment, String> {
    let (bytes, detected_mime, detected_name) = read_media_bytes(directory, id)?;
    let path = find_attachment_path(directory, id).ok_or("The attachment is unavailable")?;
    let _ = bytes;
    Ok(ChatAttachment {
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
                .is_some_and(|name| name.starts_with(&prefix) && !name.ends_with(".metadata.json"))
        })
}

pub fn write_attachment_metadata(
    directory: &Path,
    id: Uuid,
    mime_type: &str,
    display_name: &str,
) -> Result<(), String> {
    let metadata = AttachmentMetadata {
        mime_type: mime_type.to_string(),
        display_name: display_name.to_string(),
    };
    let bytes = serde_json::to_vec(&metadata)
        .map_err(|error| format!("Could not encode attachment metadata: {error}"))?;
    fs::write(directory.join(format!("{id}.metadata.json")), bytes)
        .map_err(|error| format!("Could not store attachment metadata: {error}"))
}

fn read_attachment_metadata(directory: &Path, id: Uuid) -> Option<AttachmentMetadata> {
    let bytes = fs::read(directory.join(format!("{id}.metadata.json"))).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn extension_for_mime(mime_type: &str) -> Result<&'static str, String> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        "image/svg+xml" => Ok("svg"),
        "image/heic" => Ok("heic"),
        "image/heif" => Ok("heif"),
        "image/avif" => Ok("avif"),
        "application/pdf" => Ok("pdf"),
        "text/plain" => Ok("txt"),
        "text/markdown" | "text/x-markdown" => Ok("md"),
        "text/csv" => Ok("csv"),
        "application/json" => Ok("json"),
        "application/zip" | "application/x-zip-compressed" => Ok("zip"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Ok("docx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Ok("xlsx"),
        "audio/aac" => Ok("aac"),
        "audio/flac" => Ok("flac"),
        "audio/mp4" | "audio/x-m4a" => Ok("m4a"),
        "audio/mpeg" => Ok("mp3"),
        "audio/ogg" => Ok("ogg"),
        "audio/opus" => Ok("opus"),
        "audio/wav" | "audio/x-wav" => Ok("wav"),
        "video/x-msvideo" => Ok("avi"),
        "video/x-m4v" => Ok("m4v"),
        "video/x-matroska" => Ok("mkv"),
        "video/quicktime" => Ok("mov"),
        "video/mp4" => Ok("mp4"),
        "video/mpeg" => Ok("mpeg"),
        "video/webm" => Ok("webm"),
        _ => Err(crate::attachments::unsupported_type_error()),
    }
}

fn mime_for_extension(extension: &str) -> Option<&'static str> {
    crate::attachments::mime_for_extension(extension)
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

    #[test]
    fn document_round_trip_uses_an_opaque_host_path() {
        let directory = std::env::temp_dir().join(format!("maxx-host-media-{}", Uuid::new_v4()));
        let stored =
            store_media_bytes(&directory, b"# Notes", "text/markdown", "private-notes.md").unwrap();
        assert!(stored.path.ends_with(".md"));
        assert!(!stored.path.ends_with("private-notes.md"));
        let (bytes, mime, display_name) = read_media_bytes(&directory, stored.id).unwrap();
        assert_eq!(bytes, b"# Notes");
        assert_eq!(mime, "text/markdown");
        assert_eq!(display_name, "private-notes.md");
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn discarded_media_removes_payload_and_metadata() {
        let directory = std::env::temp_dir().join(format!("maxx-host-media-{}", Uuid::new_v4()));
        let stored = store_media_bytes(&directory, b"draft", "text/plain", "draft.txt").unwrap();
        remove_media_bytes(&directory, stored.id).unwrap();
        assert!(read_media_bytes(&directory, stored.id).is_err());
        assert!(!directory.join(format!("{}.metadata.json", stored.id)).exists());
        fs::remove_dir_all(&directory).unwrap();
    }
}
