import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";

const invoke = vi.fn();

describe("clipboard IPC", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    vi.stubGlobal("window", { maxx: { invoke } });
  });

  it("writes text through the native desktop bridge", async () => {
    await ipc.writeClipboardText("mac-mini.tailnet.ts.net:54500");

    expect(invoke).toHaveBeenCalledWith("clipboard_write_text", {
      text: "mac-mini.tailnet.ts.net:54500",
    });
  });
});
