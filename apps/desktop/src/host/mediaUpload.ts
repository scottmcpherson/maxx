import { attachmentMimeType } from "../attachmentFormats";
import { ipc, mediaURL } from "../ipc";
import { isLocalHost } from "./session";

export async function prepareAttachmentsForHost(
  hostId: string | null | undefined,
  attachmentPaths: string[],
  localAttachmentIds: string[] = [],
): Promise<{ attachmentPaths: string[]; attachmentIds: string[] }> {
  if (isLocalHost(hostId)) {
    return { attachmentPaths, attachmentIds: localAttachmentIds };
  }

  const attachmentIds: string[] = [];
  for (const path of attachmentPaths) {
    const response = await fetch(mediaURL(path));
    if (!response.ok) throw new Error(`Could not read ${path}`);
    const name = path.split(/[\\/]/).pop() || "Attachment";
    const mimeType = attachmentMimeType(name);
    if (!mimeType) throw new Error(`Unsupported attachment type: ${name}`);
    const attachment = await ipc.uploadMedia(
      bytesToBase64(new Uint8Array(await response.arrayBuffer())),
      mimeType,
      name,
      hostId,
    );
    attachmentIds.push(attachment.id);
  }

  for (const id of localAttachmentIds) {
    const media = await ipc.readMedia(id);
    const attachment = await ipc.uploadMedia(
      media.dataBase64,
      media.mimeType,
      media.displayName,
      hostId,
    );
    attachmentIds.push(attachment.id);
  }

  return { attachmentPaths: [], attachmentIds };
}

export function attachmentDestination(id: string): string {
  return `attachment:${id}`;
}

export function mediaDataUrl(mimeType: string, dataBase64: string): string {
  return `data:${mimeType};base64,${dataBase64}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
