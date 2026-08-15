import type { ChatTextSelection } from "./contract/types";

export type SidePanelTab =
  | { id: string; type: "browser" }
  | { id: string; type: "terminal"; title: string }
  | { id: string; type: "side-chat"; title: string; pendingSelections: ChatTextSelection[] };

export interface SidePanelTabState {
  tabs: SidePanelTab[];
  selectedTabID: string | null;
}

interface SidePanelStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const STORAGE_PREFIX = "maxx.side-panel.tabs.";

function defaultStorage(): SidePanelStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isTab(value: unknown): value is SidePanelTab {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SidePanelTab>;
  if (typeof candidate.id !== "string" || !candidate.id) return false;
  if (candidate.type === "browser") return true;
  if (candidate.type === "terminal") {
    return typeof (candidate as { title?: unknown }).title === "string"
      && Boolean((candidate as { title: string }).title);
  }
  if (candidate.type !== "side-chat") return false;
  const sideChat = candidate as { title?: unknown; pendingSelections?: unknown };
  return typeof sideChat.title === "string"
    && Boolean(sideChat.title)
    && Array.isArray(sideChat.pendingSelections)
    && sideChat.pendingSelections.every((selection) => Boolean(selection)
      && typeof selection === "object"
      && typeof (selection as { id?: unknown }).id === "string"
      && typeof (selection as { text?: unknown }).text === "string");
}

export function loadSidePanelTabState(
  threadID: string,
  storage: SidePanelStorage | undefined = defaultStorage(),
): SidePanelTabState {
  if (!storage) return { tabs: [], selectedTabID: null };
  try {
    const parsed = JSON.parse(storage.getItem(`${STORAGE_PREFIX}${threadID}`) ?? "null") as {
      version?: unknown;
      tabs?: unknown;
      selectedTabID?: unknown;
    } | null;
    if (parsed?.version !== 1) return { tabs: [], selectedTabID: null };
    const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs.filter(isTab) : [];
    const uniqueTabs = tabs.filter((tab, index) => tabs.findIndex((candidate) => candidate.id === tab.id) === index);
    const selectedTabID = typeof parsed?.selectedTabID === "string"
      && uniqueTabs.some((tab) => tab.id === parsed.selectedTabID)
      ? parsed.selectedTabID
      : uniqueTabs[0]?.id ?? null;
    return { tabs: uniqueTabs, selectedTabID };
  } catch {
    return { tabs: [], selectedTabID: null };
  }
}

export function persistSidePanelTabState(
  threadID: string,
  state: SidePanelTabState,
  storage: SidePanelStorage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(`${STORAGE_PREFIX}${threadID}`, JSON.stringify({ version: 1, ...state }));
  } catch {
    // A live in-memory panel is still usable when storage is unavailable.
  }
}

export function reconcileSidePanelTabs(
  state: SidePanelTabState,
  browserTabIDs: string[],
  sideChatThreadIDs: string[],
  selectedBrowserTabID?: string | null,
): SidePanelTabState {
  const browserIDs = new Set(browserTabIDs);
  const sideChatIDs = new Set(sideChatThreadIDs);
  const tabs = state.tabs.filter((tab) => tab.type === "terminal"
    || (tab.type === "browser" ? browserIDs.has(tab.id) : sideChatIDs.has(tab.id)));
  const represented = new Set(tabs.map((tab) => tab.id));
  for (const id of browserTabIDs) {
    if (!represented.has(id)) tabs.push({ id, type: "browser" });
  }
  for (const id of sideChatThreadIDs) {
    if (!represented.has(id)) tabs.push({ id, type: "side-chat", title: "Side chat", pendingSelections: [] });
  }
  const selectedTabID = state.selectedTabID && tabs.some((tab) => tab.id === state.selectedTabID)
    ? state.selectedTabID
    : selectedBrowserTabID && tabs.some((tab) => tab.id === selectedBrowserTabID)
      ? selectedBrowserTabID
      : tabs[0]?.id ?? null;
  return { tabs, selectedTabID };
}

export function reorderSidePanelTabs(
  tabs: SidePanelTab[],
  draggedTabID: string,
  targetTabID: string,
  edge: "before" | "after",
): SidePanelTab[] {
  if (draggedTabID === targetTabID) return tabs;
  const draggedIndex = tabs.findIndex((tab) => tab.id === draggedTabID);
  if (draggedIndex < 0 || !tabs.some((tab) => tab.id === targetTabID)) return tabs;
  const next = tabs.slice();
  const [dragged] = next.splice(draggedIndex, 1);
  const targetIndex = next.findIndex((tab) => tab.id === targetTabID);
  next.splice(edge === "before" ? targetIndex : targetIndex + 1, 0, dragged);
  return next;
}
