import { describe, expect, it } from "vitest";
import { CHATS_PROJECT_ID } from "../types";
import { chatCreationRequest } from "./chatCreation";

const runtime = {
  provider: "codex" as const,
  model: "default",
  title: "New chat",
  effort: null,
  speed: null,
};

describe("chatCreationRequest", () => {
  it("creates projectless chats through the Chats owner", () => {
    expect(chatCreationRequest(CHATS_PROJECT_ID, runtime)).toEqual({
      method: "add_chat",
      params: runtime,
    });
  });

  it("creates project chats inside the selected folder", () => {
    expect(chatCreationRequest("project-1", runtime)).toEqual({
      method: "add_thread_with_runtime",
      params: {
        projectId: "project-1",
        ...runtime,
        surface: "gui",
        worktree: false,
      },
    });
  });
});
