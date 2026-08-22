/**
 * Client-side PCM16 playback for streamed speech.
 *
 * The speech provider is deliberately absent from this module. A caller owns
 * the stream and feeds chunks to a generation-bound session; playback only
 * converts little-endian PCM16 into short AudioBufferSourceNodes. That lets
 * the first chunk become audible immediately while keeping the amount of
 * future audio bounded.
 */

export interface Pcm16Chunk {
  /** Interleaved, little-endian signed PCM16 samples. */
  pcm: ArrayBuffer | ArrayBufferView;
  sampleRate: number;
  channels?: number;
}

export interface AudioBufferLike {
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioSourceLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioSourceLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  /** Chromium exposes this on some AudioContext versions, but not all. */
  setSinkId?: (sinkId: string) => Promise<void>;
}

export type AudioContextFactory = () => AudioContextLike;

export interface PlaybackLimits {
  /** Maximum future audio scheduled in the context. */
  maxBufferedSeconds: number;
  /** Maximum PCM payload retained or scheduled by this session. */
  maxBufferedBytes: number;
}

export interface PlaybackOptions extends Partial<PlaybackLimits> {
  outputDeviceId?: string | null;
}

export interface PlaybackStats {
  bufferedSeconds: number;
  bufferedBytes: number;
  generation: number;
  playing: boolean;
}

export class PlaybackBackpressureError extends Error {
  readonly code = "playback.backpressure" as const;

  constructor(message = "Speech playback queue is full.") {
    super(message);
    this.name = "PlaybackBackpressureError";
  }
}

export class OutputDeviceSelectionError extends Error {
  readonly code = "playback.output-device-unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "OutputDeviceSelectionError";
  }
}

export class PlaybackAudioError extends Error {
  readonly code = "playback.audio-unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "PlaybackAudioError";
  }
}

export interface PlaybackSession {
  readonly generation: number;
  /** Returns false when the session was canceled or the chunk is stale. */
  enqueue(chunk: Pcm16Chunk): Promise<boolean>;
  /** Resolve once all accepted audio has finished, or after cancellation. */
  finish(): Promise<void>;
  cancel(): Promise<void>;
}

const DEFAULT_LIMITS: PlaybackLimits = {
  maxBufferedSeconds: 2,
  maxBufferedBytes: 384_000,
};

interface ScheduledAudio {
  source: AudioSourceLike;
  bytes: number;
  duration: number;
  ended: boolean;
}

interface PendingFinish {
  resolve: () => void;
}

/**
 * One reusable output graph. Calling begin() supersedes every previous
 * generation, which is the stale-audio guard needed for barge-in/cancel.
 */
export class PcmPlayback {
  private readonly contextFactory: AudioContextFactory;
  private readonly defaultLimits: PlaybackLimits;
  private context: AudioContextLike | null = null;
  private outputDeviceId: string | null = null;
  private nextGeneration = 0;
  private current: SessionState | null = null;
  private disposed = false;

  constructor(options: {
    contextFactory?: AudioContextFactory;
    maxBufferedSeconds?: number;
    maxBufferedBytes?: number;
  } = {}) {
    this.contextFactory = options.contextFactory
      ?? (() => new AudioContext() as unknown as AudioContextLike);
    this.defaultLimits = validateLimits({
      maxBufferedSeconds: options.maxBufferedSeconds ?? DEFAULT_LIMITS.maxBufferedSeconds,
      maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_LIMITS.maxBufferedBytes,
    });
  }

  begin(options: PlaybackOptions = {}): PlaybackSession {
    if (this.disposed) throw new PlaybackAudioError("Speech playback has been disposed.");

    // Cancel synchronously enough to invalidate old enqueue calls immediately;
    // the returned promise only waits for source.stop() cleanup.
    const previous = this.current;
    if (previous) void this.cancelState(previous);

    const generation = ++this.nextGeneration;
    const state: SessionState = {
      generation,
      limits: validateLimits({
        maxBufferedSeconds: options.maxBufferedSeconds ?? this.defaultLimits.maxBufferedSeconds,
        maxBufferedBytes: options.maxBufferedBytes ?? this.defaultLimits.maxBufferedBytes,
      }),
      outputDeviceId: options.outputDeviceId ?? null,
      scheduled: [],
      bufferedBytes: 0,
      nextStartTime: 0,
      finishRequested: false,
      finishWaiters: [],
      capacityWaiters: [],
      canceled: false,
      setupPromise: null,
    };
    this.current = state;

    return {
      generation,
      enqueue: (chunk) => this.enqueue(state, chunk),
      finish: () => this.finish(state),
      cancel: () => this.cancelState(state),
    };
  }

