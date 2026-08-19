import type {
  VoiceSettings,
  VoiceTtsReadResult,
  VoiceTtsStartResult,
  VoiceTtsChunk,
} from "./types";
import { PcmPlayback, type Pcm16Chunk, type PlaybackSession } from "./playback";

const DEFAULT_MAX_READ_BYTES = 128 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_EMPTY_READS = 8;

export interface VoiceTtsTransport {
  voiceTtsStart: (
    settings: VoiceSettings,
    text: string,
    voiceId?: string | null,
    hostId?: string | null,
  ) => Promise<VoiceTtsStartResult>;
  voiceTtsRead: (
    session: number,
    afterSequence: number,
    maxBytes: number,
    hostId?: string | null,
  ) => Promise<VoiceTtsReadResult>;
  voiceTtsCancel: (session: number, hostId?: string | null) => Promise<void>;
}

export interface VoiceTtsLimits {
  maxReadBytes?: number;
  maxTotalBytes?: number;
}

export interface VoiceTtsPlayerOptions {
  playback?: PcmPlayback;
  limits?: VoiceTtsLimits;
  /** Called after the first PCM chunk is accepted by local playback. */
  onFirstChunk?: () => void;
}

export class VoiceTtsError extends Error {
  readonly code: string = "voice.tts";

  constructor(message: string) {
    super(message);
    this.name = "VoiceTtsError";
  }
}

export class VoiceTtsSequenceError extends VoiceTtsError {
  readonly code = "voice.tts-sequence" as const;
}

export class VoiceTtsBoundsError extends VoiceTtsError {
  readonly code = "voice.tts-bounds" as const;
}

export class VoiceTtsStaleGenerationError extends VoiceTtsError {
  readonly code = "voice.tts-stale-generation" as const;
}

export class VoiceTtsCanceledError extends VoiceTtsError {
  readonly code = "voice.tts-canceled" as const;
}

/** A cancellable, bounded provider stream of local PCM16 chunks. */
export class VoiceTtsStream implements AsyncIterable<Pcm16Chunk>, AsyncIterator<Pcm16Chunk> {
  readonly session: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly mimeType: string;

  private readonly maxReadBytes: number;
  private readonly maxTotalBytes: number;
  private readonly transport: VoiceTtsTransport;
  private readonly hostId: string | null | undefined;
  private readonly isCurrent: () => boolean;
  private readonly pending: Pcm16Chunk[] = [];
  private lastSequence = -1;
  private totalBytes = 0;
  private emptyReads = 0;
  private done = false;
  private canceled = false;
  private cancelSent = false;

  constructor(
    transport: VoiceTtsTransport,
    start: VoiceTtsStartResult,
    hostId: string | null | undefined,
    isCurrent: () => boolean,
    limits: VoiceTtsLimits = {},
  ) {
    if (!start || typeof start !== "object") {
      throw new VoiceTtsError("The speech host returned an invalid TTS session.");
    }
    if (!Number.isSafeInteger(start.session) || start.session < 0) {
      throw new VoiceTtsError("The speech host returned an invalid TTS session.");
    }
    if (!Number.isFinite(start.sampleRate) || start.sampleRate <= 0) {
      throw new VoiceTtsError("The speech host returned an invalid TTS sample rate.");
    }
    if (!Number.isSafeInteger(start.channels) || start.channels < 1 || start.channels > 2) {
      throw new VoiceTtsError("The speech host returned an invalid TTS channel count.");
    }
    if (!isPcmMimeType(start.mimeType)) {
      throw new VoiceTtsError(`Unsupported TTS audio format: ${start.mimeType}`);
    }

    this.transport = transport;
    this.session = start.session;
    this.sampleRate = start.sampleRate;
    this.channels = start.channels;
    this.mimeType = start.mimeType;
    this.hostId = hostId;
    this.isCurrent = isCurrent;
    this.maxReadBytes = boundedPositiveInteger(limits.maxReadBytes ?? DEFAULT_MAX_READ_BYTES, "read size");
    this.maxTotalBytes = boundedPositiveInteger(limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, "total size");
  }

