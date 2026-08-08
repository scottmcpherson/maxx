import type { MouseEvent as ReactMouseEvent } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const windowCommands = vi.hoisted(() => ({
  startDragging: vi.fn(),
  toggleMaximize: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowCommands,
}));

import { beginWindowDrag } from "./windowDrag";

function mouseEvent(
  overrides: Partial<ReactMouseEvent<HTMLElement>> = {},
): ReactMouseEvent<HTMLElement> {
  return {
    button: 0,
    detail: 1,
    target: null,
    ...overrides,
  } as unknown as ReactMouseEvent<HTMLElement>;
}

describe("beginWindowDrag", () => {
  beforeAll(() => {
    vi.stubGlobal("Element", class Element {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts dragging on a primary-button press", () => {
    beginWindowDrag(mouseEvent());

    expect(windowCommands.startDragging).toHaveBeenCalledOnce();
    expect(windowCommands.toggleMaximize).not.toHaveBeenCalled();
  });

  it("toggles the maximized state on a double-click", () => {
    beginWindowDrag(mouseEvent({ detail: 2 }));

    expect(windowCommands.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowCommands.startDragging).not.toHaveBeenCalled();
  });

  it("ignores non-primary mouse buttons", () => {
    beginWindowDrag(mouseEvent({ button: 1 }));

    expect(windowCommands.startDragging).not.toHaveBeenCalled();
    expect(windowCommands.toggleMaximize).not.toHaveBeenCalled();
  });
});
