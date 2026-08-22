import { describe, expect, it } from "vitest";
import {
  describeUpdateStatus,
  isSettledUpdateStatus,
  shouldShowUpdateButton,
  updateStatusTone,
  type UpdateStatus,
} from "./updates";

describe("update status", () => {
  it("names the current version when up to date", () => {
    expect(describeUpdateStatus({ state: "upToDate", version: "0.1.0" })).toBe(
      "Maxx 0.1.0 is up to date.",
    );
  });

  it("names the new version when one is available", () => {
    expect(
      describeUpdateStatus({ state: "available", version: "0.2.0", notes: null, date: null }),
    ).toBe("Maxx 0.2.0 is available.");
  });

  it("explains why updates are unavailable in local builds", () => {
    const status: UpdateStatus = { state: "unavailable", detail: "Signed builds only." };
    expect(describeUpdateStatus(status)).toBe("Signed builds only.");
    expect(updateStatusTone(status)).toBe("warning");
  });

  it("surfaces the failure message", () => {
    expect(describeUpdateStatus({ state: "failed", message: "timed out" })).toBe(
      "Update check failed. timed out",
    );
  });

  it("keeps the in-flight state on screen until it is replaced", () => {
    expect(isSettledUpdateStatus({ state: "checking" })).toBe(false);
    expect(isSettledUpdateStatus({ state: "downloading", version: "0.2.0", percent: 50 })).toBe(false);
    expect(isSettledUpdateStatus({ state: "upToDate", version: "0.1.0" })).toBe(true);
  });

  it("tones an available update as good news", () => {
    expect(updateStatusTone({ state: "available", version: "9.9.9", notes: "hi", date: null })).toBe("good");
    expect(updateStatusTone({ state: "checking" })).toBe("info");
  });

  it("only reserves sidebar chrome for an actionable update", () => {
    expect(shouldShowUpdateButton(null)).toBe(false);
    expect(shouldShowUpdateButton({ state: "upToDate", version: "0.1.0" })).toBe(false);
    expect(shouldShowUpdateButton({ state: "available", version: "0.2.0", notes: null, date: null })).toBe(true);
    expect(shouldShowUpdateButton({ state: "ready", version: "0.2.0" })).toBe(true);
  });
});
