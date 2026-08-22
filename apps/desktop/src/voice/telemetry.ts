export type VoiceMilestone =
  | "captureStarted"
  | "firstPartial"
  | "finalTranscript"
  | "firstModelToken"
  /** First PCM chunk accepted and scheduled by the local playback graph. */
  | "firstAudioChunkAccepted"
  | "firstPlaybackScheduled";

export interface VoiceLatencySnapshot {
  sessionID: string;
  hostClass: "local" | "remote";
  provider: string;
  reconnects: number;
  droppedInputChunks: number;
  rejectedOutputChunks: number;
  milliseconds: Partial<Record<VoiceMilestone, number>>;
}

/** Content-free latency and backpressure measurements for one voice session. */
export class VoiceLatencyTelemetry {
  private readonly startedAt: number;
  private readonly milestones = new Map<VoiceMilestone, number>();
  private reconnects = 0;
  private droppedInputChunks = 0;
  private rejectedOutputChunks = 0;

  constructor(
    private readonly sessionID: string,
    private readonly hostClass: "local" | "remote",
    private readonly provider: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = now();
  }

  mark(milestone: VoiceMilestone): void {
    if (!this.milestones.has(milestone)) this.milestones.set(milestone, this.now());
  }

  reconnected(): void {
    this.reconnects += 1;
  }

  droppedInput(): void {
    this.droppedInputChunks += 1;
  }

  rejectedOutput(): void {
    this.rejectedOutputChunks += 1;
  }

  snapshot(): VoiceLatencySnapshot {
    const milliseconds: Partial<Record<VoiceMilestone, number>> = {};
    for (const [key, value] of this.milestones) milliseconds[key] = Math.max(0, value - this.startedAt);
    return {
      sessionID: this.sessionID,
      hostClass: this.hostClass,
      provider: this.provider,
      reconnects: this.reconnects,
      droppedInputChunks: this.droppedInputChunks,
      rejectedOutputChunks: this.rejectedOutputChunks,
      milliseconds,
    };
  }
}