  [Symbol.asyncIterator](): AsyncIterator<Pcm16Chunk> {
    return this;
  }

  async next(): Promise<IteratorResult<Pcm16Chunk>> {
    this.assertCurrent();
    if (this.canceled) return { done: true, value: undefined };
    if (this.pending.length > 0) return { done: false, value: this.pending.shift()! };
    if (this.done) return { done: true, value: undefined };

    while (!this.done && this.pending.length === 0) {
      this.assertCurrent();
      const response = await this.transport.voiceTtsRead(
        this.session,
        this.lastSequence,
        this.maxReadBytes,
        this.hostId,
      );
      // Check generation before cancellation: a response from a superseded
      // stream must never become audio for the new generation.
      this.assertCurrent();
      if (this.canceled) return { done: true, value: undefined };
      validateReadResponse(response);
      if (response.error) throw new VoiceTtsError(response.error);

      if (response.chunks.length === 0) {
        if (response.done) {
          this.done = true;
          break;
        }
        this.emptyReads += 1;
        if (this.emptyReads > MAX_EMPTY_READS) {
          throw new VoiceTtsError("The speech host returned too many empty TTS reads.");
        }
        continue;
      }
      this.emptyReads = 0;
      const decoded: Array<{ item: VoiceTtsChunk; pcm: ArrayBuffer }> = [];
      let readBytes = 0;
      let expectedSequence = this.lastSequence + 1;
      for (const item of response.chunks) {
        if (item.sequence !== expectedSequence) {
          throw new VoiceTtsSequenceError(
            `TTS audio sequence ${String(item.sequence)} is out of order; expected ${expectedSequence}.`,
          );
        }
        const remainingReadBytes = this.maxReadBytes - readBytes;
        const remainingTotalBytes = this.maxTotalBytes - this.totalBytes - readBytes;
        const remainingBytes = Math.min(remainingReadBytes, remainingTotalBytes);
        if (remainingBytes < 2) {
          throw new VoiceTtsBoundsError("TTS audio exceeded the renderer playback bound.");
        }
        const pcm = decodeBase64Pcm16(item.chunk, remainingBytes);
        readBytes += pcm.byteLength;
        decoded.push({ item, pcm });
        expectedSequence += 1;
      }
      for (const entry of decoded) {
        this.acceptChunk(entry.item, entry.pcm);
      }
      if (response.done) this.done = true;
    }

    if (this.pending.length > 0) return { done: false, value: this.pending.shift()! };
    return { done: true, value: undefined };
  }

  async return(): Promise<IteratorResult<Pcm16Chunk>> {
    await this.cancel();
    return { done: true, value: undefined };
  }

  async cancel(): Promise<void> {
    if (this.canceled) return;
    this.canceled = true;
    this.done = true;
    this.pending.length = 0;
    if (this.cancelSent) return;
    this.cancelSent = true;
    // Cancellation must return immediately; the read promise may be waiting
    // on a remote host and cannot be force-aborted through the current IPC
    // contract. `next()` rechecks the generation when that read resolves.
    void this.transport.voiceTtsCancel(this.session, this.hostId).catch(() => {});
  }

  private assertCurrent(): void {
    if (!this.isCurrent()) {
      throw new VoiceTtsStaleGenerationError("Discarded audio from an older TTS generation.");
    }
  }

  private acceptChunk(item: VoiceTtsChunk, decoded?: ArrayBuffer): number {
    if (!Number.isSafeInteger(item.sequence) || item.sequence !== this.lastSequence + 1) {
      throw new VoiceTtsSequenceError(
        `TTS audio sequence ${String(item.sequence)} is out of order; expected ${this.lastSequence + 1}.`,
      );
    }
    const pcm = decoded ?? decodeBase64Pcm16(item.chunk);
    if (pcm.byteLength === 0) throw new VoiceTtsError("The speech host returned an empty TTS chunk.");
    if (this.totalBytes + pcm.byteLength > this.maxTotalBytes) {
      throw new VoiceTtsBoundsError("TTS audio exceeded the renderer playback bound.");
    }
    this.totalBytes += pcm.byteLength;
    this.lastSequence = item.sequence;
    this.pending.push({ pcm, sampleRate: this.sampleRate, channels: this.channels });
    return pcm.byteLength;
  }
}

