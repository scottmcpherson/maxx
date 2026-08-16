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

describe("automation IPC", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    vi.stubGlobal("window", { maxx: { invoke } });
  });

  it("uses the Maxx scheduler method names and preserves the create contract", async () => {
    await ipc.createAutomation({
      title: "Weekday digest",
      kind: "agent_turn",
      prompt: "Summarize new issues",
      schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
      runtime: { provider: "hermes", model: "Default" },
    });
    expect(invoke).toHaveBeenCalledWith("create_automation", {
      title: "Weekday digest",
      kind: "agent_turn",
      prompt: "Summarize new issues",
      schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
      runtime: { provider: "hermes", model: "Default" },
    });
  });

  it("uses update for pause/resume and exposes run-now/delete operations", async () => {
    await ipc.updateAutomation("automation-1", { status: "paused" });
    await ipc.runAutomation("automation-1");
    await ipc.deleteAutomation("automation-1");
    expect(invoke.mock.calls).toEqual([
      ["update_automation", { id: "automation-1", status: "paused" }],
      ["run_automation", { id: "automation-1" }],
      ["delete_automation", { id: "automation-1" }],
    ]);
  });
});
