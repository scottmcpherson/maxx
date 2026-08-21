import { useCallback, useState } from "react";
import { ipc, mediaURL } from "../ipc";
import { IconButton } from "./ui/icon-button";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentGroup,
  AttachmentMedia,
} from "./ui/attachment";
import { PlusIcon, XIcon } from "lucide-react";

export function useImageAttachments() {
  const [paths, setPaths] = useState<string[]>([]);

  const choose = useCallback(async () => {
    const additions = await ipc.openImagesDialog();
    if (additions.length === 0) return;
    await ipc.authorizeImagePreviews(additions);
    setPaths((current) => [...new Set([...current, ...additions])]);
  }, []);

  const remove = useCallback((path: string) => {
    setPaths((current) => current.filter((candidate) => candidate !== path));
  }, []);

  const clear = useCallback(() => setPaths([]), []);
  return { paths, choose, remove, clear };
}

export function AttachImagesButton({
  disabled = false,
  onChoose,
}: {
  disabled?: boolean;
  onChoose: () => void;
}) {
  return (
    <IconButton
      label="Attach images"
      tooltip="Attach images"
      size="icon-sm"
      className="text-muted-foreground"
      disabled={disabled}
      onClick={onChoose}
    >
      <PlusIcon />
    </IconButton>
  );
}

export function PendingImageStrip({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  if (paths.length === 0) return null;
  return (
    <AttachmentGroup
      className="gap-2 overflow-x-auto px-px pb-1"
      aria-label={`${paths.length} attached ${paths.length === 1 ? "image" : "images"}`}
    >
      {paths.map((path) => {
        const name = path.split(/[\\/]/).pop() || "Image";
        return (
          <Attachment
            key={path}
            state="done"
            size="sm"
            orientation="vertical"
            className="relative h-[4.5rem] w-[5.5rem] overflow-visible rounded-xl"
            title={name}
          >
            <AttachmentMedia variant="image" className="size-full rounded-xl p-0">
              <img src={mediaURL(path)} alt={name} />
            </AttachmentMedia>
            <AttachmentActions>
              <AttachmentAction
                aria-label={`Remove ${name}`}
                title={`Remove ${name}`}
                onClick={() => onRemove(path)}
              >
                <XIcon />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
}
