import { describe, expect, it } from "vitest";
import { attachmentDestination, mediaDataUrl } from "./mediaUpload";

describe("host media locators", () => {
  it("addresses attachments by id rather than a peer filesystem path", () => {
    expect(attachmentDestination("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d")).toBe(
      "attachment:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    );
    expect(mediaDataUrl("image/png", "cG5nLWJ5dGVz")).toBe("data:image/png;base64,cG5nLWJ5dGVz");
    expect(attachmentDestination("abc")).not.toContain("/Users/");
  });
});
