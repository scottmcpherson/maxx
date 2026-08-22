import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
    <div className="fixed top-2.5 right-3 z-10000 flex h-8 items-center gap-0.5 rounded-lg border border-border bg-popover/95 py-0 pr-1 pl-2.5 text-popover-foreground shadow-xl animate-in fade-in slide-in-from-top-1 [-webkit-app-region:no-drag]" role="status" aria-live="polite" aria-label="Zoom level">
      <span className="min-w-11 pe-1 text-center text-xs tabular-nums text-muted-foreground">{formatZoomPercent(percent)}</span>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        title="Zoom out"
        aria-label="Zoom out"
        disabled={atMin}
        onClick={() => commit(zoomOut(percent))}
      >−</Button>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        title="Zoom in"
        aria-label="Zoom in"
        disabled={atMax}
        onClick={() => commit(zoomIn(percent))}
      >+</Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        title="Reset zoom"
        aria-label="Reset zoom"
        disabled={atDefault}
        onClick={() => commit(DEFAULT_ZOOM_PERCENT)}
      >Reset</Button>
    </div>
  );
}
