import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { ipc } from "../ipc";
import { CHATS_PROJECT_ID, isChatsProject, projectName } from "../contract/types";
import type { ChatThread } from "../contract/types";
import {
  attachRemote,
  emptyCatalog,
  hostedProjects,
  isLocalHost,
  LOCAL_HOST_ID,
  mergedWorkspace,
} from "../host/session";
import { HostFolderPicker } from "./HostFolderPicker";
import {
  attentionThreads,
  StickyAttentionRef,
  withStickyAttention,
} from "../store/attentionFilter";
import { useAppStore } from "../store/appStore";
import {
  loadPinnedThreadIDs,
  persistPinnedThreadIDs,
  pinnedThreads,
  prunePinnedThreadIDs,
  setThreadPinned,
} from "../store/pinnedThreads";
import { threadActivity } from "../store/threadActivity";
import { beginWindowDrag } from "../windowDrag";
import { relativeTime } from "../relativeTime";
import { Icons } from "./Icons";
import { SidebarUpdateButton } from "./SidebarUpdateButton";
import { ProjectFolderIcon } from "./ProjectFolderIcon";

const COLLAPSED_PROJECTS_STORAGE_KEY = "maxx.sidebar.collapsed-projects";
const PROJECTS_SECTION_COLLAPSED_STORAGE_KEY = "maxx.sidebar.projects-section-collapsed";
const CHATS_SECTION_COLLAPSED_STORAGE_KEY = "maxx.sidebar.chats-section-collapsed";

interface ThreadMenuTarget {
  hostID: string;
  projectID: string;
  threadID: string;
  title: string;
  pinned: boolean;
  x: number;
  y: number;
}