/** Owns one active generation and rejects late start/read responses. */
export class VoiceTtsAdapter {
  private generation = 0;
  private current: VoiceTtsStream | null = null;

  constructor(
    private readonly transport: VoiceTtsTransport,
    private readonly limits: VoiceTtsLimits = {},
  ) {}

  async stream(
    settings: VoiceSettings,
    text: string,
    voiceId?: string | null,
    hostId?: string | null,
  ): Promise<VoiceTtsStream> {
    const previous = this.current;
    if (previous) void previous.cancel();
    const generation = ++this.generation;
    const start = await this.transport.voiceTtsStart(
      settings,
      text,
      voiceId ?? (settings.voiceID || null),
      hostId ?? settings.speechHostID,
    );
    if (generation !== this.generation) {
      const session = start && typeof start === "object" && Number.isSafeInteger(start.session)
        ? start.session
        : null;
      if (session !== null) {
        void this.transport.voiceTtsCancel(session, hostId ?? settings.speechHostID).catch(() => {});
      }
      throw new VoiceTtsStaleGenerationError("Discarded a late TTS session start.");
    }
    const stream = new VoiceTtsStream(
      this.transport,
      start,
      hostId ?? settings.speechHostID,
      () => generation === this.generation,
      this.limits,
    );
    this.current = stream;
    return stream;
  }

  async cancel(): Promise<void> {
    this.generation += 1;
    const current = this.current;
    this.current = null;
    if (current) await current.cancel();
  }
}

/** Consume the stream into renderer-owned PCM playback. */
export class VoiceTtsPlayer {
  private readonly adapter: VoiceTtsAdapter;
  private readonly playback: PcmPlayback;
  private readonly onFirstChunk?: () => void;
  private runGeneration = 0;
  private readonly cancellationResolvers = new Set<() => void>();

  constructor(
    transport: VoiceTtsTransport,
    options: VoiceTtsPlayerOptions = {},
  ) {
    this.adapter = new VoiceTtsAdapter(transport, options.limits);
    this.playback = options.playback ?? new PcmPlayback();
    this.onFirstChunk = options.onFirstChunk;
  }

  async play(
    settings: VoiceSettings,
    text: string,
    voiceId?: string | null,
    hostId?: string | null,
  ): Promise<void> {
    // Reserve this generation before awaiting cancellation of the previous
    // run. A concurrent cancel/play call must be able to invalidate this run
    // even while the old remote start/read is still pending.
    const run = ++this.runGeneration;
    await Promise.all([
      this.adapter.cancel().catch(() => {}),
      this.playback.cancel(),
    ]);
    if (run !== this.runGeneration) return;

    let canceled = false;
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = () => {
        canceled = true;
        resolve();
      };
      this.cancellationResolvers.add(resolveCancellation);
    });
    let session: PlaybackSession | null = null;
    let firstChunk = false;
    try {
      const stream = await Promise.race([
        this.adapter.stream(settings, text, voiceId, hostId),
        cancellation.then(() => null as VoiceTtsStream | null),
      ]);
      if (!stream || canceled || run !== this.runGeneration) return;
      session = this.playback.begin({ outputDeviceId: settings.outputDeviceID });
      while (true) {
        const result = await Promise.race([
          stream.next(),
          cancellation.then(() => null as IteratorResult<Pcm16Chunk> | null),
        ]);
        if (!result || canceled || run !== this.runGeneration) return;
        if (result.done) break;
        const accepted = await Promise.race([
          session.enqueue(result.value),
          cancellation.then(() => false),
        ]);
        if (canceled || run !== this.runGeneration) return;
        if (!accepted) throw new VoiceTtsStaleGenerationError("Discarded stale playback audio.");
        if (!firstChunk) {
          firstChunk = true;
          this.onFirstChunk?.();
        }
      }
      if (run === this.runGeneration) {
        await Promise.race([session.finish(), cancellation]);
      }
    } catch (error) {
      if (session) await session.cancel();
      if (canceled || run !== this.runGeneration || isCancellation(error)) return;
      throw error;
    } finally {
      this.cancellationResolvers.delete(resolveCancellation);
    }
  }

  async cancel(): Promise<void> {
    this.runGeneration += 1;
    for (const resolve of this.cancellationResolvers) resolve();
    this.cancellationResolvers.clear();
    // Do not hold local source cancellation behind a potentially slow IPC
    // cancellation of an in-flight TTS read. The adapter sends the remote
    // cancellation best-effort; the stream generation check discards the
    // eventual read response.
    void this.adapter.cancel().catch(() => {});
    await this.playback.cancel();
  }

  async dispose(): Promise<void> {
    await this.cancel();
    await this.playback.dispose();
  }
}

