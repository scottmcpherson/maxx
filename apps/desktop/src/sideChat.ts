import type { ChatTextSelection } from "./contract/types";

export const MAX_SIDE_CHAT_SELECTIONS = 12;
export const MAX_SIDE_CHAT_SELECTION_CHARS = 4_000;

export interface SideChatRequest {
  id: string;
  parentThreadID: string;
  selection?: ChatTextSelection;
}

export function createChatTextSelection(text: string): ChatTextSelection | null {
  const normalized = text.replace(/\s+/g, " ").trim().slice(0, MAX_SIDE_CHAT_SELECTION_CHARS);
  return normalized ? { id: crypto.randomUUID(), text: normalized } : null;
}

export function appendChatTextSelection(
  selections: ChatTextSelection[],
  selection: ChatTextSelection,
): ChatTextSelection[] {
  if (selections.some((candidate) => candidate.text === selection.text)) return selections;
  return [...selections, selection].slice(-MAX_SIDE_CHAT_SELECTIONS);
}

