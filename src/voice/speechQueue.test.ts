import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_SETTINGS } from "./types";
import {
  SpeechQueueBackpressureError,
  SpeechSynthesisQueue,
  type SpeechQueueRunner,
} from "./speechQueue";

class FakeRunner implements SpeechQueueRunner {
  calls: string[] = [];
  cancellations = 0;
  pending: Array<() => void> = [];

  async play(_settings: typeof DEFAULT_VOICE_SETTINGS, text: string): Promise<void> {
    this.calls.push(text);
    await new Promise<void>((resolve) => this.pending.push(resolve));
  }

  async cancel(): Promise<void> {
    this.cancellations += 1;
    for (const resolve of this.pending.splice(0)) resolve();
  }
}

describe("SpeechSynthesisQueue", () => {
  it("serializes phrases in order", async () => {
    const runner = new FakeRunner();
    const queue = new SpeechSynthesisQueue(runner);
    const first = queue.enqueue(DEFAULT_VOICE_SETTINGS, "first");
    const second = queue.enqueue(DEFAULT_VOICE_SETTINGS, "second");
    await Promise.resolve();
    expect(runner.calls).toEqual(["first"]);
    runner.pending.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runner.calls).toEqual(["first", "second"]);
    runner.pending.shift()?.();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it("cancels active and queued phrases without allowing stale playback", async () => {
    const runner = new FakeRunner();
    const queue = new SpeechSynthesisQueue(runner);
    const active = queue.enqueue(DEFAULT_VOICE_SETTINGS, "active");
    const queued = queue.enqueue(DEFAULT_VOICE_SETTINGS, "queued");
    await Promise.resolve();
    await queue.cancel();

    await expect(active).resolves.toBe(false);
    await expect(queued).resolves.toBe(false);
    expect(runner.cancellations).toBe(1);
    expect(runner.calls).toEqual(["active"]);
  });

  it("drains active and queued phrases before resolving", async () => {
    const runner = new FakeRunner();
    const queue = new SpeechSynthesisQueue(runner);
    const first = queue.enqueue(DEFAULT_VOICE_SETTINGS, "first");
    const second = queue.enqueue(DEFAULT_VOICE_SETTINGS, "second");
    const drained = queue.drain();
    let settled = false;
    void drained.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    runner.pending.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    runner.pending.shift()?.();
    await expect(Promise.all([first, second, drained])).resolves.toEqual([true, true, undefined]);
    expect(settled).toBe(true);
  });

  it("bounds queued phrase count and buffered text", async () => {
    const runner = new FakeRunner();
    const byCount = new SpeechSynthesisQueue(runner, { maxPhrases: 2, maxCharacters: 100 });
    const first = byCount.enqueue(DEFAULT_VOICE_SETTINGS, "first");
    const second = byCount.enqueue(DEFAULT_VOICE_SETTINGS, "second");
    await expect(byCount.enqueue(DEFAULT_VOICE_SETTINGS, "third")).rejects.toBeInstanceOf(
      SpeechQueueBackpressureError,
    );
    await byCount.cancel();
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);

    const byCharacters = new SpeechSynthesisQueue(new FakeRunner(), {
      maxPhrases: 4,
      maxCharacters: 5,
    });
    await expect(byCharacters.enqueue(DEFAULT_VOICE_SETTINGS, "123456")).rejects.toBeInstanceOf(
      SpeechQueueBackpressureError,
    );
  });
});
