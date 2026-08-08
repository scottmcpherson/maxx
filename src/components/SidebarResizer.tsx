import { useCallback, useEffect, useRef, useState } from "react";
import { MIN_WORKSPACE_WIDTH, layoutWidth, useLayoutWidth } from "../layout";

const SIDEBAR_WIDTH_STORAGE_KEY = "maxx.sidebar.width";
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 360;
const DEFAULT_SIDEBAR_WIDTH = 250;
const KEYBOARD_STEP = 8;

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

/**
 * The sidebar yields before the workspace does.
 *
 * `reservedWidth` is the room the browser pane needs. It is that pane's
 * *minimum*, not its live width, which keeps the two ranges from depending on
 * each other: the sidebar only has to guarantee the browser can still exist,
 * and the browser (see `maximumBrowserWidth`) yields against the sidebar's
 * actual width.
 */
export function maximumSidebarWidth(availableWidth: number, reservedWidth = 0): number {
  const layoutMaximum = availableWidth - MIN_WORKSPACE_WIDTH - Math.max(0, reservedWidth);
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, layoutMaximum));
}

function loadSidebarWidth(): number {
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  const width = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_SIDEBAR_WIDTH;
  return clamp(Math.round(width), MIN_SIDEBAR_WIDTH, maximumSidebarWidth(layoutWidth()));
}

export function useSidebarWidth(reservedWidth = 0) {
  // The layout width, not the viewport: `.zoom-surface` is only
  // `innerWidth / --ui-zoom` CSS pixels wide (see `useLayoutWidth`).
  const availableWidth = useLayoutWidth();
  const [width, setWidth] = useState(loadSidebarWidth);
  const [maxWidth, setMaxWidth] = useState(() =>
    maximumSidebarWidth(availableWidth, reservedWidth),
  );

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  }, [width]);

  useEffect(() => {
    const upper = maximumSidebarWidth(availableWidth, reservedWidth);
    setMaxWidth(upper);
    setWidth((current) => clamp(current, MIN_SIDEBAR_WIDTH, upper));
  }, [availableWidth, reservedWidth]);

  const commitWidth = useCallback(
    (next: number) => {
      const clamped = clamp(Math.round(next), MIN_SIDEBAR_WIDTH, maxWidth);
      setWidth(clamped);
      return clamped;
    },
    [maxWidth]
  );

  return { width, maxWidth, commitWidth };
}

export function SidebarResizer({
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

  const persist = useCallback((next: number) => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
  }, []);

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
    commitWidth(drag.startWidth + (event.clientX - drag.startX));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    persist(commitWidth(drag.startWidth + (event.clientX - drag.startX)));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 1 : KEYBOARD_STEP;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      persist(commitWidth(width - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      persist(commitWidth(width + step));
    }
  };

  useEffect(() => {
    if (!isDragging) return;
    document.body.classList.add("is-resizing-sidebar");
    return () => document.body.classList.remove("is-resizing-sidebar");
  }, [isDragging]);

  // Same as the browser pane: a collapsed range means the divider cannot move,
  // so it stands down instead of advertising a drag that does nothing.
  const inert = hidden || maxWidth <= MIN_SIDEBAR_WIDTH;

  return (
    <div
      className={`sidebar-resizer${isDragging ? " is-dragging" : ""}${inert ? " is-hidden" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar divider"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={maxWidth}
      tabIndex={inert ? -1 : 0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => persist(commitWidth(DEFAULT_SIDEBAR_WIDTH))}
      onKeyDown={handleKeyDown}
    />
  );
}
