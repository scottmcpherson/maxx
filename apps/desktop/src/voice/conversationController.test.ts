import { describe, expect, it } from "vitest";
import {
  VoiceConversationController,
  type ConversationEffect,
} from "./conversationController";

function controller(history: string[] = []) {
  const effects: ConversationEffect[] = [];
  return {
    effects,
    value: new VoiceConversationController("thread-a", history, (effect) => effects.push(effect)),
  };
}

describe("VoiceConversationController", () => {
  it("submits only final transcripts and deduplicates provider repeats", () => {
    const { value, effects } = controller();
    value.start();
    value.speechStarted();
    expect(effects).toEqual([]);
    value.transcriptFinal("  Hello Maxx.  ");
    value.transcriptFinal("hello   maxx.");
    expect(effects).toEqual([{ type: "submitTranscript", text: "Hello Maxx." }]);
    expect(value.snapshot.state).toBe("waitingForModel");
  });

  it("allows the same words again in a later turn", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("Repeat");
    value.modelFinished("turn-a");
    value.playbackFinished();
    value.transcriptFinal("Repeat");
    expect(effects.filter((effect) => effect.type === "submitTranscript")).toHaveLength(2);
  });

  it("speaks only new deltas from its bound canonical thread", () => {
    const { value, effects } = controller(["historical"]);
    value.start();
    value.transcriptFinal("Question");
    const common = { turnID: "turn-a", text: "First sentence. " };
    value.assistantDelta({ id: "historical", threadID: "thread-a", ...common });
    value.assistantDelta({ id: "other", threadID: "thread-b", ...common });
    value.assistantDelta({ id: "new", threadID: "thread-a", ...common });
    value.assistantDelta({ id: "new", threadID: "thread-a", ...common });
    expect(effects.filter((effect) => effect.type === "speak")).toEqual([
      { type: "speak", turnID: "turn-a", phrase: "First sentence." },
    ]);
  });

  it("flushes trailing text at model completion and returns after playback", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("Question");
    value.assistantDelta({ id: "one", threadID: "thread-a", turnID: "turn-a", text: "No punctuation yet" });
    value.modelFinished("turn-a");
    expect(effects.at(-1)).toEqual({ type: "speak", turnID: "turn-a", phrase: "No punctuation yet" });
    value.playbackStarted();
    value.playbackFinished();
    expect(value.snapshot.state).toBe("listening");
    expect(effects.at(-1)).toEqual({ type: "restartListening" });
  });

  it("drops assistant deltas that arrive after the model stream is terminal", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("Question");
    value.modelStarted("turn-a");
    value.modelFinished("turn-a");
    value.assistantDelta({
      id: "late-delta",
      threadID: "thread-a",
      turnID: "turn-a",
      text: "Must not be spoken.",
    });

    expect(effects.some((effect) => effect.type === "speak")).toBe(false);
  });

  it("does not bind a late prior-turn delta to the next pending turn", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("First");
    value.modelStarted("turn-a");
    value.modelFinished("turn-a");
    value.playbackFinished();

    value.transcriptFinal("Second");
    value.assistantDelta({
      id: "late-prior-turn",
      threadID: "thread-a",
      turnID: "turn-a",
      text: "Old answer.",
    });

    expect(effects.filter((effect) => effect.type === "speak")).toHaveLength(0);
  });

  it("barge-in cancels speech and the partial model turn before accepting speech", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("First question");
    value.assistantDelta({ id: "turn-event", threadID: "thread-a", turnID: "turn-a", text: "Answer" });
    value.playbackStarted();
    value.speechStarted();
    expect(effects.slice(-2)).toEqual([
      { type: "cancelSpeech" },
      { type: "interruptTurn", turnID: "turn-a", spokenText: "" },
    ]);
    expect(value.snapshot.state).toBe("transcribing");
    value.transcriptFinal("Actually, do something else");
    expect(effects.at(-1)).toEqual({ type: "submitTranscript", text: "Actually, do something else" });
  });

  it("end is idempotent and makes late events inert", () => {
    const { value, effects } = controller();
    value.start();
    value.end();
    value.end();
    value.assistantDelta({ id: "late", threadID: "thread-a", turnID: "turn-a", text: "Late." });
    expect(effects.filter((effect) => effect.type === "stopSession")).toHaveLength(1);
    expect(effects.some((effect) => effect.type === "speak")).toBe(false);
    expect(value.snapshot.state).toBe("ended");
  });

  it("deduplicates repeated finals within one utterance but accepts the same words later", () => {
    const { value, effects } = controller();
    value.start();
    value.speechStarted();
    value.transcriptFinal("same words");
    value.transcriptFinal("same words");
    value.modelFinished("turn-a");
    value.playbackFinished();
    value.speechStarted();
    value.transcriptFinal("same words");
    expect(effects.filter((effect) => effect.type === "submitTranscript")).toEqual([
      { type: "submitTranscript", text: "same words" },
      { type: "submitTranscript", text: "same words" },
    ]);
  });

  it("includes only completed phrases in a barge-in interrupt", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("first");
    value.assistantDelta({ id: "one", threadID: "thread-a", turnID: "turn-a", text: "Heard. Next." });
    value.phraseCompleted("turn-a", "Heard.");
    value.playbackStarted();
    value.speechStarted();
    expect(effects.at(-1)).toEqual({ type: "interruptTurn", turnID: "turn-a", spokenText: "Heard." });
  });

  it("does not interrupt when interruption is disabled", () => {
    const effects: ConversationEffect[] = [];
    const value = new VoiceConversationController("thread-a", [], (effect) => effects.push(effect), false);
    value.start();
    value.transcriptFinal("first");
    value.playbackStarted();
    value.speechStarted();
    expect(effects.some((effect) => effect.type === "interruptTurn")).toBe(false);
    expect(value.snapshot.state).toBe("speaking");
  });

  it("interrupts a thinking turn atomically before accepting the new utterance", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("first");
    value.assistantDelta({ id: "thinking", threadID: "thread-a", turnID: "turn-a", text: "" });
    value.speechStarted();
    expect(effects.slice(-2)).toEqual([
      { type: "cancelSpeech" },
      { type: "interruptTurn", turnID: "turn-a", spokenText: "" },
    ]);
    expect(value.snapshot.state).toBe("transcribing");
  });

  it("can interrupt before the first assistant delta when the canonical turn is known", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("first");
    value.modelStarted("turn-a");
    value.speechStarted();
    expect(effects.at(-1)).toEqual({ type: "interruptTurn", turnID: "turn-a", spokenText: "" });
  });

  it("ends a known turn through the atomic interrupt effect", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("first");
    value.assistantDelta({ id: "answer", threadID: "thread-a", turnID: "turn-a", text: "Answer" });
    value.playbackStarted();
    value.end();
    expect(effects.slice(-3)).toEqual([
      { type: "cancelSpeech" },
      { type: "interruptTurn", turnID: "turn-a", spokenText: "" },
      { type: "stopSession" },
    ]);
  });

  it("resumes listening after a manual interrupt", () => {
    const { value, effects } = controller();
    value.start();
    value.transcriptFinal("first");
    value.modelStarted("turn-a");
    value.interrupt();

    expect(value.snapshot.state).toBe("listening");
    expect(effects.at(-1)).toEqual({
      type: "interruptTurn",
      turnID: "turn-a",
      spokenText: "",
    });
  });

  it("clears a disconnected turn before reconnecting to the same thread", () => {
    const { value } = controller();
    value.start();
    value.transcriptFinal("first");
    value.modelStarted("turn-a");
    value.connectionLost();
    expect(value.snapshot.state).toBe("reconnecting");

    value.reconnected();
    value.transcriptFinal("second");
    value.modelStarted("turn-b");
    value.assistantDelta({ id: "new", threadID: "thread-a", turnID: "turn-b", text: "New." });
    expect(value.interruptTarget).toEqual({ turnID: "turn-b", spokenText: "" });
  });
});
