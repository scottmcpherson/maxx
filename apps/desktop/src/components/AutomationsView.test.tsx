import { describe, expect, it } from "vitest";
import type { AutomationSchedule } from "../contract/types";
import { automationStatusLabel, formatAutomationSchedule } from "./AutomationsView";

describe("automation view formatting", () => {
  it("renders interval schedules in human terms", () => {
    expect(formatAutomationSchedule({
      type: "interval",
      everySeconds: 3_600,
      timezone: "America/New_York",
    })).toBe("Every 1 hour");
    expect(formatAutomationSchedule({
      type: "interval",
      everySeconds: 120,
      timezone: "America/New_York",
    })).toBe("Every 2 minutes");
  });

  it("keeps cron expressions visible in job cards", () => {
    const schedule: AutomationSchedule = {
      type: "cron",
      expression: "0 9 * * 1-5",
      timezone: "America/New_York",
    };
    expect(formatAutomationSchedule(schedule)).toBe("Cron · 0 9 * * 1-5");
  });

  it("uses a human label for the unattended attention state", () => {
    expect(automationStatusLabel("needs_attention")).toBe("Needs attention");
    expect(automationStatusLabel("paused")).toBe("Paused");
  });
});
