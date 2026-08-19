import { describe, expect, it } from "vitest";
import { pcm16RootMeanSquare } from "./capture";

describe("pcm16RootMeanSquare", () => {
  it("measures silence and normalized PCM16 energy", () => {
    expect(pcm16RootMeanSquare(new Int16Array([0, 0]).buffer)).toBe(0);
    expect(pcm16RootMeanSquare(new Int16Array([0x7fff, -0x8000]).buffer)).toBeCloseTo(1);
  });
});
