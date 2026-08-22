import type { ChatAttachment } from "../contract/types";
import { attachmentKind, attachmentTypeLabel } from "../attachmentFormats";
import { MessageMedia } from "./MessageMedia";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "./ui/attachment";
import { FileArchiveIcon, FileIcon } from "lucide-react";

export function SentAttachment({
  attachment,
  projectID,
  threadID,
  hostID,
}: {
  attachment: ChatAttachment;
  projectID: string;
  threadID: string;
  hostID?: string;
}) {
  const kind = attachmentKind(attachment.mimeType);
  const playableKind = kind === "image" && /image\/(?:heic|heif)/i.test(attachment.mimeType) ? "file" : kind;
  if (playableKind !== "file") {
    return (
      <div className={playableKind === "image"
        ? "w-28 shrink-0 [&_figure]:w-full [&_img]:h-22 [&_img]:w-full [&_img]:object-cover"
        : "w-[min(24rem,82vw)] shrink-0 [&_figure]:w-full"}
      >
        <MessageMedia
          media={{ kind: playableKind, destination: `attachment:${attachment.id}`, altText: attachment.displayName }}
          projectID={projectID}
          threadID={threadID}
          hostID={hostID}
        />
      </div>
    );
  }

  const archive = attachment.mimeType.includes("zip");
  return (
    <Attachment state="done" size="sm" orientation="horizontal" className="max-w-64 bg-muted/70">
      <AttachmentMedia>{archive ? <FileArchiveIcon /> : <FileIcon />}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.displayName}</AttachmentTitle>
        <AttachmentDescription>{attachmentTypeLabel(attachment.mimeType, attachment.displayName)}</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
}
