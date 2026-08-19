import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, normalizeVoiceEvent } from "./ipc";
import { DEFAULT_VOICE_SETTINGS } from "./voice/types";

const invoke = vi.fn();

describe("clipboard IPC", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    vi.stubGlobal("window", { maxx: { invoke } });
  });

  it("writes text through the native desktop bridge", async () => {
    await ipc.writeClipboardText("mac-mini.tailnet.ts.net:54500");

    expect(invoke).toHaveBeenCalledWith("clipboard_write_text", {
      text: "mac-mini.tailnet.ts.net:54500",
    });
  });
});

describe("automation IPC", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    vi.stubGlobal("window", { maxx: { invoke } });
  });

  it("uses the Maxx scheduler method names and preserves the create contract", async () => {
    await ipc.createAutomation({
      title: "Weekday digest",
      kind: "agent_turn",
      prompt: "Summarize new issues",
      schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
      runtime: { provider: "hermes", model: "Default" },
    });
    expect(invoke).toHaveBeenCalledWith("create_automation", {
      title: "Weekday digest",
      kind: "agent_turn",
      prompt: "Summarize new issues",
      schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
      runtime: { provider: "hermes", model: "Default" },
    });
  });

  it("uses update for pause/resume and exposes run-now/delete operations", async () => {
    await ipc.updateAutomation("automation-1", { status: "paused" });
    await ipc.runAutomation("automation-1");
    await ipc.deleteAutomation("automation-1");
    expect(invoke.mock.calls).toEqual([
      ["update_automation", { id: "automation-1", status: "paused" }],
      ["run_automation", { id: "automation-1" }],
      ["delete_automation", { id: "automation-1" }],
    ]);
  });
});

describe("voice IPC", () => {
  const listen = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    listen.mockReset();
    listen.mockReturnValue(() => {});
    vi.stubGlobal("window", { maxx: { invoke, listen } });
  });

  it("routes speech execution and preserves an explicit settings snapshot", async () => {
    await ipc.voiceStatus(DEFAULT_VOICE_SETTINGS, "paired-mac");
    await ipc.voiceStart(DEFAULT_VOICE_SETTINGS, "paired-mac");
    await ipc.voiceSendAudio(7, "AQI=", 12, "paired-mac");
    await ipc.voiceStop(7, "paired-mac");

    expect(invoke.mock.calls).toEqual([
      ["voice_status", { settings: DEFAULT_VOICE_SETTINGS, hostId: "paired-mac" }],
      ["voice_start", { settings: DEFAULT_VOICE_SETTINGS, hostId: "paired-mac" }],
      ["voice_send_audio", { session: 7, chunk: "AQI=", sequence: 12, hostId: "paired-mac" }],
      ["voice_stop", { session: 7, hostId: "paired-mac" }],
    ]);
  });

  it("routes interruption mutations to the selected thread host, not speech host", async () => {
    await ipc.voiceInterruptTurn("project-1", "thread-1", "turn-1", "Already heard.", "thread-host");
    expect(invoke).toHaveBeenCalledWith("voice_interrupt_turn", {
      projectId: "project-1",
      threadId: "thread-1",
      turnId: "turn-1",
      spokenText: "Already heard.",
      hostId: "thread-host",
    });
  });

  it("routes TTS catalog, start, bounded reads, and cancellation to the speech host", async () => {
    await ipc.voiceListVoices(DEFAULT_VOICE_SETTINGS, "paired-mac");
    await ipc.voiceTtsStart(DEFAULT_VOICE_SETTINGS, "Hello", "voice-1", "paired-mac");
    await ipc.voiceTtsRead(4, -1, 4096, "paired-mac");
    await ipc.voiceTtsCancel(4, "paired-mac");

    expect(invoke.mock.calls).toEqual([
      ["voice_list_voices", { settings: DEFAULT_VOICE_SETTINGS, hostId: "paired-mac" }],
      ["voice_tts_start", { settings: DEFAULT_VOICE_SETTINGS, text: "Hello", voiceId: "voice-1", hostId: "paired-mac" }],
      ["voice_tts_read", { session: 4, afterSequence: -1, maxBytes: 4096, hostId: "paired-mac" }],
      ["voice_tts_cancel", { session: 4, hostId: "paired-mac" }],
    ]);
  });

  it("normalizes and filters remote voice events by the selected speech host", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    listen.mockImplementation((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => {};
    });
    const received: unknown[] = [];
    await ipc.onVoiceEvent((event) => received.push(event), "paired-mac");

    handlers.get("host://event")?.({
      hostId: "other-mac",
      event: "voice://event",
      payload: { kind: "final", session: 9, text: "ignored" },
    });
    handlers.get("host://event")?.({
      hostId: "paired-mac",
      event: "voice://event",
      payload: { kind: "final", session: 9, text: "accepted" },
    });

    expect(received).toEqual([{ kind: "final", session: 9, text: "accepted" }]);
    expect(normalizeVoiceEvent({ payload: { kind: "state", session: 9, state: "listening" } }))
      .toEqual({ kind: "state", session: 9, state: "listening" });
    expect(normalizeVoiceEvent({ kind: "state", session: 9, state: "unknown" })).toBeNull();
  });
});
