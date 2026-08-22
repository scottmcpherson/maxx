import { Buffer } from "buffer";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { MaxxHostClient } from "../connection/MaxxHostClient";
import type { ChatImageAttachment } from "../types";

const MAX_BYTES = 20 * 1024 * 1024;

export async function pickDocument() {
  const result = await DocumentPicker.getDocumentAsync({
    type: [
      "image/*", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json",
      "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return { uri: asset.uri, name: asset.name, mimeType: asset.mimeType || mimeFromName(asset.name) };
}

export async function takePhoto() {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("Camera permission is required to take a photo.");
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: "images", quality: 0.82 });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return { uri: asset.uri, name: asset.fileName || `Photo-${Date.now()}.jpg`, mimeType: asset.mimeType || "image/jpeg" };
}

export async function choosePhoto() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error("Photos permission is required to choose an image.");
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: "images", quality: 0.9 });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return { uri: asset.uri, name: asset.fileName || `Photo-${Date.now()}.jpg`, mimeType: asset.mimeType || "image/jpeg" };
}

export async function uploadAttachment(
  client: MaxxHostClient,
  item: { uri: string; name: string; mimeType: string } | null,
): Promise<ChatImageAttachment | null> {
  if (!item) return null;
  const bytes = await new File(item.uri).arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) throw new Error("Attachments must be 20 MB or smaller.");
  return client.request<ChatImageAttachment>("upload_media", {
    dataBase64: Buffer.from(bytes).toString("base64"),
    mimeType: item.mimeType,
    displayName: item.name,
  });
}

function mimeFromName(name: string) {
  const parts = name.split(".");
  const extension = parts[parts.length - 1]?.toLowerCase();
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
    zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  } as Record<string, string>)[extension || ""] || "application/octet-stream";
}
