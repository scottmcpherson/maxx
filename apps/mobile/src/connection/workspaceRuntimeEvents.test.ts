import { describe, expect, it } from "vitest";
import type { RuntimeEvent, WorkspaceDocument } from "../types";
import { applyRuntimeEvent, mergeLiveRuntimeEvents } from "./workspaceRuntimeEvents";

function event(id: string, sequence: number, text: string): RuntimeEvent {
  return {
    id,
    threadID: "thread",
    turnID: "turn",
    sequence,
    kind: "assistant.text.delta",
    occurredAt: 10,
    payload: { text },
  };
}

function workspace(events: RuntimeEvent[] = []): WorkspaceDocument {
  return {
    schemaVersion: 1,
    projects: [{
      id: "project",
      folderPath: "/project",
      threads: [{
        id: "thread",
        title: "Thread",
        provider: "codex",
        model: "default",
        messages: [],
        runtimeEvents: events,
        createdAt: 1,
        updatedAt: 1,
      }],
    }],
    providerProfiles: [],
    voice: {} as WorkspaceDocument["voice"],
  };
}

describe("mobile live runtime workspace", () => {
  it("appends and orders streamed deltas without duplicates", () => {
    const second = event("second", 2, "world");
    const first = event("first", 1, "Hello ");
    let current = applyRuntimeEvent(workspace(), { projectID: "project", threadID: "thread", event: second });
    current = applyRuntimeEvent(current, { projectID: "project", threadID: "thread", event: first });
    current = applyRuntimeEvent(current, { projectID: "project", threadID: "thread", event: first });
    expect(current?.projects[0].threads[0].runtimeEvents.map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("retains deltas that arrived while a workspace snapshot was in flight", () => {
    const live = event("live", 2, "world");
    const merged = mergeLiveRuntimeEvents(workspace([event("saved", 1, "Hello ")]), workspace([live]));
    expect(merged.projects[0].threads[0].runtimeEvents.map((item) => item.id)).toEqual(["saved", "live"]);
  });
});
