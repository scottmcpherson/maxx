import { afterEach, describe, expect, it, vi } from "vitest";
import { appendChatTextSelection, createChatTextSelection, MAX_SIDE_CHAT_SELECTION_CHARS } from "./sideChat";

describe("side chat selections", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes a selected excerpt and assigns an ID", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "selection-id" });
    expect(createChatTextSelection("  one\n  two  ")).toEqual({ id: "selection-id", text: "one two" });
  });

  it("rejects empty excerpts and bounds oversized ones", () => {
    expect(createChatTextSelection(" \n ")).toBeNull();
    expect(createChatTextSelection("x".repeat(MAX_SIDE_CHAT_SELECTION_CHARS + 50))?.text).toHaveLength(
      MAX_SIDE_CHAT_SELECTION_CHARS,
    );
  });

  it("deduplicates the same excerpt", () => {
    const selection = { id: "a", text: "same text" };
    expect(appendChatTextSelection([selection], { id: "b", text: "same text" })).toEqual([selection]);
  });
});
