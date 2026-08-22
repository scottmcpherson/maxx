import type { ChatMessage, ChatThread, RuntimeEvent, RuntimeFileChange, RuntimeItemState } from "../types";
import { isProviderDiagnostic } from "../../../../shared/providerDiagnostics";

export type MobileTurnState = { active: boolean; text: string; error: string };

const ACTIVITY_KINDS = new Set([
  "command",
  "tool",
  "file.change",
  "diff",
  "plan",
  "warning",
  "error",
]);

export type MobileActivity = {
  id: string;
  occurredAt: number;
  event: RuntimeEvent;
  reasoning?: string;
};

export type MobileTimelineItem =
  | { type: "message"; id: string; occurredAt: number; message: ChatMessage }
  | { type: "activity"; id: string; occurredAt: number; activity: MobileActivity };

export type MobileActivityPresentation = {
  verb: string;
  title?: string;
  detail?: string;
  output?: string;
  files?: RuntimeFileChange[];
  state?: RuntimeItemState;
  isReasoning: boolean;
};

export function cleanAssistantText(text: string) {
  return text.replace(/^(?:[\t ]*\r?\n)+/, "");
}

function orderedEvents(events: RuntimeEvent[]) {
  return [...events].sort((a, b) =>
    a.occurredAt - b.occurredAt
    || (a.sequence ?? 0) - (b.sequence ?? 0)
    || a.id.localeCompare(b.id));
}

/** Build the visible mobile transcript without duplicating assistant text events. */
export function mobileTimeline(
  messages: ChatMessage[],
  events: RuntimeEvent[],
  showProviderDiagnostics = false,
): MobileTimelineItem[] {
  const activities: MobileActivity[] = [];
  const indexByIdentity = new Map<string, number>();
  let previousReasoningIndex: number | null = null;

  orderedEvents(events).forEach((event, eventIndex) => {
    if (!showProviderDiagnostics && isProviderDiagnostic(event)) return;

    if (event.kind === "reasoning.summary") {
      const identity = `${event.turnID}:${event.itemID ?? "summary"}`;
      const text = typeof event.payload.text === "string" ? event.payload.text : "";
      if (previousReasoningIndex !== null) {
        const previous = activities[previousReasoningIndex];
        if (`${previous.event.turnID}:${previous.event.itemID ?? "summary"}` === identity) {
          activities[previousReasoningIndex] = {
            ...previous,
            event,
            reasoning: `${previous.reasoning ?? ""}${text}`,
          };
          return;
        }
      }
      previousReasoningIndex = activities.length;
      activities.push({
        id: `activity:reasoning:${identity}:${event.id}`,
        occurredAt: event.occurredAt + (event.sequence ?? eventIndex) / 1_000_000,
        event,
        reasoning: text,
      });
      return;
    }

    previousReasoningIndex = null;
    if (!ACTIVITY_KINDS.has(event.kind)) return;
    const identity = `${event.turnID}:${event.itemID ?? `${event.kind}:${event.id}`}`;
    const existing = indexByIdentity.get(identity);
    if (existing !== undefined) {
      activities[existing] = { ...activities[existing], event };
      return;
    }
    indexByIdentity.set(identity, activities.length);
    activities.push({
      id: `activity:${identity}`,
      occurredAt: event.occurredAt + (event.sequence ?? eventIndex) / 1_000_000,
      event,
    });
  });

  const rows: MobileTimelineItem[] = [
    ...messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        type: "message" as const,
        id: `message:${message.id}`,
        occurredAt: message.createdAt,
        message,
      })),
    ...activities.map((activity) => ({
      type: "activity" as const,
      id: activity.id,
      occurredAt: activity.occurredAt,
      activity,
    })),
  ];
  return rows.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
}

export function activityPresentation(activity: MobileActivity): MobileActivityPresentation {
  const { event, reasoning } = activity;
  const payload = event.payload;
  if (reasoning !== undefined) {
    return { verb: "Thought briefly", detail: reasoning, isReasoning: true };
  }
  const compactTool = event.kind === "tool"
    ? payload.tool?.name.match(/^([^:\n]{1,30}):\s*(.+)$/)
    : undefined;
  const compactToolVerb = compactTool?.[1]?.trim();
  const compactToolTarget = compactTool?.[2]?.trim();
  const verb = event.kind === "command"
    ? "Run"
    : event.kind === "file.change"
      ? "Edit"
      : event.kind === "diff"
        ? "Diff"
        : event.kind === "plan"
          ? "Plan"
        : event.kind === "warning"
          ? "Warning"
          : event.kind === "error"
            ? "Error"
            : compactToolVerb ?? payload.tool?.name ?? payload.title ?? "Tool";
  const rawTitle = event.kind === "command"
    ? payload.title ?? payload.command
    : event.kind === "tool"
      ? compactToolTarget ?? payload.title ?? payload.tool?.input
      : payload.title ?? payload.files?.map((file) => file.path).join(", ");
  const title = firstLine(rawTitle);
  const planDetail = payload.plan?.map((step) => `${step.state === "completed" ? "✓" : "○"} ${step.title}`).join("\n");
  return {
    verb,
    title: title && title !== verb ? title : undefined,
    detail: payload.command ?? payload.tool?.input ?? payload.detail ?? payload.error?.detail ?? planDetail ?? compactToolTarget,
    output: payload.output ?? payload.tool?.output ?? payload.diff ?? payload.error?.message,
    files: payload.files,
    state: payload.state ?? payload.tool?.state,
    isReasoning: false,
  };
}

function firstLine(text: string | undefined) {
  const line = text?.split("\n")[0]?.trim();
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

export function latestTurn(events: ChatThread["runtimeEvents"]): MobileTurnState {
  const latest = events[events.length - 1];
  if (!latest) return { active: false, text: "", error: "" };
  const turn = events.filter((event) => event.turnID === latest.turnID);
  const terminal = [...turn].reverse().find((event) => event.kind === "turn.terminal");
  const failure = [...turn].reverse().find((event) => event.kind === "error");
  const error = failure?.payload.error?.message || failure?.payload.title || failure?.payload.detail || "";
  const text = turn
    .filter((event) => (event.kind === "assistant.text" || event.kind === "assistant.text.delta") && typeof event.payload.text === "string")
    .map((event) => event.payload.text)
    .join("");
  return { active: !terminal, text: cleanAssistantText(text), error };
}
