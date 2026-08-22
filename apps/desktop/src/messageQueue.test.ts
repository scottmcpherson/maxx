import { describe, expect, it } from "vitest";
import { providerSupportsSteering, queuedMessageSummary, type QueuedMessage } from "./messageQueue";

function queued(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "queued-1",
    kind: "prompt",
    projectID: "project",
    threadID: "thread",
    hostID: "local",
    prompt: "  Check   this next\nplease ",
    imagePaths: [],
    annotations: [],
    textSelections: [],
    ...overrides,
  } as QueuedMessage;
}

describe("message queue presentation", () => {
  it("advertises steering only for harnesses with a native steering protocol", () => {
    expect(providerSupportsSteering("codex")).toBe(true);
    expect(providerSupportsSteering("pi")).toBe(true);
    expect(providerSupportsSteering("claude")).toBe(false);
    expect(providerSupportsSteering("hermes")).toBe(false);
    expect(providerSupportsSteering("opencode")).toBe(false);
  });

  it("summarizes text and attachment-only queue entries", () => {
    expect(queuedMessageSummary(queued())).toBe("Check this next please");
    expect(queuedMessageSummary(queued({
      prompt: "",
      imagePaths: ["one.png", "two.png"],
      annotations: [{}, {}] as never[],
      textSelections: [{ id: "selection", text: "context" }],
    }))).toBe("2 images · 3 selections");
  });
});
