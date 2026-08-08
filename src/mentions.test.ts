import { describe, expect, it } from "vitest";
import {
  applyMentionCompletion,
  filterAgentsForMention,
  findMention,
  findMentions,
  mentionQueryAt,
  mentionedAgents,
  splitMentions,
} from "./mentions";
import { AgentDefinition } from "./contract/types";

function agent(name: string): AgentDefinition {
  return {
    id: `id-${name}`,
    name,
    instructions: "",
    provider: "claude",
    model: "Default",
    colorHex: "#aabbcc",
    createdAt: 0,
    updatedAt: 0,
  };
}

const charlie = agent("Charlie");
const dana = agent("Dana");
const reviewer = agent("Code Reviewer");
const agents = [charlie, dana, reviewer];

describe("findMention", () => {
  it("finds a mention at the start of the text", () => {
    const match = findMention("@Charlie please review this work", agents);
    expect(match?.agent.id).toBe(charlie.id);
    expect(match?.index).toBe(0);
    expect(match?.length).toBe("@Charlie".length);
  });

  it("is case-insensitive", () => {
    expect(findMention("hey @charlie!", agents)?.agent.id).toBe(charlie.id);
  });

  it("matches multi-word names", () => {
    expect(findMention("@Code Reviewer take a look", agents)?.agent.id).toBe(reviewer.id);
  });

  it("requires a word boundary after the name", () => {
    expect(findMention("@Danae hi", agents)).toBeNull();
    expect(findMention("@Dana, hi", agents)?.agent.id).toBe(dana.id);
  });

  it("requires the @ to start a token", () => {
    expect(findMention("mail me at bob@Dana.com", agents)).toBeNull();
  });

  it("returns mentions in order of appearance", () => {
    const matches = findMentions("@Dana then @Charlie", agents);
    expect(matches.map((m) => m.agent.id)).toEqual([dana.id, charlie.id]);
  });

  it("returns null when nothing matches", () => {
    expect(findMention("no mentions here", agents)).toBeNull();
    expect(findMention("@Unknown person", agents)).toBeNull();
  });
});

describe("mentionedAgents", () => {
  it("returns unique agents in order of first mention", () => {
    const mentioned = mentionedAgents("@Dana @Charlie say hi", agents);
    expect(mentioned.map((a) => a.id)).toEqual([dana.id, charlie.id]);
  });

  it("dedupes repeated mentions of the same agent", () => {
    const mentioned = mentionedAgents("@Charlie and again @Charlie, plus @Dana", agents);
    expect(mentioned.map((a) => a.id)).toEqual([charlie.id, dana.id]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(mentionedAgents("no mentions here", agents)).toEqual([]);
  });
});

describe("mentionQueryAt", () => {
  it("captures the partial token before the caret", () => {
    const text = "hello @Cha";
    expect(mentionQueryAt(text, text.length)).toEqual({ query: "Cha", start: 6 });
  });

  it("allows an empty query right after @", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ query: "", start: 0 });
  });

  it("tolerates single spaces for multi-word names", () => {
    const text = "@Code Rev";
    expect(mentionQueryAt(text, text.length)?.query).toBe("Code Rev");
  });

  it("stops at newlines and double spaces", () => {
    expect(mentionQueryAt("@Cha\nrest", 9)).toBeNull();
    expect(mentionQueryAt("@Cha  rest", 10)).toBeNull();
  });

  it("rejects email-style tokens", () => {
    const text = "bob@example";
    expect(mentionQueryAt(text, text.length)).toBeNull();
  });
});

describe("filterAgentsForMention", () => {
  it("prefers prefix matches, then substring matches", () => {
    expect(filterAgentsForMention(agents, "c").map((a) => a.name)).toEqual([
      "Charlie",
      "Code Reviewer",
    ]);
  });

  it("returns everyone for an empty query", () => {
    expect(filterAgentsForMention(agents, "")).toHaveLength(3);
  });
});

describe("splitMentions", () => {
  it("isolates mentions between text segments", () => {
    const segments = splitMentions("hey @Charlie and @Dana!", agents);
    expect(segments).toEqual([
      { kind: "text", text: "hey " },
      { kind: "mention", text: "@Charlie", agent: charlie },
      { kind: "text", text: " and " },
      { kind: "mention", text: "@Dana", agent: dana },
      { kind: "text", text: "!" },
    ]);
  });

  it("returns one text segment when nothing matches", () => {
    expect(splitMentions("plain text", agents)).toEqual([
      { kind: "text", text: "plain text" },
    ]);
  });

  it("preserves the typed casing in the mention segment", () => {
    const segments = splitMentions("@charlie hi", agents);
    expect(segments[0]).toMatchObject({ kind: "mention", text: "@charlie" });
  });
});

describe("applyMentionCompletion", () => {
  it("replaces the token and moves the caret", () => {
    const text = "hey @Cha how";
    const result = applyMentionCompletion(text, 8, 4, charlie);
    expect(result.text).toBe("hey @Charlie  how");
    expect(result.caret).toBe(4 + "@Charlie ".length);
  });
});
