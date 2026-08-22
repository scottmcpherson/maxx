export type MarkdownLinkAction =
  | { kind: "open"; href: string }
  | { kind: "block" };

export type MarkdownSessionUpdate =
  | { kind: "none" }
  | { kind: "append"; text: string }
  | { kind: "reset"; text: string };

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:", "sms:"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export function resolveMarkdownLinkAction(href: string): MarkdownLinkAction {
  const normalized = href.trim();
  if (!normalized || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    return { kind: "block" };
  }

  const protocolMatch = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
  if (!protocolMatch) {
    return { kind: "block" };
  }
  const protocol = `${protocolMatch[1]?.toLowerCase()}:`;
  return ALLOWED_LINK_PROTOCOLS.has(protocol)
    ? { kind: "open", href: normalized }
    : { kind: "block" };
}

export function resolveMarkdownSessionUpdate(
  previous: string,
  next: string,
): MarkdownSessionUpdate {
  if (previous === next) {
    return { kind: "none" };
  }
  if (next.startsWith(previous)) {
    return { kind: "append", text: next.slice(previous.length) };
  }
  return { kind: "reset", text: next };
}
