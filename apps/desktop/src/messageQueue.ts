import type { BrowserAnnotation } from "./browser";
import type { ChatProvider } from "./contract/types";
import type { ChatTextSelection } from "./contract/types";

export interface QueuedPromptMessage {
  id: string;
  kind: "prompt";
  projectID: string;
  threadID: string;
  hostID: string;
  prompt: string;
  attachmentPaths: string[];
  attachmentIds: string[];
  annotations: BrowserAnnotation[];
  textSelections: ChatTextSelection[];
}

export interface QueuedAgentMessage {
  id: string;
  kind: "agent";
  projectID: string;
  threadID: string;
  hostID: string;
  agentIDs: string[];
  prompt: string;
  attachmentPaths: string[];
  attachmentIds: string[];
}

export type QueuedMessage = QueuedPromptMessage | QueuedAgentMessage;

export function providerSupportsSteering(provider: ChatProvider): boolean {
  return provider === "codex" || provider === "pi";
}

export function queuedMessageSummary(message: QueuedMessage): string {
  const prompt = message.prompt.trim().replace(/\s+/g, " ");
  if (prompt) return prompt;
  const contextCount = message.kind === "prompt"
    ? message.annotations.length + message.textSelections.length
    : 0;
  const parts = [];
  const attachmentCount = message.attachmentPaths.length + message.attachmentIds.length;
  if (attachmentCount > 0) {
    parts.push(`${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`);
  }
  if (contextCount > 0) {
    parts.push(`${contextCount} ${contextCount === 1 ? "selection" : "selections"}`);
  }
  return parts.join(" · ") || "Queued message";
}
