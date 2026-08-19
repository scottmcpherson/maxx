import { describe, expect, it } from "vitest";
import {
  IDLE_CONVERSATION,
  transitionConversation,
  type ConversationSnapshot,
} from "./conversationMachine";

describe("conversation state machine", () => {
  it("runs a complete hands-free turn", () => {
    let value = transitionConversation(IDLE_CONVERSATION, { type: "start" });
    expect(value.state).toBe("listening");
    value = transitionConversation(value, { type: "speechStarted" });
    expect(value.state).toBe("transcribing");
    value = transitionConversation(value, { type: "transcriptFinal" });
    expect(value.state).toBe("waitingForModel");
    value = transitionConversation(value, { type: "audioStarted" });
    expect(value.state).toBe("speaking");
    value = transitionConversation(value, { type: "modelFinished" });
    expect(value.state).toBe("speaking");
    value = transitionConversation(value, { type: "audioFinished" });
    expect(value.state).toBe("listening");
  });

  it("barge-in interrupts speaking and starts the next canonical turn", () => {
    let value: ConversationSnapshot = { ...IDLE_CONVERSATION, state: "speaking", audioFinished: false };
    value = transitionConversation(value, { type: "interrupt" });
    expect(value.state).toBe("interrupted");
    value = transitionConversation(value, { type: "speechStarted" });
    expect(value.state).toBe("interrupted");
    value = transitionConversation({ ...value, state: "listening" }, { type: "transcriptFinal" });
    expect(value.state).toBe("waitingForModel");
  });

  it("reconnects visibly and keeps mute state", () => {
    let value = transitionConversation(IDLE_CONVERSATION, { type: "start" });
    value = transitionConversation(value, { type: "mute" });
    value = transitionConversation(value, { type: "reconnecting" });
    expect(value.state).toBe("reconnecting");
    value = transitionConversation(value, { type: "reconnected" });
    expect(value.state).toBe("interrupted");
    expect(value.muted).toBe(true);
  });

  it("fails visibly and can retry or end from every active state", () => {
    let value = transitionConversation(
      transitionConversation(IDLE_CONVERSATION, { type: "start" }),
      { type: "fail", message: "Voice host unavailable" },
    );
    expect(value).toMatchObject({ state: "error", error: "Voice host unavailable" });
    value = transitionConversation(value, { type: "retry" });
    expect(value.state).toBe("reconnecting");
    value = transitionConversation(value, { type: "end" });
    expect(value.state).toBe("ended");
  });
});
