// The one measurement every resizable pane has to agree on: how wide the shell
// is actually laid out.

import { useEffect, useState } from "react";
import { loadZoomPercent } from "./zoom";

/** The scaled surface everything except the zoom HUD is laid out inside. */
export const ZOOM_SURFACE_SELECTOR = ".zoom-surface";

/**
 * Floor for the workspace column: both side panes reserve it, so it is what
 * caps how wide either one may be dragged.
 *
 * Kept deliberately tight. It used to be 620 (mirroring the Swift
 * `ContentView`), which on a 1280pt window with the sidebar open left the
 * browser pane `1280 - 620 - 250 = 410`… against its own 360 minimum — a range
 * of 50pt, and none at all once the sidebar passed 300. The pane then pinned
 * to one width while its divider still hovered as a live resize affordance,
 * which reads as a broken handle rather than as a layout limit.
 */
export const MIN_WORKSPACE_WIDTH = 420;

/**
 * Width available to the app shell, in CSS pixels.
 *
 * **Not** `window.innerWidth`. `.zoom-surface` is sized `100% / --ui-zoom` and
 * then transform-scaled back up (see `applyZoomPercent`), so at 200% zoom the
 * layout box is only half the viewport wide. Measuring the viewport instead
 * lets the sidebar and the browser pane — both `flex: 0 0 auto` — claim room
 * that does not exist, which squeezes `.workspace-stage` (`flex: 1;
 * min-width: 0`) to zero and pushes the pane's slot, and with it the native
 * child webview, past the right edge of the window.
 */
export function layoutWidth(): number {
  if (typeof document === "undefined" || typeof window === "undefined") return 0;
  const surface = document.querySelector(ZOOM_SURFACE_SELECTOR);
  if (surface) return surface.clientWidth;
  // First render: the surface is not in the DOM yet, and `--ui-zoom` has not
  // been applied either, so derive the scale from the persisted value.
  return Math.round(window.innerWidth / (loadZoomPercent() / 100));
}

/**
 * Tracks [`layoutWidth`] across window resizes *and* zoom changes.
 *
 * A zoom change never fires `resize` — the window did not change — but it does
 * change `.zoom-surface`'s own layout box, which is what the observer watches.
 */
export function useLayoutWidth(): number {
  const [width, setWidth] = useState(layoutWidth);

  useEffect(() => {
    const update = () => setWidth(layoutWidth());
    update();

    const surface = document.querySelector(ZOOM_SURFACE_SELECTOR);
    let observer: ResizeObserver | undefined;
    if (surface && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(surface);
    }
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return width;
}
