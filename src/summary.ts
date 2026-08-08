// Pinned-summary logic: whether the thread summary can sit inline as a rail,
// and what the header's toggle does when it cannot.
//
// The summary is a *pin*, not a pane. The user's pin survives a window that got
// too narrow to seat it (Codex's "Toggle pinned summary" behaves the same way):
// the rail stands down on its own, and the same button then reaches the summary
// as a popover instead of silently doing nothing.

/** Laid-out width of `.context-rail`. Kept in sync with `styles.css`. */
export const PINNED_SUMMARY_WIDTH = 238;

/**
 * Transcript width the rail refuses to eat into.
 *
 * Deliberately wider than `MIN_WORKSPACE_WIDTH` (420), which is the floor a
 * *divider drag* may not cross — a hard limit the user opts into by dragging.
 * The rail takes its space unasked, so it holds itself to a comfortable reading
 * column instead: with the sidebar at its default 250, this hides the rail at
 * roughly a 1048pt window, which is where the pre-toggle CSS breakpoint
 * (`max-width: 1050px`) used to drop it.
 */
export const SUMMARY_WORKSPACE_FLOOR = 560;

const SUMMARY_PINNED_STORAGE_KEY = "maxx.summary.pinned";

interface SummaryStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function summaryStorage(): SummaryStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export interface SummaryFitMetrics {
  /** `layoutWidth()` — the shell's own box, not the viewport (zoom scales it). */
  layoutWidth: number;
  /** Live sidebar width, or 0 when collapsed. */
  sidebarWidth: number;
  /** Live browser-pane width, or 0 when closed. */
  browserWidth: number;
}

/**
 * Whether the rail can be seated without pushing the transcript below
 * [`SUMMARY_WORKSPACE_FLOOR`].
 *
 * The rail is the pane that yields — the sidebar and the browser both keep
 * their widths — so this is the last claim on the row and gets whatever is
 * left over.
 */
export function canFitPinnedSummary(metrics: SummaryFitMetrics): boolean {
  const leftover = metrics.layoutWidth
    - Math.max(0, metrics.sidebarWidth)
    - Math.max(0, metrics.browserWidth)
    - SUMMARY_WORKSPACE_FLOOR;
  return leftover >= PINNED_SUMMARY_WIDTH;
}

export interface SummaryToggleState {
  /** The user's pin. Persisted, and unaffected by the window being narrow. */
  pinned: boolean;
  /** Result of [`canFitPinnedSummary`], plus anything else occupying the slot. */
  fits: boolean;
  popoverOpen: boolean;
}

export type SummaryToggleAction = "pin" | "unpin" | "openPopover" | "closePopover";

/**
 * What the header button does on click.
 *
 * With room, it is a plain pin toggle. Without room, pinning would show
 * nothing, so the click reaches the same content as a popover and leaves the
 * pin alone — which is what makes the pin survive a resize round trip.
 */
export function summaryToggleAction(state: SummaryToggleState): SummaryToggleAction {
  if (!state.fits) return state.popoverOpen ? "closePopover" : "openPopover";
  return state.pinned ? "unpin" : "pin";
}

/** The rail is inline only when the user asked for it *and* it has room. */
export function showsPinnedSummary(state: Pick<SummaryToggleState, "pinned" | "fits">): boolean {
  return state.pinned && state.fits;
}

/**
 * Whether the toggle reads as active: either the rail is up, or the popover
 * standing in for it is.
 */
export function summaryToggleActive(state: SummaryToggleState): boolean {
  return showsPinnedSummary(state) || state.popoverOpen;
}

/** Pinned by default, matching the pre-toggle behaviour of the context rail. */
export function loadSummaryPinned(storage: SummaryStorage | undefined = summaryStorage()): boolean {
  if (!storage) return true;
  return storage.getItem(SUMMARY_PINNED_STORAGE_KEY) !== "false";
}

export function persistSummaryPinned(
  pinned: boolean,
  storage: SummaryStorage | undefined = summaryStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SUMMARY_PINNED_STORAGE_KEY, String(pinned));
  } catch {
    // Session-only pinning is fine when storage is unavailable.
  }
}