function loadCollapsedProjectIDs(): Set<string> {
  try {
    const stored = window.localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY);
    if (!stored) return new Set();
    const projectIDs: unknown = JSON.parse(stored);
    return Array.isArray(projectIDs)
      ? new Set(projectIDs.filter((projectID): projectID is string => typeof projectID === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function loadProjectsSectionCollapsed(): boolean {
  try {
    return window.localStorage.getItem(PROJECTS_SECTION_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function loadChatsSectionCollapsed(): boolean {
  try {
    return window.localStorage.getItem(CHATS_SECTION_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function Sidebar() {
  const workspace = useAppStore((state) => state.workspace);
  const remoteSessions = useAppStore((state) => state.remoteSessions);
  const hostStatus = useAppStore((state) => state.hostStatus);
  const selectedThreadID = useAppStore((state) => state.selectedThreadID);
  const selectThread = useAppStore((state) => state.selectThread);
  const addProject = useAppStore((state) => state.addProject);
  const removeProject = useAppStore((state) => state.removeProject);
  const removeThread = useAppStore((state) => state.removeThread);
  const startNewThread = useAppStore((state) => state.startNewThread);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const agentsOpen = useAppStore((state) => state.agentsOpen);
  const setAgentsOpen = useAppStore((state) => state.setAgentsOpen);
  const searchOpen = useAppStore((state) => state.searchOpen);
  const setSearchOpen = useAppStore((state) => state.setSearchOpen);
  const setRenamingThread = useAppStore((state) => state.setRenamingThread);
  const activeTurns = useAppStore((state) => state.activeTurnByThread);
  const unseenThreads = useAppStore((state) => state.unseenThreadIDs);
  const attentionFilterOpen = useAppStore((state) => state.attentionFilterOpen);
  const toggleAttentionFilter = useAppStore((state) => state.toggleAttentionFilter);
  const [collapsedProjectIDs, setCollapsedProjectIDs] = useState(loadCollapsedProjectIDs);
  const [projectsSectionCollapsed, setProjectsSectionCollapsed] = useState(loadProjectsSectionCollapsed);
  const [chatsSectionCollapsed, setChatsSectionCollapsed] = useState(loadChatsSectionCollapsed);
  const [pinnedThreadIDs, setPinnedThreadIDs] = useState(loadPinnedThreadIDs);
  const [openProjectMenuID, setOpenProjectMenuID] = useState<string | null>(null);
  const [threadMenu, setThreadMenu] = useState<ThreadMenuTarget | null>(null);
  const [addingOnHost, setAddingOnHost] = useState<{ id: string; name: string } | null>(null);
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  /** Attention row being read: stays listed until selection moves on. */
  const [stickyAttention, setStickyAttention] = useState<StickyAttentionRef | null>(null);

  const catalog = useMemo(() => {
    let next = emptyCatalog(
      workspace ?? {
        schemaVersion: 7,
        projects: [],
        providerProfiles: [],
        agents: [],
        voice: { isEnabled: false, useGrokSignIn: false, language: "en", apiBase: "https://api.x.ai" },
      },
      hostStatus?.name ?? "This Mac",
    );
    for (const session of remoteSessions) {
      next = attachRemote(next, session.host, session.workspace);
    }
    return next;
  }, [hostStatus?.name, remoteSessions, workspace]);
  const visibleProjects = hostedProjects(catalog).filter(({ project }) => !isChatsProject(project));
  const offlineHostIDs = new Set(
    hostStatus?.remotes.filter((remote) => !remote.connected).map((remote) => remote.id) ?? [],
  );
  const chatsProject = catalog.local.projects.find(isChatsProject);
  const combinedWorkspace = mergedWorkspace(catalog);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPinnedThreadIDs((current) => {
      const next = prunePinnedThreadIDs(current, combinedWorkspace);
      if (next !== current) persistPinnedThreadIDs(next);
      return next;
    });
  }, [combinedWorkspace]);

  useEffect(() => {
    if (
      stickyAttention
      && (!attentionFilterOpen || stickyAttention.threadID !== selectedThreadID)
    ) {
      setStickyAttention(null);
    }
  }, [attentionFilterOpen, stickyAttention, selectedThreadID]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_PROJECTS_STORAGE_KEY,
        JSON.stringify([...collapsedProjectIDs]),
      );
    } catch {
      // Collapsing still works for the current session when storage is unavailable.
    }
  }, [collapsedProjectIDs]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PROJECTS_SECTION_COLLAPSED_STORAGE_KEY,
        String(projectsSectionCollapsed),
      );
    } catch {
      // The section still collapses for the current session when storage is unavailable.
    }
  }, [projectsSectionCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CHATS_SECTION_COLLAPSED_STORAGE_KEY,
        String(chatsSectionCollapsed),
      );
    } catch {
      // The section still collapses for the current session when storage is unavailable.
    }
  }, [chatsSectionCollapsed]);

  useEffect(() => {
    if (!openProjectMenuID) return;
    const close = (event: PointerEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) {
        setOpenProjectMenuID(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenProjectMenuID(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openProjectMenuID]);

  useEffect(() => {
    if (!threadMenu) return;
    const close = (event: PointerEvent) => {
      if (!threadMenuRef.current?.contains(event.target as Node)) setThreadMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThreadMenu(null);
    };
    const closeOnViewportChange = () => setThreadMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [threadMenu]);

  const hosts = [
    { id: LOCAL_HOST_ID, name: hostStatus?.name ?? "This Mac" },
    ...remoteSessions.map((session) => ({ id: session.host.id, name: session.host.name })),
  ];

  const pickFolderOnHost = async (hostId: string, hostName: string) => {
    setHostPickerOpen(false);
    if (isLocalHost(hostId)) {
      const folder = await ipc.openProjectDialog();
      if (folder) await addProject(folder, LOCAL_HOST_ID);
      return;
    }
    setAddingOnHost({ id: hostId, name: hostName });
  };

  const pickFolder = async () => {
    if (remoteSessions.length === 0) {
      await pickFolderOnHost(LOCAL_HOST_ID, hostStatus?.name ?? "This Mac");
      return;
    }
    setHostPickerOpen((open) => !open);
  };

  const toggleProject = (projectID: string) => {
    setCollapsedProjectIDs((current) => {
      const next = new Set(current);
      if (next.has(projectID)) next.delete(projectID);
      else next.add(projectID);
      return next;
    });
  };

  const toggleProjectsSection = () => {
    if (!projectsSectionCollapsed) setOpenProjectMenuID(null);
    setProjectsSectionCollapsed((current) => !current);
  };

  const updateThreadPin = (threadID: string, pinned: boolean) => {
    setPinnedThreadIDs((current) => {
      const next = setThreadPinned(current, threadID, pinned);
      if (next !== current) persistPinnedThreadIDs(next);
      return next;
    });
  };

  const openThreadMenu = (
    event: ReactMouseEvent,
    hostID: string,
    projectID: string,
    thread: ChatThread,
    pinned: boolean,
  ) => {
    event.preventDefault();
    setOpenProjectMenuID(null);
    const surface = document.querySelector<HTMLElement>(".zoom-surface");
    const bounds = surface?.getBoundingClientRect();
    const scale = surface && bounds && surface.clientWidth > 0
      ? bounds.width / surface.clientWidth
      : 1;
    const x = (event.clientX - (bounds?.left ?? 0)) / scale;
    const y = (event.clientY - (bounds?.top ?? 0)) / scale;
    const availableWidth = surface?.clientWidth ?? window.innerWidth;
    const availableHeight = surface?.clientHeight ?? window.innerHeight;
    setThreadMenu({
      hostID,
      projectID,
      threadID: thread.id,
      title: thread.title,
      pinned,
      x: Math.max(8, Math.min(x, availableWidth - 172)),
      y: Math.max(8, Math.min(y, availableHeight - 112)),
    });
  };

  const openRenameDialog = (hostID: string, projectID: string, threadID: string) => {
    setThreadMenu(null);
    setRenamingThread({ hostID, projectID, threadID });
  };

  const attentionItems = useMemo(
    () => attentionThreads(combinedWorkspace, activeTurns, unseenThreads, selectedThreadID),
    [activeTurns, combinedWorkspace, selectedThreadID, unseenThreads],
  );
  const attentionDisplay = useMemo(
    () => withStickyAttention(attentionItems, combinedWorkspace, stickyAttention, selectedThreadID),
    [attentionItems, combinedWorkspace, selectedThreadID, stickyAttention],
  );
  const { attentionThreadIDs, attentionProjectIDs, attentionReasons } = useMemo(
    () => ({
      attentionThreadIDs: new Set(attentionDisplay.map((item) => item.thread.id)),
      attentionProjectIDs: new Set(attentionDisplay.map((item) => item.project.id)),
      attentionReasons: new Map(
        attentionItems.map((item) => [item.thread.id, item.reason] as const),
      ),
    }),
    [attentionDisplay, attentionItems],
  );
  const pinnedItems = useMemo(
    () => pinnedThreads(combinedWorkspace, pinnedThreadIDs),
    [combinedWorkspace, pinnedThreadIDs],
  );
  const hostIdForProject = (projectID: string) =>
    visibleProjects.find((item) => item.project.id === projectID)?.hostId ?? LOCAL_HOST_ID;
  const pinnedThreadIDSet = useMemo(
    () => new Set(pinnedItems.map((item) => item.thread.id)),
    [pinnedItems],
  );
  const projectsExpanded = attentionFilterOpen || !projectsSectionCollapsed;
  const chatsVisible = !attentionFilterOpen || attentionProjectIDs.has(CHATS_PROJECT_ID);
  const chatsExpanded = attentionFilterOpen || !chatsSectionCollapsed;
  const chatThreads = chatsProject?.threads.filter((thread) => !thread.parentThreadID) ?? [];

  return (
    <aside className="sidebar">
      {/* Drag strip only. The sidebar toggle that used to live here is now
          window-anchored (`SidebarToggle`) so it does not ride the collapse. */}
      <div className="sidebar-titlebar" onMouseDown={beginWindowDrag}>
        <span className="traffic-light-spacer" aria-hidden="true" />
        <span className="window-sidebar-toggle-cutout" aria-hidden="true" />
      </div>

      <div className="sidebar-heading-row" onMouseDown={beginWindowDrag}>
        <span className="sidebar-app-title">Maxx</span>
        <button
          type="button"
          className={`icon-button sidebar-search-button ${searchOpen ? "active" : ""}`}
          title="Search (⌘K)"
          aria-label="Search"
          onClick={() => setSearchOpen(true)}
        >
          <Icons.search size={15} />
        </button>
        <button
          type="button"
          className={`icon-button attention-bell ${attentionFilterOpen ? "active" : ""} ${attentionItems.length > 0 ? "has-attention" : ""}`}
          title={attentionFilterOpen ? "Show all chats (⌥⌘U)" : "Show unread and waiting (⌥⌘U)"}
          aria-label={attentionFilterOpen ? "Show all chats" : "Show unread and waiting chats"}
          aria-pressed={attentionFilterOpen}
          onClick={toggleAttentionFilter}
        >
          <Icons.bell size={15} />
          <span className="bell-dot" aria-hidden="true" />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        <button className="nav-row" onClick={() => startNewThread(null, LOCAL_HOST_ID)}>
          <Icons.compose size={15} />
          <span>New chat</span>
          <kbd>⌘N</kbd>
        </button>
        <button
          className={`nav-row ${agentsOpen ? "active" : ""}`}
          onClick={() => setAgentsOpen(true)}
        >
          <Icons.robot size={15} />
          <span>Agents</span>
        </button>
      </nav>

      <section
        className={`repositories-section ${attentionFilterOpen ? "attention-filter-open" : ""}`}
        aria-label={attentionFilterOpen ? "Chats needing attention" : "Projects"}
      >
        <div className="sidebar-navigation-scroll">
          {pinnedItems.length > 0 && (
            <section
              className={`pinned-section sidebar-filter-block ${attentionFilterOpen ? "is-filtered-out" : ""}`}
              aria-labelledby="pinned-section-label"
              aria-hidden={attentionFilterOpen}
            >
              <div className="sidebar-filter-block-inner" inert={attentionFilterOpen}>
                <div className="sidebar-section-label" id="pinned-section-label">Pinned</div>
                <ul className="thread-list pinned-thread-list">
                  {pinnedItems.map(({ project, thread }) => (
                    <li key={thread.id} className="thread-list-item">
                      <div className="thread-list-item-inner">
                        <ThreadRow
                          thread={thread}
                          selected={thread.id === selectedThreadID}
                          activity={threadActivity(thread, activeTurns)}
                          unseen={Boolean(unseenThreads[thread.id]) && thread.id !== selectedThreadID}
                          pinned
                          onSelect={() => selectThread(project.id, thread.id, hostIdForProject(project.id))}
                          onRename={() => openRenameDialog(hostIdForProject(project.id), project.id, thread.id)}
                          onContextMenu={(event) => openThreadMenu(
                            event,
                            hostIdForProject(project.id),
                            project.id,
                            thread,
                            true,
                          )}
                          onTogglePin={() => updateThreadPin(thread.id, false)}
                          onDelete={() => void removeThread(project.id, thread.id)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <header className="repositories-header">
            <button
              type="button"
              className="repositories-disclosure"
              aria-expanded={projectsExpanded}
              aria-controls="sidebar-projects"
              title={attentionFilterOpen ? "Projects are expanded while filtering" : undefined}
              disabled={attentionFilterOpen}
              onClick={toggleProjectsSection}
            >
              <span>Projects</span>
              <Icons.chevronRight
                size={11}
                className={`repositories-chevron ${projectsExpanded ? "is-expanded" : ""}`}
              />
            </button>
            <button
              type="button"
              className="icon-button repositories-add"
              title="Open project folder"
              aria-label="Open project folder"
              onClick={() => void pickFolder()}
            >
              <Icons.plus size={15} />
            </button>
            {hostPickerOpen && (
              <div className="host-choice-menu" role="menu" aria-label="Add project on host">
                {hosts.map((host) => (
                  <button
                    key={host.id}
                    type="button"
                    className="host-choice-item"
                    role="menuitem"
                    onClick={() => void pickFolderOnHost(host.id, host.name)}
                  >
                    <Icons.computer size={15} />
                    <span>{isLocalHost(host.id) ? `${host.name} (this Mac)` : host.name}</span>
                  </button>
                ))}
              </div>
            )}
          </header>

          <div
            className={`projects-reveal ${projectsExpanded ? "is-expanded" : ""}`}
            id="sidebar-projects"
            aria-hidden={!projectsExpanded}
            inert={!projectsExpanded}
          >
            <div className="projects-reveal-inner">
              <div className="projects-list">
                {visibleProjects.length === 0 && !attentionFilterOpen && (
                  <button className="empty-project-cta" onClick={() => void pickFolder()}>
                    <Icons.folder size={15} />
                    <span>Open a project folder</span>
                  </button>
                )}

                <div
                  className={`attention-empty ${attentionFilterOpen && attentionDisplay.length === 0 ? "is-visible" : ""}`}
                  aria-hidden={!attentionFilterOpen || attentionDisplay.length > 0}
                >
                  <div
                    className="attention-empty-inner"
                    inert={!attentionFilterOpen || attentionDisplay.length > 0}
                  >
                    <span>All caught up</span>
                    <small>No unread or waiting chats.</small>
                  </div>
                </div>

                {visibleProjects.map(({ hostId, hostName, project }) => {
                  const remoteProject = !isLocalHost(hostId);
                  const remoteOffline = remoteProject && offlineHostIDs.has(hostId);
                  const projectVisible = !attentionFilterOpen || attentionProjectIDs.has(project.id);
                  const projectExpanded = attentionFilterOpen
                    ? projectVisible
                    : !collapsedProjectIDs.has(project.id);
                  const threadListID = `project-threads-${project.id}`;
                  return (
                    <section
                      key={project.id}
                      className={`project sidebar-filter-block ${projectVisible ? "" : "is-filtered-out"}`}
                      aria-hidden={!projectVisible}
                    >
                      <div className="sidebar-filter-block-inner" inert={!projectVisible}>
                        <header className={`project-header${openProjectMenuID === project.id ? " is-actions-open" : ""}`}>
                          <button
                            type="button"
                            className="project-disclosure"
                            aria-label={remoteProject
                              ? `${projectName(project)} — Remote project on ${hostName}${remoteOffline ? ", offline" : ""}`
                              : undefined}
                            aria-expanded={projectExpanded}
                            aria-controls={threadListID}
                            title={attentionFilterOpen ? "Expanded while filtering" : undefined}
                            disabled={attentionFilterOpen}
                            onClick={(event) => {
                              toggleProject(project.id);
                              if (event.detail > 0) event.currentTarget.blur();
                            }}
                          >
                            <ProjectFolderIcon
                              expanded={projectExpanded}
                              remote={remoteProject}
                              hostName={hostName}
                            />
                            <span className="project-name" title={project.folderPath}>{projectName(project)}</span>
                          </button>
                          {remoteProject && (
                            <span
                              className={`project-host-label is-remote${remoteOffline ? " is-offline" : ""}`}
                              title={remoteOffline
                                ? `${hostName} is offline. Reconnecting…`
                                : `Remote host: ${hostName}`}
                            >
                              {remoteOffline && (
                                <span className="project-host-offline-indicator" aria-hidden="true">
                                  <Icons.warning size={12} />
                                </span>
                              )}
                              <span className="project-host-label-text">{hostName}</span>
                            </span>
                          )}
                          <span
                            className={`project-header-actions ${openProjectMenuID === project.id ? "is-open" : ""}`}
                          >
                            <div className="project-menu" ref={openProjectMenuID === project.id ? projectMenuRef : undefined}>
                              <button
                                type="button"
                                className="icon-button"
                                title="Project actions"
                                aria-haspopup="menu"
                                aria-expanded={openProjectMenuID === project.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setOpenProjectMenuID((current) => (current === project.id ? null : project.id));
                                }}
                              >
                                <Icons.more size={15} />
                              </button>
                              {openProjectMenuID === project.id && (
                                <div className="project-menu-popover" role="menu" aria-label="Project actions">
                                  <button
                                    type="button"
                                    className="project-menu-item danger"
                                    role="menuitem"
                                    onClick={() => {
                                      setOpenProjectMenuID(null);
                                      void removeProject(project.id, hostId);
                                    }}
                                  >
                                    Remove project
                                  </button>
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              className="icon-button"
                              title="New chat in this project"
                              aria-label={`New chat in ${projectName(project)}`}
                              onClick={() => startNewThread(project.id, hostId)}
                            >
                              <Icons.compose size={15} />
                            </button>
                          </span>
                        </header>

                        <div
                          className={`project-threads-reveal ${projectExpanded ? "is-expanded" : ""}`}
                          id={threadListID}
                          aria-hidden={!projectExpanded}
                          inert={!projectExpanded}
                        >
                          <div className="project-threads-reveal-inner">
                            <ul className="thread-list">
                              {/* Side threads live in the reply panel, not the sidebar. */}
                              {project.threads.filter((thread) => !thread.parentThreadID).map((thread) => {
                                const pinned = pinnedThreadIDSet.has(thread.id);
                                const threadVisible = attentionFilterOpen
                                  ? attentionThreadIDs.has(thread.id)
                                  : !pinned;
                                return (
                                  <li
                                    key={thread.id}
                                    className={`thread-list-item ${threadVisible ? "" : "is-filtered-out"}`}
                                    aria-hidden={!threadVisible}
                                  >
                                    <div className="thread-list-item-inner" inert={!threadVisible}>
                                      <ThreadRow
                                        thread={thread}
                                        selected={thread.id === selectedThreadID}
                                        activity={threadActivity(thread, activeTurns)}
                                        unseen={Boolean(unseenThreads[thread.id]) && thread.id !== selectedThreadID}
                                        pinned={pinned}
                                        onSelect={() => {
                                          const reason = attentionReasons.get(thread.id);
                                          if (attentionFilterOpen && reason) {
                                            setStickyAttention({ threadID: thread.id, reason });
                                          }
                                          selectThread(project.id, thread.id, hostId);
                                        }}
                                        onRename={() => openRenameDialog(hostId, project.id, thread.id)}
                                        onContextMenu={(event) => openThreadMenu(event, hostId, project.id, thread, pinned)}
                                        onTogglePin={() => updateThreadPin(thread.id, !pinned)}
                                        onDelete={() => void removeThread(project.id, thread.id)}
                                      />
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        </div>
                      </div>
                    </section>
                  );
                })}
                {addingOnHost && (
                  <HostFolderPicker
                    hostId={addingOnHost.id}
                    hostName={addingOnHost.name}
                    onSelect={(folder) => {
                      const hostId = addingOnHost.id;
                      setAddingOnHost(null);
                      void addProject(folder, hostId);
                    }}
                    onCancel={() => setAddingOnHost(null)}
                  />
                )}
              </div>
            </div>
          </div>

          {chatsProject && chatThreads.length > 0 && (
            <section
              className={`chats-section sidebar-filter-block ${chatsVisible ? "" : "is-filtered-out"}`}
              aria-hidden={!chatsVisible}
            >
              <div className="sidebar-filter-block-inner" inert={!chatsVisible}>
                <header className="repositories-header chats-header">
                  <button
                    type="button"
                    className="repositories-disclosure"
                    aria-expanded={chatsExpanded}
                    aria-controls="sidebar-chats"
                    title={attentionFilterOpen ? "Chats are expanded while filtering" : undefined}
                    disabled={attentionFilterOpen}
                    onClick={() => setChatsSectionCollapsed((collapsed) => !collapsed)}
                  >
                    <span>Chats</span>
                    <Icons.chevronRight
                      size={11}
                      className={`repositories-chevron ${chatsExpanded ? "is-expanded" : ""}`}
                    />
                  </button>
                </header>
                <div
                  className={`projects-reveal ${chatsExpanded ? "is-expanded" : ""}`}
                  id="sidebar-chats"
                  aria-hidden={!chatsExpanded}
                  inert={!chatsExpanded}
                >
                  <div className="projects-reveal-inner">
                    <ul className="thread-list chats-thread-list">
                      {chatThreads.map((thread) => {
                        const pinned = pinnedThreadIDSet.has(thread.id);
                        const threadVisible = attentionFilterOpen
                          ? attentionThreadIDs.has(thread.id)
                          : !pinned;
                        return (
                          <li
                            key={thread.id}
                            className={`thread-list-item ${threadVisible ? "" : "is-filtered-out"}`}
                            aria-hidden={!threadVisible}
                          >
                            <div className="thread-list-item-inner" inert={!threadVisible}>
                              <ThreadRow
                                thread={thread}
                                selected={thread.id === selectedThreadID}
                                activity={threadActivity(thread, activeTurns)}
                                unseen={Boolean(unseenThreads[thread.id]) && thread.id !== selectedThreadID}
                                pinned={pinned}
                                onSelect={() => {
                                  const reason = attentionReasons.get(thread.id);
                                  if (attentionFilterOpen && reason) {
                                    setStickyAttention({ threadID: thread.id, reason });
                                  }
                                  selectThread(CHATS_PROJECT_ID, thread.id, LOCAL_HOST_ID);
                                }}
                                onRename={() => openRenameDialog(LOCAL_HOST_ID, CHATS_PROJECT_ID, thread.id)}
                                onContextMenu={(event) => openThreadMenu(
                                  event,
                                  LOCAL_HOST_ID,
                                  CHATS_PROJECT_ID,
                                  thread,
                                  pinned,
                                )}
                                onTogglePin={() => updateThreadPin(thread.id, !pinned)}
                                onDelete={() => void removeThread(CHATS_PROJECT_ID, thread.id)}
                              />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </section>

      <nav className="sidebar-footer" aria-label="Settings">
        <SidebarUpdateButton />
        <button
          className={`nav-row ${settingsOpen ? "active" : ""}`}
          onClick={() => setSettingsOpen(true)}
        >
          <Icons.settings size={15} />
          <span>Settings</span>
          <kbd>⌘,</kbd>
        </button>
      </nav>

      {threadMenu && createPortal((
        <div
          ref={threadMenuRef}
          className="thread-context-menu"
          role="menu"
          aria-label={`Actions for ${threadMenu.title}`}
          style={{ left: threadMenu.x, top: threadMenu.y }}
        >
          <button
            type="button"
            className="thread-context-menu-item"
            role="menuitem"
            onClick={() => {
              updateThreadPin(threadMenu.threadID, !threadMenu.pinned);
              setThreadMenu(null);
            }}
          >
            {threadMenu.pinned ? "Unpin chat" : "Pin chat"}
          </button>
          <button
            type="button"
            className="thread-context-menu-item"
            role="menuitem"
            onClick={() => openRenameDialog(
              threadMenu.hostID,
              threadMenu.projectID,
              threadMenu.threadID,
            )}
          >
            Rename chat
          </button>
          <div className="thread-context-menu-separator" role="separator" />
          <button
            type="button"
            className="thread-context-menu-item danger"
            role="menuitem"
            onClick={() => {
              void removeThread(threadMenu.projectID, threadMenu.threadID);
              setThreadMenu(null);
            }}
          >
            Delete chat
          </button>
        </div>
      ), document.querySelector(".zoom-surface") ?? document.body)}
    </aside>
  );
}

function ThreadRow({
  thread,
  selected,
  activity,
  unseen,
  pinned,
  onSelect,
  onRename,
  onContextMenu,
  onTogglePin,
  onDelete,
}: {
  thread: ChatThread;
  selected: boolean;
  activity: ReturnType<typeof threadActivity>;
  unseen: boolean;
  pinned: boolean;
  onSelect: () => void;
  onRename: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const busy = activity.status === "running" || activity.status === "waiting";
  const statusLabel =
    activity.status === "running"
      ? "Running"
      : activity.status === "waiting"
        ? "Waiting for input"
        : unseen
          ? "Finished while away"
          : undefined;

  return (
    <div
      className={`thread-row ${selected ? "selected" : ""}`}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className="thread-row-select"
        onClick={onSelect}
        onDoubleClick={onRename}
        aria-busy={busy || undefined}
        aria-current={selected ? "page" : undefined}
        aria-label={statusLabel ? `${thread.title}, ${statusLabel}` : thread.title}
      >
        <ThreadStateMark activity={activity} unseen={unseen} />
        <span className="thread-title" title={thread.title}>{thread.title}</span>
        <span className="thread-time">{relativeTime(thread.updatedAt)}</span>
      </button>
      <span className="thread-actions">
        <button
          type="button"
          className="icon-button thread-pin"
          aria-label={`${pinned ? "Unpin" : "Pin"} ${thread.title}`}
          title={pinned ? "Unpin thread" : "Pin thread"}
          aria-pressed={pinned}
          onClick={onTogglePin}
        >
          {pinned ? <Icons.pinFilled size={15} /> : <Icons.pin size={15} />}
        </button>
        <button
          type="button"
          className="icon-button thread-delete"
          aria-label={`Delete ${thread.title}`}
          title="Delete thread"
          onClick={onDelete}
        >
          <Icons.trash size={15} />
        </button>
      </span>
    </div>
  );
}

/** Activity mark: idle spacer, running spinner, waiting pulse, unseen dot. */
function ThreadStateMark({
  activity,
  unseen,
}: {
  activity: ReturnType<typeof threadActivity>;
  unseen: boolean;
}) {
  if (activity.status === "running") {
    return (
      <span className="thread-state running" title="Running" aria-hidden="true">
        <span className="mini-spinner thread-activity-spinner" />
      </span>
    );
  }
  if (activity.status === "waiting") {
    return (
      <span
        className="thread-state waiting"
        title="Waiting for input"
        aria-hidden="true"
      >
        <span className="thread-waiting-dot" />
      </span>
    );
  }
  if (unseen) {
    return (
      <span className="thread-state unseen" title="Finished while away" aria-hidden="true">
        <span className="thread-unseen-dot" />
      </span>
    );
  }
  return <span className="thread-state idle" aria-hidden="true" />;
}
