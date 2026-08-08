import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import {
  DEFAULT_BROWSER_TITLE,
  normalizeAddressInput,
  type BrowserHumanInput,
  type BrowserRenderedFrame,
  type BrowserTabSummary,
} from "../browser";
import { ipc } from "../ipc";
import { useAppStore } from "../store/appStore";
import { beginWindowDrag } from "../windowDrag";
import { Icons } from "./Icons";

function buttonName(button: number): string {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return "left";
}

function modifiersFor(event: KeyboardEvent<HTMLDivElement>): number {
  return (event.altKey ? 1 : 0)
    | (event.ctrlKey ? 2 : 0)
    | (event.metaKey ? 4 : 0)
    | (event.shiftKey ? 8 : 0);
}

export function BrowserPane({
  threadID,
  showContent,
}: {
  threadID: string;
  showContent: boolean;
  animating: boolean;
}) {
  const setBrowserOpen = useAppStore((state) => state.setBrowserOpen);
  const pendingBrowserReveal = useAppStore((state) => state.pendingBrowserReveal);
  const consumeBrowserReveal = useAppStore((state) => state.consumeBrowserReveal);
  const [tabs, setTabs] = useState<BrowserTabSummary[]>([]);
  const [selectedTabID, setSelectedTabID] = useState<string | null>(null);
  const [browserFrame, setBrowserFrame] = useState<BrowserRenderedFrame | null>(null);
  const [draft, setDraft] = useState("");
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<string | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ x: number; y: number; buttons: number } | null>(null);

  useEffect(() => () => {
    if (moveFrameRef.current !== null) cancelAnimationFrame(moveFrameRef.current);
    moveFrameRef.current = null;
    pendingMoveRef.current = null;
  }, []);

  useEffect(() => {
    selectedRef.current = selectedTabID;
  }, [selectedTabID]);

  const refreshTabs = useCallback(async () => {
    const next = await ipc.browserUiTabs(threadID);
    setTabs(next);
    const brokerSelected = next.find((tab) => tab.selected)?.id;
    const current = selectedRef.current;
    const resolved = brokerSelected ?? (current && next.some((tab) => tab.id === current) ? current : next[0]?.id);
    setSelectedTabID(resolved ?? null);
    return next;
  }, [threadID]);

  const openTab = useCallback(async (url: string | null = null) => {
    const tabID = await ipc.browserUiOpenTab(threadID, url);
    selectedRef.current = tabID;
    setSelectedTabID(tabID);
    setBrowserFrame(null);
    await refreshTabs();
  }, [refreshTabs, threadID]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await refreshTabs();
        if (!cancelled && existing.length === 0) await openTab();
      } catch (error) {
        if (!cancelled) setSurfaceError(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openTab, refreshTabs]);

  useEffect(() => {
    if (!pendingBrowserReveal || pendingBrowserReveal.threadId !== threadID) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await refreshTabs();
        if (cancelled) return;
        if (next.some((tab) => tab.id === pendingBrowserReveal.tabId)) {
          selectedRef.current = pendingBrowserReveal.tabId;
          setSelectedTabID(pendingBrowserReveal.tabId);
          setBrowserFrame(null);
        }
      } catch (error) {
        if (!cancelled) setSurfaceError(String(error));
      } finally {
        if (!cancelled) consumeBrowserReveal(pendingBrowserReveal.tabId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [consumeBrowserReveal, pendingBrowserReveal, refreshTabs, threadID]);

  useEffect(() => {
    if (!showContent || !selectedTabID) return;
    let cancelled = false;
    let streamID: string | null = null;
    let unlisten: (() => void) | null = null;
    let receivedFrameEvent = false;
    const applyFrame = (next: BrowserRenderedFrame) => {
      setBrowserFrame(next);
      setSurfaceError(null);
      setTabs((current) => current.map((tab) => tab.id === selectedTabID
        ? { ...tab, url: next.url, title: next.title, loading: next.loading }
        : tab));
    };
    void (async () => {
      try {
        unlisten = await ipc.onBrowserFrame((next) => {
          if (cancelled || next.tabId !== selectedTabID || selectedRef.current !== selectedTabID) return;
          receivedFrameEvent = true;
          applyFrame(next);
        });
        if (cancelled) {
          unlisten();
          unlisten = null;
          return;
        }
        const subscription = await ipc.browserUiStartFrameStream(selectedTabID);
        streamID = subscription.streamId;
        if (cancelled) {
          await ipc.browserUiStopFrameStream(selectedTabID, streamID);
          streamID = null;
        } else if (!receivedFrameEvent) {
          applyFrame(subscription.initialFrame);
        }
      } catch (error) {
        if (!cancelled) setSurfaceError(String(error));
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (streamID) void ipc.browserUiStopFrameStream(selectedTabID, streamID);
    };
  }, [selectedTabID, showContent]);

  useEffect(() => {
    const url = browserFrame?.url ?? "";
    if (document.activeElement !== inputRef.current) setDraft(url === "about:blank" ? "" : url);
  }, [browserFrame?.url]);

  const selectedTab = tabs.find((tab) => tab.id === selectedTabID);
  const nav = browserFrame && browserFrame.tabId === selectedTabID ? browserFrame : null;

  const selectTab = async (tabID: string) => {
    try {
      await ipc.browserUiSelectTab(tabID);
      selectedRef.current = tabID;
      setSelectedTabID(tabID);
      setBrowserFrame(null);
      await refreshTabs();
    } catch (error) {
      setSurfaceError(String(error));
    }
  };

  const closeTab = async (tabID: string) => {
    try {
      await ipc.browserUiCloseTab(tabID);
      const remaining = await refreshTabs();
      if (remaining.length === 0) await openTab();
    } catch (error) {
      setSurfaceError(String(error));
    }
  };

  const navigate = async (url: string) => {
    if (!selectedTabID) return;
    setDraft(url);
    try {
      await ipc.browserUiNavigate(selectedTabID, url);
    } catch (error) {
      setSurfaceError(String(error));
    }
  };

  const submitAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const resolved = normalizeAddressInput(draft);
    if (!resolved) return;
    inputRef.current?.blur();
    void navigate(resolved);
  };

  const framePoint = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    const frame = browserFrame;
    if (!stage || !frame) return null;
    const rect = stage.getBoundingClientRect();
    const scale = Math.min(rect.width / frame.viewportWidth, rect.height / frame.viewportHeight);
    const width = frame.viewportWidth * scale;
    const height = frame.viewportHeight * scale;
    const left = rect.left + (rect.width - width) / 2;
    const top = rect.top + (rect.height - height) / 2;
    if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;
    return { x: (clientX - left) / scale, y: (clientY - top) / scale };
  };

  const sendInput = (input: BrowserHumanInput) => {
    const tabID = selectedRef.current;
    if (!tabID) return;
    void ipc.browserUiInput(tabID, input).catch((error: unknown) => setSurfaceError(String(error)));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const point = framePoint(event.clientX, event.clientY);
    if (!point) return;
    pendingMoveRef.current = { ...point, buttons: event.buttons };
    if (moveFrameRef.current !== null) return;
    moveFrameRef.current = requestAnimationFrame(() => {
      moveFrameRef.current = null;
      const pending = pendingMoveRef.current;
      if (pending) sendInput({ type: "pointer_move", ...pending });
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const point = framePoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    sendInput({ type: "pointer_down", ...point, button: buttonName(event.button) });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const point = framePoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    sendInput({ type: "pointer_up", ...point, button: buttonName(event.button) });
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const point = framePoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    sendInput({ type: "wheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    sendInput({
      type: "key",
      key: event.key,
      code: event.code,
      modifiers: modifiersFor(event),
      text: event.key.length === 1 && !event.metaKey && !event.ctrlKey ? event.key : "",
    });
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    sendInput({ type: "text", text });
  };

  return (
    <aside className={`browser-pane${showContent ? "" : " is-obscured"}`} aria-label="Browser">
      <div className="browser-tabbar" onMouseDown={beginWindowDrag}>
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === selectedTabID}
              className={`browser-tab${tab.id === selectedTabID ? " is-selected" : ""}`}
              title={tab.title || tab.url || DEFAULT_BROWSER_TITLE}
              onClick={() => void selectTab(tab.id)}
            >
              <Icons.globe size={12} />
              <span className="browser-tab-title">{tab.title || DEFAULT_BROWSER_TITLE}</span>
              {tab.controllerSessionId && <span className="browser-agent-control" title="Agent controls this tab" />}
              <span
                className="browser-tab-close"
                role="button"
                aria-label={`Close ${tab.title || "browser tab"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.id);
                }}
              >
                <Icons.close size={9} />
              </span>
            </button>
          ))}
        </div>
        <button className="icon-button" type="button" title="New tab" aria-label="New tab" onClick={() => void openTab()}>
          <Icons.plus size={13} />
        </button>
        <span className="browser-tabbar-spacer" />
        <button className="icon-button" type="button" title="Close browser" aria-label="Close browser" onClick={() => setBrowserOpen(false)}>
          <Icons.close size={12} />
        </button>
      </div>

      <form className="browser-navbar" onSubmit={submitAddress}>
        <button type="button" className="icon-button" title="Back" aria-label="Back" disabled={!nav?.canGoBack} onClick={() => selectedTabID && void ipc.browserUiBack(selectedTabID)}>
          <Icons.chevronLeft size={14} />
        </button>
        <button type="button" className="icon-button" title="Forward" aria-label="Forward" disabled={!nav?.canGoForward} onClick={() => selectedTabID && void ipc.browserUiForward(selectedTabID)}>
          <Icons.chevronRight size={14} />
        </button>
        <button type="button" className="icon-button" title="Reload" aria-label="Reload" disabled={!selectedTabID} onClick={() => selectedTabID && void ipc.browserUiReload(selectedTabID)}>
          <Icons.reload size={13} />
        </button>
        <input
          ref={inputRef}
          className="browser-address"
          type="text"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Address"
          placeholder="Search or enter website"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
        />
        <button className="icon-button" type="submit" title="Go" aria-label="Go">
          <Icons.arrowRight size={14} />
        </button>
      </form>

      <div
        ref={stageRef}
        className="browser-frame-stage"
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onContextMenu={(event) => event.preventDefault()}
      >
        {browserFrame && browserFrame.tabId === selectedTabID ? (
          <img
            className="browser-frame"
            src={`data:${browserFrame.mimeType};base64,${browserFrame.dataBase64}`}
            alt=""
            draggable={false}
          />
        ) : (
          <div className="browser-frame-placeholder">{selectedTab ? "Starting Chromium…" : "No browser tab"}</div>
        )}
        {nav?.loading && <div className="browser-loading-bar" />}
        {surfaceError && <div className="browser-surface-error">{surfaceError}</div>}
      </div>
    </aside>
  );
}
