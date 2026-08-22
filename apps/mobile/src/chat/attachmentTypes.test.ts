import { describe, expect, it } from "vitest";
import { attachmentMimeType, canPreviewAsNativeImage, clipboardImageBase64 } from "./attachmentTypes";

describe("mobile attachment types", () => {
  it.each([
    ["notes.md", "text/markdown"],
    ["archive.zip", "application/zip"],
    ["document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["drawing.svg", "image/svg+xml"],
    ["photo.heic", "image/heic"],
    ["photo.avif", "image/avif"],
    ["voice.m4a", "audio/mp4"],
    ["movie.mov", "video/quicktime"],
  ])("maps %s to %s", (name, expected) => {
    expect(attachmentMimeType(name)).toBe(expected);
  });

  it("prefers a known extension over a generic provider MIME type", () => {
    expect(attachmentMimeType("recording.m4a", "application/octet-stream")).toBe("audio/mp4");
  });

  it("preserves a reported MIME type when the extension is unknown", () => {
    expect(attachmentMimeType("recording", "audio/mpeg")).toBe("audio/mpeg");
  });

  it("only sends reliably supported React Native image formats to Image", () => {
    expect(canPreviewAsNativeImage("image/png")).toBe(true);
    expect(canPreviewAsNativeImage("image/svg+xml")).toBe(false);
    expect(canPreviewAsNativeImage("image/heic")).toBe(false);
    expect(canPreviewAsNativeImage("image/avif")).toBe(false);
  });

  it("extracts image bytes from Expo clipboard data URIs", () => {
    expect(clipboardImageBase64("data:image/png;base64,cG5n")).toBe("cG5n");
    expect(() => clipboardImageBase64("not-an-image")).toThrow("clipboard image could not be read");
  });
});
