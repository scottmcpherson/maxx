import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import { Utf8StreamDecoder } from "./utf8Stream";

describe("Utf8StreamDecoder", () => {
  it("preserves multibyte characters split across socket chunks", () => {
    const decoder = new Utf8StreamDecoder();
    const message = '{"text":"captain’s home ⚓"}\n';
    const bytes = Buffer.from(message, "utf8");

    const decoded = [...bytes]
      .map((byte) => decoder.decode(Uint8Array.of(byte)))
      .join("");

    expect(decoded).toBe(message);
    expect(decoded).not.toContain("�");
  });
});
