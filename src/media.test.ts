import { describe, expect, it } from "vitest";
import { parseMessageContent } from "./media";

describe("parseMessageContent", () => {
  it("renders Grok-style generated image links as media", () => {
    const segments = parseMessageContent(
      "Here it is:\n\n**[images/1.jpg](images/1.jpg)**\n\nDone.",
    );
    expect(segments).toEqual([
      { id: 0, kind: "markdown", text: "Here it is:" },
      {
        id: 1,
        kind: "media",
        media: { destination: "images/1.jpg", altText: "images/1.jpg", kind: "image" },
      },
      { id: 2, kind: "markdown", text: "Done." },
    ]);
  });

  it("supports image markdown and rich video or audio links", () => {
    const segments = parseMessageContent(
      "![preview](art/output.png)\n\n[clip](media/demo.mp4)\n\n[sound](audio/sample.mp3)",
    );
    expect(segments.filter((segment) => segment.kind === "media").map((segment) => segment.media.kind))
      .toEqual(["image", "video", "audio"]);
  });

  it("does not turn media-looking markdown inside a code fence into content", () => {
    const source = "```md\n[example](images/not-real.jpg)\n```";
    expect(parseMessageContent(source)).toEqual([{ id: 0, kind: "markdown", text: source }]);
  });

  it("leaves ordinary links in Streamdown", () => {
    const source = "Read [the docs](https://example.com/docs).";
    expect(parseMessageContent(source)).toEqual([{ id: 0, kind: "markdown", text: source }]);
  });
});
