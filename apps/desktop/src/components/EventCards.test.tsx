import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventKind, type ProviderRuntimeEvent } from "../contract/types";
import { ActivityCard } from "./EventCards";

function toolEvent(): ProviderRuntimeEvent {
  return {
    schemaVersion: 1,
    id: "event-1",
    providerInstanceID: "provider-1",
    threadID: "thread-1",
    turnID: "turn-1",
    itemID: "item-1",
    sequence: 1,
    occurredAt: 1,
    kind: EventKind.tool,
    payload: {
      title: "Read package.json",
      tool: {
        name: "read",
        input: "/Users/scott/Developer/maxx/package.json",
        output: "package contents",
        state: "completed",
      },
    },
  };
}

describe("ActivityCard", () => {
  it("renders tool activity as a collapsed disclosure row", () => {
    const markup = renderToStaticMarkup(
      <ActivityCard event={toolEvent()} threadID="thread-1" />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("lucide-chevron-right");
    expect(markup).toContain("read");
    expect(markup).toContain("Read package.json");
    expect(markup).not.toContain("package contents");
  });
});
