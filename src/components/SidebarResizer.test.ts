import { describe, expect, it } from "vitest";
import { MIN_BROWSER_WIDTH, maximumBrowserWidth } from "../browser";
import { MIN_WORKSPACE_WIDTH } from "../layout";
import { maximumSidebarWidth } from "./SidebarResizer";

const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 360;

describe("maximumSidebarWidth", () => {
  it("caps at the design maximum on a wide window", () => {
    expect(maximumSidebarWidth(2400)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("yields to the workspace before the workspace yields", () => {
    expect(maximumSidebarWidth(700)).toBe(700 - MIN_WORKSPACE_WIDTH);
  });

  it("never returns less than the sidebar minimum", () => {
    expect(maximumSidebarWidth(400)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it("reserves room for the browser pane when one is open", () => {
    // Wide enough that the design cap still binds.
    expect(maximumSidebarWidth(1400, MIN_BROWSER_WIDTH)).toBe(MAX_SIDEBAR_WIDTH);
    // Narrow enough that the reservation does.
    expect(maximumSidebarWidth(1000, MIN_BROWSER_WIDTH))
      .toBe(1000 - MIN_WORKSPACE_WIDTH - MIN_BROWSER_WIDTH);
  });

  it("treats a negative reservation as none", () => {
    expect(maximumSidebarWidth(1200, -500)).toBe(maximumSidebarWidth(1200));
  });
});

describe("sidebar and browser ranges together", () => {
  /** The narrowest window that can seat both panes and a full-width workspace. */
  const COMFORTABLE = MIN_SIDEBAR_WIDTH + MIN_BROWSER_WIDTH + MIN_WORKSPACE_WIDTH;

  it("leave the workspace its minimum once the window is wide enough", () => {
    // The two ranges are resolved in one direction only — the sidebar reserves
    // the browser's *minimum*, the browser yields to the sidebar's real width —
    // so there is no cycle. The invariant still has to hold at every size above
    // the point where it is satisfiable at all.
    for (let available = COMFORTABLE; available <= 2600; available += 25) {
      const sidebar = maximumSidebarWidth(available, MIN_BROWSER_WIDTH);
      const browser = maximumBrowserWidth(available, sidebar);
      expect(available - sidebar - browser).toBeGreaterThanOrEqual(MIN_WORKSPACE_WIDTH);
    }
  });

  it("leave the browser pane a real drag range at the window sizes people use", () => {
    // Regression: with a 620 workspace floor, a 1280pt window plus an open
    // sidebar drove maximumBrowserWidth down to MIN_BROWSER_WIDTH, so the pane
    // was pinned and its divider did nothing.
    for (const available of [1280, 1440, 1600, 1920]) {
      for (const sidebar of [MIN_SIDEBAR_WIDTH, 250, MAX_SIDEBAR_WIDTH]) {
        expect(maximumBrowserWidth(available, sidebar)).toBeGreaterThan(MIN_BROWSER_WIDTH);
      }
    }
  });

  it("pin both panes to their minimums below that, rather than one starving the other", () => {
    for (let available = 600; available < COMFORTABLE; available += 25) {
      const sidebar = maximumSidebarWidth(available, MIN_BROWSER_WIDTH);
      const browser = maximumBrowserWidth(available, sidebar);
      expect(sidebar).toBe(MIN_SIDEBAR_WIDTH);
      expect(browser).toBe(MIN_BROWSER_WIDTH);
    }
  });
});
