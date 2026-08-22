import { describe, expect, it } from "vitest";
import { horizontalOverflow } from "./horizontalOverflow";

describe("horizontal overflow indicators", () => {
  it("shows only the directions with hidden content", () => {
    expect(horizontalOverflow(0, 300, 500)).toEqual({ left: false, right: true });
    expect(horizontalOverflow(100, 300, 500)).toEqual({ left: true, right: true });
    expect(horizontalOverflow(200, 300, 500)).toEqual({ left: true, right: false });
  });

  it("shows no fades when all content fits", () => {
    expect(horizontalOverflow(0, 500, 300)).toEqual({ left: false, right: false });
  });
});
