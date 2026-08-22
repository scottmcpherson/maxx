import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types";
import { firstNewUserMessageIndex, turnAnchorSpacerHeight } from "./turnAnchor";

function message(id: string, role: ChatMessage["role"]): ChatMessage {
  return { id, role, content: id, createdAt: 1 };
}

describe("mobile turn anchoring", () => {
  it("finds the newly appended user message while ignoring assistant updates", () => {
    const messages = [message("old-user", "user"), message("reply", "assistant"), message("new-user", "user")];
    expect(firstNewUserMessageIndex(messages, new Set(["old-user", "reply"]))).toBe(2);
  });

  it("reserves exactly the visible transcript height below the anchor", () => {
    expect(turnAnchorSpacerHeight(844, 120, 86, 300)).toBe(338);
    expect(turnAnchorSpacerHeight(400, 200, 150, 100)).toBe(0);
  });
});
