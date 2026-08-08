// Microphone capture in the webview.
//
// WebKit already owns an audio stack, so capture is `getUserMedia` here rather
// than CoreAudio in Rust. What crosses to Rust is the same thing that would
// have crossed anyway: 16 kHz mono PCM16, in ~100 ms chunks.
//
// An AudioWorklet rather than the deprecated ScriptProcessorNode, and raw PCM
// rather than MediaRecorder: MediaRecorder cannot emit partial results mid
// utterance, which is the entire point of live transcription, and its codec
// support in WKWebView is inconsistent.

import { VOICE_SAMPLE_RATE } from "./types";

/** ~100 ms of audio per message. Small enough to feel live, large enough that
 *  the IPC round trip per chunk stays irrelevant. */
const CHUNK_MILLISECONDS = 100;

/**
 * Worklet source, inlined and loaded from a blob URL so no separate build
 * entry or static asset is needed. `addModule` requires a URL, and a blob is
 * the only way to give it one without a bundler plugin.
 *
 * Resampling happens here rather than on the main thread because the worklet
 * is the only place that sees every render quantum without jitter. The
 * `sampleRate` global is the context's real rate, which is not necessarily the
 * rate we asked for.
 */
const WORKLET_SOURCE = `
class MaxxPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = options.processorOptions.targetRate;
    this.step = sampleRate / target;
    this.chunkSamples = Math.round(target * ${CHUNK_MILLISECONDS} / 1000);
    this.cursor = 0;
    this.pending = [];
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    // Linear interpolation between neighbouring input samples. \`cursor\`
    // carries its fractional part across quanta so the output rate does not
    // drift over a long dictation.
    while (this.cursor < channel.length) {
      const index = Math.floor(this.cursor);
      const fraction = this.cursor - index;
      const current = channel[index];
      const next = index + 1 < channel.length ? channel[index + 1] : current;
      this.pending.push(current + (next - current) * fraction);
      this.cursor += this.step;
      if (this.pending.length >= this.chunkSamples) this.flush();
    }
    this.cursor -= channel.length;
    return true;
  }

  flush() {
    const pcm = new Int16Array(this.pending.length);
    for (let i = 0; i < pcm.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, this.pending[i]));
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    this.pending = [];
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
}

registerProcessor("maxx-pcm", MaxxPcmProcessor);
`;

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

  const moduleUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
  );

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
    URL.revokeObjectURL(moduleUrl);
    throw error;
  } finally {
    // `addModule` has already fetched it; holding the URL only leaks.
    URL.revokeObjectURL(moduleUrl);
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
