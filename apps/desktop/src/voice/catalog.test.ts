import { describe, expect, it } from "vitest";
import type { VoiceProfile } from "./types";
import { resolveVoiceSelection } from "./catalog";

const SCARLETT: VoiceProfile = {
  id: "scarlett",
  name: "Scarlett",
  model: "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
  language: "English",
};

describe("resolveVoiceSelection", () => {
  it("resolves a manually typed catalog ID to the catalog model", () => {
    expect(resolveVoiceSelection([SCARLETT], "scarlett", "tts-1")).toEqual({
      voiceID: "scarlett",
      model: SCARLETT.model,
    });
  });

  it("preserves a manual provider model when the voice is not in the catalog", () => {
    expect(resolveVoiceSelection([SCARLETT], "custom-voice", "custom-model")).toEqual({
      voiceID: "custom-voice",
      model: "custom-model",
    });
  });
});

