import { describe, expect, it } from "vitest";
import { isNearScrollBottom } from "./scrollFollow";

describe("mobile transcript scroll following", () => {
  it("keeps following while the viewport is near the bottom", () => {
    expect(isNearScrollBottom({ contentHeight: 1_000, viewportHeight: 600, offsetY: 350 })).toBe(true);
  });

  it("stops following after the user scrolls away", () => {
    expect(isNearScrollBottom({ contentHeight: 1_000, viewportHeight: 600, offsetY: 200 })).toBe(false);
  });

  it("treats short content and bottom overscroll as pinned", () => {
    expect(isNearScrollBottom({ contentHeight: 400, viewportHeight: 600, offsetY: 0 })).toBe(true);
    expect(isNearScrollBottom({ contentHeight: 1_000, viewportHeight: 600, offsetY: 430 })).toBe(true);
  });

  it("does not count reserved turn-anchor space as content below the fold", () => {
    expect(isNearScrollBottom({
      contentHeight: 1_100,
      viewportHeight: 600,
      offsetY: 100,
      reservedBottomHeight: 500,
    })).toBe(true);
    expect(isNearScrollBottom({
      contentHeight: 1_100,
      viewportHeight: 600,
      offsetY: 100,
      reservedBottomHeight: 100,
    })).toBe(false);
  });
});
