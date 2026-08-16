import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInstanceSettings } from "./build-instance.js";

describe("buildInstanceSettings", () => {
  it("leaves the installed app on its canonical data and listener port", () => {
    expect(buildInstanceSettings("/AppData", "Maxx", "/repo/maxx", false, false)).toEqual({
      userDataPath: null,
      listenPort: null,
    });
  });

  it("isolates each checkout build on a stable listener port", () => {
    const first = buildInstanceSettings("/AppData", "Maxx", "/repo/one", false, true);
    const repeated = buildInstanceSettings("/AppData", "Maxx", "/repo/one", false, true);
    const second = buildInstanceSettings("/AppData", "Maxx", "/repo/two", false, true);

    expect(Number(first.listenPort)).toBeGreaterThanOrEqual(40_000);
    expect(Number(first.listenPort)).toBeLessThan(49_000);
    expect(repeated.listenPort).toBe(first.listenPort);
    expect(first.userDataPath).toMatch(new RegExp(`^${path.join("/AppData", "Maxx-build-")}`));
    expect(second.userDataPath).not.toBe(first.userDataPath);
    expect(second.listenPort).not.toBe(first.listenPort);
  });

  it("keeps development data distinct from the packaged checkout build", () => {
    const development = buildInstanceSettings("/AppData", "Maxx", "/repo/maxx", true, false);
    const packaged = buildInstanceSettings("/AppData", "Maxx", "/repo/maxx", false, true);

    expect(development.userDataPath).not.toBe(packaged.userDataPath);
    expect(development.listenPort).not.toBe(packaged.listenPort);
  });
});
