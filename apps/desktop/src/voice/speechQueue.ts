import type { VoiceSettings } from "./types";

export interface SpeechQueueRunner {
  play: (
    settings: VoiceSettings,
    text: string,
    voiceId?: string | null,
    hostId?: string | null,
  ) => Promise<void>;
  cancel: () => Promise<void>;
}

interface QueuedPhrase {
  generation: number;
  settings: VoiceSettings;
  text: string;
  voiceId: string | null | undefined;
  hostId: string | null | undefined;
  resolve: (completed: boolean) => void;
  reject: (reason: unknown) => void;
}

export interface SpeechQueueLimits {
  maxPhrases: number;
  maxCharacters: number;
}

const DEFAULT_LIMITS: SpeechQueueLimits = {
  maxPhrases: 32,
  maxCharacters: 16_384,
};

export class SpeechQueueBackpressureError extends Error {
  readonly code = "voice.speech-queue-full" as const;

  constructor() {
    super("Speech output is arriving faster than it can be synthesized.");
    this.name = "SpeechQueueBackpressureError";
  }
}

/** Serializes phrase synthesis and makes cancellation generation-safe. */
export class SpeechSynthesisQueue {
  private readonly pending: QueuedPhrase[] = [];
  private readonly drainWaiters: Array<() => void> = [];
  private generation = 0;
  private draining = false;
  private disposed = false;
  private active: QueuedPhrase | null = null;
  private bufferedCharacters = 0;
  private readonly limits: SpeechQueueLimits;

  constructor(
    private readonly runner: SpeechQueueRunner,
    limits: Partial<SpeechQueueLimits> = {},
  ) {
    this.limits = {
      maxPhrases: positiveInteger(limits.maxPhrases ?? DEFAULT_LIMITS.maxPhrases, "phrase"),
      maxCharacters: positiveInteger(limits.maxCharacters ?? DEFAULT_LIMITS.maxCharacters, "character"),
    };
  }

  enqueue(
    settings: VoiceSettings,
    text: string,
    voiceId?: string | null,
    hostId?: string | null,
  ): Promise<boolean> {
    const normalized = text.trim();
    if (this.disposed || !normalized) return Promise.resolve(false);
    const phraseCount = this.pending.length + (this.active ? 1 : 0);
    if (
      phraseCount >= this.limits.maxPhrases
      || this.bufferedCharacters + normalized.length > this.limits.maxCharacters
    ) {
      return Promise.reject(new SpeechQueueBackpressureError());
    }
    const generation = this.generation;
    const promise = new Promise<boolean>((resolve, reject) => {
      this.pending.push({
        generation,
        settings,
        text: normalized,
        voiceId,
        hostId,
        resolve,
        reject,
      });
    });
    this.bufferedCharacters += normalized.length;
    void this.pump();
    return promise;
  }

  async cancel(): Promise<void> {
    this.generation += 1;
    for (const phrase of this.pending.splice(0)) {
      this.bufferedCharacters -= phrase.text.length;
      phrase.resolve(false);
    }
    await this.runner.cancel();
    this.resolveDrainWaiters();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cancel();
  }

  /**
   * Wait until the active runner and every queued phrase have settled. This
   * is intentionally separate from individual enqueue promises: a terminal
   * model event can flush one phrase while a late delta appends another before
   * the renderer is ready to return to Listening.
   */
  async drain(): Promise<void> {
    if (!this.draining && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  get hasWork(): boolean {
    return this.draining || this.pending.length > 0;
  }

  private async pump(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const phrase = this.pending.shift()!;
        this.active = phrase;
        if (this.disposed || phrase.generation !== this.generation) {
          phrase.resolve(false);
          this.bufferedCharacters -= phrase.text.length;
          this.active = null;
          continue;
        }
        try {
          await this.runner.play(phrase.settings, phrase.text, phrase.voiceId, phrase.hostId);
          phrase.resolve(phrase.generation === this.generation && !this.disposed);
        } catch (error) {
          if (phrase.generation !== this.generation || this.disposed) phrase.resolve(false);
          else phrase.reject(error);
        } finally {
          this.bufferedCharacters -= phrase.text.length;
          this.active = null;
        }
      }
    } finally {
      this.draining = false;
      this.resolveDrainWaiters();
      if (this.pending.length > 0) void this.pump();
    }
  }

  private resolveDrainWaiters(): void {
    if (this.draining || this.pending.length > 0) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Speech queue ${label} limit must be a positive integer.`);
  }
  return value;
}
