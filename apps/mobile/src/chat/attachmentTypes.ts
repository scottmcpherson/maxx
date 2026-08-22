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
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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

const NATIVE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function attachmentMimeType(name: string, reportedMimeType?: string | null): string {
  const extension = name.split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXTENSION[extension] || reportedMimeType?.trim().toLowerCase() || "application/octet-stream";
}

export function canPreviewAsNativeImage(mimeType: string): boolean {
  return NATIVE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function clipboardImageBase64(dataUri: string): string {
  const match = /^data:image\/(?:png|jpeg);base64,(.+)$/is.exec(dataUri);
  if (!match?.[1]) throw new Error("The clipboard image could not be read.");
  return match[1];
}
