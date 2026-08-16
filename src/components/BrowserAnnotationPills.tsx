import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BrowserAnnotation } from "../browser";
import { annotationKind, annotationLabel, annotationPopoverPosition } from "../browserAnnotations";
import { Icons } from "./Icons";

function AnnotationPreview({ annotation }: { annotation: BrowserAnnotation }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [annotation.previewDataUrl]);
  if (annotation.previewDataUrl && !failed) {
    return <img src={annotation.previewDataUrl} alt="" onError={() => setFailed(true)} />;
  }
  return <span className="browser-annotation-preview-fallback"><Icons.annotation size={15} /></span>;
}

interface PopoverPosition {
  left: number;
  top: number;
}

export function BrowserAnnotationPills({
  annotations,
  onClear,
  readonly = false,
}: {
  annotations: BrowserAnnotation[];
  onClear?: () => void;
  readonly?: boolean;
}) {
  const popoverID = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const openPopover = useCallback(() => {
    cancelScheduledClose();
    setPopoverOpen(true);
  }, [cancelScheduledClose]);

  const schedulePopoverClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      setPopoverOpen(false);
      setPopoverPosition(null);
      closeTimerRef.current = null;
    }, 160);
  }, [cancelScheduledClose]);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    const popover = popoverRef.current?.getBoundingClientRect();
    if (!trigger || !popover) return;
    setPopoverPosition(annotationPopoverPosition({
      trigger,
      popover,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      alignRight: readonly,
    }));
  }, [readonly]);

  useLayoutEffect(() => {
    if (!popoverOpen) return;
    updatePopoverPosition();
  }, [annotations, popoverOpen, updatePopoverPosition]);

  useEffect(() => {
    if (!popoverOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      cancelScheduledClose();
      setPopoverOpen(false);
      setPopoverPosition(null);
    };
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [cancelScheduledClose, popoverOpen, updatePopoverPosition]);

  useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

  useEffect(() => {
    if (annotations.length > 0) return;
    cancelScheduledClose();
    setPopoverOpen(false);
    setPopoverPosition(null);
  }, [annotations.length, cancelScheduledClose]);

  if (annotations.length === 0) return null;
  const noun = annotations.length === 1 ? "annotation" : "annotations";

  return (
    <div className={`browser-annotation-attachment${readonly ? " is-readonly" : ""}`}>
      {readonly && (
        <div className="browser-annotation-preview-strip" aria-hidden="true">
          {annotations.map((annotation) => (
            <span key={annotation.id} className="browser-annotation-preview-tile">
              <AnnotationPreview annotation={annotation} />
            </span>
          ))}
        </div>
      )}
      <div
        className="browser-annotation-summary"
        onMouseEnter={openPopover}
        onMouseLeave={schedulePopoverClose}
        onFocusCapture={openPopover}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) schedulePopoverClose();
        }}
      >
        <div className="browser-annotation-summary-pill">
          <button
            ref={triggerRef}
            type="button"
            className="browser-annotation-summary-trigger"
            aria-describedby={popoverOpen ? popoverID : undefined}
            aria-expanded={popoverOpen}
          >
            <Icons.bubble size={13} />
            <span>{annotations.length} {noun}</span>
          </button>
          {!readonly && onClear && (
            <button type="button" className="browser-annotation-summary-clear" aria-label={`Remove all ${noun}`} onClick={onClear}>
              <Icons.close size={10} />
            </button>
          )}
        </div>
      </div>
      {popoverOpen && createPortal(
        <div
          ref={popoverRef}
          id={popoverID}
          className={`browser-annotation-popover${popoverPosition ? " is-positioned" : ""}`}
          role="tooltip"
          style={popoverPosition ?? undefined}
          onMouseEnter={cancelScheduledClose}
          onMouseLeave={schedulePopoverClose}
        >
          {annotations.map((annotation) => (
            <div key={annotation.id} className="browser-annotation-popover-row">
              <span className="browser-annotation-popover-preview" aria-hidden="true">
                <AnnotationPreview annotation={annotation} />
              </span>
              <span className="browser-annotation-popover-copy">
                <span className="browser-annotation-popover-target">
                  <span className="browser-annotation-kind">{annotationKind(annotation)}</span>
                  <span className="browser-annotation-label">{annotationLabel(annotation)}</span>
                </span>
                <span className="browser-annotation-instruction">{annotation.instruction}</span>
              </span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
