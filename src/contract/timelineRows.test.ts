import { describe, expect, it } from "vitest";
import { buildTimeline } from "./timeline";
import { bylineAnchors, buildRows, rendersRow } from "./timelineRows";
import { AgentDefinition, ChatThread, EventKind, ProviderRuntimeEvent } from "./types";

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

function agent(name: string): AgentDefinition {
  return {
    id: `agent-${name}`,
    name,
    instructions: "",
    provider: "codex",
    model: "Default",
    colorHex: "#856FFF",
    createdAt: 0,
    updatedAt: 0,
  };
}

function thread(events: ProviderRuntimeEvent[]): ChatThread {
  return {
    id: "thread",
    title: "Thread",
    provider: "codex",
    model: "Default",
    messages: [],
    runtimeEvents: events,
    interactionRequests: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("rendersRow", () => {
  it("hides provider diagnostics by default and reveals them on request", () => {
    const [unknown] = buildTimeline([
      event({ kind: EventKind.warning, itemID: "u", payload: { title: "Unknown provider event" } }),
    ]);
    const [codex] = buildTimeline([
      event({
        kind: EventKind.warning,
        itemID: "codex",
        payload: { title: "Codex warning" },
        nativeReference: { protocolName: "codex-app-server", eventType: "warning" },
      }),
    ]);
    const [claude] = buildTimeline([
      event({
        kind: EventKind.warning,
        itemID: "claude",
        payload: { title: "Claude rate limit", rawType: "allowed_warning" },
        nativeReference: { protocolName: "claude-stream-json", eventType: "rate_limit_event" },
      }),
    ]);
    const [actionable] = buildTimeline([
      event({
        kind: EventKind.warning,
        itemID: "mcp",
        payload: { title: "MCP server failed to start" },
        nativeReference: {
          protocolName: "codex-app-server",
          eventType: "mcpServer/startupStatus/updated",
        },
      }),
    ]);
    expect(rendersRow(unknown, new Set())).toBe(false);
    expect(rendersRow(codex, new Set())).toBe(false);
    expect(rendersRow(claude, new Set())).toBe(false);
    expect(rendersRow(actionable, new Set())).toBe(true);
    expect(rendersRow(unknown, new Set(), true)).toBe(true);
    expect(rendersRow(codex, new Set(), true)).toBe(true);
    expect(rendersRow(claude, new Set(), true)).toBe(true);
  });

  it("drops the status line and the completed terminal marker once a turn ends", () => {
    const [status] = buildTimeline([
      event({ turnID: "turn-1", kind: EventKind.sessionState, payload: { detail: "Working…" } }),
    ]);
    const [terminal] = buildTimeline([
      event({ turnID: "turn-1", kind: EventKind.turnTerminal, payload: { terminalState: "completed" } }),
    ]);
    expect(rendersRow(status, new Set())).toBe(true);
    expect(rendersRow(status, new Set(["turn-1"]))).toBe(false);
    expect(rendersRow(terminal, new Set())).toBe(false);
  });
});

describe("buildRows", () => {
  it("carries persisted image attachments into user rows", () => {
    const value = thread([]);
    value.messages = [{
      id: "message",
      role: "user",
      content: "compare these",
      createdAt: 1,
      attachments: [
        { id: "image", path: "/tmp/image.png", mimeType: "image/png", displayName: "image.png" },
      ],
    }];
    expect(buildRows(value, [])).toEqual([{
      key: "message-message",
      at: 1,
      kind: "user",
      messageID: "message",
      text: "compare these",
      attachments: [
        { id: "image", path: "/tmp/image.png", mimeType: "image/png", displayName: "image.png" },
      ],
      annotations: [],
    }]);
  });

  it("carries structured browser annotations into user rows", () => {
    const value = thread([]);
    const annotation = {
      id: "annotation",
      tabId: "tab",
      url: "https://example.com/",
      selector: "main > h1",
      tagName: "H1",
      role: "heading",
      name: "Example Domain",
      text: "Example Domain",
      instruction: "Make this heading orange",
      previewDataUrl: "",
      rect: { x: 20, y: 30, width: 200, height: 40 },
      createdAt: 1,
    };
    value.messages = [{
      id: "message",
      role: "user",
      content: "change this",
      createdAt: 1,
      attachments: [],
      annotations: [annotation],
    }];
    expect(buildRows(value, [])[0]).toMatchObject({ kind: "user", annotations: [annotation] });
  });
});

describe("bylineAnchors", () => {
  const dana = agent("Dana");
  const charlie = agent("Charlie");

  it("gives every agent in a multi-agent thread its own byline", () => {
    // Shape of a real chained turn: each agent's turn opens with provider
    // noise the timeline swallows, then the reply itself.
    const events = [
      event({ turnID: "turn-1", kind: EventKind.sessionState, itemID: "s1", payload: {} }),
      event({ turnID: "turn-1", kind: EventKind.warning, itemID: "u1", payload: { title: "Unknown provider event" } }),
      event({ turnID: "turn-1", payload: { text: "Hi, I am Dana." } }),
      event({ turnID: "turn-2", kind: EventKind.sessionState, itemID: "s2", payload: {} }),
      event({ turnID: "turn-2", kind: EventKind.warning, itemID: "u2", payload: { title: "Unknown provider event" } }),
      event({ turnID: "turn-2", payload: { text: "Hi, I am Charlie." } }),
    ];
    const timeline = buildTimeline(events);
    const rows = buildRows(thread(events), timeline);
    const anchors = bylineAnchors(
      rows,
      new Map([["turn-1", dana], ["turn-2", charlie]]),
      new Set(),
    );
    const named = rows
      .filter((row) => anchors.has(row.key))
      .map((row) => [row.kind === "item" ? row.item.type : row.kind, anchors.get(row.key)?.name]);
    expect(named).toEqual([
      ["assistantText", "Dana"],
      ["assistantText", "Charlie"],
    ]);
  });

  it("anchors on the first painted row of a turn, not a status line", () => {
    const events = [
      event({ turnID: "turn-1", kind: EventKind.sessionState, payload: { detail: "Working…" } }),
      event({ turnID: "turn-1", kind: EventKind.warning, itemID: "w1", payload: { title: "Codex warning" } }),
      event({ turnID: "turn-1", payload: { text: "Done." } }),
    ];
    const timeline = buildTimeline(events);
    const rows = buildRows(thread(events), timeline);
    const anchors = bylineAnchors(rows, new Map([["turn-1", dana]]), new Set());
    expect(anchors.size).toBe(1);
    const [anchoredKey] = [...anchors.keys()];
    const anchored = rows.find((row) => row.key === anchoredKey);
    expect(anchored?.kind === "item" && anchored.item.type).toBe("card");
  });

  it("returns nothing without turn attribution", () => {
    const events = [event({ turnID: "turn-1", payload: { text: "Hi." } })];
    const rows = buildRows(thread(events), buildTimeline(events));
    expect(bylineAnchors(rows, undefined, new Set()).size).toBe(0);
    expect(bylineAnchors(rows, new Map(), new Set()).size).toBe(0);
  });
});
