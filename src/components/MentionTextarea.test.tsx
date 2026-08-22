import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MentionTextarea } from "./MentionTextarea";

describe("MentionTextarea", () => {
  it("uses identical text metrics for the visible mirror and caret textarea", () => {
    const markup = renderToStaticMarkup(
      <MentionTextarea agents={[]} value="Thi" readOnly />,
    );

    const mirrorClasses = markup.match(/<div class="([^"]+)" aria-hidden="true"/)?.[1].split(" ");
    const textareaClasses = markup.match(/<textarea[^>]+class="([^"]+)"/)?.[1].split(" ");
    const textMetrics = ["px-0.5", "pt-0.5", "pb-1.5", "text-sm", "leading-normal"];

    expect(mirrorClasses).toEqual(expect.arrayContaining(textMetrics));
    expect(textareaClasses).toEqual(expect.arrayContaining(textMetrics));
    expect(textareaClasses).not.toContain("py-2");
  });
});
