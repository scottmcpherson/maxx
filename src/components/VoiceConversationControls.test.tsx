import { describe, expect, it, vi } from "vitest";
import { IDLE_CONVERSATION } from "../voice/conversationMachine";
import type { VoiceConversation } from "../voice/useVoiceConversation";
import {
  composerPrimaryAction,
  VoiceConversationActionButton,
  VoiceConversationControls,
} from "./VoiceConversationControls";

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
  it("uses conversation when empty, send with content, and stop while active", () => {
    expect(composerPrimaryAction({ conversationActive: false, hasContent: false, voiceEnabled: true }))
      .toBe("conversation");
    expect(composerPrimaryAction({ conversationActive: false, hasContent: true, voiceEnabled: true }))
      .toBe("send");
    expect(composerPrimaryAction({ conversationActive: true, hasContent: true, voiceEnabled: true }))
      .toBe("stop-conversation");
    expect(composerPrimaryAction({ conversationActive: false, hasContent: false, voiceEnabled: false }))
      .toBe("send");
  });

  it("switches the composer action between conversation and stop", () => {
    const start = VoiceConversationActionButton({ onClick: vi.fn() });
    expect(start.props["aria-label"]).toBe("Start conversation");

    const stop = VoiceConversationActionButton({ active: true, onClick: vi.fn() });
    expect(stop.props["aria-label"]).toBe("Stop conversation");
  });

  it("exposes manual finish and retry states", () => {
    const conversation = model({
      snapshot: { ...IDLE_CONVERSATION, state: "transcribing" },
      status: "Transcribing",
      isActive: true,
    });
    const element = VoiceConversationControls({ conversation, visible: true, manual: true });
    expect(element?.props["aria-label"]).toBe("Voice conversation controls");
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
