import type { BrowserAnnotation } from "./browser";

export const MAX_BROWSER_ANNOTATIONS = 20;

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
