import { useCallback, useEffect, useRef, useState } from "react";
import { shouldShowBrowserContent, MIN_BROWSER_WIDTH } from "./browser";
import { AgentsView } from "./components/AgentsView";
import { SidePanel } from "./components/SidePanel";
import { BrowserResizer, useBrowserWidth } from "./components/BrowserResizer";
import { Sidebar } from "./components/Sidebar";
import { SidebarResizer, useSidebarWidth } from "./components/SidebarResizer";
import { SidebarToggle } from "./components/SidebarToggle";
import { ThreadView } from "./components/ThreadView";
import { SettingsPanel } from "./components/SettingsPanel";
import { SearchPalette } from "./components/SearchPalette";
import { RenameThreadDialog } from "./components/RenameThreadDialog";
import { ZoomControls, type ZoomControlsHandle } from "./components/ZoomControls";
import { matchesKeyboardShortcut } from "./keyboardShortcuts";
import { useLayoutWidth } from "./layout";
import { canFitPinnedSummary } from "./summary";
import { isNativeMenuShortcut, menuAcceleratorFor } from "./menu";
import { UpdateToast } from "./components/UpdateToast";
import { HostDisconnectNotice } from "./components/HostDisconnectNotice";
import { ipc } from "./ipc";
import { useAppStore } from "./store/appStore";

/** Cmd+= / Cmd++ / Cmd+- / Cmd+0 (and Ctrl on non-mac layouts). */
function isZoomModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function isZoomInKey(event: KeyboardEvent): boolean {
  // "=" is the unshifted key on US keyboards; "+" arrives with Shift.
  return event.key === "=" || event.key === "+" || event.code === "Equal" || event.code === "NumpadAdd";
}

function isZoomOutKey(event: KeyboardEvent): boolean {
  return event.key === "-" || event.key === "_" || event.code === "Minus" || event.code === "NumpadSubtract";
}

function isZoomResetKey(event: KeyboardEvent): boolean {
  return event.key === "0" || event.code === "Digit0" || event.code === "Numpad0";
}

const BROWSER_TRANSITION_FALLBACK_MS = 300;

