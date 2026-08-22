import { Buffer } from "buffer";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { MaxxHostClient } from "../connection/MaxxHostClient";
import type { ChatAttachment } from "../types";
import { attachmentMimeType, clipboardImageBase64 } from "./attachmentTypes";

const MAX_BYTES = 20 * 1024 * 1024;

type AttachmentUpload = {
  name: string;
  mimeType: string;
} & ({ uri: string } | { dataBase64: string });

export async function pickDocument() {
  const result = await DocumentPicker.getDocumentAsync({
    type: [
      "image/*", "audio/*", "video/*", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json",
      "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return { uri: asset.uri, name: asset.name, mimeType: attachmentMimeType(asset.name, asset.mimeType) };
}

export async function takePhoto() {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("Camera permission is required to take a photo.");
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: "images", quality: 0.82 });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const name = asset.fileName || `Photo-${Date.now()}.jpg`;
  return { uri: asset.uri, name, mimeType: attachmentMimeType(name, asset.mimeType || "image/jpeg") };
}

export async function choosePhotoOrVideo() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error("Photos permission is required to choose a photo or video.");
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.9 });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const video = asset.type === "video";
  const name = asset.fileName || `${video ? "Video" : "Photo"}-${Date.now()}.${video ? "mp4" : "jpg"}`;
  return { uri: asset.uri, name, mimeType: attachmentMimeType(name, asset.mimeType || (video ? "video/mp4" : "image/jpeg")) };
}

export async function pasteClipboardImage(): Promise<AttachmentUpload> {
  const image = await Clipboard.getImageAsync({ format: "png" });
  if (!image) throw new Error("The clipboard does not contain an image.");
  return {
    dataBase64: clipboardImageBase64(image.data),
    name: `Clipboard-${Date.now()}.png`,
    mimeType: "image/png",
  };
}

export async function uploadAttachment(
  client: MaxxHostClient,
  item: AttachmentUpload | null,
): Promise<ChatAttachment | null> {
  if (!item) return null;
  const bytes = "uri" in item
    ? Buffer.from(await new File(item.uri).arrayBuffer())
    : Buffer.from(item.dataBase64, "base64");
  if (bytes.byteLength === 0) throw new Error("The attachment is empty.");
  if (bytes.byteLength > MAX_BYTES) throw new Error("Attachments must be 20 MB or smaller.");
  return client.request<ChatAttachment>("upload_media", {
    dataBase64: bytes.toString("base64"),
    mimeType: item.mimeType,
    displayName: item.name,
  });
}
