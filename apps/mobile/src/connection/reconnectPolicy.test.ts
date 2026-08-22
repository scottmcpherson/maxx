import { describe, expect, it } from "vitest";
import {
  automaticReconnectDelay,
  shouldAutomaticallyReconnect,
  shouldShowReconnectProgress,
} from "./reconnectPolicy";

describe("shouldShowReconnectProgress", () => {
  it("keeps automatic retries on the stable disconnected screen", () => {
    expect(shouldShowReconnectProgress("startup")).toBe(true);
    expect(shouldShowReconnectProgress("manual")).toBe(true);
    expect(shouldShowReconnectProgress("automatic")).toBe(false);
  });
});

describe("automaticReconnectDelay", () => {
  it("backs off quickly and caps retries at five seconds", () => {
    expect([0, 1, 2, 3, 4, 12].map(automaticReconnectDelay)).toEqual([
      500,
      1_000,
      2_000,
      5_000,
      5_000,
      5_000,
    ]);
  });
});

describe("shouldAutomaticallyReconnect", () => {
  it("retries transient connection failures", () => {
    expect(shouldAutomaticallyReconnect(new Error("Connection lost."))).toBe(true);
    expect(shouldAutomaticallyReconnect(new Error("connect ECONNREFUSED"))).toBe(true);
  });

  it("stops when retrying cannot repair the saved identity or credential", () => {
    expect(shouldAutomaticallyReconnect(new Error("The saved address now belongs to a different Maxx host."))).toBe(false);
    expect(shouldAutomaticallyReconnect(new Error("Maxx rejected this device."))).toBe(false);
    expect(shouldAutomaticallyReconnect(new Error("The device credential was rejected"))).toBe(false);
    expect(shouldAutomaticallyReconnect(new Error("The host credentials were rejected"))).toBe(false);
    expect(shouldAutomaticallyReconnect(new Error("This Maxx version is not compatible with the mobile app."))).toBe(false);
  });
});
