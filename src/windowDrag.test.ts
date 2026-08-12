import type { MouseEvent as ReactMouseEvent } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const windowCommands = vi.hoisted(() => ({
  invoke: vi.fn(),
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
    vi.stubGlobal("window", { maxx: { invoke: windowCommands.invoke } });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves primary-button dragging to the Electron drag region", () => {
    beginWindowDrag(mouseEvent());

    expect(windowCommands.invoke).not.toHaveBeenCalled();
  });

  it("toggles the maximized state on a double-click", () => {
    beginWindowDrag(mouseEvent({ detail: 2 }));

    expect(windowCommands.invoke).toHaveBeenCalledWith("window_toggle_maximize");
  });

  it("ignores non-primary mouse buttons", () => {
    beginWindowDrag(mouseEvent({ button: 1 }));

    expect(windowCommands.invoke).not.toHaveBeenCalled();
  });
});
