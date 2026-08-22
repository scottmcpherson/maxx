import { describe, expect, it } from "vitest";
import {
  loadShowProviderDiagnostics,
  persistShowProviderDiagnostics,
} from "./providerDiagnostics";
import { isProviderDiagnostic } from "../../../shared/providerDiagnostics";
import { EventKind, ProviderRuntimeEvent } from "./contract/types";

function warning(overrides: Partial<ProviderRuntimeEvent> = {}): ProviderRuntimeEvent {
  return {
    schemaVersion: 1,
    id: "event",
    providerInstanceID: "instance",
    threadID: "thread",
    turnID: "turn",
    sequence: 1,
    occurredAt: 1,
    kind: EventKind.warning,
    payload: {},
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("isProviderDiagnostic", () => {
  it("classifies structured Codex runtime warnings", () => {
    expect(isProviderDiagnostic(warning({
      nativeReference: { protocolName: "codex-app-server", eventType: "warning" },
    }))).toBe(true);
  });

  it("classifies Claude allowed warnings but keeps harder rate limits visible", () => {
    const nativeReference = {
      protocolName: "claude-stream-json",
      eventType: "rate_limit_event",
    };
    expect(isProviderDiagnostic(warning({
      payload: { rawType: "allowed_warning" },
      nativeReference,
    }))).toBe(true);
    expect(isProviderDiagnostic(warning({
      payload: { rawType: "throttled" },
      nativeReference,
    }))).toBe(false);
  });

  it("keeps actionable provider warnings visible", () => {
    expect(isProviderDiagnostic(warning({
      nativeReference: {
        protocolName: "codex-app-server",
        eventType: "mcpServer/startupStatus/updated",
      },
    }))).toBe(false);
  });
});

describe("provider diagnostics preference", () => {
  it("defaults off and round-trips the user's choice", () => {
    const storage = memoryStorage();
    expect(loadShowProviderDiagnostics(storage)).toBe(false);
    persistShowProviderDiagnostics(true, storage);
    expect(loadShowProviderDiagnostics(storage)).toBe(true);
    persistShowProviderDiagnostics(false, storage);
    expect(loadShowProviderDiagnostics(storage)).toBe(false);
  });

  it("stays off when storage is unavailable", () => {
    expect(loadShowProviderDiagnostics(undefined)).toBe(false);
    expect(() => persistShowProviderDiagnostics(true, undefined)).not.toThrow();
  });
});