  async cancel(): Promise<void> {
    if (this.current) await this.cancelState(this.current);
  }

  stats(): PlaybackStats {
    const state = this.current;
    if (!state) {
      return {
        bufferedSeconds: 0,
        bufferedBytes: 0,
        generation: this.nextGeneration,
        playing: false,
      };
    }
    return {
      bufferedSeconds: Math.max(0, state.nextStartTime - (this.context?.currentTime ?? 0)),
      bufferedBytes: state.bufferedBytes,
      generation: state.generation,
      playing: !state.canceled && state.scheduled.length > 0,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.current) await this.cancelState(this.current);
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => {});
  }

  private async enqueue(state: SessionState, chunk: Pcm16Chunk): Promise<boolean> {
    if (!this.isCurrent(state)) return false;
    const normalized = normalizeChunk(chunk);
    const context = await this.ensureContext(state);
    if (!this.isCurrent(state) || !context) return false;

    if (normalized.bytes > state.limits.maxBufferedBytes || normalized.duration > state.limits.maxBufferedSeconds) {
      throw new PlaybackBackpressureError(
        `A single speech chunk is larger than the playback bound (${state.limits.maxBufferedSeconds}s or ${state.limits.maxBufferedBytes} bytes).`,
      );
    }
    if (!await this.waitForCapacity(state, normalized, context)) return false;

    const buffer = context.createBuffer(normalized.channels, normalized.frames, normalized.sampleRate);
    for (let channel = 0; channel < normalized.channels; channel += 1) {
      const destination = buffer.getChannelData(channel);
      for (let frame = 0; frame < normalized.frames; frame += 1) {
        destination[frame] = normalized.samples[frame * normalized.channels + channel];
      }
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const now = context.currentTime;
    const startAt = Math.max(now, state.nextStartTime);
    const scheduled: ScheduledAudio = {
      source,
      bytes: normalized.bytes,
      duration: normalized.duration,
      ended: false,
    };
    state.scheduled.push(scheduled);
    state.bufferedBytes += normalized.bytes;
    state.nextStartTime = startAt + normalized.duration;
    source.onended = () => this.sourceEnded(state, scheduled);
    try {
      source.start(startAt);
    } catch (error) {
      this.sourceEnded(state, scheduled);
      throw new PlaybackAudioError(`Could not start speech playback: ${String(error)}`);
    }
    return true;
  }

  private async finish(state: SessionState): Promise<void> {
    if (!this.isCurrent(state) || state.canceled) return;
    state.finishRequested = true;
    this.resolveFinishIfDrained(state);
    if (state.scheduled.length === 0) return;
    await new Promise<void>((resolve) => state.finishWaiters.push({ resolve }));
  }

  private async cancelState(state: SessionState): Promise<void> {
    if (state.canceled) return;
    state.canceled = true;
    state.finishRequested = true;
    for (const scheduled of [...state.scheduled]) {
      scheduled.source.onended = null;
      try {
        scheduled.source.stop();
      } catch {
        // A source can already have ended between the stale check and stop.
      }
    }
    state.scheduled.length = 0;
    state.bufferedBytes = 0;
    state.nextStartTime = 0;
    const capacityWaiters = state.capacityWaiters.splice(0);
    for (const resolve of capacityWaiters) resolve(false);
    this.resolveFinishIfDrained(state);
    if (this.current === state) this.current = null;
  }

  private async ensureContext(state: SessionState): Promise<AudioContextLike | null> {
    if (!this.isCurrent(state)) return null;
    if (!state.setupPromise) {
      const setup = this.createContext(state);
      const trackedSetup = setup.finally(() => {
        if (state.setupPromise === trackedSetup) state.setupPromise = null;
      });
      state.setupPromise = trackedSetup;
    }
    try {
      const context = await state.setupPromise;
      if (!this.isCurrent(state)) return null;
      return context;
    } catch (error) {
      if (error instanceof OutputDeviceSelectionError || error instanceof PlaybackAudioError) throw error;
      throw new PlaybackAudioError(`Could not initialize speech playback: ${String(error)}`);
    }
  }

  private async createContext(state: SessionState): Promise<AudioContextLike> {
    let context: AudioContextLike;
    try {
      context = this.context ?? this.contextFactory();
    } catch (error) {
      throw new PlaybackAudioError(`Could not initialize speech playback: ${String(error)}`);
    }

    const requestedSink = state.outputDeviceId ?? "";
    if (this.outputDeviceId !== requestedSink) {
      if (typeof context.setSinkId !== "function") {
        if (requestedSink) {
          throw new OutputDeviceSelectionError(
            "This Maxx build cannot select a speech output device. Choose System Default or update the app.",
          );
        }
      } else {
        try {
          await context.setSinkId(requestedSink);
        } catch (error) {
          throw new OutputDeviceSelectionError(
            `Could not use the selected speech output device: ${String(error)}`,
          );
        }
      }
      this.outputDeviceId = requestedSink;
    }

    this.context = context;
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch (error) {
        throw new PlaybackAudioError(
          `Audio playback is blocked until Maxx receives an audio gesture: ${String(error)}`,
        );
      }
    }
    return context;
  }

  private sourceEnded(state: SessionState, scheduled: ScheduledAudio): void {
    if (scheduled.ended) return;
    scheduled.ended = true;
    const index = state.scheduled.indexOf(scheduled);
    if (index >= 0) state.scheduled.splice(index, 1);
    state.bufferedBytes = Math.max(0, state.bufferedBytes - scheduled.bytes);
    if (state.scheduled.length === 0) state.nextStartTime = this.context?.currentTime ?? state.nextStartTime;
    this.wakeCapacityWaiters(state);
    this.resolveFinishIfDrained(state);
  }

  /** Wait for scheduled audio to drain instead of failing a fast provider stream. */
  private async waitForCapacity(
    state: SessionState,
    normalized: NormalizedChunk,
    context: AudioContextLike,
  ): Promise<boolean> {
    while (this.isCurrent(state)) {
      const bufferedSeconds = Math.max(0, state.nextStartTime - context.currentTime);
      if (
        state.bufferedBytes + normalized.bytes <= state.limits.maxBufferedBytes
        && bufferedSeconds + normalized.duration <= state.limits.maxBufferedSeconds
      ) return true;
      const hasCapacity = await new Promise<boolean>((resolve) => {
        state.capacityWaiters.push(resolve);
      });
      if (!hasCapacity) return false;
    }
    return false;
  }

  private wakeCapacityWaiters(state: SessionState): void {
    const waiters = state.capacityWaiters.splice(0);
    for (const resolve of waiters) resolve(true);
  }

  private resolveFinishIfDrained(state: SessionState): void {
    if (!state.finishRequested || state.scheduled.length > 0) return;
    const waiters = state.finishWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private isCurrent(state: SessionState): boolean {
    return !this.disposed && this.current === state && !state.canceled;
  }
}

