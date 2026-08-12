import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  DEFAULT_BROWSER_TITLE,
  normalizeAddressInput,
  type BrowserAnnotation,
  type BrowserNativeState,
  type BrowserTabSummary,
  type ChromeImportStatus,
} from "../browser";
import { addAnnotationToComposer } from "../browserAnnotations";
import { ipc } from "../ipc";
import { useAppStore } from "../store/appStore";
import { beginWindowDrag } from "../windowDrag";
import { Icons } from "./Icons";

function tabWithNativeState(tab: BrowserTabSummary, state: BrowserNativeState): BrowserTabSummary {
  return {
    ...tab,
    url: state.url,
    title: state.title,
    loading: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    crashed: state.crashed,
  };
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
  const [draft, setDraft] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState(false);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>([]);
  const [chromeImport, setChromeImport] = useState<ChromeImportStatus | null>(null);
  const [chromeProfileID, setChromeProfileID] = useState<string | null>(null);
  const [importingChrome, setImportingChrome] = useState(false);
  const [importDismissed, setImportDismissed] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const pendingNavigationRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    selectedRef.current = selectedTabID;
  }, [selectedTabID]);

  useEffect(() => {
    pendingNavigationRef.current = pendingNavigation;
  }, [pendingNavigation]);

  const refreshTabs = useCallback(async () => {
    const next = await ipc.browserUiTabs(threadID);
    const current = selectedRef.current;
    const selected = next.find((tab) => tab.selected)?.id
      ?? (current && next.some((tab) => tab.id === current) ? current : next[0]?.id)
      ?? null;
    selectedRef.current = selected;
    setSelectedTabID(selected);
    setTabs(next);
    const tab = next.find((candidate) => candidate.id === selected);
    if (tab && document.activeElement !== inputRef.current) setDraft(tab.url === "about:blank" ? "" : tab.url);
    return next;
  }, [threadID]);

  const openTab = useCallback(async (url: string | null = null) => {
    setSurfaceError(null);
    try {
      const tabID = await ipc.browserUiOpenTab(threadID, url);
      selectedRef.current = tabID;
      setSelectedTabID(tabID);
      setAnnotationMode(false);
      await refreshTabs();
    } catch (error) {
      setSurfaceError(String(error));
    }
  }, [refreshTabs, threadID]);

  useEffect(() => {
    let cancelled = false;
    void refreshTabs().then((existing) => {
      if (!cancelled && existing.length === 0) return openTab();
    }).catch((error) => {
      if (!cancelled) setSurfaceError(String(error));
    });
    return () => { cancelled = true; };
  }, [openTab, refreshTabs]);

  useEffect(() => {
    void ipc.browserChromeImportStatus().then((status) => {
      setChromeImport(status);
      setChromeProfileID(status.lastProfile ?? status.profiles[0]?.id ?? null);
    }).catch(() => setChromeImport(null));
  }, []);

  useEffect(() => {
    if (!pendingBrowserReveal || pendingBrowserReveal.threadId !== threadID) return;
    let cancelled = false;
    void refreshTabs().then(async (next) => {
      if (cancelled || !next.some((tab) => tab.id === pendingBrowserReveal.tabId)) return;
      await ipc.browserUiSelectTab(pendingBrowserReveal.tabId);
      if (cancelled) return;
      selectedRef.current = pendingBrowserReveal.tabId;
      setSelectedTabID(pendingBrowserReveal.tabId);
    }).catch((error) => {
      if (!cancelled) setSurfaceError(String(error));
    }).finally(() => {
      if (!cancelled) consumeBrowserReveal(pendingBrowserReveal.tabId);
    });
    return () => { cancelled = true; };
  }, [consumeBrowserReveal, pendingBrowserReveal, refreshTabs, threadID]);

  useEffect(() => {
    let unlistenState: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenAnnotation: (() => void) | undefined;
    void ipc.onBrowserState((state) => {
      setTabs((current) => current.map((tab) => tab.id === state.id ? tabWithNativeState(tab, state) : tab));
      if (selectedRef.current === state.id && document.activeElement !== inputRef.current && !pendingNavigationRef.current) {
        setDraft(state.url === "about:blank" ? "" : state.url);
      }
    }).then((stop) => { unlistenState = stop; });
    void ipc.onBrowserError((error) => {
      if (error.tabId === selectedRef.current) {
        setPendingNavigation(false);
        setSurfaceError(`${error.code}: ${error.message}`);
      }
    }).then((stop) => { unlistenError = stop; });
    void ipc.onBrowserAnnotation((annotation) => {
      if (annotation.tabId === selectedRef.current) setAnnotations((current) => [...current, annotation]);
    }).then((stop) => { unlistenAnnotation = stop; });
    return () => { unlistenState?.(); unlistenError?.(); unlistenAnnotation?.(); };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let frame = 0;
    const publish = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = stage.getBoundingClientRect();
        void ipc.browserViewBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      });
    };
    const observer = new ResizeObserver(publish);
    observer.observe(stage);
    window.addEventListener("resize", publish);
    publish();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", publish); };
  }, [annotations.length, surfaceError]);

  useEffect(() => {
    void ipc.browserViewVisible(showContent && Boolean(selectedTabID));
    return () => { void ipc.browserViewVisible(false); };
  }, [selectedTabID, showContent]);

  useEffect(() => {
    if (!selectedTabID) return;
    void ipc.browserAnnotationMode(selectedTabID, annotationMode).catch((error) => setSurfaceError(String(error)));
  }, [annotationMode, selectedTabID]);

  const selectTab = async (tabID: string) => {
    try {
      await ipc.browserUiSelectTab(tabID);
      selectedRef.current = tabID;
      setSelectedTabID(tabID);
      setAnnotationMode(false);
      pendingNavigationRef.current = false;
      setPendingNavigation(false);
      setSurfaceError(null);
      const tab = tabs.find((candidate) => candidate.id === tabID);
      setDraft(tab?.url === "about:blank" ? "" : tab?.url ?? "");
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
    const tabID = selectedRef.current;
    if (!tabID) return;
    setPendingNavigation(true);
    pendingNavigationRef.current = true;
    setSurfaceError(null);
    setDraft(url);
    setTabs((current) => current.map((tab) => tab.id === tabID ? { ...tab, loading: true } : tab));
    try {
      await ipc.browserUiNavigate(tabID, url);
      await refreshTabs();
    } catch (error) {
      setSurfaceError(String(error));
    } finally {
      pendingNavigationRef.current = false;
      setPendingNavigation(false);
    }
  };

  const submitAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const resolved = normalizeAddressInput(draft);
    if (!resolved) return;
    inputRef.current?.blur();
    void navigate(resolved);
  };

  const selectedTab = tabs.find((tab) => tab.id === selectedTabID);
  const showImport = chromeImport?.available && !chromeImport.importedAt && !importDismissed;

  const importChrome = async () => {
    if (!chromeProfileID) return;
    setImportingChrome(true);
    setSurfaceError(null);
    try {
      setChromeImport(await ipc.browserImportChrome(chromeProfileID));
      if (selectedTabID) await ipc.browserUiReload(selectedTabID);
    } catch (error) {
      setSurfaceError(String(error));
    } finally {
      setImportingChrome(false);
    }
  };

  return (
    <aside className={`browser-pane${showContent ? "" : " is-obscured"}`} aria-label="Browser">
      <div className="browser-tabbar" onMouseDown={beginWindowDrag}>
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
          {tabs.map((tab) => (
            <button key={tab.id} type="button" role="tab" aria-selected={tab.id === selectedTabID}
              className={`browser-tab${tab.id === selectedTabID ? " is-selected" : ""}`}
              title={tab.title || tab.url || DEFAULT_BROWSER_TITLE} onClick={() => void selectTab(tab.id)}>
              <Icons.globe size={12} />
              <span className="browser-tab-title">{tab.title || DEFAULT_BROWSER_TITLE}</span>
              {tab.controllerSessionId && <span className="browser-agent-control" title="Agent controls this tab" />}
              <span className="browser-tab-close" role="button" aria-label={`Close ${tab.title || "browser tab"}`}
                onClick={(event) => { event.stopPropagation(); void closeTab(tab.id); }}>
                <Icons.close size={9} />
              </span>
            </button>
          ))}
        </div>
        <button className="icon-button" type="button" title="New tab" aria-label="New tab" onClick={() => void openTab()}><Icons.plus size={13} /></button>
        <span className="browser-tabbar-spacer" />
        <button className={`icon-button${annotationMode ? " is-active" : ""}`} type="button" title="Annotate webpage"
          aria-label="Annotate webpage" aria-pressed={annotationMode} disabled={!selectedTabID}
          onClick={() => setAnnotationMode((value) => !value)}><Icons.plus size={13} /></button>
        <button className="icon-button" type="button" title="Close browser" aria-label="Close browser" onClick={() => setBrowserOpen(false)}><Icons.close size={12} /></button>
      </div>

      <form className="browser-navbar" onSubmit={submitAddress}>
        <button type="button" className="icon-button" title="Back" aria-label="Back" disabled={!selectedTab?.canGoBack}
          onClick={() => selectedTabID && void ipc.browserUiBack(selectedTabID)}><Icons.chevronLeft size={14} /></button>
        <button type="button" className="icon-button" title="Forward" aria-label="Forward" disabled={!selectedTab?.canGoForward}
          onClick={() => selectedTabID && void ipc.browserUiForward(selectedTabID)}><Icons.chevronRight size={14} /></button>
        <button type="button" className="icon-button" title="Reload" aria-label="Reload" disabled={!selectedTabID}
          onClick={() => selectedTabID && void ipc.browserUiReload(selectedTabID)}><Icons.reload size={13} /></button>
        <input ref={inputRef} className="browser-address" type="text" spellCheck={false} autoComplete="off" autoCorrect="off"
          autoCapitalize="off" aria-label="Address" placeholder="Search or enter website" value={draft}
          onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} />
        {(pendingNavigation || selectedTab?.loading) && <span className="browser-native-loading" aria-label="Loading" />}
        <button type="button" className="icon-button" title="Fill saved Chrome password" aria-label="Fill saved password"
          disabled={!selectedTabID} onClick={() => selectedTabID && void ipc.browserFillSavedPassword(selectedTabID)
            .then((filled) => { if (!filled) setSurfaceError("No imported password is saved for this website."); })}>
          <Icons.lock size={13} />
        </button>
      </form>

      {showImport && (
        <div className="browser-import-banner">
          <span><strong>Import data from Chrome</strong><small>Bring over your passwords and cookies to the built-in browser</small></span>
          {chromeImport.profiles.length > 1 && (
            <select aria-label="Chrome profile" value={chromeProfileID ?? ""} onChange={(event) => setChromeProfileID(event.target.value)}>
              {chromeImport.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          )}
          <button type="button" disabled={importingChrome} onClick={() => void importChrome()}>{importingChrome ? "Importing…" : "Import"}</button>
          <button type="button" className="icon-button" aria-label="Dismiss Chrome import" onClick={() => setImportDismissed(true)}><Icons.close size={11} /></button>
        </div>
      )}

      {(annotationMode || annotations.length > 0 || surfaceError) && (
        <div className="browser-context-bar">
          {annotationMode && <span>Click an element on the page to annotate it.</span>}
          {annotations.slice(-3).map((annotation) => (
            <button key={annotation.id} type="button" className="browser-annotation-chip"
              title={annotation.selector} onClick={() => addAnnotationToComposer(annotation)}>
              Add “{annotation.name || annotation.text || annotation.tagName}” to prompt
            </button>
          ))}
          {surfaceError && <span className="browser-surface-error">{surfaceError}</span>}
        </div>
      )}

      <div ref={stageRef} className="browser-native-stage" aria-label="Webpage">
        {!selectedTabID && <span>Opening browser…</span>}
        {selectedTab?.crashed && <span>The Chromium renderer stopped. Reload this tab.</span>}
      </div>
    </aside>
  );
}
