import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimelineDisclosure } from "./TimelineDisclosure";

describe("TimelineDisclosure", () => {
  it("renders a collapsed button with a left chevron", () => {
    const markup = renderToStaticMarkup(
      <TimelineDisclosure summary="Thought briefly">
        <p>Private reasoning</p>
      </TimelineDisclosure>,
    );

    expect(markup).toContain("Thought briefly");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-slot="collapsible-trigger"');
    expect(markup).toContain("lucide-chevron-right");
    expect(markup).not.toContain("Private reasoning");
  });
});
