import { describe, expect, it } from "vitest";
import {
  attachmentKind,
  attachmentMimeType,
  SUPPORTED_ATTACHMENT_EXTENSIONS,
} from "./attachmentFormats";

describe("attachment formats", () => {
  it("recognizes every requested document and archive type", () => {
    expect(attachmentMimeType("brief.pdf")).toBe("application/pdf");
    expect(attachmentMimeType("brief.docx")).toContain("wordprocessingml");
    expect(attachmentMimeType("budget.xlsx")).toContain("spreadsheetml");
    expect(attachmentMimeType("notes.txt")).toBe("text/plain");
    expect(attachmentMimeType("notes.markdown")).toBe("text/markdown");
    expect(attachmentMimeType("rows.csv")).toBe("text/csv");
    expect(attachmentMimeType("data.json")).toBe("application/json");
    expect(attachmentMimeType("bundle.zip")).toBe("application/zip");
  });

  it("recognizes extended image, audio, and video formats", () => {
    expect(attachmentMimeType("drawing.svg")).toBe("image/svg+xml");
    expect(attachmentMimeType("photo.heic")).toBe("image/heic");
    expect(attachmentMimeType("photo.avif")).toBe("image/avif");
    expect(attachmentKind(attachmentMimeType("voice.m4a")!)).toBe("audio");
    expect(attachmentKind(attachmentMimeType("clip.mov")!)).toBe("video");
    expect(SUPPORTED_ATTACHMENT_EXTENSIONS).toContain("webm");
  });

  it("rejects unknown file types even when the browser reports a generic mime", () => {
    expect(attachmentMimeType("payload.exe", "application/octet-stream")).toBeNull();
  });
});
