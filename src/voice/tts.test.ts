import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_SETTINGS } from "./types";
import {
  VoiceTtsAdapter,
  VoiceTtsBoundsError,
  VoiceTtsError,
  VoiceTtsPlayer,
  VoiceTtsSequenceError,
  VoiceTtsStaleGenerationError,
  VoiceTtsStream,
  type VoiceTtsTransport,
} from "./tts";
import type { VoiceTtsReadResult, VoiceTtsStartResult } from "./types";
import { PcmPlayback, type AudioBufferLike, type AudioContextLike, type AudioSourceLike } from "./playback";

const SETTINGS = {
  ...DEFAULT_VOICE_SETTINGS,
  ttsApiBase: "http://voice.test/v1",
  ttsModel: "test-voice",
};

function pcmBase64(sampleCount = 2): string {
  const bytes = new Uint8Array(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = index === 0 ? 0x7fff : 0;
    bytes[index * 2] = sample & 0xff;
    bytes[index * 2 + 1] = sample >> 8;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class FakeTransport implements VoiceTtsTransport {
  nextSession = 1;
  reads: VoiceTtsReadResult[] = [];
  starts: Array<{ text: string; voiceId: string | null | undefined; hostId: string | null | undefined }> = [];
  readCalls: Array<{ session: number; afterSequence: number; maxBytes: number; hostId: string | null | undefined }> = [];
  canceled: Array<{ session: number; hostId: string | null | undefined }> = [];

  async voiceTtsStart(_settings: typeof SETTINGS, text: string, voiceId?: string | null, hostId?: string | null): Promise<VoiceTtsStartResult> {
    this.starts.push({ text, voiceId, hostId });
    return { session: this.nextSession++, mimeType: "audio/pcm", sampleRate: 16_000, channels: 1 };
  }

  async voiceTtsRead(session: number, afterSequence: number, maxBytes: number, hostId?: string | null): Promise<VoiceTtsReadResult> {
    this.readCalls.push({ session, afterSequence, maxBytes, hostId });
    return this.reads.shift() ?? { chunks: [], done: true };
  }

  async voiceTtsCancel(session: number, hostId?: string | null): Promise<void> {
    this.canceled.push({ session, hostId });
  }
}

class FakeBuffer implements AudioBufferLike {
  readonly duration: number;
  constructor(frames: number, sampleRate: number) {
    this.duration = frames / sampleRate;
  }
  getChannelData(): Float32Array {
    return new Float32Array(1);
  }
}

class FakeSource implements AudioSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect(): unknown { return this; }
  start(): void {
    this.started = true;
    queueMicrotask(() => this.onended?.());
  }
  stop(): void { this.stopped = true; this.onended?.(); }
}

class FakeContext implements AudioContextLike {
  currentTime = 0;
  state = "running";
  destination = {};
  sources: FakeSource[] = [];
  createBuffer(_channels: number, frames: number, sampleRate: number): AudioBufferLike {
    return new FakeBuffer(frames, sampleRate);
  }
  createBufferSource(): AudioSourceLike {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("VoiceTtsAdapter", () => {
  it("streams PCM chunks immediately with bounded host reads and strict sequence", async () => {
    const transport = new FakeTransport();
    transport.reads.push({
      chunks: [
        { sequence: 0, chunk: pcmBase64() },
        { sequence: 1, chunk: pcmBase64() },
      ],
      done: true,
    });
    const stream = await new VoiceTtsAdapter(transport, { maxReadBytes: 64 }).stream(
      SETTINGS,
      "Hello",
      "voice-1",
      "remote-mac",
    );
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].sampleRate).toBe(16_000);
    expect(transport.readCalls[0]).toMatchObject({ afterSequence: -1, maxBytes: 64, hostId: "remote-mac" });
    expect(transport.starts[0]).toMatchObject({ voiceId: "voice-1", hostId: "remote-mac" });
  });

  it("rejects gaps and total payloads beyond the renderer bound", async () => {
    const sequenceTransport = new FakeTransport();
    sequenceTransport.reads.push({ chunks: [{ sequence: 2, chunk: pcmBase64() }], done: true });
    const sequenceStream = await new VoiceTtsAdapter(sequenceTransport).stream(SETTINGS, "Hello");
    await expect(sequenceStream.next()).rejects.toBeInstanceOf(VoiceTtsSequenceError);

    const boundsTransport = new FakeTransport();
    boundsTransport.reads.push({ chunks: [{ sequence: 0, chunk: pcmBase64(2) }], done: true });
    const boundsStream = await new VoiceTtsAdapter(boundsTransport, { maxTotalBytes: 2 }).stream(SETTINGS, "Hello");
    await expect(boundsStream.next()).rejects.toBeInstanceOf(VoiceTtsBoundsError);
  });

  it("rejects structurally invalid chunks as a provider error", async () => {
    const transport = new FakeTransport();
    transport.reads.push({ chunks: [{ sequence: 0, chunk: 42 as unknown as string }], done: true });
    const stream = await new VoiceTtsAdapter(transport).stream(SETTINGS, "Hello");
    await expect(stream.next()).rejects.toMatchObject({ code: "voice.tts" });
  });

  it("rejects malformed provider error and session metadata explicitly", async () => {
    const errorTransport = new FakeTransport();
    errorTransport.reads.push({ chunks: [], done: true, error: { message: "bad" } as unknown as string });
    const errorStream = await new VoiceTtsAdapter(errorTransport).stream(SETTINGS, "Hello");
    await expect(errorStream.next()).rejects.toBeInstanceOf(VoiceTtsError);

    expect(() => new VoiceTtsStream(
      errorTransport,
      { session: 1, mimeType: null as unknown as string, sampleRate: 16_000, channels: 1 },
      "local",
      () => true,
    )).toThrow("Unsupported TTS audio format");
  });

  it("bounds encoded PCM before decoding an oversized read", async () => {
    const transport = new FakeTransport();
    transport.reads.push({ chunks: [{ sequence: 0, chunk: pcmBase64(8) }], done: true });
    const stream = await new VoiceTtsAdapter(transport, { maxReadBytes: 4 }).stream(SETTINGS, "Hello");
    await expect(stream.next()).rejects.toBeInstanceOf(VoiceTtsBoundsError);
  });

  it("cancels the host session and rejects a late read from a superseded generation", async () => {
    const transport = new FakeTransport();
    let resolveRead: ((result: VoiceTtsReadResult) => void) | undefined;
    transport.voiceTtsRead = async (...args) => {
      transport.readCalls.push({ session: args[0], afterSequence: args[1], maxBytes: args[2], hostId: args[3] });
      return new Promise<VoiceTtsReadResult>((resolve) => { resolveRead = resolve; });
    };
    const adapter = new VoiceTtsAdapter(transport);
    const stream = await adapter.stream(SETTINGS, "Hello", null, "remote-mac");
    const pending = stream.next();
    await adapter.cancel();
    resolveRead?.({ chunks: [], done: true });

    await expect(pending).rejects.toBeInstanceOf(VoiceTtsStaleGenerationError);
    expect(transport.canceled).toEqual([{ session: 1, hostId: "remote-mac" }]);
  });
});

describe("VoiceTtsPlayer", () => {
  it("feeds the first streamed chunk directly into PcmPlayback", async () => {
    const transport = new FakeTransport();
    transport.reads.push({ chunks: [{ sequence: 0, chunk: pcmBase64() }], done: true });
    const context = new FakeContext();
    let firstChunkAccepted = 0;
    const player = new VoiceTtsPlayer(transport, {
      playback: new PcmPlayback({ contextFactory: () => context }),
      onFirstChunk: () => { firstChunkAccepted += 1; },
    });

    await player.play(SETTINGS, "This is a test.", "voice-1", "local");

    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].started).toBe(true);
    expect(firstChunkAccepted).toBe(1);
    expect(transport.canceled).toHaveLength(0);
  });

  it("cancels both synthesis and scheduled playback", async () => {
    const transport = new FakeTransport();
    let resolveRead: ((result: VoiceTtsReadResult) => void) | undefined;
    transport.voiceTtsRead = async () => new Promise<VoiceTtsReadResult>((resolve) => { resolveRead = resolve; });
    const context = new FakeContext();
    const player = new VoiceTtsPlayer(transport, { playback: new PcmPlayback({ contextFactory: () => context }) });
    const playing = player.play(SETTINGS, "This is a test.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await player.cancel();
    resolveRead?.({ chunks: [], done: true });
    await expect(playing).resolves.toBeUndefined();
    expect(transport.canceled).toEqual([{ session: 1, hostId: "local" }]);
  });

  it("short-circuits playback cancellation while remote read and cancel are pending", async () => {
    const transport = new FakeTransport();
    let resolveRead: ((result: VoiceTtsReadResult) => void) | undefined;
    let resolveCancel: (() => void) | undefined;
    transport.voiceTtsRead = async () => new Promise<VoiceTtsReadResult>((resolve) => {
      resolveRead = resolve;
    });
    transport.voiceTtsCancel = async () => new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const player = new VoiceTtsPlayer(transport, { playback: new PcmPlayback({ contextFactory: () => new FakeContext() }) });
    const playing = player.play(SETTINGS, "This is a test.");
    await new Promise((resolve) => setTimeout(resolve, 0));

    let playbackSettled = false;
    void playing.then(() => { playbackSettled = true; });
    await player.cancel();
    await Promise.resolve();
    expect(playbackSettled).toBe(true);

    resolveRead?.({ chunks: [], done: true });
    resolveCancel?.();
    await playing;
  });
});
