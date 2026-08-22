import { describe, expect, it } from "vitest";
import { MIN_WORKSPACE_WIDTH } from "./layout";
import {
  PINNED_SUMMARY_WIDTH,
  SUMMARY_WORKSPACE_FLOOR,
  canFitPinnedSummary,
  loadSummaryPinned,
  persistSummaryPinned,
  showsPinnedSummary,
  summaryToggleAction,
  summaryToggleActive,
} from "./summary";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("canFitPinnedSummary", () => {
  it("seats the rail when the transcript keeps its floor", () => {
    const exact = SUMMARY_WORKSPACE_FLOOR + PINNED_SUMMARY_WIDTH;
    expect(canFitPinnedSummary({ layoutWidth: exact, sidebarWidth: 0, browserWidth: 0 })).toBe(true);
    expect(canFitPinnedSummary({ layoutWidth: exact - 1, sidebarWidth: 0, browserWidth: 0 })).toBe(false);
  });

  it("stands down before a divider drag would have to", () => {
    // The rail yields while the transcript is still merely narrow, not once it
    // has hit the hard floor the resizers enforce.
    expect(SUMMARY_WORKSPACE_FLOOR).toBeGreaterThan(MIN_WORKSPACE_WIDTH);
  });

  it("hides at the narrowest window the app allows", () => {
    // tauri.conf.json minWidth 900, sidebar clamped to its own 190 minimum.
    expect(canFitPinnedSummary({ layoutWidth: 900, sidebarWidth: 190, browserWidth: 0 })).toBe(false);
  });

  it("keeps the rail at the default window size", () => {
    expect(canFitPinnedSummary({ layoutWidth: 1280, sidebarWidth: 250, browserWidth: 0 })).toBe(true);
  });

  it("counts the sidebar and the browser pane against the leftover", () => {
    const metrics = { layoutWidth: 1400, sidebarWidth: 250, browserWidth: 0 };
    expect(canFitPinnedSummary(metrics)).toBe(true);
    // Opening the browser is what typically pushes the rail out.
    expect(canFitPinnedSummary({ ...metrics, browserWidth: 584 })).toBe(false);
  });

  it("treats a collapsed pane's negative width as zero", () => {
    const wide = { layoutWidth: 1400, sidebarWidth: -250, browserWidth: -10 };
    expect(canFitPinnedSummary(wide)).toBe(true);
  });
});

describe("summaryToggleAction", () => {
  it("is a plain pin toggle while the rail has room", () => {
    expect(summaryToggleAction({ pinned: true, fits: true, popoverOpen: false })).toBe("unpin");
    expect(summaryToggleAction({ pinned: false, fits: true, popoverOpen: false })).toBe("pin");
  });

  it("reaches the summary as a popover when the rail cannot be seated", () => {
    expect(summaryToggleAction({ pinned: true, fits: false, popoverOpen: false })).toBe("openPopover");
    expect(summaryToggleAction({ pinned: false, fits: false, popoverOpen: false })).toBe("openPopover");
    expect(summaryToggleAction({ pinned: true, fits: false, popoverOpen: true })).toBe("closePopover");
  });
});

describe("showsPinnedSummary", () => {
  it("needs both the pin and the room", () => {
    expect(showsPinnedSummary({ pinned: true, fits: true })).toBe(true);
    expect(showsPinnedSummary({ pinned: true, fits: false })).toBe(false);
    expect(showsPinnedSummary({ pinned: false, fits: true })).toBe(false);
  });
});

describe("summaryToggleActive", () => {
  it("is active for the inline rail and for the popover standing in for it", () => {
    expect(summaryToggleActive({ pinned: true, fits: true, popoverOpen: false })).toBe(true);
    expect(summaryToggleActive({ pinned: true, fits: false, popoverOpen: true })).toBe(true);
    expect(summaryToggleActive({ pinned: true, fits: false, popoverOpen: false })).toBe(false);
    expect(summaryToggleActive({ pinned: false, fits: true, popoverOpen: false })).toBe(false);
  });
});

describe("summary pin persistence", () => {
  it("defaults to pinned and round-trips the user's choice", () => {
    const storage = memoryStorage();
    expect(loadSummaryPinned(storage)).toBe(true);
    persistSummaryPinned(false, storage);
    expect(loadSummaryPinned(storage)).toBe(false);
    persistSummaryPinned(true, storage);
    expect(loadSummaryPinned(storage)).toBe(true);
  });

  it("stays pinned when storage is unavailable", () => {
    expect(loadSummaryPinned(undefined)).toBe(true);
    expect(() => persistSummaryPinned(false, undefined)).not.toThrow();
  });
});
