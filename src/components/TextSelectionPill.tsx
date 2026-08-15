import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatTextSelection } from "../contract/types";
import { Icons } from "./Icons";

interface PreviewPosition {
  left: number;
  bottom: number;
  maxWidth: number;
}

export function TextSelectionPill({
  selections,
  onClear,
}: {
  selections: ChatTextSelection[];
  onClear?: () => void;
}) {
  const pillRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<PreviewPosition | null>(null);

  const openPreview = useCallback(() => {
    const rect = pillRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPreview({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 372)),
      bottom: Math.max(12, window.innerHeight - rect.top + 8),
      maxWidth: Math.min(360, window.innerWidth - 24),
    });
  }, []);

  useEffect(() => {
    if (!preview) return;
    const close = () => setPreview(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [preview]);

  if (selections.length === 0) return null;
  const label = `${selections.length} ${selections.length === 1 ? "selection" : "selections"}`;

  return (
    <>
      <div
        ref={pillRef}
        className="text-selection-pill"
        tabIndex={0}
        aria-label={`${label}. Focus or hover to preview.`}
        aria-expanded={Boolean(preview)}
        onMouseEnter={openPreview}
        onMouseLeave={() => setPreview(null)}
        onFocus={openPreview}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setPreview(null);
        }}
      >
        <Icons.bubble size={13} />
        <span>{label}</span>
        {onClear && (
          <button type="button" aria-label={`Clear ${label}`} onClick={onClear}>
            <Icons.close size={12} />
          </button>
        )}
      </div>
      {preview && createPortal(
        <div
          className="text-selection-preview"
          role="tooltip"
          style={{ left: preview.left, bottom: preview.bottom, maxWidth: preview.maxWidth }}
        >
          {selections.map((selection) => (
            <blockquote key={selection.id}>{selection.text}</blockquote>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
