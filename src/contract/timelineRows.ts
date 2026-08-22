import { AgentDefinition, ChatImageAttachment, ChatTextSelection, ChatThread, EventKind } from "./types";
import { TimelineItem } from "./timeline";
import { isProviderDiagnostic } from "../../shared/providerDiagnostics";
import type { BrowserAnnotation } from "../browser";

/** One rendered line of a thread transcript, in chronological order. */
export type TimelineRow =
  | { key: string; at: number; kind: "user"; messageID: string; text: string; attachments: ChatImageAttachment[]; annotations: BrowserAnnotation[]; textSelections: ChatTextSelection[] }
  // Provider-reconciled terminal replies have no synthetic runtime event; a
  // normal GUI reply still renders from its source event to avoid duplication.
  | { key: string; at: number; kind: "assistant"; messageID: string; text: string }
  // `system` messages are Maxx's own annotations (currently the cross-provider
  // context handoff notice), rendered as a quiet inline marker.
  | { key: string; at: number; kind: "system"; messageID: string; text: string }
  | { key: string; at: number; kind: "terminalArchive"; archiveID: string; text: string }
  | { key: string; at: number; kind: "item"; item: TimelineItem };

export function buildRows(
  thread: ChatThread | undefined,
  timeline: TimelineItem[],
): TimelineRow[] {
  if (!thread) return [];
  const rows = thread.messages.reduce<TimelineRow[]>((result, message) => {
    const shared = {
      key: `message-${message.id}`,
      at: message.createdAt,
      messageID: message.id,
      text: message.content,
    };
    if (message.role === "user") {
      result.push({
        ...shared,
        kind: "user",
        attachments: message.attachments ?? [],
        annotations: message.annotations ?? [],
        textSelections: message.textSelections ?? [],
      });
    } else if (message.role === "assistant" && !message.sourceEventID) {
      result.push({ ...shared, kind: "assistant" });
    } else if (message.role === "system") {
      result.push({ ...shared, kind: "system" });
    }
    return result;
  }, []);
  const eventTimes = new Map<string, number>();
  for (const archive of thread.terminalArchives ?? []) {
    rows.push({
      key: `terminal-archive-${archive.id}`,
      at: archive.endedAt,
      kind: "terminalArchive",
      archiveID: archive.id,
      text: archive.content,
    });
  }
  for (const event of thread.runtimeEvents) {
    const existing = eventTimes.get(event.turnID);
    if (existing === undefined || event.occurredAt < existing) eventTimes.set(event.turnID, event.occurredAt);
  }
  timeline.forEach((item, index) => {
    rows.push({ key: item.key, at: (eventTimes.get(item.turnID) ?? 0) + index / 1_000_000, kind: "item", item });
  });
  return rows.sort((a, b) => a.at - b.at);
}

/**
 * Whether a timeline item paints anything. Single source of truth for the
 * render switch and for byline anchoring, which must agree.
 */
export function rendersRow(
  item: TimelineItem,
  terminalTurnIDs: Set<string>,
  showProviderDiagnostics = false,
): boolean {
  switch (item.type) {
    case "assistantText":
    case "reasoning":
    case "interaction":
      return true;
    case "status":
      return !terminalTurnIDs.has(item.turnID);
    case "terminal":
      return item.state !== "completed";
    case "card":
      return (
        item.kind !== EventKind.sessionState
        && (showProviderDiagnostics || !isProviderDiagnostic(item.event))
      );
    default:
      return false;
  }
}

/**
 * Row keys that open an agent's turn, mapped to that agent — the transcript
 * renders a byline (avatar + name + time) above them.
 *
 * The anchor must be a row that actually paints: anchoring to a swallowed row
 * (an "Unknown provider event" warning, say) would drop that agent's byline for
 * the whole turn, which in a multi-agent thread reads as if only one agent
 * answered. Status and terminal lines are progress chrome, never anchors.
 */
export function bylineAnchors(
  rows: TimelineRow[],
  turnAgents: Map<string, AgentDefinition> | undefined,
  terminalTurnIDs: Set<string>,
  showProviderDiagnostics = false,
): Map<string, AgentDefinition> {
  const map = new Map<string, AgentDefinition>();
  if (!turnAgents?.size) return map;
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "item") continue;
    const { item } = row;
    if (seen.has(item.turnID)) continue;
    if (item.type === "status" || item.type === "terminal") continue;
    if (!rendersRow(item, terminalTurnIDs, showProviderDiagnostics)) continue;
    seen.add(item.turnID);
    const agent = turnAgents.get(item.turnID);
    if (agent) map.set(row.key, agent);
  }
  return map;
}
