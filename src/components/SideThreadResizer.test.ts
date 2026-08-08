import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDE_THREAD_WIDTH,
  MIN_SIDE_THREAD_WIDTH,
  clampSideThreadWidth,
  maximumSideThreadWidth,
} from "./SideThreadResizer";

const MAX_SIDE_THREAD_WIDTH = 720;
const MIN_THREAD_COLUMN_WIDTH = 380;

describe("maximumSideThreadWidth", () => {
  it("caps at the design maximum on a wide stage", () => {
    expect(maximumSideThreadWidth(2400)).toBe(MAX_SIDE_THREAD_WIDTH);
  });

  it("leaves the transcript its minimum column", () => {
    expect(maximumSideThreadWidth(900)).toBe(900 - MIN_THREAD_COLUMN_WIDTH);
  });

  it("never returns less than the panel minimum", () => {
    expect(maximumSideThreadWidth(500)).toBe(MIN_SIDE_THREAD_WIDTH);
    expect(maximumSideThreadWidth(0)).toBe(MIN_SIDE_THREAD_WIDTH);
  });

  it("seats the default width on any stage wide enough for both columns", () => {
    expect(maximumSideThreadWidth(MIN_THREAD_COLUMN_WIDTH + DEFAULT_SIDE_THREAD_WIDTH))
      .toBe(DEFAULT_SIDE_THREAD_WIDTH);
  });
});

describe("clampSideThreadWidth", () => {
  it("rounds and clamps into the range", () => {
    const max = maximumSideThreadWidth(1200);
    expect(clampSideThreadWidth(420.4, max)).toBe(420);
    expect(clampSideThreadWidth(10, max)).toBe(MIN_SIDE_THREAD_WIDTH);
    expect(clampSideThreadWidth(5000, max)).toBe(max);
  });

  it("keeps the minimum when the stage is too narrow to honour the maximum", () => {
    // A stage this small cannot satisfy both columns; the panel wins its floor
    // and the transcript takes the squeeze rather than the panel vanishing.
    expect(clampSideThreadWidth(600, maximumSideThreadWidth(400))).toBe(MIN_SIDE_THREAD_WIDTH);
  });
});
