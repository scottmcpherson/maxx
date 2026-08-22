import { describe, expect, it } from "vitest";
import { EventKind, type ProviderRuntimeEvent } from "../contract/types";
import { VoiceConversationController } from "./conversationController";
import {
  isPlaybackEchoGuardActive,
  isVoiceHostAvailable,
  PLAYBACK_ECHO_GUARD_MS,
  processRuntimeEvent,
} from "./useVoiceConversation";

function runtimeEvent(
  overrides: Partial<ProviderRuntimeEvent> = {},
): ProviderRuntimeEvent {
  return {
    schemaVersion: 1,
    id: "event-1",
    providerInstanceID: "provider-1",
    threadID: "thread-a",
    turnID: "turn-a",
    sequence: 1,
    occurredAt: 1,
    kind: EventKind.turnTerminal,
    payload: { terminalState: "completed" },
    ...overrides,
  };
}

describe("voice conversation host lifecycle", () => {
  it("suppresses only the initial playback echo window", () => {
    const startedAt = 1_000;

    expect(isPlaybackEchoGuardActive("waitingForModel", startedAt, startedAt + PLAYBACK_ECHO_GUARD_MS)).toBe(false);
    expect(isPlaybackEchoGuardActive("speaking", startedAt + 1, startedAt + PLAYBACK_ECHO_GUARD_MS)).toBe(true);
    expect(isPlaybackEchoGuardActive(
      "speaking",
      startedAt + PLAYBACK_ECHO_GUARD_MS,
      startedAt + PLAYBACK_ECHO_GUARD_MS,
    )).toBe(false);
  });

  it("treats the client as available without a remote session", () => {
    expect(isVoiceHostAvailable("local", [], null)).toBe(true);
  });

  it("requires a connected signal for each remote execution or speech host", () => {
    const sessions = [{ host: { id: "speech-host" } }];
    const status = {
      remotes: [
        { id: "speech-host", connected: true },
        { id: "execution-host", connected: false },
      ],
    };

    expect(isVoiceHostAvailable("speech-host", sessions, status)).toBe(true);
    expect(isVoiceHostAvailable("execution-host", sessions, status)).toBe(false);
    expect(isVoiceHostAvailable("unknown-host", sessions, status)).toBe(false);
  });

  it("treats a remote host missing from an authoritative status snapshot as unavailable", () => {
    expect(isVoiceHostAvailable(
      "speech-host",
      [{ host: { id: "speech-host" } }],
      { remotes: [] },
    )).toBe(false);
    expect(isVoiceHostAvailable(
      "speech-host",
      [{ host: { id: "speech-host" } }],
      null,
    )).toBe(true);
  });

  it("rejects runtime events from another thread before they can finish or speak", () => {
    const effects: Array<{ type: string; text?: string }> = [];
    const controller = new VoiceConversationController("thread-a", [], (effect) => effects.push(effect));
    controller.start();
    controller.transcriptFinal("hello");
    const voiceTurnIDRef = { current: "turn-a" as string | null };
    const pendingVoiceTurnRef = { current: false };
    let playbackWaits = 0;
    processRuntimeEvent(
      runtimeEvent({
        id: "foreign-delta",
        threadID: "thread-b",
        kind: EventKind.assistantTextDelta,
        payload: { text: "Do not speak this." },
      }),
      controller,
      voiceTurnIDRef,
      pendingVoiceTurnRef,
      async () => { playbackWaits += 1; },
      1,
      () => {},
      () => { throw new Error("foreign event failed the conversation"); },
      () => {},
    );
    processRuntimeEvent(
      runtimeEvent({ id: "foreign-terminal", threadID: "thread-b" }),
      controller,
      voiceTurnIDRef,
      pendingVoiceTurnRef,
      async () => { playbackWaits += 1; },
      1,
      () => {},
      () => { throw new Error("foreign event failed the conversation"); },
      () => {},
    );
    expect(effects).toEqual([{ type: "submitTranscript", text: "hello" }]);
    expect(playbackWaits).toBe(0);
    expect(controller.snapshot.state).toBe("waitingForModel");
  });

  it("waits for playback only once when a terminal event is delivered twice", () => {
    const controller = new VoiceConversationController("thread-a", [], () => {});
    controller.start();
    controller.transcriptFinal("hello");
    const voiceTurnIDRef = { current: "turn-a" as string | null };
    const pendingVoiceTurnRef = { current: false };
    let playbackWaits = 0;
    const wait = async () => { playbackWaits += 1; };
    const event = runtimeEvent({ id: "terminal-1" });
    processRuntimeEvent(event, controller, voiceTurnIDRef, pendingVoiceTurnRef, wait, 1, () => {}, () => {}, () => {});
    processRuntimeEvent(event, controller, voiceTurnIDRef, pendingVoiceTurnRef, wait, 1, () => {}, () => {}, () => {});
    expect(playbackWaits).toBe(1);
  });

  it("speaks a canonical complete-text event from a non-streaming provider", () => {
    const effects: Array<{ type: string; text?: string; phrase?: string }> = [];
    const controller = new VoiceConversationController("thread-a", [], (effect) => effects.push(effect));
    controller.start();
    controller.transcriptFinal("hello");
    const voiceTurnIDRef = { current: "turn-a" as string | null };
    const pendingVoiceTurnRef = { current: false };

    processRuntimeEvent(
      runtimeEvent({
        id: "complete-text",
        kind: EventKind.assistantText,
        payload: { text: "Complete provider response." },
      }),
      controller,
      voiceTurnIDRef,
      pendingVoiceTurnRef,
      async () => {},
      1,
      () => {},
      () => {},
      () => {},
    );
    processRuntimeEvent(
      runtimeEvent({ id: "complete-terminal" }),
      controller,
      voiceTurnIDRef,
      pendingVoiceTurnRef,
      async () => {},
      1,
      () => {},
      () => {},
      () => {},
    );

    expect(effects).toEqual([
      { type: "submitTranscript", text: "hello" },
      { type: "speak", turnID: "turn-a", phrase: "Complete provider response." },
    ]);
  });
});
