import { useId } from "react";
import type { BrowserAnnotation } from "../browser";
import { annotationKind, annotationLabel } from "../browserAnnotations";
import { Icons } from "./Icons";

function AnnotationPreview({ annotation }: { annotation: BrowserAnnotation }) {
  if (annotation.previewDataUrl) {
    return <img src={annotation.previewDataUrl} alt="" />;
  }
  return <span className="browser-annotation-preview-fallback"><Icons.annotation size={15} /></span>;
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
      <div className="browser-annotation-summary">
        <div className="browser-annotation-summary-pill">
          <button type="button" className="browser-annotation-summary-trigger" aria-describedby={popoverID}>
            <Icons.bubble size={13} />
            <span>{annotations.length} {noun}</span>
          </button>
          {!readonly && onClear && (
            <button type="button" className="browser-annotation-summary-clear" aria-label={`Remove all ${noun}`} onClick={onClear}>
              <Icons.close size={10} />
            </button>
          )}
        </div>
        <div id={popoverID} className="browser-annotation-popover" role="tooltip">
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
        </div>
      </div>
    </div>
  );
}
