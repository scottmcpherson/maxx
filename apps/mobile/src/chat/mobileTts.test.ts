import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import { pcm16Wav } from "./mobileWav";

describe("mobile TTS WAV packaging", () => {
  it("wraps PCM16 with the advertised sample rate and channel count", () => {
    const wav = pcm16Wav(Buffer.from([0, 0, 1, 0]), 24_000, 1);
    const readable = Buffer.from(wav);
    expect(readable.toString("ascii", 0, 4)).toBe("RIFF");
    expect(readable.toString("ascii", 8, 12)).toBe("WAVE");
    expect(readable.readUInt16LE(22)).toBe(1);
    expect(readable.readUInt32LE(24)).toBe(24_000);
    expect(readable.readUInt32LE(40)).toBe(4);
    expect(wav.length).toBe(48);
  });

  it("returns a native Uint8Array accepted by Expo's iOS file writer", () => {
    const wav = pcm16Wav(Buffer.from([0, 0]), 24_000, 1);

    expect(wav.constructor).toBe(Uint8Array);
    expect(wav.constructor.name).toBe("Uint8Array");
  });
});
