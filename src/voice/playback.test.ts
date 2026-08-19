import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OutputDeviceSelectionError,
  PcmPlayback,
  PlaybackBackpressureError,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioSourceLike,
  type Pcm16Chunk,
} from "./playback";

class FakeBuffer implements AudioBufferLike {
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(channelCount: number, frames: number, sampleRate: number) {
    this.duration = frames / sampleRate;
    this.channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

class FakeSource implements AudioSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  startCalls: number[] = [];
  stopped = false;

  connect(): unknown {
    return this;
  }

  start(when = 0): void {
    this.startCalls.push(when);
  }

  stop(): void {
    this.stopped = true;
    this.onended?.();
  }

  complete(): void {
    this.onended?.();
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 0;
  state = "running";
  destination = {};
  sources: FakeSource[] = [];
  sinkIDs: string[] = [];
  setSinkId = vi.fn(async (sinkId: string) => {
    this.sinkIDs.push(sinkId);
  });

  createBuffer(channels: number, frames: number, sampleRate: number): AudioBufferLike {
    return new FakeBuffer(channels, frames, sampleRate);
  }

  createBufferSource(): AudioSourceLike {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}

function pcm(sampleCount = 160): Pcm16Chunk {
  return {
    pcm: new Int16Array(sampleCount).buffer,
    sampleRate: 16_000,
  };
}

describe("PcmPlayback", () => {
  let context: FakeContext;
  let playback: PcmPlayback;

  beforeEach(() => {
    context = new FakeContext();
    playback = new PcmPlayback({ contextFactory: () => context });
  });

  it("starts a source from the first PCM chunk before the stream finishes", async () => {
    const session = playback.begin();
    expect(context.sources).toHaveLength(0);

    await expect(session.enqueue(pcm())).resolves.toBe(true);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].startCalls).toHaveLength(1);
  });

  it("bounds future playback by bytes and duration", async () => {
    const session = playback.begin({ maxBufferedBytes: 320, maxBufferedSeconds: 0.007 });
    await expect(session.enqueue(pcm(80))).resolves.toBe(true);
    const next = session.enqueue(pcm(80));
    await Promise.resolve();
    expect(context.sources).toHaveLength(1);
    context.sources[0].complete();
    await expect(next).resolves.toBe(true);
    expect(playback.stats().bufferedBytes).toBe(160);
  });

  it("rejects one impossible chunk while waiting for capacity for normal chunks", async () => {
    const session = playback.begin({ maxBufferedBytes: 320, maxBufferedSeconds: 0.007 });
    await expect(session.enqueue(pcm(160))).rejects.toBeInstanceOf(PlaybackBackpressureError);
  });

  it("applies bounded backpressure to a fast stream until each source completes", async () => {
    const session = playback.begin({ maxBufferedBytes: 320, maxBufferedSeconds: 0.021 });
    let producerDone = false;
    const producer = (async () => {
      for (let index = 0; index < 24; index += 1) await session.enqueue(pcm(160));
      producerDone = true;
    })();
    let completed = 0;
    for (let guard = 0; guard < 1_000 && !producerDone; guard += 1) {
      const source = context.sources[completed];
      if (source) {
        source.complete();
        completed += 1;
      }
      await Promise.resolve();
    }
    await producer;
    expect(completed).toBeGreaterThan(10);
    expect(playback.stats().bufferedBytes).toBeLessThanOrEqual(320);
    await session.cancel();
  });

  it("waits for scheduled audio to end on finish", async () => {
    const session = playback.begin();
    await session.enqueue(pcm());
    let finished = false;
    const done = session.finish().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    context.sources[0].complete();
    await done;
    expect(finished).toBe(true);
  });

  it("cancels active audio and rejects stale generations", async () => {
    const first = playback.begin();
    await first.enqueue(pcm());
    const second = playback.begin();
    await expect(first.enqueue(pcm())).resolves.toBe(false);
    expect(context.sources[0].stopped).toBe(true);
    await expect(second.enqueue(pcm())).resolves.toBe(true);
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  it("selects an output device when the context supports sink selection", async () => {
    const session = playback.begin({ outputDeviceId: "headphones" });
    await session.enqueue(pcm());
    expect(context.sinkIDs).toEqual(["headphones"]);
  });

  it("reports an explicit error when output selection is unavailable", async () => {
    const unsupported = new FakeContext();
    Reflect.deleteProperty(unsupported, "setSinkId");
    const session = new PcmPlayback({ contextFactory: () => unsupported }).begin({
      outputDeviceId: "headphones",
    });
    await expect(session.enqueue(pcm())).rejects.toBeInstanceOf(OutputDeviceSelectionError);
  });

  it("supports typed-array views without reading outside their byte range", async () => {
    const bytes = new Uint8Array(8);
    const view = new Int16Array(bytes.buffer, 2, 2);
    view[0] = 0x7fff;
    view[1] = -0x8000;
    const session = playback.begin();
    await expect(session.enqueue({ pcm: view, sampleRate: 16_000 })).resolves.toBe(true);
    const buffer = context.sources[0].buffer as FakeBuffer;
    expect(buffer.getChannelData(0)[0]).toBeCloseTo(1);
    expect(buffer.getChannelData(0)[1]).toBeCloseTo(-1);
  });
});
