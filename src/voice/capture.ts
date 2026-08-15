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

export interface MicrophoneCapture {
  stop: () => Promise<void>;
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
): Promise<MicrophoneCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

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
