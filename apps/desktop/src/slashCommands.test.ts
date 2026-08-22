import { describe, expect, it } from "vitest";
import type { SlashCommandItem } from "./slashCommands";
import {
  applySlashCompletion,
  filterSlashCommands,
  slashCommandScore,
  slashTokenAt,
} from "./slashCommands";

const items: SlashCommandItem[] = [
  {
    id: "codex:skill:review",
    name: "review",
    invocation: "$review",
    displayName: "Review",
    description: "Review the current changes",
    kind: "skill",
    source: "Codex",
    scope: "repo",
    provider: "codex",
  },
  {
    id: "claude:command:model",
    name: "model",
    invocation: "/model",
    displayName: "Model",
    description: "Change the active model",
    kind: "command",
    source: "Claude",
    provider: "claude",
  },
];

describe("slashTokenAt", () => {
  it("opens after whitespace in the middle of a sentence", () => {
    const text = "please use /rev";
    expect(slashTokenAt(text, text.length)).toEqual({ from: 11, to: 15, query: "rev" });
  });

  it("opens at the beginning and after newlines or tabs", () => {
    expect(slashTokenAt("/", 1)).toEqual({ from: 0, to: 1, query: "" });
    expect(slashTokenAt("first\n/mo", 9)).toEqual({ from: 6, to: 9, query: "mo" });
    expect(slashTokenAt("first\t/mo", 9)).toEqual({ from: 6, to: 9, query: "mo" });
  });

  it("supports namespaced, hyphenated, underscored, and Unicode names", () => {
    for (const text of ["/skill:code-review", "/code_review", "/révision"]) {
      expect(slashTokenAt(text, text.length)?.query).toBe(text.slice(1));
    }
  });

  it("does not trigger inside absolute URLs, paths, or words", () => {
    for (const text of [
      "https://example.com/docs",
      "example.com/docs",
      "folder/name",
      "word/review",
      "https://",
    ]) {
      expect(slashTokenAt(text, text.length)).toBeNull();
    }
  });

  it("closes on URL/path punctuation and whitespace", () => {
    for (const text of ["use /api/users", "use /api.json", "use /api?x", "use /api#top", "use /api now"]) {
      expect(slashTokenAt(text, text.length)).toBeNull();
    }
  });

  it("uses the real caret rather than a later slash", () => {
    const text = "use /review then https://example.com";
    expect(slashTokenAt(text, 11)).toEqual({ from: 4, to: 11, query: "review" });
    expect(slashTokenAt(text, text.length)).toBeNull();
  });

  it("clamps invalid caret positions", () => {
    expect(slashTokenAt("/model", 999)?.query).toBe("model");
    expect(slashTokenAt("/model", -1)).toBeNull();
  });
});

describe("slash command filtering", () => {
  it("ranks exact and prefix name matches before metadata matches", () => {
    expect(filterSlashCommands(items, "model").map((item) => item.name)).toEqual(["model"]);
    expect(filterSlashCommands(items, "rev").map((item) => item.name)).toEqual(["review"]);
    expect(filterSlashCommands(items, "repo").map((item) => item.name)).toEqual(["review"]);
    expect(slashCommandScore(items[0], "review")).toBe(1_000);
  });

  it("honors the result cap", () => {
    expect(filterSlashCommands([...items, ...items], "", 1)).toHaveLength(1);
  });
});

describe("applySlashCompletion", () => {
  it("replaces only the active mid-sentence token using native invocation syntax", () => {
    const text = "please use /rev for this";
    expect(applySlashCompletion(text, { from: 11, to: 15, query: "rev" }, items[0])).toEqual({
      text: "please use $review for this",
      caret: 18,
    });
  });

  it("does not append a space to argument-free commands", () => {
    expect(applySlashCompletion("/mo", { from: 0, to: 3, query: "mo" }, items[1])).toEqual({
      text: "/model",
      caret: 6,
    });
  });
});
