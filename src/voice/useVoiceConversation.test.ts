import { describe, expect, it } from "vitest";
import { isVoiceHostAvailable } from "./useVoiceConversation";

describe("voice conversation host lifecycle", () => {
  it("treats the client as available without a remote session", () => {
    expect(isVoiceHostAvailable("local", [], null)).toBe(true);
  });

  it("requires a connected signal for each remote execution or speech host", () => {
    const sessions = [{ host: { id: "speech-host" } }];
    const status = {
      remotes: [
        { id: "speech-host", connected: true },
        { id: "execution-host", connected: false },
      ],
    };

    expect(isVoiceHostAvailable("speech-host", sessions, status)).toBe(true);
    expect(isVoiceHostAvailable("execution-host", sessions, status)).toBe(false);
    expect(isVoiceHostAvailable("unknown-host", sessions, status)).toBe(false);
  });
});
