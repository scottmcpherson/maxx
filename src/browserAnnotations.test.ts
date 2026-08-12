import { describe, expect, it } from "vitest";
import { annotationPromptContext } from "./browserAnnotations";

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
      rect: { x: 20, y: 30, width: 100, height: 44 },
      createdAt: 1,
    });

    expect(context).toContain("URL: https://example.com/settings");
    expect(context).toContain("Element: #profile > button:nth-of-type(2)");
    expect(context).toContain("Description: Save profile");
    expect(context).toContain("Visible text: Save");
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
      rect: { x: 0, y: 0, width: 200, height: 30 },
      createdAt: 1,
    });

    expect(context).toContain("Description: Status details");
    expect(context.match(/Status details/g)).toHaveLength(1);
  });
});
