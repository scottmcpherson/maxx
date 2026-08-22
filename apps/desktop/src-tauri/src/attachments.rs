use base64::Engine;
use maxx_core::persist::ChatAttachment;
use maxx_core::persist::WorkspaceDocument;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

pub fn import_attachments(source_paths: &[String]) -> Result<Vec<ChatAttachment>, String> {
    let directory = crate::state::chat_attachments_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the chat attachment store: {error}"))?;

    source_paths
        .iter()
        .map(|source_path| import_attachment(&directory, source_path))
        .collect()
}

fn import_attachment(directory: &Path, source_path: &str) -> Result<ChatAttachment, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err(format!("Attachment is unavailable: {source_path}"));
    }
    let metadata = std::fs::metadata(&source)
        .map_err(|error| format!("Could not inspect {source_path}: {error}"))?;
    if metadata.len() == 0 {
        return Err("The attachment is empty".into());
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err("Attachments must be 20 MB or smaller".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Unsupported attachment type".to_string())?;
    let mime_type = mime_for_extension(&extension).ok_or_else(unsupported_type_error)?;
    let display_name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Attachment".into());
    let id = Uuid::new_v4();
    let destination = directory.join(format!("{id}.{extension}"));
    std::fs::copy(&source, &destination)
        .map_err(|error| format!("Could not copy {display_name}: {error}"))?;
    if let Err(error) = crate::host_session::write_attachment_metadata(
        directory,
        id,
        mime_type,
        &display_name,
    ) {
        let _ = std::fs::remove_file(&destination);
        return Err(error);
    }
    Ok(ChatAttachment {
        id,
        path: destination.to_string_lossy().into_owned(),
        mime_type: mime_type.into(),
        display_name,
    })
}

pub fn mime_for_extension(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        "avif" => Some("image/avif"),
        "pdf" => Some("application/pdf"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "txt" => Some("text/plain"),
        "md" | "markdown" => Some("text/markdown"),
        "csv" => Some("text/csv"),
        "json" => Some("application/json"),
        "zip" => Some("application/zip"),
        "aac" => Some("audio/aac"),
        "flac" => Some("audio/flac"),
        "m4a" => Some("audio/mp4"),
        "mp3" => Some("audio/mpeg"),
        "oga" | "ogg" => Some("audio/ogg"),
        "opus" => Some("audio/opus"),
        "wav" => Some("audio/wav"),
        "avi" => Some("video/x-msvideo"),
        "m4v" => Some("video/x-m4v"),
        "mkv" => Some("video/x-matroska"),
        "mov" => Some("video/quicktime"),
        "mp4" => Some("video/mp4"),
        "mpeg" | "mpg" => Some("video/mpeg"),
        "webm" => Some("video/webm"),
        _ => None,
    }
}

pub fn is_provider_image(mime_type: &str) -> bool {
    matches!(mime_type, "image/png" | "image/jpeg" | "image/gif" | "image/webp")
}

pub fn unsupported_type_error() -> String {
    "Unsupported attachment type. Choose PDF, DOCX, XLSX, TXT, Markdown, CSV, JSON, ZIP, an image, an audio file, or a video file.".into()
}

#[derive(Debug, Clone)]
pub struct EncodedImage {
    pub data: String,
    pub mime_type: String,
    pub display_name: String,
}

pub fn encode_images(attachments: &[ChatAttachment]) -> Result<Vec<EncodedImage>, String> {
    attachments
        .iter()
        .filter(|attachment| is_provider_image(&attachment.mime_type))
        .map(|attachment| {
            let bytes = std::fs::read(&attachment.path)
                .map_err(|error| format!("Could not read {}: {error}", attachment.display_name))?;
            Ok(EncodedImage {
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
                mime_type: attachment.mime_type.clone(),
                display_name: attachment.display_name.clone(),
            })
        })
        .collect()
}

pub fn prune_attachments(workspace: &WorkspaceDocument) {
    let referenced: HashSet<Uuid> = workspace
        .projects
        .iter()
        .flat_map(|project| &project.threads)
        .flat_map(|thread| &thread.messages)
        .flat_map(|message| &message.attachments)
        .map(|attachment| attachment.id)
        .collect();
    let Ok(entries) = std::fs::read_dir(crate::state::chat_attachments_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let id = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.split('.').next())
            .and_then(|value| Uuid::parse_str(value).ok());
        if id.is_none_or(|id| !referenced.contains(&id)) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_and_encodes_supported_images() {
        let root = std::env::temp_dir().join(format!("maxx-image-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("sample.png");
        std::fs::write(&source, [1_u8, 2, 3]).unwrap();
        let destination = root.join("stored");
        let attachment = import_attachment(&destination, source.to_str().unwrap()).unwrap_err();
        assert!(attachment.contains("Could not copy"));
        std::fs::create_dir_all(&destination).unwrap();
        let attachment = import_attachment(&destination, source.to_str().unwrap()).unwrap();
        assert_eq!(attachment.mime_type, "image/png");
        let encoded = encode_images(&[attachment]).unwrap();
        assert_eq!(encoded[0].data, "AQID");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recognizes_requested_attachment_families() {
        for extension in [
            "pdf", "docx", "xlsx", "txt", "md", "markdown", "csv", "json", "zip",
            "svg", "heic", "avif", "aac", "flac", "m4a", "mp3", "ogg", "opus", "wav",
            "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm",
        ] {
            assert!(mime_for_extension(extension).is_some(), "missing {extension}");
        }
        assert!(mime_for_extension("exe").is_none());
    }

    #[test]
    fn only_provider_native_images_are_base64_encoded() {
        let root = std::env::temp_dir().join(format!("maxx-attachment-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let png_path = root.join("one.png");
        let svg_path = root.join("two.svg");
        std::fs::write(&png_path, b"png").unwrap();
        std::fs::write(&svg_path, b"svg").unwrap();
        let attachments = vec![
            ChatAttachment { id: Uuid::new_v4(), path: png_path.to_string_lossy().into_owned(), mime_type: "image/png".into(), display_name: "one.png".into() },
            ChatAttachment { id: Uuid::new_v4(), path: svg_path.to_string_lossy().into_owned(), mime_type: "image/svg+xml".into(), display_name: "two.svg".into() },
        ];
        let encoded = encode_images(&attachments).unwrap();
        assert_eq!(encoded.len(), 1);
        assert_eq!(encoded[0].display_name, "one.png");
        let _ = std::fs::remove_dir_all(root);
    }
}
