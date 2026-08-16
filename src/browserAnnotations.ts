import type { BrowserAnnotation } from "./browser";

export const MAX_BROWSER_ANNOTATIONS = 20;

export interface AnnotationPopoverPosition {
  left: number;
  top: number;
}

export function annotationPopoverPosition({
  trigger,
  popover,
  viewport,
  alignRight,
  gap = 8,
  margin = 12,
}: {
  trigger: { left: number; right: number; top: number; bottom: number };
  popover: { width: number; height: number };
  viewport: { width: number; height: number };
  alignRight: boolean;
  gap?: number;
  margin?: number;
}): AnnotationPopoverPosition {
  const maxLeft = Math.max(margin, viewport.width - popover.width - margin);
  const preferredLeft = alignRight ? trigger.right - popover.width : trigger.left;
  const left = Math.min(Math.max(preferredLeft, margin), maxLeft);
  const roomAbove = trigger.top - gap - margin;
  const roomBelow = viewport.height - trigger.bottom - gap - margin;
  const openBelow = popover.height > roomAbove && roomBelow > roomAbove;
  const preferredTop = openBelow ? trigger.bottom + gap : trigger.top - popover.height - gap;
  const maxTop = Math.max(margin, viewport.height - popover.height - margin);
  return {
    left,
    top: Math.min(Math.max(preferredTop, margin), maxTop),
  };
}

export function annotationKey(annotation: Pick<BrowserAnnotation, "tabId" | "selector">): string {
  return `${annotation.tabId}\u0000${annotation.selector}`;
}

export function annotationLabel(annotation: BrowserAnnotation): string {
  return annotation.name || annotation.text || `<${annotation.tagName}>`;
}

export function annotationKind(annotation: Pick<BrowserAnnotation, "role" | "tagName">): string {
  if (annotation.role) return annotation.role;
  if (/^h[1-6]$/i.test(annotation.tagName)) return "heading";
  if (/^(input|textarea)$/i.test(annotation.tagName)) return "textbox";
  return annotation.tagName.toLowerCase();
}

export function annotationPromptContext(annotation: BrowserAnnotation): string {
  const description = annotationLabel(annotation);
  return [
    `URL: ${annotation.url}`,
    `Element: ${annotation.selector}`,
    annotation.role ? `Role: ${annotation.role}` : null,
    `Description: ${description}`,
    `Instruction: ${annotation.instruction}`,
    annotation.text && annotation.text !== description ? `Visible text: ${annotation.text}` : null,
    `Bounds: x=${Math.round(annotation.rect.x)}, y=${Math.round(annotation.rect.y)}, width=${Math.round(annotation.rect.width)}, height=${Math.round(annotation.rect.height)}`,
  ].filter(Boolean).join("\n");
}

export function annotationsPromptContext(annotations: BrowserAnnotation[]): string {
  if (annotations.length === 0) return "";
  return [
    "[Selected webpage elements]",
    ...annotations.flatMap((annotation, index) => [
      `\n${index + 1}. ${annotationLabel(annotation)}`,
      annotationPromptContext(annotation),
    ]),
  ].join("\n");
}
