import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../types";
import {
  activityPresentation,
  cleanAssistantText,
  latestTurn,
  mobileTimeline,
  shouldRenderLiveTurn,
} from "./runtime";

function event(kind: string, payload: RuntimeEvent["payload"], id = kind): RuntimeEvent {
  return { id, threadID: "thread", turnID: "turn", kind, occurredAt: 1, payload };
}

describe("latestTurn", () => {
  it("combines streaming assistant text until the terminal event", () => {
    const events = [
      event("assistant.text.delta", { text: "Mobile " }, "1"),
      event("assistant.text.delta", { text: "verified" }, "2"),
    ];
    expect(latestTurn(events)).toEqual({
      active: true,
      text: "Mobile verified",
      error: "",
      turnID: "turn",
      sourceEventID: "1",
    });
    expect(latestTurn([...events, event("turn.terminal", { terminalState: "completed" }, "3")]).active).toBe(false);
  });

  it("surfaces structured provider failures", () => {
    expect(latestTurn([
      event("error", {
        error: { code: "auth", message: "Sign in again.", isRecoverable: true },
      }),
      event("turn.terminal", { terminalState: "failed" }, "terminal"),
    ])).toEqual({
      active: false,
      text: "",
      error: "Sign in again.",
      turnID: "turn",
      sourceEventID: null,
    });
  });

  it("removes provider-introduced blank lines before streaming text", () => {
    expect(latestTurn([
      event("assistant.text.delta", { text: "\n\n" }, "1"),
      event("assistant.text.delta", { text: "Done" }, "2"),
    ]).text).toBe("Done");
  });

  it("uses runtime chronology instead of arrival order to identify the latest turn", () => {
    const old = event("assistant.text.delta", { text: "Old" }, "old");
    old.turnID = "old-turn";
    old.occurredAt = 1;
    const current = event("assistant.text.delta", { text: "Current" }, "current");
    current.turnID = "current-turn";
    current.occurredAt = 2;
    expect(latestTurn([current, old])).toMatchObject({
      turnID: "current-turn",
      text: "Current",
    });
  });
});

describe("shouldRenderLiveTurn", () => {
  const completed = {
    active: false,
    text: "Finished response",
    error: "",
    turnID: "turn",
    sourceEventID: "assistant-event",
  };

  it("keeps completed streamed text visible until its persisted message arrives", () => {
    expect(shouldRenderLiveTurn([], completed, false, false)).toBe(true);
    expect(shouldRenderLiveTurn([{
      id: "message",
      role: "assistant",
      content: "Finished response",
      createdAt: 2,
      sourceEventID: "assistant-event",
    }], completed, false, false)).toBe(false);
  });

  it("does not let an unrelated assistant message end the live handoff", () => {
    expect(shouldRenderLiveTurn([{
      id: "older-message",
      role: "assistant",
      content: "Older response",
      createdAt: 1,
      sourceEventID: "older-event",
    }], completed, false, false)).toBe(true);
  });

  it("waits for the submitted user message before showing working state", () => {
    const active = {
      active: true,
      text: "",
      error: "",
      turnID: "turn",
      sourceEventID: null,
    };
    expect(shouldRenderLiveTurn([], active, true, true)).toBe(false);
    expect(shouldRenderLiveTurn([], active, true, false)).toBe(true);
  });
});

describe("cleanAssistantText", () => {
  it("keeps meaningful spacing after removing only leading blank lines", () => {
    expect(cleanAssistantText("\n \nAnswer\n\nDetail")).toBe("Answer\n\nDetail");
  });
});

describe("mobileTimeline", () => {
  it("interleaves tool activity between user and assistant messages", () => {
    const messages = [
      { id: "user", role: "user" as const, content: "inspect it", createdAt: 1 },
      { id: "assistant", role: "assistant" as const, content: "Done", createdAt: 3 },
    ];
    const tool = event("tool", {
      tool: { name: "read_file", input: "package.json", output: "contents", state: "completed" },
    }, "tool");
    tool.occurredAt = 2;
    tool.itemID = "tool-1";
    expect(mobileTimeline(messages, [tool]).map((item) => item.id)).toEqual([
      "message:user",
      "activity:turn:tool-1",
      "message:assistant",
    ]);
  });

  it("collapses updates to one tool row and coalesces adjacent reasoning", () => {
    const running = event("tool", { tool: { name: "search", state: "running" } }, "running");
    running.itemID = "tool-1";
    const completed = event("tool", { tool: { name: "search", output: "found", state: "completed" } }, "completed");
    completed.itemID = "tool-1";
    completed.occurredAt = 2;
    const thoughtOne = event("reasoning.summary", { text: "Check " }, "thought-1");
    thoughtOne.itemID = "thought";
    thoughtOne.occurredAt = 3;
    const thoughtTwo = event("reasoning.summary", { text: "the types." }, "thought-2");
    thoughtTwo.itemID = "thought";
    thoughtTwo.occurredAt = 4;
    const items = mobileTimeline([], [running, completed, thoughtOne, thoughtTwo]);
    expect(items).toHaveLength(2);
    expect(items[0].type === "activity" && items[0].activity.event.payload.tool?.state).toBe("completed");
    expect(items[1].type === "activity" && items[1].activity.reasoning).toBe("Check the types.");
  });

  it("hides provider diagnostics by default and reveals them on request", () => {
    const diagnostic = event("warning", { title: "Unknown provider event" }, "diagnostic");
    expect(mobileTimeline([], [diagnostic])).toEqual([]);
    expect(mobileTimeline([], [diagnostic], true)).toHaveLength(1);
  });

  it("keeps actionable warnings visible", () => {
    const actionable = event("warning", { title: "Provider failed to start" }, "actionable");
    actionable.nativeReference = {
      protocolName: "codex-app-server",
      eventType: "mcpServer/startupStatus/updated",
    };
    expect(mobileTimeline([], [actionable])).toHaveLength(1);
  });
});

describe("activityPresentation", () => {
  it("presents a command as a subdued disclosure row", () => {
    const command = event("command", { title: "process list", command: "ps aux", output: "ok", state: "completed" });
    expect(activityPresentation({ id: "command", occurredAt: 1, event: command })).toEqual({
      verb: "Run",
      title: "process list",
      detail: "ps aux",
      output: "ok",
      files: undefined,
      state: "completed",
      isReasoning: false,
    });
  });

  it("turns compact verb-and-target tools into expandable disclosures", () => {
    const read = event("tool", {
      title: "read: /workspace/package.json",
      state: "pending",
      tool: { name: "read: /workspace/package.json", state: "pending" },
    });
    expect(activityPresentation({ id: "read", occurredAt: 1, event: read })).toMatchObject({
      verb: "read",
      title: "/workspace/package.json",
      detail: "/workspace/package.json",
    });
  });
});
