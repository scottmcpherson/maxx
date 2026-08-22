import { composerPrimaryAction, conversationIsAvailable, sttIsAvailable } from "./composerVoice";
import type { VoiceSettings } from "../types";
import { describe, expect, it } from "vitest";

const configured: VoiceSettings = {
  isEnabled: true,
  useGrokSignIn: false,
  sttProvider: "openai-compatible",
  sttApiBase: "http://127.0.0.1:8000/v1",
  sttModel: "parakeet",
  language: "en",
  ttsProvider: "openai-compatible",
  ttsApiBase: "http://127.0.0.1:8001/v1",
  ttsModel: "qwen-tts",
  voiceID: "scarlett",
  inputDeviceID: null,
  outputDeviceID: null,
  speechHostID: "local",
  turnDetection: "automatic",
  allowInterruption: true,
};

describe("mobile composer voice actions", () => {
  it("shows dictation only when STT is configured", () => {
    expect(sttIsAvailable(configured)).toBe(true);
    expect(sttIsAvailable({ ...configured, sttModel: "" })).toBe(false);
    expect(sttIsAvailable({ ...configured, isEnabled: false })).toBe(false);
    expect(sttIsAvailable({ ...configured, sttProvider: "xai", sttModel: "" })).toBe(true);
  });

  it("requires both STT and named TTS for conversation", () => {
    expect(conversationIsAvailable(configured)).toBe(true);
    expect(conversationIsAvailable({ ...configured, voiceID: "" })).toBe(false);
    expect(conversationIsAvailable({ ...configured, ttsApiBase: "" })).toBe(false);
  });

  it("matches the desktop primary-action priority", () => {
    expect(composerPrimaryAction({ conversationActive: false, hasContent: false, conversationAvailable: true })).toBe("conversation");
    expect(composerPrimaryAction({ conversationActive: false, hasContent: true, conversationAvailable: true })).toBe("send");
    expect(composerPrimaryAction({ conversationActive: true, hasContent: true, conversationAvailable: true })).toBe("stop-conversation");
  });
});
