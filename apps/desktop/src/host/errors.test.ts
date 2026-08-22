import { describe, expect, it } from "vitest";
import { hostErrorMessage, isHostConnectionError } from "./errors";

describe("host errors", () => {
  it("recognizes remote transport failures regardless of their wrapper", () => {
    expect(isHostConnectionError(
      new Error("Error invoking remote method 'maxx:invoke': Error: Environment mini is offline"),
    )).toBe(true);
    expect(isHostConnectionError("The remote Maxx disconnected")).toBe(true);
    expect(isHostConnectionError("Connection closed by peer")).toBe(true);
  });

  it("does not hide unrelated Git operation failures", () => {
    expect(isHostConnectionError("git push failed: non-fast-forward")).toBe(false);
  });

  it("normalizes nested Error prefixes for user-facing messages", () => {
    expect(hostErrorMessage(new Error("Error: Connection lost"))).toBe("Connection lost");
  });
});
