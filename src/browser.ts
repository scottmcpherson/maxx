// Browser-pane logic and the typed direct-rendering contract. Electron owns
// pixels and Chromium lifecycle; Rust owns provider scope and control epochs.

import { MIN_WORKSPACE_WIDTH } from "./layout";

export const BROWSER_LABEL = "browser";
export const DEFAULT_BROWSER_TITLE = "Browser";

export const DEFAULT_BROWSER_WIDTH = 584;
export const MIN_BROWSER_WIDTH = 360;
export const MAX_BROWSER_WIDTH = 1140;

const SEARCH_ENDPOINT = "https://duckduckgo.com/";
const BROWSER_WIDTH_STORAGE_KEY = "maxx.browser.width";

interface BrowserStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function browserStorage(): BrowserStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Address normalization                                                       */
/* -------------------------------------------------------------------------- */

function isWebScheme(scheme: string): boolean {
  return scheme === "http:" || scheme === "https:";
}

function parseWebURL(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    if (!isWebScheme(url.protocol) || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A host is anything without whitespace whose authority is `localhost` or has a
 * plausible dotted suffix. Everything else reads as a search query.
 */
function looksLikeHost(value: string): boolean {
  if (/\s/.test(value)) return false;
  const authority = value.split(/[/?#]/, 1)[0] ?? value;
  const afterUserInfo = authority.slice(authority.lastIndexOf("@") + 1);
  const hostname = afterUserInfo.split(":", 1)[0] ?? afterUserInfo;
  if (!hostname) return false;
  if (hostname.toLowerCase() === "localhost") return true;
  const dot = hostname.lastIndexOf(".");
  if (dot <= 0 || dot === hostname.length - 1) return false;
  return /^[a-z0-9-]+$/i.test(hostname.slice(dot + 1));
}

function searchURL(query: string): string {
  const url = new URL(SEARCH_ENDPOINT);
  url.search = new URLSearchParams({ q: query }).toString();
  return url.toString();
}

/**
 * Resolves what the address field should load before the Rust boundary repeats
 * the absolute HTTP(S)-only validation.
 *
 * Bare hosts get `https://` (as `BrowserModel.loadAddress` did). Input with
 * whitespace, or without a recognisable host, becomes a web search — which is
 * what the Swift "Search or enter website" placeholder always implied. Non-web
 * schemes are searched for rather than loaded, so `javascript:`/`file:` cannot
 * be reached through the field. Blank input resolves to `null`.
 */
export function normalizeAddressInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const schemeSeparator = trimmed.indexOf("://");
  if (schemeSeparator > 0) {
    const scheme = `${trimmed.slice(0, schemeSeparator).toLowerCase()}:`;
    if (isWebScheme(scheme)) {
      const parsed = parseWebURL(trimmed);
      if (parsed) return parsed;
    }
    return searchURL(trimmed);
  }

  if (looksLikeHost(trimmed)) {
    const parsed = parseWebURL(`https://${trimmed}`);
    if (parsed) return parsed;
  }
  return searchURL(trimmed);
}

/* -------------------------------------------------------------------------- */
/* Navigation state                                                            */
/* -------------------------------------------------------------------------- */

export interface BrowserTabSummary {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  selected: boolean;
  controlEpoch: number;
  controllerSessionId?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  crashed?: boolean;
}

export type BrowserTabDropEdge = "before" | "after";

export function reorderBrowserTabs(
  tabs: BrowserTabSummary[],
  draggedTabId: string,
  targetTabId: string,
  edge: BrowserTabDropEdge,
): BrowserTabSummary[] {
  if (draggedTabId === targetTabId) return tabs;
  const draggedIndex = tabs.findIndex((tab) => tab.id === draggedTabId);
  if (draggedIndex < 0 || !tabs.some((tab) => tab.id === targetTabId)) return tabs;

  const next = tabs.slice();
  const [dragged] = next.splice(draggedIndex, 1);
  const targetIndex = next.findIndex((tab) => tab.id === targetTabId);
  next.splice(edge === "before" ? targetIndex : targetIndex + 1, 0, dragged);
  return next;
}

export interface BrowserUiReveal {
  threadId: string;
  tabId: string;
}

export interface BrowserArtifactContent {
  id: string;
  mimeType: string;
  title?: string;
  dataBase64: string;
}

export function browserArtifactDataURL(content: BrowserArtifactContent): string {
  if (!/^image\/[a-z0-9.+-]+$/i.test(content.mimeType)) {
    throw new Error("Browser artifact is not an image");
  }
  return `data:${content.mimeType};base64,${content.dataBase64}`;
}

export interface BrowserNativeState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed?: boolean;
}

export interface BrowserAnnotation {
  id: string;
  tabId: string;
  url: string;
  selector: string;
  tagName: string;
  role: string | null;
  name: string;
  text: string;
  instruction: string;
  previewDataUrl: string;
  rect: { x: number; y: number; width: number; height: number };
  createdAt: number;
}

export type BrowserAnnotationEvent = (BrowserAnnotation & { selected: boolean }) | { tabId: string; cancel: true };

export interface BrowserAnnotationSelection {
  selector: string;
  index: number;
  instruction: string;
}

export interface ChromeImportStatus {
  available: boolean;
  profiles: { id: string; name: string }[];
  importedAt: number | null;
  lastProfile: string | null;
  cookieCount: number;
  passwordCount: number;
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                  */
/* -------------------------------------------------------------------------- */

export interface BrowserVisibilityFlags {
  browserOpen: boolean;
  settingsOpen: boolean;
  agentsOpen: boolean;
  searchOpen: boolean;
  renameOpen: boolean;
}

/**
 * Full-window product surfaces temporarily reclaim the browser column.
 */
export function shouldShowBrowserContent(flags: BrowserVisibilityFlags): boolean {
  return flags.browserOpen
    && !flags.settingsOpen
    && !flags.agentsOpen
    && !flags.searchOpen
    && !flags.renameOpen;
}

/* -------------------------------------------------------------------------- */
/* Width                                                                       */
/* -------------------------------------------------------------------------- */

export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

/** The pane shrinks before the workspace does, and the sidebar keeps its width. */
export function maximumBrowserWidth(availableWidth: number, sidebarWidth: number): number {
  const layoutMaximum = availableWidth - MIN_WORKSPACE_WIDTH - Math.max(0, sidebarWidth);
  return Math.max(MIN_BROWSER_WIDTH, Math.min(MAX_BROWSER_WIDTH, layoutMaximum));
}

export function clampBrowserWidth(width: number, maxWidth: number): number {
  return clamp(Math.round(width), MIN_BROWSER_WIDTH, Math.max(MIN_BROWSER_WIDTH, maxWidth));
}

export function loadBrowserWidth(storage: BrowserStorage | undefined = browserStorage()): number {
  if (!storage) return DEFAULT_BROWSER_WIDTH;
  const stored = Number(storage.getItem(BROWSER_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : DEFAULT_BROWSER_WIDTH;
}

export function persistBrowserWidth(
  width: number,
  storage: BrowserStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(BROWSER_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Session-only width is fine when storage is unavailable.
  }
}
