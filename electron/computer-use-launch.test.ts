import { describe, expect, it } from "vitest";
import { computerUseMcpArgs, computerUseServeArgs } from "./computer-use-launch.js";

describe("Computer Use launch authorization", () => {
  it("keeps the embedded daemon in standard mode without profile authority by default", () => {
    const args = computerUseServeArgs("/tmp/cua.sock", "com.maxx.original", false);
    expect(args).toEqual([
      "serve",
      "--embedded",
      "--socket",
      "/tmp/cua.sock",
      "--host-bundle-id",
      "com.maxx.original",
      "--permission-mode",
      "standard",
    ]);
    expect(args).not.toContain("--dangerously-bypass-approvals");
  });

  it("adds only Cua's explicit existing-profile grant when the user enables it", () => {
    const args = computerUseServeArgs("/tmp/cua.sock", "com.maxx.original", true);
    expect(args.slice(-2)).toEqual(["--grant", "existing-profile"]);
    expect(args).not.toContain("--dangerously-bypass-approvals");
  });

  it("connects MCP clients to the already-authorized embedded daemon", () => {
    expect(computerUseMcpArgs("/tmp/cua.sock", "com.maxx.original")).toEqual([
      "mcp",
      "--embedded",
      "--socket",
      "/tmp/cua.sock",
      "--host-bundle-id",
      "com.maxx.original",
    ]);
  });
});
