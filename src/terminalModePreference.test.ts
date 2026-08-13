import { describe, expect, it } from "vitest";
import {
  loadTerminalModeEnabled,
  persistTerminalModeEnabled,
} from "./terminalModePreference";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("terminal mode preference", () => {
  it("defaults off and round-trips the user's choice", () => {
    const storage = memoryStorage();
    expect(loadTerminalModeEnabled(storage)).toBe(false);
    persistTerminalModeEnabled(true, storage);
    expect(loadTerminalModeEnabled(storage)).toBe(true);
    persistTerminalModeEnabled(false, storage);
    expect(loadTerminalModeEnabled(storage)).toBe(false);
  });

  it("stays off when storage is unavailable", () => {
    expect(loadTerminalModeEnabled(undefined)).toBe(false);
    expect(() => persistTerminalModeEnabled(true, undefined)).not.toThrow();
  });
});
