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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Icons } from "./Icons";
import { ShellTerminalView } from "./ShellTerminalView";
import { SideChatView } from "./SideChatView";

const EMPTY_ANNOTATIONS: BrowserAnnotation[] = [];

function measureVisibleBrowserBounds(stage: HTMLElement): { x: number; y: number; width: number; height: number } {
  const stageRect = stage.getBoundingClientRect();
  const shellRect = stage.closest<HTMLElement>(".browser-shell")?.getBoundingClientRect();
  const left = Math.max(0, stageRect.left, shellRect?.left ?? 0);
  const top = Math.max(0, stageRect.top, shellRect?.top ?? 0);
  const right = Math.min(window.innerWidth, stageRect.right, shellRect?.right ?? window.innerWidth);
  const bottom = Math.min(window.innerHeight, stageRect.bottom, shellRect?.bottom ?? window.innerHeight);

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(0, Math.round(right - left)),
    height: Math.max(0, Math.round(bottom - top)),
  };
}

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
  animating,
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
    const shell = stage.closest<HTMLElement>(".browser-shell");
    let scheduledFrame = 0;
    let transitionFrame = 0;
    let previousBounds = "";
    const publishNow = (): void => {
      const bounds = measureVisibleBrowserBounds(stage);
      const serialized = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      if (serialized === previousBounds) return;
      previousBounds = serialized;
      void ipc.browserViewBounds(bounds);
    };
    const publish = (): void => {
      cancelAnimationFrame(scheduledFrame);
      scheduledFrame = requestAnimationFrame(publishNow);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(stage);
    if (shell) observer.observe(shell);
    window.addEventListener("resize", publish);
    publish();
    if (animating) {
      const followTransition = (): void => {
        publishNow();
        transitionFrame = requestAnimationFrame(followTransition);
      };
      transitionFrame = requestAnimationFrame(followTransition);
    }
    return () => {
      cancelAnimationFrame(scheduledFrame);
      cancelAnimationFrame(transitionFrame);
      observer.disconnect();
      window.removeEventListener("resize", publish);
    };
  }, [animating, annotations.length, selectedTabID, surfaceError]);

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
                    <Button className="browser-tab-close" variant="ghost" size="icon-xs" type="button" title="Close tab"
                      aria-label={`Close ${title}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); void closeTab(panelTab); }}>
                      <Icons.close />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
          {panelTabs.length > 0 && (
            <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
              <DropdownMenuTrigger
                render={<Button className="browser-new-tab" variant="ghost" size="icon-sm" aria-label="New tab" />}
              >
                <Icons.plus />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" aria-label="New tab type">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => void openTab()}>
                    <Icons.globe /><span>Browser</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openTerminalTab}>
                    <Icons.terminal /><span>Terminal</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void openSideChatTab()}>
                    <Icons.bubble /><span>Side chat</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <IconButton
          className="browser-expand-toggle"
          label={expanded ? "Restore right panel" : "Expand right panel"}
          aria-pressed={expanded}
          onClick={onToggleExpanded}
        >
          {expanded ? <Icons.collapse /> : <Icons.expand />}
        </IconButton>
      </div>

      {selectedPanelTab?.type === "browser" && (annotationMode ? (
        <div className="browser-annotation-toolbar">
          <div className="browser-annotation-toolbar-actions">
            <IconButton label="Cancel annotations" onClick={cancelAnnotations}>
              <Icons.close />
            </IconButton>
            <IconButton label="Clear annotations"
              disabled={annotations.length === 0} onClick={() => clearBrowserAnnotations(threadID)}>
              <Icons.trash />
            </IconButton>
          </div>
          <span className="browser-annotation-toolbar-title">Annotating <span>•</span> {annotationLocation}</span>
          <Button type="button" size="sm"
            disabled={annotations.length === 0 || turnRunning || submittingAnnotations}
            aria-busy={submittingAnnotations} onClick={() => void submitAnnotations()}>
            {submittingAnnotations && <Spinner data-icon="inline-start" />}
            {submittingAnnotations ? "Sending…" : <>Send <span>{annotations.length}</span></>}
          </Button>
        </div>
      ) : (
      <form className="browser-navbar" onSubmit={submitAddress}>
        <IconButton label="Back" disabled={!selectedTab?.canGoBack}
          onClick={() => selectedTabID && void ipc.browserUiBack(selectedTabID)}><Icons.chevronLeft /></IconButton>
        <IconButton label="Forward" disabled={!selectedTab?.canGoForward}
          onClick={() => selectedTabID && void ipc.browserUiForward(selectedTabID)}><Icons.chevronRight /></IconButton>
        <IconButton label="Reload" disabled={!selectedTabID}
          onClick={() => selectedTabID && void ipc.browserUiReload(selectedTabID)}><Icons.reload /></IconButton>
        <Input ref={inputRef} className="browser-address" type="text" spellCheck={false} autoComplete="off" autoCorrect="off"
          autoCapitalize="off" aria-label="Address" placeholder="Search or enter website" value={draft}
          onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} />
        {(pendingNavigation || selectedTab?.loading) && <Spinner className="browser-native-loading" aria-label="Loading" />}
        {!terminalMode && (
          <IconButton label="Annotate webpage" disabled={!selectedTabID}
            onClick={beginAnnotations}><Icons.annotation /></IconButton>
        )}
        <IconButton label="Fill saved Chrome password"
          disabled={!selectedTabID} onClick={() => selectedTabID && void ipc.browserFillSavedPassword(selectedTabID)
            .then((filled) => { if (!filled) setSurfaceError("No imported password is saved for this website."); })}>
          <Icons.lock />
        </IconButton>
      </form>
      ))}

      {selectedPanelTab?.type === "browser" && showImport && (
        <div className="browser-import-banner">
          <span><strong>Import data from Chrome</strong><small>Bring over your passwords and cookies to the built-in browser</small></span>
          {chromeImport.profiles.length > 1 && (
            <NativeSelect aria-label="Chrome profile" size="sm" value={chromeProfileID ?? ""} onChange={(event) => setChromeProfileID(event.target.value)}>
              {chromeImport.profiles.map((profile) => <NativeSelectOption key={profile.id} value={profile.id}>{profile.name}</NativeSelectOption>)}
            </NativeSelect>
          )}
          <Button type="button" size="sm" disabled={importingChrome} onClick={() => void importChrome()}>
            {importingChrome && <Spinner data-icon="inline-start" />}{importingChrome ? "Importing…" : "Import"}
          </Button>
          <IconButton label="Dismiss Chrome import" onClick={() => setImportDismissed(true)}><Icons.close /></IconButton>
        </div>
      )}

      {surfaceError && (
        <Alert className="m-2" variant="destructive">
          <AlertDescription>{surfaceError}</AlertDescription>
        </Alert>
      )}

      {panelTabs.length === 0 && (
        <Empty className="items-center justify-center gap-4 rounded-none px-5 text-left">
          <EmptyHeader className="w-full max-w-md items-start gap-0">
            <EmptyTitle className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Open a tab
            </EmptyTitle>
          </EmptyHeader>
          <EmptyContent className="max-w-md items-stretch gap-3 text-left">
            <Button className="min-h-20 w-full justify-start gap-4 rounded-xl px-4 py-3 text-left whitespace-normal" variant="card" onClick={() => void openTab()}>
              <Icons.globe className="size-5" data-icon="inline-start" />
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <strong className="font-semibold text-foreground">Browser</strong>
                <span className="text-xs font-normal text-muted-foreground">Browse and annotate the web</span>
              </span>
            </Button>
            <Button className="min-h-20 w-full justify-start gap-4 rounded-xl px-4 py-3 text-left whitespace-normal" variant="card" onClick={openTerminalTab}>
              <Icons.terminal className="size-5" data-icon="inline-start" />
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <strong className="font-semibold text-foreground">Terminal</strong>
                <span className="text-xs font-normal text-muted-foreground">Open a shell in this project</span>
              </span>
            </Button>
            <Button className="min-h-20 w-full justify-start gap-4 rounded-xl px-4 py-3 text-left whitespace-normal" variant="card" onClick={() => void openSideChatTab()}>
              <Icons.bubble className="size-5" data-icon="inline-start" />
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <strong className="font-semibold text-foreground">Side chat</strong>
                <span className="text-xs font-normal text-muted-foreground">Ask with this chat’s context</span>
              </span>
            </Button>
          </EmptyContent>
        </Empty>
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
