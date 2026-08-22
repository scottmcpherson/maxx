use base64::Engine;
use maxx_core::persist::ChatImageAttachment;
use maxx_core::persist::WorkspaceDocument;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub fn import_images(source_paths: &[String]) -> Result<Vec<ChatImageAttachment>, String> {
    let directory = crate::state::chat_images_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the chat image store: {error}"))?;

    source_paths
        .iter()
        .map(|source_path| import_image(&directory, source_path))
        .collect()
}

fn import_image(directory: &Path, source_path: &str) -> Result<ChatImageAttachment, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err(format!("Image is unavailable: {source_path}"));
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Unsupported image type".to_string())?;
    let mime_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err("Unsupported image type. Choose PNG, JPEG, GIF, or WebP.".into()),
    };
    let display_name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Image".into());
    let id = Uuid::new_v4();
    let destination = directory.join(format!("{id}.{extension}"));
    std::fs::copy(&source, &destination)
        .map_err(|error| format!("Could not copy {display_name}: {error}"))?;
    Ok(ChatImageAttachment {
        id,
        path: destination.to_string_lossy().into_owned(),
        mime_type: mime_type.into(),
        display_name,
    })
}

#[derive(Debug, Clone)]
pub struct EncodedImage {
    pub data: String,
    pub mime_type: String,
    pub display_name: String,
}

pub fn encode_images(attachments: &[ChatImageAttachment]) -> Result<Vec<EncodedImage>, String> {
    attachments
        .iter()
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

pub fn prune_images(workspace: &WorkspaceDocument) {
    let referenced: HashSet<PathBuf> = workspace
        .projects
        .iter()
        .flat_map(|project| &project.threads)
        .flat_map(|thread| &thread.messages)
        .flat_map(|message| &message.attachments)
        .map(|attachment| PathBuf::from(&attachment.path))
        .collect();
    let Ok(entries) = std::fs::read_dir(crate::state::chat_images_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !referenced.contains(&path) {
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
        let attachment = import_image(&destination, source.to_str().unwrap()).unwrap_err();
        assert!(attachment.contains("Could not copy"));
        std::fs::create_dir_all(&destination).unwrap();
        let attachment = import_image(&destination, source.to_str().unwrap()).unwrap();
        assert_eq!(attachment.mime_type, "image/png");
        let encoded = encode_images(&[attachment]).unwrap();
        assert_eq!(encoded[0].data, "AQID");
        let _ = std::fs::remove_dir_all(root);
    }
}