export default function App() {
  const bootstrap = useAppStore((s) => s.bootstrap);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const agentsOpen = useAppStore((s) => s.agentsOpen);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const renameOpen = useAppStore((s) => s.renamingThread !== null);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const browserOpen = useAppStore((s) => s.browserOpen);
  const selectedThreadID = useAppStore((s) => s.selectedThreadID);
  // Keep the React surface mounted through its slide transition. Chromium tabs
  // themselves live in the Rust broker and survive this component unmounting.
  const [browserPresent, setBrowserPresent] = useState(browserOpen);
  const [browserThreadID, setBrowserThreadID] = useState<string | null>(
    browserOpen ? selectedThreadID : null,
  );
  const [browserAnimating, setBrowserAnimating] = useState(false);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const previousBrowserOpen = useRef(browserOpen);
  const toggleSidebarShortcut = useAppStore((s) => s.keyboardShortcuts.toggleSidebar);
  const toggleBrowserShortcut = useAppStore((s) => s.keyboardShortcuts.toggleBrowser);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleBrowser = useAppStore((s) => s.toggleBrowser);
  const toggleAttentionFilter = useAppStore((s) => s.toggleAttentionFilter);
  const {
    width: sidebarWidth,
    maxWidth: sidebarMaxWidth,
    commitWidth,
  } = useSidebarWidth(browserOpen ? MIN_BROWSER_WIDTH : 0);
  const {
    width: browserWidth,
    maxWidth: browserMaxWidth,
    commitWidth: commitBrowserWidth,
  } = useBrowserWidth(sidebarOpen ? sidebarWidth : 0);
  // Full-window product surfaces temporarily reclaim the browser column.
  const browserUnobscured = shouldShowBrowserContent({
    browserOpen: true,
    settingsOpen,
    agentsOpen,
    searchOpen,
    renameOpen,
  });
  const browserExpandedActive = browserExpanded && browserOpen && browserUnobscured;
  const browserVisible = browserPresent && browserUnobscured;
  // The summary rail is the last claim on the row, so it is measured here where
  // both pane widths are already known. `browserPresent`, not `browserVisible`:
  // an obscured or closing pane still holds its slot in the layout.
  const shellWidth = useLayoutWidth();
  const summaryFits = canFitPinnedSummary({
    layoutWidth: shellWidth,
    sidebarWidth: sidebarOpen ? sidebarWidth : 0,
    browserWidth: browserPresent ? browserWidth : 0,
  });
  const zoomRef = useRef<ZoomControlsHandle | null>(null);
  const onZoomReady = useCallback((handle: ZoomControlsHandle) => {
    zoomRef.current = handle;
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!browserOpen || !browserUnobscured) setBrowserExpanded(false);
  }, [browserOpen, browserUnobscured]);

  useEffect(() => {
    if (previousBrowserOpen.current === browserOpen) return;
    previousBrowserOpen.current = browserOpen;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setBrowserPresent(browserOpen);
      setBrowserThreadID(browserOpen ? selectedThreadID : null);
      setBrowserAnimating(false);
      return;
    }

    if (browserOpen) {
      setBrowserThreadID(selectedThreadID);
      setBrowserPresent(true);
    }
    setBrowserAnimating(true);

    // `transitionend` is the normal completion path. This also covers an
    // interrupted transition (for example, an overlay making the shell
    // display:none before the browser finishes closing).
    const fallback = window.setTimeout(() => {
      setBrowserAnimating(false);
      if (!browserOpen) {
        setBrowserPresent(false);
        setBrowserThreadID(null);
      }
    }, BROWSER_TRANSITION_FALLBACK_MS);
    return () => window.clearTimeout(fallback);
  }, [browserOpen, selectedThreadID]);

  const finishBrowserTransition = useCallback(() => {
    setBrowserAnimating(false);
    if (!browserOpen) {
      setBrowserPresent(false);
      setBrowserThreadID(null);
    }
  }, [browserOpen]);

  // Give the two remappable View items the user's binding as a real menu key
  // equivalent. AppKit matches those before any webview sees the event, which
  // is what keeps these shortcuts alive while the browser pane's child webview
  // holds first responder — the `keydown` handler below only ever runs when the
  // app's own webview is focused, and is the fallback for a binding muda has no
  // accelerator for.
  useEffect(() => {
    void ipc
      .setShortcutAccelerators(
        menuAcceleratorFor(toggleSidebarShortcut),
        menuAcceleratorFor(toggleBrowserShortcut),
      )
      .catch(() => {
        // Without the accelerator the keydown handler still covers the common
        // case; nothing here is worth interrupting the user for.
      });
  }, [toggleBrowserShortcut, toggleSidebarShortcut]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      // Defer to the native menu for every combination it binds as an
      // accelerator (see src/menu.ts). AppKit already consumes those before the
      // webview sees them; returning here makes that ownership explicit instead
      // of leaving two live handlers for one key.
      if (isNativeMenuShortcut(event)) return;

      // Zoom works even while settings/search are open (same as browser zoom).
      if (isZoomModifier(event) && !event.altKey) {
        if (isZoomInKey(event)) {
          event.preventDefault();
          if (!event.repeat) zoomRef.current?.zoomIn();
          return;
        }
        if (isZoomOutKey(event)) {
          event.preventDefault();
          if (!event.repeat) zoomRef.current?.zoomOut();
          return;
        }
        if (isZoomResetKey(event)) {
          event.preventDefault();
          if (!event.repeat) zoomRef.current?.reset();
          return;
        }
      }

      // Fixed ⌥⌘U (Codex parity). Matched on `event.code`: Option+U is a
      // dead key on macOS layouts, so `event.key` never reports "u".
      if (
        !event.repeat
        && !settingsOpen
        && !searchOpen
        && !renameOpen
        && event.metaKey
        && event.altKey
        && !event.ctrlKey
        && !event.shiftKey
        && event.code === "KeyU"
      ) {
        event.preventDefault();
        toggleAttentionFilter();
        return;
      }
      if (
        !event.repeat
        && !settingsOpen
        && !searchOpen
        && !renameOpen
        && matchesKeyboardShortcut(event, toggleSidebarShortcut)
      ) {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (
        !event.repeat
        && !settingsOpen
        && !searchOpen
        && !renameOpen
        && matchesKeyboardShortcut(event, toggleBrowserShortcut)
      ) {
        event.preventDefault();
        toggleBrowser();
        return;
      }
      // ⌘N / ⌘K / ⌘, are not handled here at all: the File and application
      // submenus bind them, so the menu event is their only trigger.
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    renameOpen,
    searchOpen,
    settingsOpen,
    toggleAttentionFilter,
    toggleBrowser,
    toggleBrowserShortcut,
    toggleSidebar,
    toggleSidebarShortcut,
  ]);

  // Native menu + tray activations. Every branch calls the same store action
  // the in-app affordance calls; nothing is reimplemented here.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void ipc
      .onMenuAction((id) => {
        const state = useAppStore.getState();
        switch (id) {
          case "settings":
            state.setSettingsOpen(!state.settingsOpen);
            break;
          case "new_thread":
            state.startNewThread();
            break;
          case "search":
            state.setSearchOpen(!state.searchOpen);
            break;
          case "toggle_sidebar":
            state.toggleSidebar();
            break;
          case "toggle_browser":
            state.toggleBrowser();
            break;
          case "zoom_in":
            zoomRef.current?.zoomIn();
            break;
          case "zoom_out":
            zoomRef.current?.zoomOut();
            break;
          case "zoom_reset":
            zoomRef.current?.reset();
            break;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="zoom-viewport">
      {/*
        Scaled surface: laid out smaller (100%/scale) then transform-scaled up so
        the whole shell — including the right context rail — still fits the window.
      */}
      <div className="zoom-surface">
        <div className={`app-shell${browserExpandedActive ? " is-browser-expanded" : ""}`}>
          {/* Outside every pane: it has to stay put while the sidebar slides.
              Each underlying titlebar owns a matching no-drag cutout so native
              hit testing reaches this stationary control. */}
          <div className="window-sidebar-toggle-region">
            <SidebarToggle />
          </div>
          <div
            className={`sidebar-shell ${sidebarOpen ? "is-open" : "is-closed"}`}
            aria-hidden={!sidebarOpen}
            inert={!sidebarOpen}
          >
            <Sidebar />
          </div>
          <SidebarResizer
            width={sidebarWidth}
            maxWidth={sidebarMaxWidth}
            commitWidth={commitWidth}
            hidden={!sidebarOpen}
          />
          {agentsOpen ? (
            <AgentsView />
          ) : (
            <ThreadView summaryFits={summaryFits} browserExpanded={browserExpandedActive} />
          )}
          {browserUnobscured && !browserExpandedActive && (
            <BrowserResizer
              width={browserWidth}
              maxWidth={browserMaxWidth}
              commitWidth={commitBrowserWidth}
              hidden={!browserOpen}
            />
          )}
          <div
            className={`browser-shell ${browserOpen ? "is-open" : "is-closed"}${browserUnobscured ? "" : " is-obscured"}${browserExpandedActive ? " is-expanded" : ""}`}
            aria-hidden={!browserOpen || !browserUnobscured}
            inert={!browserOpen || !browserUnobscured}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && event.propertyName === "width") {
                finishBrowserTransition();
              }
            }}
          >
            {/* Closing keeps the native webview alive until the shell reaches
                zero width. Overlays hide it without tearing down the page. */}
            {browserPresent && browserThreadID && (
              <SidePanel
                key={browserThreadID}
                threadID={browserThreadID}
                showContent={browserVisible}
                animating={browserAnimating}
                expanded={browserExpandedActive}
                onToggleExpanded={() => setBrowserExpanded((current) => !current)}
              />
            )}
          </div>
          {settingsOpen && <SettingsPanel />}
          {searchOpen && <SearchPalette />}
          {renameOpen && <RenameThreadDialog />}
        </div>
      </div>
      {/* HUD stays outside the scaled surface so fixed positioning tracks the real window. */}
      <ZoomControls onReady={onZoomReady} />
      <HostDisconnectNotice />
      <UpdateToast />
    </div>
  );
}
