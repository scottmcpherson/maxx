import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { layoutWidth } from "../layout";

const SIDE_THREAD_WIDTH_STORAGE_KEY = "maxx.sideThread.width";
export const MIN_SIDE_THREAD_WIDTH = 300;
const MAX_SIDE_THREAD_WIDTH = 720;
export const DEFAULT_SIDE_THREAD_WIDTH = 380;
/** The main transcript keeps this much of the stage no matter how wide the panel gets. */
const MIN_THREAD_COLUMN_WIDTH = 380;
const KEYBOARD_STEP = 8;

/** The flex row the transcript and the side thread share. */
const STAGE_SELECTOR = ".workspace-stage";

/**
 * The panel splits `.workspace-stage`, not the window: the sidebar and the
 * browser pane have already taken their room by the time the stage is laid out,
 * so measuring the stage keeps this range independent of theirs.
 */
export function maximumSideThreadWidth(stageWidth: number): number {
  const layoutMaximum = stageWidth - MIN_THREAD_COLUMN_WIDTH;
  return Math.max(MIN_SIDE_THREAD_WIDTH, Math.min(MAX_SIDE_THREAD_WIDTH, layoutMaximum));
}

export function clampSideThreadWidth(width: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(MIN_SIDE_THREAD_WIDTH, Math.round(width)));
}

function stageWidth(): number {
  if (typeof document === "undefined") return 0;
  const stage = document.querySelector(STAGE_SELECTOR);
  return stage ? stage.clientWidth : layoutWidth();
}

/**
 * Tracks the stage's width. The stage is `flex: 1; min-width: 0`, so its own
 * width never depends on how wide the panel inside it is — observing it cannot
 * feed back into the width being clamped.
 */
function useStageWidth(): number {
  const [width, setWidth] = useState(stageWidth);

  useEffect(() => {
    const update = () => setWidth(stageWidth());
    update();

    const stage = document.querySelector(STAGE_SELECTOR);
    let observer: ResizeObserver | undefined;
    if (stage && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(stage);
    }
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return width;
}

function loadSideThreadWidth(): number {
  if (typeof window === "undefined") return DEFAULT_SIDE_THREAD_WIDTH;
  const stored = Number(window.localStorage.getItem(SIDE_THREAD_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : DEFAULT_SIDE_THREAD_WIDTH;
}

function persistSideThreadWidth(width: number) {
  window.localStorage.setItem(SIDE_THREAD_WIDTH_STORAGE_KEY, String(width));
}

/**
 * Left-edge splitter for the side thread panel. Mirrors `BrowserResizer` — the
 * panel is on the right, so dragging left widens it — but lives inside the
 * stage as a flex sibling with negative margins rather than being anchored to
 * the window edge, because the browser pane can sit between it and that edge.
 */
export function SideThreadResizer() {
  const availableWidth = useStageWidth();
  const [width, setWidth] = useState(loadSideThreadWidth);
  const [maxWidth, setMaxWidth] = useState(() => maximumSideThreadWidth(availableWidth));
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ pointerID: number; startX: number; startWidth: number } | null>(null);

  // Layout effect, not an effect: the panel mounts with this resizer, and a
  // paint at the fallback width before the stored one lands reads as a flinch.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--side-thread-width", `${width}px`);
  }, [width]);

  useEffect(() => {
    const upper = maximumSideThreadWidth(availableWidth);
    setMaxWidth(upper);
    setWidth((current) => clampSideThreadWidth(current, upper));
  }, [availableWidth]);

  const commitWidth = useCallback(
    (next: number) => {
      const clamped = clampSideThreadWidth(next, maxWidth);
      setWidth(clamped);
      return clamped;
    },
    [maxWidth],
  );

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
    persistSideThreadWidth(commitWidth(widthForPointer(drag, event.clientX)));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 1 : KEYBOARD_STEP;
    // Arrow direction is spatial: left grows the panel, right shrinks it.
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      persistSideThreadWidth(commitWidth(width + step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      persistSideThreadWidth(commitWidth(width - step));
    }
  };

  useEffect(() => {
    if (!isDragging) return;
    document.body.classList.add("is-resizing-sidebar");
    return () => document.body.classList.remove("is-resizing-sidebar");
  }, [isDragging]);

  return (
    <div
      className={`side-thread-resizer${isDragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Side thread divider"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDE_THREAD_WIDTH}
      aria-valuemax={maxWidth}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => persistSideThreadWidth(commitWidth(DEFAULT_SIDE_THREAD_WIDTH))}
      onKeyDown={handleKeyDown}
    />
  );
}
