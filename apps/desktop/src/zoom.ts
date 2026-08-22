// App-wide UI zoom (Cmd+/Cmd-/Cmd+0), persisted and applied via a
// scale + inverse-size surface so the shell still fits the window
// (plain CSS zoom pushes side panels off-screen).

export const DEFAULT_ZOOM_PERCENT = 100;
export const MIN_ZOOM_PERCENT = 50;
export const MAX_ZOOM_PERCENT = 200;
/** Step size matching browser-style zoom increments. */
export const ZOOM_STEP_PERCENT = 10;

/** CSS custom property consumed by `.zoom-surface`. */
export const UI_ZOOM_CSS_VAR = "--ui-zoom";
/** Enables the transformed zoom surface only when zoom differs from 100%. */
export const UI_ZOOM_ACTIVE_CLASS = "ui-zoom-active";

const ZOOM_STORAGE_KEY = "maxx.ui-zoom.v1";

interface ZoomStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function browserStorage(): ZoomStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Snap to a valid step within the supported range. */
export function clampZoomPercent(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_ZOOM_PERCENT;
  const stepped = Math.round(percent / ZOOM_STEP_PERCENT) * ZOOM_STEP_PERCENT;
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, stepped));
}

export function formatZoomPercent(percent: number): string {
  return `${clampZoomPercent(percent)}%`;
}

export function zoomIn(percent: number): number {
  return clampZoomPercent(percent + ZOOM_STEP_PERCENT);
}

export function zoomOut(percent: number): number {
  return clampZoomPercent(percent - ZOOM_STEP_PERCENT);
}

export function loadZoomPercent(storage: ZoomStorage | undefined = browserStorage()): number {
  if (!storage) return DEFAULT_ZOOM_PERCENT;
  try {
    const raw = storage.getItem(ZOOM_STORAGE_KEY);
    if (!raw) return DEFAULT_ZOOM_PERCENT;
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object") return DEFAULT_ZOOM_PERCENT;
    const value = (stored as { percent?: unknown }).percent;
    if (typeof value !== "number") return DEFAULT_ZOOM_PERCENT;
    return clampZoomPercent(value);
  } catch {
    return DEFAULT_ZOOM_PERCENT;
  }
}

export function persistZoomPercent(
  percent: number,
  storage: ZoomStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      ZOOM_STORAGE_KEY,
      JSON.stringify({ version: 1, percent: clampZoomPercent(percent) }),
    );
  } catch {
    // Session-only zoom is fine if storage is unavailable.
  }
}

/**
 * Scale the UI while keeping layout inside the window.
 *
 * At non-default zoom, `.zoom-surface` is laid out at `100% / scale` then
 * `transform: scale(scale)`, so chrome still fits the viewport. At 100%, the
 * transform is removed entirely so WebKit can repaint continuously while the
 * native window animates between sizes.
 *
 * Also clears any legacy CSS `zoom` left from earlier builds.
 */
export function applyZoomPercent(percent: number): void {
  if (typeof document === "undefined") return;
  const scale = clampZoomPercent(percent) / 100;
  const root = document.documentElement;
  root.style.removeProperty("zoom");
  root.style.setProperty(UI_ZOOM_CSS_VAR, String(scale));
  root.classList.toggle(UI_ZOOM_ACTIVE_CLASS, scale !== 1);
}
