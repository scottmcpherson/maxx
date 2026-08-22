import { describe, expect, it } from "vitest";
import {
  annotationKey,
  annotationKind,
  annotationPopoverPosition,
  annotationPromptContext,
  annotationsPromptContext,
} from "./browserAnnotations";

describe("annotationPopoverPosition", () => {
  const viewport = { width: 1_000, height: 700 };
  const popover = { width: 390, height: 150 };

  it("opens below a trigger near the top instead of clipping", () => {
    expect(annotationPopoverPosition({
      trigger: { left: 500, right: 650, top: 20, bottom: 49 },
      popover,
      viewport,
      alignRight: true,
    })).toEqual({ left: 260, top: 57 });
  });

  it("opens above a trigger near the bottom", () => {
    expect(annotationPopoverPosition({
      trigger: { left: 20, right: 170, top: 650, bottom: 679 },
      popover,
      viewport,
      alignRight: false,
    })).toEqual({ left: 20, top: 492 });
  });

  it("clamps right-aligned popovers to both viewport edges", () => {
    expect(annotationPopoverPosition({
      trigger: { left: 10, right: 90, top: 300, bottom: 329 },
      popover,
      viewport,
      alignRight: true,
    }).left).toBe(12);
    expect(annotationPopoverPosition({
      trigger: { left: 950, right: 990, top: 300, bottom: 329 },
      popover,
      viewport,
      alignRight: false,
    }).left).toBe(598);
  });
});

describe("annotationPromptContext", () => {
  it("describes the exact DOM target without embedding a screenshot", () => {
    const context = annotationPromptContext({
      id: "annotation-1",
      tabId: "tab-1",
      url: "https://example.com/settings",
      selector: "#profile > button:nth-of-type(2)",
      tagName: "button",
      role: "button",
      name: "Save profile",
      text: "Save",
      instruction: "Keep this button visible",
      previewDataUrl: "data:image/png;base64,cHJldmlldw==",
      rect: { x: 20, y: 30, width: 100, height: 44 },
      createdAt: 1,
    });

    expect(context).toContain("URL: https://example.com/settings");
    expect(context).toContain("Element: #profile > button:nth-of-type(2)");
    expect(context).toContain("Description: Save profile");
    expect(context).toContain("Visible text: Save");
    expect(context).toContain("Role: button");
    expect(context).toContain("Instruction: Keep this button visible");
    expect(context).toContain("Bounds: x=20, y=30, width=100, height=44");
    expect(context).not.toMatch(/data:image|screenshot/i);
  });

  it("falls back to visible text when no accessible name is present", () => {
    const context = annotationPromptContext({
      id: "annotation-2",
      tabId: "tab-1",
      url: "https://example.com",
      selector: "main > p",
      tagName: "p",
      role: null,
      name: "",
      text: "Status details",
      instruction: "Shorten this copy",
      previewDataUrl: "",
      rect: { x: 0, y: 0, width: 200, height: 30 },
      createdAt: 1,
    });

    expect(context).toContain("Description: Status details");
    expect(context.match(/Status details/g)).toHaveLength(1);
  });

  it("serializes multiple elements in their visible pill order", () => {
    const annotations = [
      {
        id: "a", tabId: "tab-1", url: "https://example.com", selector: "header",
        tagName: "header", role: "banner", name: "Site header", text: "",
        instruction: "Make this compact", previewDataUrl: "",
        rect: { x: 0, y: 0, width: 800, height: 80 }, createdAt: 1,
      },
      {
        id: "b", tabId: "tab-1", url: "https://example.com", selector: "button.primary",
        tagName: "button", role: "button", name: "Buy now", text: "Buy now",
        instruction: "Use the primary color", previewDataUrl: "",
        rect: { x: 600, y: 500, width: 120, height: 44 }, createdAt: 2,
      },
    ];

    const context = annotationsPromptContext(annotations);
    expect(context).toContain("1. Site header");
    expect(context).toContain("2. Buy now");
    expect(context.indexOf("1. Site header")).toBeLessThan(context.indexOf("2. Buy now"));
    expect(annotationKey(annotations[0])).toBe("tab-1\u0000header");
    expect(annotationKind(annotations[0])).toBe("banner");
  });

  it("uses a heading label when the page omitted an explicit role", () => {
    expect(annotationKind({ tagName: "h2", role: null })).toBe("heading");
  });
});
