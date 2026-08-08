import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent } from "react";

const INTERACTIVE_SELECTOR =
  "button, input, textarea, select, option, a, [role='button'], [data-no-drag]";

export function beginWindowDrag(event: ReactMouseEvent<HTMLElement>) {
  if (event.button !== 0) return;

  const target = event.target;
  if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;

  const window = getCurrentWindow();
  if (event.detail === 2) {
    void window.toggleMaximize();
    return;
  }

  void window.startDragging();
}
