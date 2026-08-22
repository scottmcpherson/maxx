import { describe, expect, it } from "vitest";

import { resolveMarkdownLinkAction, resolveMarkdownSessionUpdate } from "./markdownModel";

describe("resolveMarkdownLinkAction", () => {
  it("allows external protocols the mobile app can safely hand to the OS", () => {
    expect(resolveMarkdownLinkAction(" https://example.com/docs ")).toEqual({
      kind: "open",
      href: "https://example.com/docs",
    });
    expect(resolveMarkdownLinkAction("mailto:hello@example.com").kind).toBe("open");
  });

  it("blocks executable, local, relative, and malformed destinations", () => {
    expect(resolveMarkdownLinkAction("javascript:alert(1)")).toEqual({ kind: "block" });
    expect(resolveMarkdownLinkAction("file:///Users/scott/private.txt")).toEqual({ kind: "block" });
    expect(resolveMarkdownLinkAction("../src/App.tsx")).toEqual({ kind: "block" });
    expect(resolveMarkdownLinkAction("https://example.com\njavascript:alert(1)")).toEqual({
      kind: "block",
    });
  });
});

describe("resolveMarkdownSessionUpdate", () => {
  it("appends only the new suffix during ordinary streaming", () => {
    expect(resolveMarkdownSessionUpdate("Hello", "Hello **world**")).toEqual({
      kind: "append",
      text: " **world**",
    });
  });

  it("resets when an upstream correction replaces earlier text", () => {
    expect(resolveMarkdownSessionUpdate("Hello world", "Hello Maxx")).toEqual({
      kind: "reset",
      text: "Hello Maxx",
    });
  });

  it("does nothing when the accumulated response is unchanged", () => {
    expect(resolveMarkdownSessionUpdate("Done", "Done")).toEqual({ kind: "none" });
  });
});
