import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import {
  attachmentKind,
  attachmentMimeType,
  attachmentTypeLabel,
  MAX_ATTACHMENT_BYTES,
} from "../attachmentFormats";
import { ipc, mediaURL } from "../ipc";
import { cn } from "../lib/utils";
import { IconButton } from "./ui/icon-button";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "./ui/attachment";
import { toast } from "./ui/toast";
import { FileArchiveIcon, FileIcon, FileMusicIcon, FileVideoIcon, PlusIcon, XIcon } from "lucide-react";

export interface ComposerAttachment {
  key: string;
  name: string;
  mimeType: string;
  path?: string;
  attachmentId?: string;
  previewUrl?: string;
}

export interface ComposerAttachmentPayload {
  attachmentPaths: string[];
  attachmentIds: string[];
}

export function useComposerAttachments() {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const payload = useMemo<ComposerAttachmentPayload>(() => ({
    attachmentPaths: attachments.flatMap((attachment) => attachment.path ? [attachment.path] : []),
    attachmentIds: attachments.flatMap((attachment) => attachment.attachmentId ? [attachment.attachmentId] : []),
  }), [attachments]);

  const addPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    await ipc.authorizeAttachmentPreviews(paths);
    const additions = paths.flatMap((path): ComposerAttachment[] => {
      const name = path.split(/[\\/]/).pop() || "Attachment";
      const mimeType = attachmentMimeType(name);
      return mimeType ? [{ key: `path:${path}`, name, mimeType, path }] : [];
    });
    setAttachments((current) => {
      const next = deduplicateAttachments([...current, ...additions]);
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const choose = useCallback(async () => {
    try {
      await addPaths(await ipc.openAttachmentsDialog());
    } catch (error) {
      showAttachmentError(error);
    }
  }, [addPaths]);

  const addFiles = useCallback(async (files: File[]) => {
    const paths: string[] = [];
    const additions: ComposerAttachment[] = [];
    for (const file of files) {
      const mimeType = attachmentMimeType(file.name, file.type);
      if (!mimeType) {
        toast.add({ title: `Unsupported file: ${file.name}`, description: "Choose a supported document, image, audio, video, or ZIP file.", type: "error" });
        continue;
      }
      if (file.size === 0 || file.size > MAX_ATTACHMENT_BYTES) {
        toast.add({ title: `Could not attach ${file.name}`, description: file.size === 0 ? "The file is empty." : "Attachments must be 20 MB or smaller.", type: "error" });
        continue;
      }
      const path = window.maxx.filePath(file);
      if (path) {
        paths.push(path);
        continue;
      }
      try {
        const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        const stored = await ipc.uploadMedia(dataBase64, mimeType, file.name);
        additions.push({
          key: `id:${stored.id}`,
          name: file.name,
          mimeType,
          attachmentId: stored.id,
          previewUrl: URL.createObjectURL(file),
        });
      } catch (error) {
        showAttachmentError(error, file.name);
      }
    }
    try {
      await addPaths(paths);
    } catch (error) {
      showAttachmentError(error);
    }
    if (additions.length > 0) {
      setAttachments((current) => {
        const next = deduplicateAttachments([...current, ...additions]);
        attachmentsRef.current = next;
        return next;
      });
    }
  }, [addPaths]);

  const remove = useCallback((key: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.key === key);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      if (removed?.attachmentId) void ipc.discardMedia(removed.attachmentId);
      const next = current.filter((attachment) => attachment.key !== key);
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    attachmentsRef.current = [];
    setAttachments([]);
  }, []);

  const discard = useCallback(() => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      if (attachment.attachmentId) void ipc.discardMedia(attachment.attachmentId);
    }
    attachmentsRef.current = [];
    setAttachments([]);
  }, []);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      if (attachment.attachmentId) void ipc.discardMedia(attachment.attachmentId);
    }
    attachmentsRef.current = [];
  }, []);

  const onPaste = useCallback((event: ClipboardEvent<HTMLElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    void addFiles(images);
  }, [addFiles]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }, [addFiles]);

  return { attachments, payload, choose, remove, clear, discard, onPaste, onDragOver, onDrop };
}

export function AttachFilesButton({ disabled = false, onChoose }: { disabled?: boolean; onChoose: () => void }) {
  return (
    <IconButton label="Attach files" tooltip="Attach files" size="icon-sm" className="text-muted-foreground" disabled={disabled} onClick={onChoose}>
      <PlusIcon />
    </IconButton>
  );
}

export function PendingAttachmentStrip({ attachments, onRemove }: { attachments: ComposerAttachment[]; onRemove: (key: string) => void }) {
  if (attachments.length === 0) return null;
  return (
    <AttachmentGroup className="gap-2 overflow-x-auto px-px pb-1" aria-label={`${attachments.length} attached ${attachments.length === 1 ? "file" : "files"}`}>
      {attachments.map((attachment) => <PendingAttachment key={attachment.key} attachment={attachment} onRemove={onRemove} />)}
    </AttachmentGroup>
  );
}

function PendingAttachment({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove: (key: string) => void }) {
  const kind = attachmentKind(attachment.mimeType);
  const previewUrl = attachment.previewUrl ?? (attachment.path ? mediaURL(attachment.path) : undefined);
  const previewableImage = kind === "image" && !/image\/(?:heic|heif)/i.test(attachment.mimeType);
  const visual = previewableImage && previewUrl
    ? <img className="size-full! object-cover" src={previewUrl} alt={attachment.name} />
    : kind === "audio" ? <FileMusicIcon />
      : kind === "video" ? <FileVideoIcon />
        : attachment.mimeType.includes("zip") ? <FileArchiveIcon />
          : <FileIcon />;
  return (
    <Attachment
      state="done"
      size="sm"
      orientation={previewableImage ? "vertical" : "horizontal"}
      className={cn(
        "relative",
        previewableImage
          ? "h-[4.5rem] w-[5.5rem] gap-0 overflow-visible rounded-xl p-0!"
          : "max-w-56 pr-8",
      )}
      title={attachment.name}
    >
      <AttachmentMedia
        variant={previewableImage ? "image" : "icon"}
        className={cn(previewableImage && "size-full! rounded-[inherit] p-0!")}
      >
        {visual}
      </AttachmentMedia>
      {!previewableImage && (
        <AttachmentContent>
          <AttachmentTitle>{attachment.name}</AttachmentTitle>
          <AttachmentDescription>{attachmentTypeLabel(attachment.mimeType, attachment.name)}</AttachmentDescription>
        </AttachmentContent>
      )}
      <AttachmentActions className={cn("absolute", previewableImage ? "top-1 right-1" : "right-1")}>
        <AttachmentAction
          variant="default"
          size="icon-xs"
          className="rounded-full"
          aria-label={`Remove ${attachment.name}`}
          title={`Remove ${attachment.name}`}
          onClick={() => onRemove(attachment.key)}
        >
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}

function deduplicateAttachments(attachments: ComposerAttachment[]): ComposerAttachment[] {
  return [...new Map(attachments.map((attachment) => [attachment.key, attachment])).values()];
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function showAttachmentError(error: unknown, name?: string): void {
  toast.add({
    title: name ? `Could not attach ${name}` : "Could not attach file",
    description: error instanceof Error ? error.message : String(error),
    type: "error",
  });
}
