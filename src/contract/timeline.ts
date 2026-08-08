// Port of `ConversationTimelineItem.build`: fold the ordered canonical event
// stream into display items. Assistant deltas and reasoning chunks coalesce
// into consecutive runs (an intervening item starts a new block, preserving
// text/tool interleaving), updates to the same itemID collapse into one card
// (latest state wins), and the turn terminal closes the block.

import {
  EventKind,
  ProviderRuntimeEvent,
  ProviderTurnTerminalState,
  RuntimeEventPayload,
} from "./types";

export type TimelineItem =
  | { type: "assistantText"; key: string; turnID: string; text: string }
  | { type: "reasoning"; key: string; turnID: string; itemID: string; text: string }
  | { type: "status"; key: string; turnID: string; text: string }
  | { type: "card"; key: string; turnID: string; kind: string; event: ProviderRuntimeEvent }
  | {
      type: "interaction";
      key: string;
      turnID: string;
      kind: string;
      event: ProviderRuntimeEvent;
    }
  | {
      type: "terminal";
      key: string;
      turnID: string;
      state: ProviderTurnTerminalState;
    };

/** Ordering mirror of `RuntimeContract.ordered` for events already grouped by
 * thread: sequence within a turn, turn blocks chronologically. */
export function orderedEvents(events: ProviderRuntimeEvent[]): ProviderRuntimeEvent[] {
  const byTurn = new Map<string, ProviderRuntimeEvent[]>();
  for (const event of events) {
    const key = `${event.providerInstanceID}:${event.threadID}:${event.turnID}`;
    const bucket = byTurn.get(key);
    if (bucket) bucket.push(event);
    else byTurn.set(key, [event]);
  }
  const blocks = [...byTurn.entries()].map(([key, bucket]) => {
    bucket.sort(
      (a, b) =>
        a.sequence - b.sequence || a.occurredAt - b.occurredAt || a.id.localeCompare(b.id),
    );
    const date = Math.min(...bucket.map((e) => e.occurredAt));
    return { key, date, bucket };
  });
  blocks.sort((a, b) => a.date - b.date || a.key.localeCompare(b.key));
  const seen = new Set<string>();
  const result: ProviderRuntimeEvent[] = [];
  for (const block of blocks) {
    for (const event of block.bucket) {
      if (!seen.has(event.id)) {
        seen.add(event.id);
        result.push(event);
      }
    }
  }
  return result;
}

export function buildTimeline(events: ProviderRuntimeEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const indexByKey = new Map<string, number>();

  const upsert = (key: string, item: TimelineItem) => {
    const existing = indexByKey.get(key);
    if (existing === undefined) {
      indexByKey.set(key, items.length);
      items.push(item);
    } else {
      items[existing] = item;
    }
  };

  for (const event of orderedEvents(events)) {
    const payload: RuntimeEventPayload = event.payload;
    switch (event.kind) {
      case EventKind.assistantTextDelta:
      case EventKind.assistantText: {
        // Mirror of `ConversationTimelineItem.build`: a delta extends the
        // immediately preceding assistant run of the same turn; any
        // intervening item (tool, reasoning, card) starts a new text block so
        // interleaving is preserved instead of anchoring all text at the
        // position of the turn's first delta.
        const last = items[items.length - 1];
        if (last?.type === "assistantText" && last.turnID === event.turnID) {
          items[items.length - 1] = { ...last, text: last.text + (payload.text ?? "") };
        } else {
          const key = `assistant:${event.turnID}:${event.id}`;
          upsert(key, {
            type: "assistantText",
            key,
            turnID: event.turnID,
            text: payload.text ?? "",
          });
        }
        break;
      }
      case EventKind.reasoningSummary: {
        const itemID = event.itemID ?? "summary";
        const last = items[items.length - 1];
        if (
          last?.type === "reasoning" &&
          last.turnID === event.turnID &&
          last.itemID === itemID
        ) {
          items[items.length - 1] = { ...last, text: last.text + (payload.text ?? "") };
        } else {
          const key = `reasoning:${event.turnID}:${itemID}:${event.id}`;
          upsert(key, {
            type: "reasoning",
            key,
            turnID: event.turnID,
            itemID,
            text: payload.text ?? "",
          });
        }
        break;
      }
      case EventKind.sessionState: {
        const key = `status:${event.turnID}`;
        upsert(key, {
          type: "status",
          key,
          turnID: event.turnID,
          text: payload.detail ?? "",
        });
        break;
      }
      case EventKind.sessionBinding:
        break; // bookkeeping, not a visible card
      case EventKind.approvalRequest:
      case EventKind.userInputRequest: {
        const key = `interaction:${event.requestID ?? event.id}`;
        upsert(key, {
          type: "interaction",
          key,
          turnID: event.turnID,
          kind: event.kind,
          event,
        });
        break;
      }
      case EventKind.turnTerminal: {
        const key = `terminal:${event.turnID}`;
        upsert(key, {
          type: "terminal",
          key,
          turnID: event.turnID,
          state: payload.terminalState ?? "completed",
        });
        break;
      }
      default: {
        // command / file.change / diff / tool / plan / usage / warning / error
        // and unknown future kinds render as activity cards; updates with the
        // same itemID collapse into one card.
        const key = `card:${event.kind}:${event.turnID}:${event.itemID ?? event.id}`;
        upsert(key, { type: "card", key, turnID: event.turnID, kind: event.kind, event });
        break;
      }
    }
  }
  return items;
}
