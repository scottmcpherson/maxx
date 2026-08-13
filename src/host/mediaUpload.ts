import { ipc, mediaURL } from "../ipc";
import { isLocalHost } from "./session";

export async function uploadImagesForHost(
  hostId: string | null | undefined,
  imagePaths: string[],
): Promise<{ imagePaths: string[]; attachmentIds: string[] }> {
  if (imagePaths.length === 0 || isLocalHost(hostId)) {
    return { imagePaths, attachmentIds: [] };
  }
  const attachmentIds: string[] = [];
  for (const path of imagePaths) {
    const response = await fetch(mediaURL(path));
    if (!response.ok) throw new Error(`Could not read ${path}`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (const byte of buffer) binary += String.fromCharCode(byte);
    const name = path.split(/[\\/]/).pop() || "Image";
    const attachment = await ipc.uploadMedia(
      btoa(binary),
      mimeTypeForName(name),
      name,
      hostId,
    );
    attachmentIds.push(attachment.id);
  }
  return { imagePaths: [], attachmentIds };
}

function mimeTypeForName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "image/png";
}

export function attachmentDestination(id: string): string {
  return `attachment:${id}`;
}

export function mediaDataUrl(mimeType: string, dataBase64: string): string {
  return `data:${mimeType};base64,${dataBase64}`;
}
