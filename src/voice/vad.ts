import type { TurnDetection } from "./types";

export type VadEvent = "speech.started" | "speech.stopped";

/** Automatic mode owns quiet-period finalization; manual mode never does. */
export function shouldFinishUtterance(turnDetection: TurnDetection, event: VadEvent): boolean {
  return turnDetection === "automatic" && event === "speech.stopped";
}

export interface EnergyVadOptions {
  threshold?: number;
  startChunks?: number;
  stopChunks?: number;
}

/**
 * Small local energy gate used for prompt barge-in. Provider VAD remains
 * authoritative for transcript finalization; this only reacts quickly enough
 * to stop playback before a complete transcript arrives.
 */
export class EnergyVad {
  private readonly threshold: number;
  private readonly startChunks: number;
  private readonly stopChunks: number;
  private loudChunks = 0;
  private quietChunks = 0;
  private speaking = false;

  constructor(options: EnergyVadOptions = {}) {
    this.threshold = options.threshold ?? 0.035;
    this.startChunks = options.startChunks ?? 2;
    this.stopChunks = options.stopChunks ?? 8;
    if (this.threshold <= 0 || this.threshold > 1) throw new Error("VAD threshold must be between 0 and 1.");
    if (this.startChunks < 1 || this.stopChunks < 1) throw new Error("VAD chunk windows must be positive.");
  }

  update(level: number): VadEvent | null {
    if (!Number.isFinite(level) || level < 0) return null;
    if (level >= this.threshold) {
      this.loudChunks += 1;
      this.quietChunks = 0;
      if (!this.speaking && this.loudChunks >= this.startChunks) {
        this.speaking = true;
        return "speech.started";
      }
      return null;
    }
    this.loudChunks = 0;
    if (!this.speaking) return null;
    this.quietChunks += 1;
    if (this.quietChunks >= this.stopChunks) {
      this.speaking = false;
      this.quietChunks = 0;
      return "speech.stopped";
    }
    return null;
  }

  reset(): void {
    this.loudChunks = 0;
    this.quietChunks = 0;
    this.speaking = false;
  }
}
