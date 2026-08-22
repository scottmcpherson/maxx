import { describe, expect, it } from "vitest";
import {
  AudioDeviceError,
  enumerateVoiceDevices,
  outputDeviceSelectionSupported,
  voiceInputConstraints,
} from "./devices";

function device(
  kind: MediaDeviceKind,
  deviceId: string,
  label = "",
): MediaDeviceInfo {
  return { deviceId, groupId: "group", kind, label, toJSON: () => ({}) };
}

describe("voice audio devices", () => {
  it("separates inputs and outputs, de-duplicates, and puts the default first", async () => {
    const result = await enumerateVoiceDevices({
      enumerateDevices: async () => [
        device("audiooutput", "speaker-1", "Desk speakers"),
        device("audioinput", "mic-1", "Desk microphone"),
        device("audioinput", "default"),
        device("audioinput", "mic-1", "Duplicate microphone"),
        device("videoinput", "camera"),
      ],
    });
    expect(result.inputs).toEqual([
      { id: "default", kind: "input", label: "Default microphone", isDefault: true },
      { id: "mic-1", kind: "input", label: "Desk microphone", isDefault: false },
    ]);
    expect(result.outputs).toEqual([
      { id: "speaker-1", kind: "output", label: "Desk speakers", isDefault: false },
    ]);
  });

  it("creates an exact input constraint only for a chosen non-default device", () => {
    expect(voiceInputConstraints()).toEqual({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    expect(voiceInputConstraints("mic-1")).toMatchObject({ deviceId: { exact: "mic-1" } });
  });

  it("reports unavailable media devices explicitly", async () => {
    await expect(enumerateVoiceDevices(null)).rejects.toBeInstanceOf(AudioDeviceError);
  });

  it("feature-detects output routing", () => {
    expect(outputDeviceSelectionSupported({ setSinkId: async () => {} })).toBe(true);
    expect(outputDeviceSelectionSupported({})).toBe(false);
  });
});
