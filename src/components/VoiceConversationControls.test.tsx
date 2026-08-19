import { describe, expect, it, vi } from "vitest";
import { IDLE_CONVERSATION } from "../voice/conversationMachine";
import type { VoiceConversation } from "../voice/useVoiceConversation";
import { VoiceConversationControls } from "./VoiceConversationControls";

function hasChildText(element: ReturnType<typeof VoiceConversationControls>, text: string): boolean {
  const children = Array.isArray(element?.props.children) ? element.props.children : [element?.props.children];
  return children.some((child: unknown) => {
    if (!child || typeof child !== "object" || !("props" in child)) return false;
    return (child as { props?: { children?: unknown } }).props?.children === text;
  });
}

function model(overrides: Partial<VoiceConversation> = {}): VoiceConversation {
  return {
    snapshot: IDLE_CONVERSATION,
    status: "Ready",
    isActive: false,
    canStart: true,
    telemetry: null,
    start: vi.fn(),
    end: vi.fn(),
    mute: vi.fn(),
    unmute: vi.fn(),
    interrupt: vi.fn(),
    retry: vi.fn(),
    finishUtterance: vi.fn(),
    ...overrides,
  };
}

describe("VoiceConversationControls", () => {
  it("renders an accessible start control independently of dictation", () => {
    const conversation = model();
    const element = VoiceConversationControls({ conversation, visible: true, manual: false });
    expect(element?.props["aria-label"]).toBe("Voice conversation controls");
    expect(element?.props.children[1].props.children).toContain("Start conversation");
  });

  it("exposes manual finish and retry states", () => {
    const conversation = model({
      snapshot: { ...IDLE_CONVERSATION, state: "transcribing" },
      status: "Transcribing",
      isActive: true,
    });
    const element = VoiceConversationControls({ conversation, visible: true, manual: true });
    expect(hasChildText(element, "Finish utterance")).toBe(true);

    const retry = VoiceConversationControls({
      conversation: model({
        snapshot: { ...IDLE_CONVERSATION, state: "error", error: "Speech host unavailable" },
        status: "Error",
        isActive: true,
      }),
      visible: true,
      manual: false,
    });
    expect(hasChildText(retry, "Retry")).toBe(true);
  });
});
