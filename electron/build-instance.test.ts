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

  it("isolates each checkout build and requests a dynamic listener port", () => {
    const first = buildInstanceSettings("/AppData", "Maxx", "/repo/one", false, true);
    const second = buildInstanceSettings("/AppData", "Maxx", "/repo/two", false, true);

    expect(first.listenPort).toBe("0");
    expect(first.userDataPath).toMatch(new RegExp(`^${path.join("/AppData", "Maxx-build-")}`));
    expect(second.userDataPath).not.toBe(first.userDataPath);
  });

  it("keeps development data distinct from the packaged checkout build", () => {
    const development = buildInstanceSettings("/AppData", "Maxx", "/repo/maxx", true, false);
    const packaged = buildInstanceSettings("/AppData", "Maxx", "/repo/maxx", false, true);

    expect(development.userDataPath).not.toBe(packaged.userDataPath);
    expect(development.listenPort).toBe("0");
  });
});
