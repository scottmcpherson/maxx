import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_ZOOM_PERCENT,
  applyZoomPercent,
  formatZoomPercent,
  loadZoomPercent,
  persistZoomPercent,
  zoomIn,
  zoomOut,
} from "../zoom";

const HIDE_DELAY_MS = 2200;

export interface ZoomControlsHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

interface ZoomControlsProps {
  onReady?: (handle: ZoomControlsHandle) => void;
}

export function ZoomControls({ onReady }: ZoomControlsProps) {
  const [percent, setPercent] = useState(() => loadZoomPercent());
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);
  // Keep the latest percent without re-binding keyboard handlers every tick.
  const percentRef = useRef(percent);
  percentRef.current = percent;

  const showTemporarily = useCallback(() => {
    setVisible(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setVisible(false);
      hideTimer.current = null;
    }, HIDE_DELAY_MS);
  }, []);

  const commit = useCallback(
    (next: number, reveal = true) => {
      const clamped = next;
      setPercent(clamped);
      percentRef.current = clamped;
      applyZoomPercent(clamped);
      persistZoomPercent(clamped);
      if (reveal) showTemporarily();
    },
    [showTemporarily],
  );

  // Apply restored zoom once on mount (no HUD flash at 100%).
  useEffect(() => {
    applyZoomPercent(percent);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount only

  useEffect(() => {
    const handle: ZoomControlsHandle = {
      zoomIn: () => commit(zoomIn(percentRef.current)),
      zoomOut: () => commit(zoomOut(percentRef.current)),
      reset: () => commit(DEFAULT_ZOOM_PERCENT),
    };
    onReady?.(handle);
  }, [commit, onReady]);

  useEffect(() => {
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, []);

  if (!visible) return null;

  const atMin = percent <= 50;
  const atMax = percent >= 200;
  const atDefault = percent === DEFAULT_ZOOM_PERCENT;

  return (
    <div className="zoom-controls" role="status" aria-live="polite" aria-label="Zoom level">
      <span className="zoom-controls-percent">{formatZoomPercent(percent)}</span>
      <button
        type="button"
        className="zoom-controls-btn"
        title="Zoom out"
        aria-label="Zoom out"
        disabled={atMin}
        onClick={() => commit(zoomOut(percent))}
      >
        −
      </button>
      <button
        type="button"
        className="zoom-controls-btn"
        title="Zoom in"
        aria-label="Zoom in"
        disabled={atMax}
        onClick={() => commit(zoomIn(percent))}
      >
        +
      </button>
      <button
        type="button"
        className="zoom-controls-reset"
        title="Reset zoom"
        aria-label="Reset zoom"
        disabled={atDefault}
        onClick={() => commit(DEFAULT_ZOOM_PERCENT)}
      >
        Reset
      </button>
    </div>
  );
}
