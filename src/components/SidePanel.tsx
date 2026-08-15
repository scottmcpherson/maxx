// The right panel owns mixed tab chrome; Chromium remains one tab content type.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  DEFAULT_BROWSER_TITLE,
  normalizeAddressInput,
  type BrowserAnnotation,
  type BrowserNativeState,
  type BrowserTabDropEdge,
  type BrowserTabSummary,
  type ChromeImportStatus,
} from "../browser";
import { projectName, type ChatTextSelection } from "../contract/types";
import { ipc } from "../ipc";
import {
  loadSidePanelTabState,
  persistSidePanelTabState,
  reconcileSidePanelTabs,
  reorderSidePanelTabs,
  type SidePanelTab,
} from "../sidePanelTabs";
import { useAppStore } from "../store/appStore";
import { appendChatTextSelection } from "../sideChat";
import { beginWindowDrag } from "../windowDrag";
import { Icons } from "./Icons";
import { ShellTerminalView } from "./ShellTerminalView";
import { SideChatView } from "./SideChatView";

const EMPTY_ANNOTATIONS: BrowserAnnotation[] = [];

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

export function SidePanel({
  threadID,
  showContent,
  expanded,
  onToggleExpanded,
}: {
  threadID: string;
  showContent: boolean;
  animating: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const pendingBrowserReveal = useAppStore((state) => state.pendingBrowserReveal);
  const consumeBrowserReveal = useAppStore((state) => state.consumeBrowserReveal);
  const pendingSideChatRequest = useAppStore((state) => state.pendingSideChatRequest);
  const consumeSideChatRequest = useAppStore((state) => state.consumeSideChatRequest);
  const createSideChat = useAppStore((state) => state.createSideChat);
  const removeThread = useAppStore((state) => state.removeThread);
  const annotations = useAppStore((state) => state.browserAnnotationsByThread[threadID] ?? EMPTY_ANNOTATIONS);
  const applyBrowserAnnotation = useAppStore((state) => state.applyBrowserAnnotation);
  const replaceBrowserAnnotations = useAppStore((state) => state.replaceBrowserAnnotations);
  const clearBrowserAnnotations = useAppStore((state) => state.clearBrowserAnnotations);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const turnRunning = useAppStore((state) => Boolean(state.activeTurnByThread[threadID]));
  const terminalMode = useAppStore((state) => {
    const workspaces = [state.workspace, ...state.remoteSessions.map((session) => session.workspace)];
    return workspaces.some((workspace) => workspace?.projects.some((project) =>
      project.threads.some((thread) => thread.id === threadID && thread.surface === "terminal"),
    ));
  });
  const workspace = useAppStore((state) => state.workspace);
  const remoteSessions = useAppStore((state) => state.remoteSessions);
  const selectedHostID = useAppStore((state) => state.selectedHostID);
  const selectedProjectID = useAppStore((state) => state.selectedProjectID);
  const projectWorkspace = useMemo(() => {
    if (!selectedHostID || selectedHostID === "local") return workspace;
    return remoteSessions.find((session) => session.host.id === selectedHostID)?.workspace ?? workspace;
  }, [remoteSessions, selectedHostID, workspace]);
  const project = useMemo(
    () => projectWorkspace?.projects.find((candidate) => candidate.id === selectedProjectID),
    [projectWorkspace, selectedProjectID],
  );
  const sideChatThreads = useMemo(
    () => project?.threads.filter((candidate) => candidate.parentThreadID === threadID && !candidate.agentID) ?? [],
    [project, threadID],
  );
  const sideChatThreadsByID = useMemo(
    () => new Map(sideChatThreads.map((candidate) => [candidate.id, candidate])),
    [sideChatThreads],
  );
  const sideChatThreadIDs = useMemo(() => sideChatThreads.map((candidate) => candidate.id), [sideChatThreads]);
  const [tabs, setTabs] = useState<BrowserTabSummary[]>([]);
  const [panelState, setPanelState] = useState(() => loadSidePanelTabState(threadID));
  const panelTabs = panelState.tabs;
  const browserTabsByID = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const selectedPanelTabID = panelState.selectedTabID;
  const selectedPanelTab = panelTabs.find((tab) => tab.id === selectedPanelTabID);
  const selectedTabID = selectedPanelTab?.type === "browser" ? selectedPanelTab.id : null;
  const [draft, setDraft] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState(false);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [submittingAnnotations, setSubmittingAnnotations] = useState(false);
  const [chromeImport, setChromeImport] = useState<ChromeImportStatus | null>(null);
  const [chromeProfileID, setChromeProfileID] = useState<string | null>(null);
  const [importingChrome, setImportingChrome] = useState(false);
  const [importDismissed, setImportDismissed] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const pendingNavigationRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const tabPointerDragRef = useRef<{ tabID: string; pointerID: number; startX: number; dragging: boolean } | null>(null);
  const dropTargetRef = useRef<{ tabID: string; edge: BrowserTabDropEdge } | null>(null);
  const suppressTabClickRef = useRef(false);
  const [draggedTabID, setDraggedTabID] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ tabID: string; edge: BrowserTabDropEdge } | null>(null);
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  const updateTabOverflow = useCallback(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const left = strip.scrollLeft > 1;
    const right = strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1;
    setTabOverflow((current) => current.left === left && current.right === right ? current : { left, right });
  }, []);
  const annotationTabRef = useRef<string | null>(null);
  const annotationSyncRef = useRef(0);
  const annotationSessionStartRef = useRef<BrowserAnnotation[] | null>(null);

  useEffect(() => {
    selectedRef.current = selectedTabID;
  }, [selectedTabID]);

  useEffect(() => {
    persistSidePanelTabState(threadID, panelState);
  }, [panelState, threadID]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithEscape);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    if ((!terminalMode && selectedTabID) || !annotationMode) return;
    const tabID = annotationTabRef.current;
    annotationTabRef.current = null;
    annotationSessionStartRef.current = null;
    setAnnotationMode(false);
    clearBrowserAnnotations(threadID);
    if (tabID) void ipc.browserAnnotationMode(tabID, false);
  }, [annotationMode, clearBrowserAnnotations, selectedTabID, terminalMode, threadID]);

  useEffect(() => {
    if (!selectedPanelTabID) return;
    const frame = requestAnimationFrame(() => {
      tabRefs.current.get(selectedPanelTabID)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      updateTabOverflow();
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedPanelTabID, panelTabs.length, updateTabOverflow]);

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(updateTabOverflow);
    observer.observe(strip);
    const frame = requestAnimationFrame(updateTabOverflow);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [panelTabs.length, updateTabOverflow]);

  useEffect(() => {
    pendingNavigationRef.current = pendingNavigation;
  }, [pendingNavigation]);

  const refreshTabs = useCallback(async () => {
    const next = await ipc.browserUiTabs(threadID);
    setTabs(next);
    setPanelState((current) => reconcileSidePanelTabs(
      current,
      next.map((tab) => tab.id),
      sideChatThreadIDs,
      next.find((tab) => tab.selected)?.id,
    ));
    const tab = next.find((candidate) => candidate.id === selectedRef.current);
    if (tab && document.activeElement !== inputRef.current) setDraft(tab.url === "about:blank" ? "" : tab.url);
    return next;
  }, [sideChatThreadIDs, threadID]);

  const openTab = useCallback(async (url: string | null = null) => {
    setAddMenuOpen(false);
    setSurfaceError(null);
    try {
      const tabID = await ipc.browserUiOpenTab(threadID, url);
      selectedRef.current = tabID;
      setPanelState((current) => ({
        tabs: current.tabs.some((tab) => tab.id === tabID)
          ? current.tabs
          : [...current.tabs, { id: tabID, type: "browser" }],
        selectedTabID: tabID,
      }));
      await refreshTabs();
    } catch (error) {
      setSurfaceError(String(error));
    }
  }, [refreshTabs, threadID]);

  useEffect(() => {
    let cancelled = false;
    void refreshTabs().catch((error) => {
      if (!cancelled) setSurfaceError(String(error));
    });
    return () => { cancelled = true; };
  }, [refreshTabs]);

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
      setPanelState((current) => ({ ...current, selectedTabID: pendingBrowserReveal.tabId }));
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
      if (annotation.tabId !== selectedRef.current) return;
      if ("cancel" in annotation) {
        const original = annotationSessionStartRef.current;
        if (original) replaceBrowserAnnotations(threadID, original);
        annotationSessionStartRef.current = null;
        setAnnotationMode(false);
        return;
      }
      applyBrowserAnnotation(threadID, annotation, annotation.selected);
    }).then((stop) => { unlistenAnnotation = stop; });
    return () => { unlistenState?.(); unlistenError?.(); unlistenAnnotation?.(); };
  }, [applyBrowserAnnotation, replaceBrowserAnnotations, threadID]);

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
  }, [annotations.length, selectedTabID, surfaceError]);

  useEffect(() => {
    void ipc.browserViewVisible(showContent && Boolean(selectedTabID));
    return () => { void ipc.browserViewVisible(false); };
  }, [selectedTabID, showContent]);

  useEffect(() => {
    const generation = ++annotationSyncRef.current;
    const previousTabID = annotationTabRef.current;
    annotationTabRef.current = annotationMode ? selectedTabID : null;
    void (async () => {
      try {
        if (previousTabID && previousTabID !== selectedTabID) await ipc.browserAnnotationMode(previousTabID, false);
        if (!selectedTabID || generation !== annotationSyncRef.current) return;
        await ipc.browserAnnotationMode(selectedTabID, annotationMode);
        if (!annotationMode || generation !== annotationSyncRef.current) return;
        await ipc.browserAnnotationSelections(selectedTabID, annotations
          .map((annotation, index) => ({ annotation, index: index + 1 }))
          .filter(({ annotation }) => annotation.tabId === selectedTabID)
          .map(({ annotation, index }) => ({
            selector: annotation.selector,
            index,
            instruction: annotation.instruction,
          })));
      } catch (error) {
        if (generation === annotationSyncRef.current) setSurfaceError(String(error));
      }
    })();
  }, [annotationMode, annotations, selectedTabID]);

  useEffect(() => () => {
    const tabID = annotationTabRef.current;
    if (tabID) void ipc.browserAnnotationMode(tabID, false);
  }, []);

  const selectTab = async (tabID: string) => {
    try {
      await ipc.browserUiSelectTab(tabID);
      selectedRef.current = tabID;
      setPanelState((current) => ({ ...current, selectedTabID: tabID }));
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

  const selectPanelTab = (tab: SidePanelTab) => {
    setAddMenuOpen(false);
    if (tab.type === "browser") void selectTab(tab.id);
    else {
      selectedRef.current = null;
      setPanelState((current) => ({ ...current, selectedTabID: tab.id }));
      setSurfaceError(null);
    }
  };

  const closeTab = async (panelTab: SidePanelTab) => {
    try {
      if (annotationTabRef.current === panelTab.id) annotationTabRef.current = null;
      if (panelTab.type === "browser") await ipc.browserUiCloseTab(panelTab.id);
      else if (panelTab.type === "terminal") await ipc.shellTerminalStop(panelTab.id, selectedHostID);
      else if (project) await removeThread(project.id, panelTab.id);
      const index = panelTabs.findIndex((tab) => tab.id === panelTab.id);
      const remaining = panelTabs.filter((tab) => tab.id !== panelTab.id);
      const next = remaining[Math.min(Math.max(0, index), remaining.length - 1)] ?? null;
      selectedRef.current = next?.type === "browser" ? next.id : null;
      setPanelState({ tabs: remaining, selectedTabID: next?.id ?? null });
      if (next?.type === "browser") await ipc.browserUiSelectTab(next.id);
      if (panelTab.type === "browser") await refreshTabs();
    } catch (error) {
      setSurfaceError(String(error));
    }
  };

  const setTabDropTarget = (target: { tabID: string; edge: BrowserTabDropEdge } | null) => {
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  const persistTabOrder = async (
    draggedTabID: string,
    targetTabID: string,
    edge: BrowserTabDropEdge,
  ) => {
    const next = reorderSidePanelTabs(panelTabs, draggedTabID, targetTabID, edge);
    if (next === panelTabs) return;
    setPanelState((current) => ({ ...current, tabs: next }));
    setSurfaceError(null);
    try {
      const browserTabIDs = next.filter((tab) => tab.type === "browser").map((tab) => tab.id);
      if (browserTabIDs.length > 0) await ipc.browserUiReorderTabs(threadID, browserTabIDs);
    } catch (error) {
      setSurfaceError(String(error));
      await refreshTabs().catch(() => undefined);
    }
  };

  const moveTabPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = tabPointerDragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    if (!drag.dragging) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.dragging = true;
      setDraggedTabID(drag.tabID);
    }

    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".browser-tab");
    const targetTabID = target?.dataset.tabId;
    if (!target || !targetTabID || targetTabID === drag.tabID) {
      setTabDropTarget(null);
    } else {
      const bounds = target.getBoundingClientRect();
      setTabDropTarget({
        tabID: targetTabID,
        edge: event.clientX < bounds.left + bounds.width / 2 ? "before" : "after",
      });
    }

    const strip = tabStripRef.current;
    if (!strip) return;
    const stripBounds = strip.getBoundingClientRect();
    if (event.clientX < stripBounds.left + 36) strip.scrollLeft -= 18;
    else if (event.clientX > stripBounds.right - 36) strip.scrollLeft += 18;
  };

  const endTabPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = tabPointerDragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    tabPointerDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const target = dropTargetRef.current;
    if (drag.dragging) {
      suppressTabClickRef.current = true;
      if (target) void persistTabOrder(drag.tabID, target.tabID, target.edge);
    }
    setDraggedTabID(null);
    setTabDropTarget(null);
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

  const openTerminalTab = () => {
    if (!project) {
      setSurfaceError("The selected project is unavailable.");
      return;
    }
    const tab: SidePanelTab = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: projectName(project),
    };
    selectedRef.current = null;
    setPanelState((current) => ({ tabs: [...current.tabs, tab], selectedTabID: tab.id }));
    setAddMenuOpen(false);
    setSurfaceError(null);
  };

  const openSideChatTab = useCallback(async (selection?: ChatTextSelection) => {
    if (!project) {
      setSurfaceError("The selected project is unavailable.");
      return;
    }
    setAddMenuOpen(false);
    setSurfaceError(null);
    const sideChat = await createSideChat(project.id, threadID);
    if (!sideChat) return;
    const tab: SidePanelTab = {
      id: sideChat.id,
      type: "side-chat",
      title: sideChat.title || "Side chat",
      pendingSelections: selection ? [selection] : [],
    };
    selectedRef.current = null;
    setPanelState((current) => ({
      tabs: [...current.tabs.filter((candidate) => candidate.id !== tab.id), tab],
      selectedTabID: tab.id,
    }));
  }, [createSideChat, project, threadID]);

  useEffect(() => {
    if (!pendingSideChatRequest || pendingSideChatRequest.parentThreadID !== threadID) return;
    consumeSideChatRequest(pendingSideChatRequest.id);
    const selected = panelTabs.find((tab) => tab.id === selectedPanelTabID);
    if (selected?.type === "side-chat") {
      setPanelState((current) => ({
        ...current,
        tabs: current.tabs.map((tab) => tab.id === selected.id && tab.type === "side-chat"
          ? {
              ...tab,
              pendingSelections: pendingSideChatRequest.selection
                ? appendChatTextSelection(tab.pendingSelections, pendingSideChatRequest.selection)
                : tab.pendingSelections,
            }
          : tab),
        selectedTabID: selected.id,
      }));
      return;
    }
    void openSideChatTab(pendingSideChatRequest.selection);
  }, [consumeSideChatRequest, openSideChatTab, panelTabs, pendingSideChatRequest, selectedPanelTabID, threadID]);

  const beginAnnotations = () => {
    annotationSessionStartRef.current = [...annotations];
    setAnnotationMode(true);
  };

  const cancelAnnotations = () => {
    const original = annotationSessionStartRef.current;
    if (original) replaceBrowserAnnotations(threadID, original);
    annotationSessionStartRef.current = null;
    setAnnotationMode(false);
  };

  const submitAnnotations = async () => {
    if (annotations.length === 0 || turnRunning || submittingAnnotations) return;
    setSubmittingAnnotations(true);
    const sent = await sendPrompt("", [], [...annotations]);
    setSubmittingAnnotations(false);
    if (!sent) return;
    annotationSessionStartRef.current = null;
    clearBrowserAnnotations(threadID);
    setAnnotationMode(false);
  };

  const annotationLocation = (() => {
    if (!selectedTab?.url || selectedTab.url === "about:blank") return DEFAULT_BROWSER_TITLE;
    try {
      const url = new URL(selectedTab.url);
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return selectedTab.title || DEFAULT_BROWSER_TITLE;
    }
  })();

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
    <aside className={`browser-pane${showContent ? "" : " is-obscured"}`} aria-label="Right side panel">
      <div className="browser-tabbar" onMouseDown={beginWindowDrag}>
        <div className={`browser-tabs-viewport${tabOverflow.left ? " has-overflow-left" : ""}${tabOverflow.right ? " has-overflow-right" : ""}`}>
          <div ref={tabStripRef} className="browser-tabs"
            onScroll={updateTabOverflow}
            onWheel={(event) => {
              if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
              if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
              event.preventDefault();
              event.currentTarget.scrollLeft += event.deltaY;
            }}>
            <div className="browser-tab-list" role="tablist" aria-label="Right panel tabs">
              {panelTabs.map((panelTab) => {
                const browserTab = panelTab.type === "browser" ? browserTabsByID.get(panelTab.id) : null;
                const title = panelTab.type === "terminal"
                  ? panelTab.title
                  : panelTab.type === "side-chat"
                    ? sideChatThreadsByID.get(panelTab.id)?.title || panelTab.title
                    : browserTab?.title || DEFAULT_BROWSER_TITLE;
                return (
                  <div key={panelTab.id} ref={(element) => {
                    if (element) tabRefs.current.set(panelTab.id, element);
                    else tabRefs.current.delete(panelTab.id);
                  }} role="tab" tabIndex={panelTab.id === selectedPanelTabID ? 0 : -1}
                    aria-selected={panelTab.id === selectedPanelTabID}
                    data-tab-id={panelTab.id}
                    className={`browser-tab${panelTab.id === selectedPanelTabID ? " is-selected" : ""}${draggedTabID === panelTab.id ? " is-dragging" : ""}${dropTarget?.tabID === panelTab.id ? ` drop-${dropTarget.edge}` : ""}`}
                    title={title}
                    onClick={() => {
                      if (suppressTabClickRef.current) {
                        suppressTabClickRef.current = false;
                        return;
                      }
                      selectPanelTab(panelTab);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      selectPanelTab(panelTab);
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      tabPointerDragRef.current = {
                        tabID: panelTab.id,
                        pointerID: event.pointerId,
                        startX: event.clientX,
                        dragging: false,
                      };
                    }}
                    onPointerMove={moveTabPointer}
                    onPointerUp={endTabPointer}
                    onPointerCancel={(event) => {
                      const drag = tabPointerDragRef.current;
                      if (!drag || drag.pointerID !== event.pointerId) return;
                      tabPointerDragRef.current = null;
                      setDraggedTabID(null);
                      setTabDropTarget(null);
                    }}>
                    {panelTab.type === "terminal"
                      ? <Icons.terminal size={12} />
                      : panelTab.type === "side-chat"
                        ? <Icons.bubble size={12} />
                        : <Icons.globe size={12} />}
                    <span className="browser-tab-title">{title}</span>
                    {browserTab?.controllerSessionId && <span className="browser-agent-control" title="Agent controls this tab" />}
                    <button className="browser-tab-close" type="button" title="Close tab"
                      aria-label={`Close ${title}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); void closeTab(panelTab); }}>
                      <Icons.close size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          {panelTabs.length > 0 && (
            <div className="side-panel-add" ref={addMenuRef}>
              <button className="icon-button browser-new-tab" type="button" title="New tab" aria-label="New tab"
                aria-haspopup="menu" aria-expanded={addMenuOpen}
                onClick={() => setAddMenuOpen((open) => !open)}><Icons.plus size={13} /></button>
              {addMenuOpen && (
                <div className="side-panel-add-menu" role="menu" aria-label="New tab type">
                  <button type="button" role="menuitem" onClick={() => void openTab()}>
                    <Icons.globe size={15} /><span>Browser</span>
                  </button>
                  <button type="button" role="menuitem" onClick={openTerminalTab}>
                    <Icons.terminal size={15} /><span>Terminal</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => void openSideChatTab()}>
                    <Icons.bubble size={15} /><span>Side chat</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <button
          className={`icon-button browser-expand-toggle${expanded ? " is-active" : ""}`}
          type="button"
          title={expanded ? "Restore right panel" : "Expand right panel"}
          aria-label={expanded ? "Restore right panel" : "Expand right panel"}
          aria-pressed={expanded}
          onClick={onToggleExpanded}
        >
          {expanded ? <Icons.collapse size={13} /> : <Icons.expand size={13} />}
        </button>
      </div>

      {selectedPanelTab?.type === "browser" && (annotationMode ? (
        <div className="browser-annotation-toolbar">
          <div className="browser-annotation-toolbar-actions">
            <button type="button" className="icon-button" title="Cancel annotations" aria-label="Cancel annotations" onClick={cancelAnnotations}>
              <Icons.close size={14} />
            </button>
            <button type="button" className="icon-button" title="Clear annotations" aria-label="Clear annotations"
              disabled={annotations.length === 0} onClick={() => clearBrowserAnnotations(threadID)}>
              <Icons.trash size={14} />
            </button>
          </div>
          <span className="browser-annotation-toolbar-title">Annotating <span>•</span> {annotationLocation}</span>
          <button type="button" className="browser-annotation-send"
            disabled={annotations.length === 0 || turnRunning || submittingAnnotations}
            aria-busy={submittingAnnotations} onClick={() => void submitAnnotations()}>
            {submittingAnnotations ? "Sending…" : <>Send <span>{annotations.length}</span></>}
          </button>
        </div>
      ) : (
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
        {!terminalMode && (
          <button className="icon-button" type="button" title="Annotate webpage"
            aria-label="Annotate webpage" disabled={!selectedTabID}
            onClick={beginAnnotations}><Icons.annotation size={15} /></button>
        )}
        <button type="button" className="icon-button" title="Fill saved Chrome password" aria-label="Fill saved password"
          disabled={!selectedTabID} onClick={() => selectedTabID && void ipc.browserFillSavedPassword(selectedTabID)
            .then((filled) => { if (!filled) setSurfaceError("No imported password is saved for this website."); })}>
          <Icons.lock size={13} />
        </button>
      </form>
      ))}

      {selectedPanelTab?.type === "browser" && showImport && (
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

      {surfaceError && (
        <div className="browser-context-bar">
          <span className="browser-surface-error">{surfaceError}</span>
        </div>
      )}

      {panelTabs.length === 0 && (
        <div className="side-panel-empty">
          <div className="side-panel-empty-card">
            <span className="side-panel-empty-title">Open a tab</span>
            <button type="button" onClick={() => void openTab()}>
              <Icons.globe size={18} />
              <span><strong>Browser</strong><small>Browse and annotate the web</small></span>
            </button>
            <button type="button" onClick={openTerminalTab}>
              <Icons.terminal size={18} />
              <span><strong>Terminal</strong><small>Open a shell in this project</small></span>
            </button>
            <button type="button" onClick={() => void openSideChatTab()}>
              <Icons.bubble size={18} />
              <span><strong>Side chat</strong><small>Ask with this chat’s context</small></span>
            </button>
          </div>
        </div>
      )}
      {selectedPanelTab?.type === "browser" && (
        <div ref={stageRef} className="browser-native-stage" aria-label="Webpage">
          {selectedTab?.crashed && <span>The Chromium renderer stopped. Reload this tab.</span>}
        </div>
      )}
      {selectedPanelTab?.type === "terminal" && project && (
        <ShellTerminalView
          key={selectedPanelTab.id}
          projectID={project.id}
          threadID={threadID}
          sessionID={selectedPanelTab.id}
          hostID={selectedHostID ?? undefined}
        />
      )}
      {selectedPanelTab?.type === "side-chat" && project && sideChatThreadsByID.get(selectedPanelTab.id) && (
        <SideChatView
          key={selectedPanelTab.id}
          project={project}
          thread={sideChatThreadsByID.get(selectedPanelTab.id)!}
          hostID={selectedHostID ?? undefined}
          pendingSelections={selectedPanelTab.pendingSelections}
          onClearSelections={() => setPanelState((current) => ({
            ...current,
            tabs: current.tabs.map((tab) => tab.id === selectedPanelTab.id && tab.type === "side-chat"
              ? { ...tab, pendingSelections: [] }
              : tab),
          }))}
        />
      )}
    </aside>
  );
}
