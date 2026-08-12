import type { BrowserAnnotation } from "./browser";

const EVENT = "maxx:browser-annotation-context";

export function annotationPromptContext(annotation: BrowserAnnotation): string {
  const description = annotation.name || annotation.text || `<${annotation.tagName}>`;
  return [
    "[Annotated webpage element]",
    `URL: ${annotation.url}`,
    `Element: ${annotation.selector}`,
    `Description: ${description}`,
    annotation.text && annotation.text !== description ? `Visible text: ${annotation.text}` : null,
  ].filter(Boolean).join("\n");
}

export function addAnnotationToComposer(annotation: BrowserAnnotation): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: annotationPromptContext(annotation) }));
}

export function onAnnotationComposerContext(handler: (context: string) => void): () => void {
  const listener = (event: Event): void => handler((event as CustomEvent<string>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