function validateReadResponse(response: VoiceTtsReadResult): void {
  if (!response || !Array.isArray(response.chunks) || typeof response.done !== "boolean") {
    throw new VoiceTtsError("The speech host returned an invalid TTS read.");
  }
  if (response.error !== undefined && typeof response.error !== "string") {
    throw new VoiceTtsError("The speech host returned an invalid TTS error.");
  }
  for (const item of response.chunks) {
    if (
      !item
      || typeof item !== "object"
      || !Number.isSafeInteger(item.sequence)
      || typeof item.chunk !== "string"
    ) {
      throw new VoiceTtsError("The speech host returned an invalid TTS chunk.");
    }
  }
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 2) throw new VoiceTtsBoundsError(`Invalid TTS ${label}.`);
  return value;
}

function isPcmMimeType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const mime = value.trim().toLowerCase();
  return mime.includes("pcm") || mime.includes("l16");
}

function isCancellation(error: unknown): boolean {
  return error instanceof VoiceTtsCanceledError || error instanceof VoiceTtsStaleGenerationError;
}

function decodeBase64Pcm16(value: string, maxBytes?: number): ArrayBuffer {
  const bytes = decodeBase64(value, maxBytes);
  if (bytes.byteLength % 2 !== 0) throw new VoiceTtsError("The speech host returned an odd PCM16 byte count.");
  return bytes.slice().buffer;
}

function decodeBase64(value: string, maxBytes?: number): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new VoiceTtsError("The speech host returned invalid base64 audio.");
  }
  if (maxBytes !== undefined && normalized.length > 4 * Math.ceil(maxBytes / 3)) {
    throw new VoiceTtsBoundsError("TTS audio exceeded the renderer read bound.");
  }
  if (typeof atob === "function") {
    let binary: string;
    try {
      binary = atob(normalized);
    } catch {
      throw new VoiceTtsError("The speech host returned invalid base64 audio.");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
      throw new VoiceTtsBoundsError("TTS audio exceeded the renderer read bound.");
    }
    return bytes;
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output: number[] = [];
  for (let index = 0; index < normalized.length; index += 4) {
    const a = alphabet.indexOf(normalized[index]);
    const b = alphabet.indexOf(normalized[index + 1]);
    const c = normalized[index + 2] === "=" ? 0 : alphabet.indexOf(normalized[index + 2]);
    const d = normalized[index + 3] === "=" ? 0 : alphabet.indexOf(normalized[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new VoiceTtsError("The speech host returned invalid base64 audio.");
    output.push((a << 2) | (b >> 4));
    if (normalized[index + 2] !== "=") output.push(((b & 15) << 4) | (c >> 2));
    if (normalized[index + 3] !== "=") output.push(((c & 3) << 6) | d);
  }
  const bytes = Uint8Array.from(output);
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    throw new VoiceTtsBoundsError("TTS audio exceeded the renderer read bound.");
  }
  return bytes;
}
