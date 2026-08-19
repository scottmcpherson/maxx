/** Renderer-owned audio device discovery and stable display helpers. */

export type VoiceAudioDeviceKind = "input" | "output";

export interface VoiceAudioDevice {
  id: string;
  kind: VoiceAudioDeviceKind;
  label: string;
  isDefault: boolean;
}

export interface VoiceAudioDevices {
  inputs: VoiceAudioDevice[];
  outputs: VoiceAudioDevice[];
}

export class AudioDeviceError extends Error {
  readonly code = "audio.devices-unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "AudioDeviceError";
  }
}

export interface AudioDeviceEnumerator {
  enumerateDevices(): Promise<ReadonlyArray<MediaDeviceInfo>>;
}

/**
 * Enumerate only devices relevant to voice. Labels are intentionally generated
 * when the browser withholds them before permission; device IDs are retained
 * so settings can still identify a selected device without exposing paths.
 */
export async function enumerateVoiceDevices(
  mediaDevices: AudioDeviceEnumerator | null | undefined = defaultMediaDevices(),
): Promise<VoiceAudioDevices> {
  if (!mediaDevices) {
    throw new AudioDeviceError("This environment does not provide audio devices.");
  }
  let devices: ReadonlyArray<MediaDeviceInfo>;
  try {
    devices = await mediaDevices.enumerateDevices();
  } catch (error) {
    throw new AudioDeviceError(`Could not enumerate audio devices: ${String(error)}`);
  }

  const inputs: VoiceAudioDevice[] = [];
  const outputs: VoiceAudioDevice[] = [];
  const seen = new Set<string>();
  for (const device of devices) {
    if (device.kind !== "audioinput" && device.kind !== "audiooutput") continue;
    const kind: VoiceAudioDeviceKind = device.kind === "audioinput" ? "input" : "output";
    const id = device.deviceId || "default";
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = kind === "input" ? inputs : outputs;
    target.push({
      id,
      kind,
      label: device.label.trim() || fallbackLabel(kind, target.length, id),
      isDefault: id === "default",
    });
  }

  return {
    inputs: putDefaultFirst(inputs),
    outputs: putDefaultFirst(outputs),
  };
}

/** Build a microphone constraint without silently selecting a different input. */
export function voiceInputConstraints(deviceId?: string | null): MediaTrackConstraints {
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
  };
}

export function outputDeviceSelectionSupported(context: { setSinkId?: unknown }): boolean {
  return typeof context.setSinkId === "function";
}

function defaultMediaDevices(): AudioDeviceEnumerator | null {
  return typeof navigator !== "undefined" ? navigator.mediaDevices : null;
}

function fallbackLabel(kind: VoiceAudioDeviceKind, index: number, id: string): string {
  if (id === "default") return kind === "input" ? "Default microphone" : "System Default";
  return `${kind === "input" ? "Microphone" : "Speaker"} ${index + 1}`;
}

function putDefaultFirst(devices: VoiceAudioDevice[]): VoiceAudioDevice[] {
  return [...devices].sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
}
