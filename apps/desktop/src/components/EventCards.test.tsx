import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventKind, type ProviderRuntimeEvent } from "../contract/types";
import { ActivityCard, InteractionCard } from "./EventCards";

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

describe("InteractionCard", () => {
  it("places rejection actions before session and one-time approvals", () => {
    const event: ProviderRuntimeEvent = {
      ...toolEvent(),
      kind: EventKind.approvalRequest,
      payload: {
        approval: {
          kind: "command",
          title: "Run command?",
          paths: [],
          options: [
            { id: "once", title: "Allow once", kind: "approve", isPersistent: false },
            { id: "session", title: "Always allow", kind: "approveForSession", isPersistent: true },
            { id: "deny", title: "Deny", kind: "deny", isPersistent: false },
            { id: "cancel", title: "Cancel turn", kind: "cancel", isPersistent: false },
          ],
        },
      },
    };

    const markup = renderToStaticMarkup(
      <InteractionCard event={event} resolved={null} onResolve={() => undefined} />,
    );

    expect(markup.indexOf("Cancel turn")).toBeLessThan(markup.indexOf("Deny"));
    expect(markup.indexOf("Deny")).toBeLessThan(markup.indexOf("Always allow"));
    expect(markup.indexOf("Always allow")).toBeLessThan(markup.indexOf("Allow once"));
    expect(markup).toContain("justify-end");
  });
});
