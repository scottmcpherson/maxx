import { useCallback, useState } from "react";
import { ipc, mediaURL } from "../ipc";
import { Icons } from "./Icons";

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
    <button
      type="button"
      className="attach-images-button"
      title="Attach images"
      aria-label="Attach images"
      disabled={disabled}
      onClick={onChoose}
    >
      <Icons.plus size={16} />
    </button>
  );
}

export function PendingImageStrip({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  if (paths.length === 0) return null;
  return (
    <div className="pending-image-strip" aria-label={`${paths.length} attached ${paths.length === 1 ? "image" : "images"}`}>
      {paths.map((path) => {
        const name = path.split(/[\\/]/).pop() || "Image";
        return (
          <div className="pending-image" key={path} title={name}>
            <img src={mediaURL(path)} alt={name} />
            <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemove(path)}>
              <Icons.close size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
