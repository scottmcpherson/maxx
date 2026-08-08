import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";
import { ipc } from "../ipc";
import { Icons } from "./Icons";

const IMAGE_FILTER = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }];

export function useImageAttachments() {
  const [paths, setPaths] = useState<string[]>([]);

  const choose = useCallback(async () => {
    const selected = await open({ multiple: true, directory: false, filters: IMAGE_FILTER });
    if (!selected) return;
    const additions = Array.isArray(selected) ? selected : [selected];
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
            <img src={convertFileSrc(path)} alt={name} />
            <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemove(path)}>
              <Icons.close size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
