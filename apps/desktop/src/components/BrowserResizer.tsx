import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_BROWSER_WIDTH,
  MIN_BROWSER_WIDTH,
  clampBrowserWidth,
  loadBrowserWidth,
  maximumBrowserWidth,
  persistBrowserWidth,
} from "../browser";
import { useLayoutWidth } from "../layout";

const KEYBOARD_STEP = 8;

/**
 * Owns the pane width and publishes it as `--browser-width`.
 *
 * `sidebarReservedWidth` is the sidebar's live width (0 when it is collapsed):
 * per `ContentView.browserWidthRange` the browser is the pane that yields, so
 * it shrinks rather than pushing the workspace below its minimum.
 */
export function useBrowserWidth(sidebarReservedWidth: number) {
  // The layout width, not the viewport: at 200% zoom the shell is laid out in
  // half the window's CSS pixels (see `useLayoutWidth`).
  const availableWidth = useLayoutWidth();
  const [width, setWidth] = useState(loadBrowserWidth);
  const [maxWidth, setMaxWidth] = useState(() =>
    maximumBrowserWidth(availableWidth, sidebarReservedWidth),
  );

  useEffect(() => {
    document.documentElement.style.setProperty("--browser-width", `${width}px`);
  }, [width]);

  // Re-clamp against every input that can steal room: the window, the zoom
  // level (both fold into `availableWidth`) and the sidebar.
  useEffect(() => {
    const upper = maximumBrowserWidth(availableWidth, sidebarReservedWidth);
    setMaxWidth(upper);
    setWidth((current) => clampBrowserWidth(current, upper));
  }, [availableWidth, sidebarReservedWidth]);

  const commitWidth = useCallback(
    (next: number) => {
      const clamped = clampBrowserWidth(next, maxWidth);
      setWidth(clamped);
      return clamped;
    },
    [maxWidth],
  );

  return { width, maxWidth, commitWidth };
}

/**
 * Right-edge splitter. Mirrors `SidebarResizer` with the drag delta inverted —
 * dragging left widens the pane (Swift's `dragDirection: -1`).
 */
export function BrowserResizer({
  width,
  maxWidth,
  commitWidth,
  hidden,
}: {
  width: number;
  maxWidth: number;
  commitWidth: (next: number) => number;
  hidden: boolean;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ pointerID: number; startX: number; startWidth: number } | null>(null);

  const widthForPointer = (drag: { startX: number; startWidth: number }, clientX: number) =>
    drag.startWidth - (clientX - drag.startX);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerID: event.pointerId, startX: event.clientX, startWidth: width };
    setIsDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    commitWidth(widthForPointer(drag, event.clientX));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    persistBrowserWidth(commitWidth(widthForPointer(drag, event.clientX)));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 1 : KEYBOARD_STEP;
    // Arrow direction is spatial: left grows the pane, right shrinks it.
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      persistBrowserWidth(commitWidth(width + step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      persistBrowserWidth(commitWidth(width - step));
    }
  };

  useEffect(() => {
    if (!isDragging) return;
    document.body.classList.add("is-resizing-sidebar");
    return () => document.body.classList.remove("is-resizing-sidebar");
  }, [isDragging]);

  // On a window too narrow to seat both minimums the range collapses to a
  // single width. Drop the handle rather than leave a col-resize cursor over a
  // divider that cannot move.
  if (maxWidth <= MIN_BROWSER_WIDTH) return null;

  return (
    <div
      className={`browser-resizer${isDragging ? " is-dragging" : ""}${hidden ? " is-hidden" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Browser divider"
      aria-valuenow={width}
      aria-valuemin={MIN_BROWSER_WIDTH}
      aria-valuemax={maxWidth}
      tabIndex={hidden ? -1 : 0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => persistBrowserWidth(commitWidth(DEFAULT_BROWSER_WIDTH))}
      onKeyDown={handleKeyDown}
    />
  );
}
