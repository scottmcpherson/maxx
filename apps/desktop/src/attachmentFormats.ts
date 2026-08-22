export type AttachmentKind = "image" | "audio" | "video" | "file";

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  avi: "video/x-msvideo",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  webm: "video/webm",
};

export const SUPPORTED_ATTACHMENT_EXTENSIONS = Object.freeze(Object.keys(MIME_BY_EXTENSION));
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function attachmentMimeType(name: string, browserMimeType = ""): string | null {
  const separator = name.lastIndexOf(".");
  if (separator >= 0) {
    return MIME_BY_EXTENSION[name.slice(separator + 1).toLowerCase()] ?? null;
  }
  return isSupportedMimeType(browserMimeType) ? browserMimeType : null;
}

export function isSupportedMimeType(mimeType: string): boolean {
  return Object.values(MIME_BY_EXTENSION).includes(mimeType);
}

export function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

export function attachmentTypeLabel(mimeType: string, name: string): string {
  const extension = name.split(".").pop()?.toUpperCase();
  if (extension) return extension;
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.startsWith("audio/")) return "Audio";
  if (mimeType.startsWith("video/")) return "Video";
  return "File";
}
