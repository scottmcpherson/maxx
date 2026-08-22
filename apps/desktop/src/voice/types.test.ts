import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_SETTINGS } from "./types";

describe("voice settings contract", () => {
  it("defaults to disabled voice features with xAI transcription and no TTS configuration", () => {
    expect(DEFAULT_VOICE_SETTINGS).toMatchObject({
      isEnabled: false,
      sttProvider: "xai",
      sttApiBase: "https://api.x.ai",
      ttsApiBase: "",
      ttsModel: "",
      voiceID: "",
      speechHostID: "local",
    });
  });
});
