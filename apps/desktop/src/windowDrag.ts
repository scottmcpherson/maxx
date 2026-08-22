import type { MouseEvent as ReactMouseEvent } from "react";

const INTERACTIVE_SELECTOR =
  "button, input, textarea, select, option, a, [role='button'], [data-no-drag]";

export function beginWindowDrag(event: ReactMouseEvent<HTMLElement>) {
  if (event.button !== 0) return;

  const target = event.target;
  if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;

  if (event.detail === 2) {
    void window.maxx.invoke("window_toggle_maximize");
    return;
  }

  // Electron starts native dragging through `-webkit-app-region: drag` on the
  // title surfaces. The handler remains for double-click parity and to keep
  // interactive descendants from stealing the gesture.
}