interface SessionState {
  generation: number;
  limits: PlaybackLimits;
  outputDeviceId: string | null;
  scheduled: ScheduledAudio[];
  bufferedBytes: number;
  nextStartTime: number;
  finishRequested: boolean;
  finishWaiters: PendingFinish[];
  capacityWaiters: Array<(hasCapacity: boolean) => void>;
  canceled: boolean;
  setupPromise: Promise<AudioContextLike> | null;
}

interface NormalizedChunk {
  bytes: number;
  channels: number;
  frames: number;
  duration: number;
  sampleRate: number;
  samples: Float32Array;
}

function validateLimits(limits: PlaybackLimits): PlaybackLimits {
  if (!Number.isFinite(limits.maxBufferedSeconds) || limits.maxBufferedSeconds <= 0) {
    throw new RangeError("maxBufferedSeconds must be positive.");
  }
  if (!Number.isSafeInteger(limits.maxBufferedBytes) || limits.maxBufferedBytes <= 0) {
    throw new RangeError("maxBufferedBytes must be a positive integer.");
  }
  return limits;
}

function normalizeChunk(chunk: Pcm16Chunk): NormalizedChunk {
  if (!Number.isFinite(chunk.sampleRate) || chunk.sampleRate <= 0) {
    throw new RangeError("PCM sampleRate must be positive.");
  }
  const channels = chunk.channels ?? 1;
  if (!Number.isSafeInteger(channels) || channels < 1) {
    throw new RangeError("PCM channels must be a positive integer.");
  }
  const bytes = byteLength(chunk.pcm);
  if (bytes === 0 || bytes % 2 !== 0) throw new RangeError("PCM16 data must contain complete samples.");
  const samples = new Float32Array(bytes / 2);
  const view = new DataView(toArrayBuffer(chunk.pcm));
  for (let index = 0; index < samples.length; index += 1) {
    const value = view.getInt16(index * 2, true);
    samples[index] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  if (samples.length % channels !== 0) {
    throw new RangeError("PCM16 data does not contain a complete interleaved frame.");
  }
  const frames = samples.length / channels;
  return {
    bytes,
    channels,
    frames,
    duration: frames / chunk.sampleRate,
    sampleRate: chunk.sampleRate,
    samples,
  };
}

function byteLength(value: ArrayBuffer | ArrayBufferView): number {
  return value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
}

function toArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
