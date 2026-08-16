import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_WIDTH,
  MAX_BROWSER_WIDTH,
  MIN_BROWSER_WIDTH,
  browserArtifactDataURL,
  clampBrowserWidth,
  loadBrowserWidth,
  maximumBrowserWidth,
  normalizeAddressInput,
  persistBrowserWidth,
  reorderBrowserTabs,
  shouldShowBrowserContent,
} from "./browser";

describe("browserArtifactDataURL", () => {
  it("turns trusted screenshot bytes into an image source", () => {
    expect(browserArtifactDataURL({
      id: "artifact",
      mimeType: "image/png",
      title: "Browser screenshot",
      dataBase64: "cG5n",
    })).toBe("data:image/png;base64,cG5n");
  });

  it("rejects non-image artifact content", () => {
    expect(() => browserArtifactDataURL({
      id: "artifact",
      mimeType: "text/html",
      dataBase64: "PGh0bWw+",
    })).toThrow("not an image");
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("normalizeAddressInput", () => {
  it("returns null for blank input", () => {
    expect(normalizeAddressInput("")).toBeNull();
    expect(normalizeAddressInput("   \n\t ")).toBeNull();
  });

  it("prepends https to a bare host", () => {
    expect(normalizeAddressInput("apple.com")).toBe("https://apple.com/");
    expect(normalizeAddressInput("  www.apple.com/mac  ")).toBe("https://www.apple.com/mac");
  });

  it("keeps an explicit web scheme", () => {
    expect(normalizeAddressInput("http://example.com/x?y=1")).toBe("http://example.com/x?y=1");
    expect(normalizeAddressInput("https://example.com")).toBe("https://example.com/");
  });

  it("treats localhost as a host even without a dot", () => {
    expect(normalizeAddressInput("localhost:1420")).toBe("https://localhost:1420/");
  });

  it("searches for input with spaces", () => {
    expect(normalizeAddressInput("swift concurrency")).toBe(
      "https://duckduckgo.com/?q=swift+concurrency",
    );
  });

  it("searches for a bare word with no dot", () => {
    expect(normalizeAddressInput("apple")).toBe("https://duckduckgo.com/?q=apple");
  });

  it("searches for non-web schemes instead of loading them", () => {
    expect(normalizeAddressInput("javascript://alert(1)")).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    expect(normalizeAddressInput("file:///etc/passwd")).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    expect(normalizeAddressInput("tauri://localhost")).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
  });
});

describe("shouldShowBrowserContent", () => {
  const base = {
    browserOpen: true,
    settingsOpen: false,
    agentsOpen: false,
    automationsOpen: false,
    searchOpen: false,
    renameOpen: false,
  };

  it("shows the native layer only while the pane is open and unobstructed", () => {
    expect(shouldShowBrowserContent(base)).toBe(true);
  });

  it("hides for a closed pane", () => {
    expect(shouldShowBrowserContent({ ...base, browserOpen: false })).toBe(false);
  });

  it("hides behind every full-window surface", () => {
    expect(shouldShowBrowserContent({ ...base, settingsOpen: true })).toBe(false);
    expect(shouldShowBrowserContent({ ...base, agentsOpen: true })).toBe(false);
    expect(shouldShowBrowserContent({ ...base, automationsOpen: true })).toBe(false);
    expect(shouldShowBrowserContent({ ...base, searchOpen: true })).toBe(false);
    expect(shouldShowBrowserContent({ ...base, renameOpen: true })).toBe(false);
  });
});

describe("width", () => {
  it("yields to the workspace and the sidebar", () => {
    // 1280 - 420 workspace - 250 sidebar, and still a real range above the
    // pane's own 360 minimum — the divider has somewhere to go.
    expect(maximumBrowserWidth(1280, 250)).toBe(610);
    expect(maximumBrowserWidth(1920, 250)).toBe(1140);
    expect(maximumBrowserWidth(900, 250)).toBe(MIN_BROWSER_WIDTH);
  });

  it("clamps into the supported range", () => {
    expect(clampBrowserWidth(2000, MAX_BROWSER_WIDTH)).toBe(1140);
    expect(clampBrowserWidth(10, MAX_BROWSER_WIDTH)).toBe(MIN_BROWSER_WIDTH);
    expect(clampBrowserWidth(584.4, MAX_BROWSER_WIDTH)).toBe(584);
  });

  it("round-trips through storage", () => {
    const storage = memoryStorage();
    expect(loadBrowserWidth(storage)).toBe(DEFAULT_BROWSER_WIDTH);
    persistBrowserWidth(430, storage);
    expect(loadBrowserWidth(storage)).toBe(430);
  });
});

describe("reorderBrowserTabs", () => {
  const tab = (id: string) => ({
    id,
    url: "about:blank",
    title: id,
    loading: false,
    selected: id === "b",
    controlEpoch: 0,
  });
  const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];

  it("moves a tab before the hovered tab", () => {
    expect(reorderBrowserTabs(tabs, "d", "b", "before").map(({ id }) => id))
      .toEqual(["a", "d", "b", "c"]);
  });

  it("moves a tab after the hovered tab", () => {
    expect(reorderBrowserTabs(tabs, "a", "c", "after").map(({ id }) => id))
      .toEqual(["b", "c", "a", "d"]);
  });

  it("keeps the current order for an invalid or self-targeted drag", () => {
    expect(reorderBrowserTabs(tabs, "b", "b", "before")).toBe(tabs);
    expect(reorderBrowserTabs(tabs, "missing", "b", "before")).toBe(tabs);
  });
});
