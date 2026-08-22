import { describe, expect, it } from "vitest";
import { VoiceLatencyTelemetry } from "./telemetry";

describe("VoiceLatencyTelemetry", () => {
  it("records first-occurrence latency without accepting content", () => {
    let now = 1_000;
    const telemetry = new VoiceLatencyTelemetry("session-1", "remote", "local-openai", () => now);
    now = 1_125;
    telemetry.mark("firstPartial");
    now = 1_500;
    telemetry.mark("firstPartial");
    telemetry.mark("finalTranscript");
    telemetry.reconnected();
    telemetry.droppedInput();
    telemetry.rejectedOutput();
    expect(telemetry.snapshot()).toEqual({
      sessionID: "session-1",
      hostClass: "remote",
      provider: "local-openai",
      reconnects: 1,
      droppedInputChunks: 1,
      rejectedOutputChunks: 1,
      milliseconds: { firstPartial: 125, finalTranscript: 500 },
    });
  });
});
