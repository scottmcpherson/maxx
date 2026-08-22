import { describe, expect, it } from "vitest";
import { EnergyVad, shouldFinishUtterance } from "./vad";

describe("EnergyVad", () => {
  it("requires sustained energy to start and sustained quiet to stop", () => {
    const vad = new EnergyVad({ threshold: 0.1, startChunks: 2, stopChunks: 3 });
    expect(vad.update(0.2)).toBeNull();
    expect(vad.update(0.2)).toBe("speech.started");
    expect(vad.update(0.01)).toBeNull();
    expect(vad.update(0.01)).toBeNull();
    expect(vad.update(0.01)).toBe("speech.stopped");
  });

  it("ignores spikes and invalid measurements", () => {
    const vad = new EnergyVad({ threshold: 0.1, startChunks: 2 });
    expect(vad.update(0.2)).toBeNull();
    expect(vad.update(0)).toBeNull();
    expect(vad.update(Number.NaN)).toBeNull();
    expect(vad.update(-1)).toBeNull();
  });

  it("finishes only automatic turns on a quiet-period stop", () => {
    expect(shouldFinishUtterance("automatic", "speech.stopped")).toBe(true);
    expect(shouldFinishUtterance("manual", "speech.stopped")).toBe(false);
    expect(shouldFinishUtterance("automatic", "speech.started")).toBe(false);
  });
});
