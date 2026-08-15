// AudioWorklet processor for microphone capture. This file is copied as-is to
// the renderer root so both Vite's dev server and the packaged file URL can
// load it under Maxx's script-src 'self' policy.

const CHUNK_MILLISECONDS = 100;

class MaxxPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = options.processorOptions.targetRate;
    this.step = sampleRate / target;
    this.chunkSamples = Math.round(target * CHUNK_MILLISECONDS / 1000);
    this.cursor = 0;
    this.pending = [];
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    // Linear interpolation between neighbouring input samples. `cursor`
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
    for (let index = 0; index < pcm.length; index += 1) {
      const clamped = Math.max(-1, Math.min(1, this.pending[index]));
      pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    this.pending = [];
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
}

registerProcessor("maxx-pcm", MaxxPcmProcessor);
