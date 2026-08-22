import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserAnnotation } from "../browser";
import { annotationKind, annotationLabel } from "../browserAnnotations";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { BubblesIcon, XIcon } from "lucide-react";
import { cn } from "../lib/utils";

function AnnotationPreview({ annotation }: { annotation: BrowserAnnotation }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [annotation.previewDataUrl]);
  if (annotation.previewDataUrl && !failed) {
    return <img className="size-full object-cover" src={annotation.previewDataUrl} alt="" onError={() => setFailed(true)} />;
  }
  return <span className="grid size-full place-items-center bg-muted text-muted-foreground"><BubblesIcon /></span>;
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
  const closeTimerRef = useRef<number | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

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
      closeTimerRef.current = null;
    }, 160);
  }, [cancelScheduledClose]);

  useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);
  useEffect(() => {
    if (annotations.length > 0) return;
    cancelScheduledClose();
    setPopoverOpen(false);
  }, [annotations.length, cancelScheduledClose]);

  if (annotations.length === 0) return null;
  const noun = annotations.length === 1 ? "annotation" : "annotations";

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <div
        className={cn(
          "relative flex w-full max-w-full flex-col items-start gap-1.5 px-px pb-1",
          readonly && "max-w-[42.5rem] items-end self-end pb-0",
        )}
        onMouseEnter={openPopover}
        onMouseLeave={schedulePopoverClose}
        onFocusCapture={openPopover}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) schedulePopoverClose();
        }}
      >
        {readonly && (
          <div className="flex items-center justify-end gap-2" aria-hidden="true">
            {annotations.map((annotation) => (
              <span key={annotation.id} className="size-14 overflow-hidden rounded-lg border border-border bg-muted shadow-sm">
                <AnnotationPreview annotation={annotation} />
              </span>
            ))}
          </div>
        )}
        <div className="flex max-w-full items-center overflow-hidden rounded-full border border-border bg-secondary text-secondary-foreground">
          <PopoverTrigger render={<Button variant="secondary" size="sm" className="min-w-0 rounded-none border-0 bg-transparent" aria-expanded={popoverOpen} />}>
            <BubblesIcon data-icon="inline-start" />
            <span>{annotations.length} {noun}</span>
          </PopoverTrigger>
          {!readonly && onClear && (
            <IconButton
              label={`Remove all ${noun}`}
              tooltip={`Remove all ${noun}`}
              size="icon-xs"
              className="me-1"
              onClick={onClear}
            >
              <XIcon />
            </IconButton>
          )}
        </div>
        <PopoverContent
          align={readonly ? "end" : "start"}
          className="w-[min(24.375rem,calc(100vw-1.5rem))] max-h-[calc(100vh-1.5rem)] overflow-y-auto p-0"
          onMouseEnter={cancelScheduledClose}
          onMouseLeave={schedulePopoverClose}
        >
          {annotations.map((annotation) => (
            <div key={annotation.id} className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-2.5 border-b border-border p-3 last:border-b-0">
              <span className="mt-px size-14 overflow-hidden rounded-lg border border-border bg-muted">
                <AnnotationPreview annotation={annotation} />
              </span>
              <span className="min-w-0 flex flex-col gap-1.5">
                <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.65rem]">{annotationKind(annotation)}</span>
                  <span className="truncate">{annotationLabel(annotation)}</span>
                </span>
                <span className="text-sm leading-snug text-foreground select-text">{annotation.instruction}</span>
              </span>
            </div>
          ))}
        </PopoverContent>
      </div>
    </Popover>
  );
}
