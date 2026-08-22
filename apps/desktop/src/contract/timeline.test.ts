// Port of the presentation guarantees in `RuntimeTimelinePresentationTests`
// and `ConversationTimelineTests`: delta coalescing, item-update collapsing,
// replay ordering, and unknown kinds staying renderable.

import { describe, expect, it } from "vitest";
import { buildTimeline, orderedEvents } from "./timeline";
import { EventKind, ProviderRuntimeEvent } from "./types";

let counter = 0;
function event(overrides: Partial<ProviderRuntimeEvent>): ProviderRuntimeEvent {
  counter += 1;
  return {
    schemaVersion: 1,
    id: `event-${counter}`,
    providerInstanceID: "instance",
    threadID: "thread",
    turnID: "turn",
    sequence: counter,
    occurredAt: counter,
    kind: EventKind.assistantTextDelta,
    payload: {},
    ...overrides,
  };
}

describe("orderedEvents", () => {
  it("orders by sequence inside a turn and drops duplicate ids", () => {
    const a = event({ sequence: 2, occurredAt: 5, payload: { text: "b" } });
    const b = event({ sequence: 1, occurredAt: 9, payload: { text: "a" } });
    const duplicate = { ...a, payload: { text: "dup" } };
    const ordered = orderedEvents([a, duplicate, b]);
    expect(ordered.map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it("orders turn blocks chronologically even when sequences restart", () => {
    const early1 = event({ turnID: "turn-early", sequence: 5, occurredAt: 10 });
    const early2 = event({ turnID: "turn-early", sequence: 6, occurredAt: 11 });
    const late = event({ turnID: "turn-late", sequence: 1, occurredAt: 50 });
    const ordered = orderedEvents([late, early2, early1]);
    expect(ordered.map((e) => e.id)).toEqual([early1.id, early2.id, late.id]);
  });
});

describe("buildTimeline", () => {
  it("coalesces assistant deltas per turn", () => {
    const items = buildTimeline([
      event({ payload: { text: "Hel" } }),
      event({ payload: { text: "lo" } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "assistantText", text: "Hello" });
  });

  it("collapses updates to the same item into one card with the latest state", () => {
    const items = buildTimeline([
      event({
        kind: EventKind.tool,
        itemID: "tool-1",
        payload: { title: "Read", state: "running" },
      }),
      event({
        kind: EventKind.tool,
        itemID: "tool-1",
        payload: { title: "Read", state: "completed" },
      }),
    ]);
    const cards = items.filter((i) => i.type === "card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: EventKind.tool });
    const card = cards[0] as Extract<(typeof cards)[number], { type: "card" }>;
    expect(card.event.payload.state).toBe("completed");
  });

  it("keeps one card when a sparse update supplies the item kind later", () => {
    const items = buildTimeline([
      event({
        kind: EventKind.tool,
        itemID: "tool-1",
        payload: { title: "Run browser action", state: "pending" },
      }),
      event({
        kind: EventKind.command,
        itemID: "tool-1",
        payload: {
          title: "Run browser action",
          command: '{"ref":"button-1"}',
          output: "Clicked button-1",
          state: "completed",
        },
      }),
    ]);
    const cards = items.filter((item) => item.type === "card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: EventKind.command,
      event: { payload: { output: "Clicked button-1", state: "completed" } },
    });
  });

  it("keeps interactions addressable by requestID and renders exactly one terminal", () => {
    const items = buildTimeline([
      event({
        kind: EventKind.approvalRequest,
        requestID: "request-1",
        payload: { approval: { kind: "command", title: "Run?", paths: [], options: [] } },
      }),
      event({ kind: EventKind.turnTerminal, payload: { terminalState: "completed" } }),
    ]);
    expect(items.filter((i) => i.type === "interaction")).toHaveLength(1);
    const terminals = items.filter((i) => i.type === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ state: "completed" });
  });

  it("renders unknown future kinds as generic cards without data loss", () => {
    const items = buildTimeline([
      event({ kind: "future.kind", payload: { text: "preserved" } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "card", kind: "future.kind" });
  });

  it("preserves text/tool interleaving instead of anchoring all text at the first delta", () => {
    const items = buildTimeline([
      event({ payload: { text: "Checking the docs." } }),
      event({
        kind: EventKind.tool,
        itemID: "tool-1",
        payload: { title: "Read", state: "completed" },
      }),
      event({ payload: { text: "Here is the answer." } }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["assistantText", "card", "assistantText"]);
    expect(items[0]).toMatchObject({ text: "Checking the docs." });
    expect(items[2]).toMatchObject({ text: "Here is the answer." });
  });

  it("splits reasoning runs with the same item id when another item intervenes", () => {
    const items = buildTimeline([
      event({ kind: EventKind.reasoningSummary, itemID: "agent-thought", payload: { text: "plan" } }),
      event({
        kind: EventKind.tool,
        itemID: "tool-1",
        payload: { title: "Read", state: "completed" },
      }),
      event({ kind: EventKind.reasoningSummary, itemID: "agent-thought", payload: { text: "revise" } }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["reasoning", "card", "reasoning"]);
    expect(items[0]).toMatchObject({ text: "plan" });
    expect(items[2]).toMatchObject({ text: "revise" });
  });

  it("keeps merging a text run across updates to an earlier card", () => {
    const items = buildTimeline([
      event({
        kind: EventKind.tool,
        itemID: "tool-1",
        payload: { title: "Read", state: "running" },
      }),
      event({ payload: { text: "Sum" } }),
      event({
        kind: EventKind.tool,
        itemID: "tool-1",
        payload: { title: "Read", state: "completed" },
      }),
      event({ payload: { text: "mary" } }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["card", "assistantText"]);
    expect(items[1]).toMatchObject({ text: "Summary" });
  });

  it("separates reasoning streams by item id", () => {
    const items = buildTimeline([
      event({ kind: EventKind.reasoningSummary, itemID: "a", payload: { text: "one" } }),
      event({ kind: EventKind.reasoningSummary, itemID: "a", payload: { text: " two" } }),
      event({ kind: EventKind.reasoningSummary, itemID: "b", payload: { text: "other" } }),
    ]);
    const reasoning = items.filter((i) => i.type === "reasoning");
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0]).toMatchObject({ text: "one two" });
  });
});
