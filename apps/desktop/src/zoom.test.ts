import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM_PERCENT,
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  UI_ZOOM_ACTIVE_CLASS,
  UI_ZOOM_CSS_VAR,
  applyZoomPercent,
  clampZoomPercent,
  formatZoomPercent,
  loadZoomPercent,
  persistZoomPercent,
  zoomIn,
  zoomOut,
} from "./zoom";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("zoom", () => {
  it("clamps and snaps to 10% steps", () => {
    expect(clampZoomPercent(100)).toBe(100);
    expect(clampZoomPercent(133)).toBe(130);
    expect(clampZoomPercent(10)).toBe(MIN_ZOOM_PERCENT);
    expect(clampZoomPercent(999)).toBe(MAX_ZOOM_PERCENT);
    expect(clampZoomPercent(Number.NaN)).toBe(DEFAULT_ZOOM_PERCENT);
  });

  it("zooms in and out by one step", () => {
    expect(zoomIn(100)).toBe(110);
    expect(zoomOut(100)).toBe(90);
    expect(zoomIn(MAX_ZOOM_PERCENT)).toBe(MAX_ZOOM_PERCENT);
    expect(zoomOut(MIN_ZOOM_PERCENT)).toBe(MIN_ZOOM_PERCENT);
  });

  it("formats percent for the HUD", () => {
    expect(formatZoomPercent(130)).toBe("130%");
    expect(formatZoomPercent(100)).toBe("100%");
  });

  it("persists and restores zoom percent", () => {
    const storage = memoryStorage();
    expect(loadZoomPercent(storage)).toBe(DEFAULT_ZOOM_PERCENT);
    persistZoomPercent(130, storage);
    expect(loadZoomPercent(storage)).toBe(130);
  });

  it("falls back to default for corrupt storage", () => {
    const storage = memoryStorage();
    storage.setItem("maxx.ui-zoom.v1", "not-json");
    expect(loadZoomPercent(storage)).toBe(DEFAULT_ZOOM_PERCENT);
    storage.setItem("maxx.ui-zoom.v1", JSON.stringify({ percent: "big" }));
    expect(loadZoomPercent(storage)).toBe(DEFAULT_ZOOM_PERCENT);
  });

  it("writes a CSS zoom factor and clears legacy document zoom", () => {
    // jsdom is not always present; skip DOM assertions in pure-node runs.
    if (typeof document === "undefined") return;
    document.documentElement.style.zoom = "1.5";
    applyZoomPercent(130);
    expect(document.documentElement.style.getPropertyValue(UI_ZOOM_CSS_VAR)).toBe("1.3");
    expect(document.documentElement.classList.contains(UI_ZOOM_ACTIVE_CLASS)).toBe(true);
    expect(document.documentElement.style.zoom).toBe("");
    applyZoomPercent(100);
    expect(document.documentElement.style.getPropertyValue(UI_ZOOM_CSS_VAR)).toBe("1");
    expect(document.documentElement.classList.contains(UI_ZOOM_ACTIVE_CLASS)).toBe(false);
  });
});

afterEach(() => {
  if (typeof document === "undefined") return;
  document.documentElement.style.removeProperty(UI_ZOOM_CSS_VAR);
  document.documentElement.style.removeProperty("zoom");
  document.documentElement.classList.remove(UI_ZOOM_ACTIVE_CLASS);
});
