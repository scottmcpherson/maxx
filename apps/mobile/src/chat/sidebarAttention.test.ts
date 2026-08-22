import { describe, expect, it } from "vitest";
import type { ChatProject, ChatThread, WorkspaceDocument } from "../types";
import { attentionThreads, unseenTargetForFinishedTurn, withStickyAttention } from "./sidebarAttention";

function thread(id: string, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    title: id,
    provider: "codex",
    model: "default",
    messages: [],
    runtimeEvents: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function project(id: string, threads: ChatThread[]): ChatProject {
  return { id, folderPath: `/tmp/${id}`, threads };
}

describe("mobile sidebar attention", () => {
  it("shows only unseen and waiting top-level chats with waiting taking precedence", () => {
    const projects = [project("one", [
      thread("read"),
      thread("unseen"),
      thread("waiting", { interactionRequests: [{ turnID: "turn-a", status: "pending" }] }),
      thread("both", { interactionRequests: [{ turnID: "turn-b", status: "pending" }] }),
      thread("side", { parentThreadID: "unseen" }),
    ])];
    const items = attentionThreads(
      projects,
      { waiting: "turn-a", both: "turn-b" },
      new Set(["unseen", "both", "side"]),
      null,
    );
    expect(items.map((item) => [item.thread.id, item.reason])).toEqual([
      ["unseen", "unseen"],
      ["waiting", "waiting"],
      ["both", "waiting"],
    ]);
  });

  it("excludes the selected chat and keeps it sticky only while it stays selected", () => {
    const projects = [project("one", [thread("selected"), thread("other")])];
    const items = attentionThreads(projects, {}, new Set(["selected", "other"]), "selected");
    expect(items.map((item) => item.thread.id)).toEqual(["other"]);
    expect(withStickyAttention(items, projects, { threadID: "selected", reason: "unseen" }, "selected")
      .map((item) => item.thread.id)).toEqual(["other", "selected"]);
    expect(withStickyAttention(items, projects, { threadID: "selected", reason: "unseen" }, "other"))
      .toEqual(items);
  });

  it("rolls side-chat completions up and ignores user-cancelled finishes", () => {
    const workspace = {
      projects: [project("one", [thread("parent"), thread("side", { parentThreadID: "parent" })])],
    } as WorkspaceDocument;
    const envelope = { projectID: "one", threadID: "side", turnID: "turn-a", terminalState: "completed" as const };
    expect(unseenTargetForFinishedTurn(workspace, envelope, null)).toBe("parent");
    expect(unseenTargetForFinishedTurn(workspace, { ...envelope, terminalState: "cancelled" }, null)).toBeNull();
    expect(unseenTargetForFinishedTurn(workspace, envelope, "parent")).toBeNull();
  });
});
