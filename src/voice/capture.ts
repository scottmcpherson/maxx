// Microphone capture in the sandboxed app renderer.
//
// Chromium already owns an audio stack, so capture is `getUserMedia` here rather
// than CoreAudio in Rust. What crosses to Rust is the same thing that would
// have crossed anyway: 16 kHz mono PCM16, in ~100 ms chunks.
//
// An AudioWorklet rather than the deprecated ScriptProcessorNode, and raw PCM
// rather than MediaRecorder: MediaRecorder cannot emit partial results mid
// utterance, which is the entire point of live transcription, and its codec
// browser codec support can vary across platforms.

import { VOICE_SAMPLE_RATE } from "./types";
import { voiceInputConstraints } from "./devices";
import { ipc } from "../ipc";

const MICROPHONE_OPEN_TIMEOUT_MS = 10_000;

export class MicrophoneAccessError extends Error {
  readonly code = "voice.microphone-access" as const;

  constructor(message: string) {
    super(message);
    this.name = "MicrophoneAccessError";
  }
}

export function microphoneErrorMessage(reason: unknown): string {
  if (reason instanceof MicrophoneAccessError) return reason.message;
  if (reason instanceof DOMException && reason.name === "NotAllowedError") {
    return "Maxx needs microphone access. Allow it in System Settings → Privacy & Security → Microphone, then restart Maxx.";
  }
  const detail = reason instanceof Error ? reason.message : String(reason);
  return `Could not open the microphone: ${detail}`;
}

export interface MicrophoneCapture {
  stop: () => Promise<void>;
}

export interface MicrophoneCaptureOptions {
  inputDeviceId?: string | null;
  /** Root-mean-square signal level from 0–1, used only for local VAD. */
  onLevel?: (level: number) => void;
}

/** Base64 for the IPC hop. At ~32 kB/s the encoding cost is not measurable. */
function encodeChunk(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Chunked so a long buffer cannot blow the argument limit of `apply`.
  const STRIDE = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += STRIDE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + STRIDE));
  }
  return btoa(binary);
}

/**
 * Open the microphone and deliver PCM16 chunks until `stop()`.
 *
 * Rejects if the user denies the microphone or no input device exists — the
 * caller surfaces that rather than leaving a session hanging.
 */
export async function startMicrophoneCapture(
  onChunk: (base64: string) => void,
  options: MicrophoneCaptureOptions = {},
): Promise<MicrophoneCapture> {
  const access = await ipc.voiceMicrophoneAccess();
  if (!access.granted) {
    const action = access.status === "restricted"
      ? "Microphone access is restricted by macOS."
      : "Maxx does not have microphone access.";
    throw new MicrophoneAccessError(
      `${action} Allow it in System Settings → Privacy & Security → Microphone, then restart Maxx.`,
    );
  }

  const stream = await openMicrophone(options.inputDeviceId);

  // Asking for the target rate directly avoids resampling when the device can
  // oblige; the worklet still handles the case where it cannot.
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
  } catch {
    context = new AudioContext();
  }

  // Keep the processor as a packaged asset. Maxx's CSP deliberately excludes
  // blob scripts, and AudioWorklet applies that policy to addModule as well.
  const moduleUrl = new URL("maxx-pcm-worklet.js", document.baseURI).href;

  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  try {
    await context.audioWorklet.addModule(moduleUrl);
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, "maxx-pcm", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { targetRate: VOICE_SAMPLE_RATE },
    });
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      options.onLevel?.(pcm16RootMeanSquare(event.data));
      onChunk(encodeChunk(event.data));
    };
    source.connect(worklet);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close().catch(() => {});
    throw error;
  }

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // Tracks first: this is what actually turns off the recording indicator.
      stream.getTracks().forEach((track) => track.stop());
      if (worklet) {
        worklet.port.onmessage = null;
        worklet.disconnect();
      }
      source?.disconnect();
      await context.close().catch(() => {});
    },
  };
}

async function openMicrophone(inputDeviceId?: string | null): Promise<MediaStream> {
  const request = navigator.mediaDevices.getUserMedia({
    audio: voiceInputConstraints(inputDeviceId),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MicrophoneAccessError(
          "The microphone did not open. Check the selected input device and restart Maxx.",
        )), MICROPHONE_OPEN_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // getUserMedia cannot be aborted. If Chromium resolves after our bounded
    // wait, stop the late stream immediately so no hidden capture survives.
    void request.then((lateStream) => {
      lateStream.getTracks().forEach((track) => track.stop());
    }).catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function pcm16RootMeanSquare(buffer: ArrayBuffer): number {
  const samples = new Int16Array(buffer);
  if (samples.length === 0) return 0;
  let squareSum = 0;
  for (const sample of samples) {
    const normalized = sample / (sample < 0 ? 0x8000 : 0x7fff);
    squareSum += normalized * normalized;
  }
  return Math.sqrt(squareSum / samples.length);
}
