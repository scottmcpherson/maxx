import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SlashCommandItem } from "../slashCommands";
import {
  keepOptionVisible,
  SlashCommandMenu,
  type SlashCommandMenuState,
} from "./SlashCommandMenu";

const candidates: SlashCommandItem[] = Array.from({ length: 8 }, (_, index) => ({
  id: `command-${index}`,
  name: `command-${index}`,
  invocation: `/command-${index}`,
  displayName: `Command ${index}`,
  description: `Description ${index}`,
  kind: "command",
  source: "test",
  provider: "codex",
}));

function menu(overrides: Partial<SlashCommandMenuState> = {}): SlashCommandMenuState {
  return {
    open: true,
    loading: false,
    error: null,
    candidates,
    activeIndex: 0,
    provider: "codex",
    refresh: vi.fn(),
    retry: vi.fn(),
    activate: vi.fn(),
    complete: vi.fn(),
    onKeyDown: vi.fn(() => false),
    dismiss: vi.fn(),
    ...overrides,
  };
}

describe("SlashCommandMenu", () => {
  it("renders a tall, independently scrolling command list", () => {
    const markup = renderToStaticMarkup(<SlashCommandMenu menu={menu()} />);

    expect(markup).toContain("h-auto!");
    expect(markup).toContain("max-h-96");
    expect(markup).toContain("max-h-80");
    expect(markup).toContain("overscroll-contain");
    expect(markup.match(/data-slot="command-item"/g)).toHaveLength(8);
    expect(markup.match(/data-command-index=/g)).toHaveLength(8);
    expect(markup).toContain("hover:bg-muted");
  });

  it("scrolls only the list viewport to reveal an option below it", () => {
    const list = {
      scrollTop: 40,
      getBoundingClientRect: () => ({ top: 100, bottom: 300 }),
    } as HTMLElement;
    const selected = {
      getBoundingClientRect: () => ({ top: 310, bottom: 350 }),
    } as HTMLElement;

    keepOptionVisible(list, selected);

    expect(list.scrollTop).toBe(90);
  });

  it("does not move the list when the selected option is already visible", () => {
    const list = {
      scrollTop: 40,
      getBoundingClientRect: () => ({ top: 100, bottom: 300 }),
    } as HTMLElement;
    const selected = {
      getBoundingClientRect: () => ({ top: 140, bottom: 180 }),
    } as HTMLElement;

    keepOptionVisible(list, selected);

    expect(list.scrollTop).toBe(40);
  });
});
