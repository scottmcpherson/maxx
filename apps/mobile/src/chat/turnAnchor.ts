import type { ChatMessage } from "../types";

export function firstNewUserMessageIndex(messages: ChatMessage[], knownMessageIDs: ReadonlySet<string>): number {
  return messages.findIndex((message) => message.role === "user" && !knownMessageIDs.has(message.id));
}

export function turnAnchorSpacerHeight(
  windowHeight: number,
  headerHeight: number,
  composerHeight: number,
  keyboardOffset: number,
): number {
  return Math.max(0, windowHeight - headerHeight - composerHeight - keyboardOffset);
}
