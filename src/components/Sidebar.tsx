import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ipc } from "../ipc";
import { CHATS_PROJECT_ID, DEFAULT_COMPUTER_USE_SETTINGS, isChatsProject, projectName } from "../contract/types";
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
import { IconButton } from "./ui/icon-button";
import { SidebarUpdateButton } from "./SidebarUpdateButton";
import { ProjectFolderIcon } from "./ProjectFolderIcon";
import { SettingsNavigation } from "./SettingsNavigation";
import { DEFAULT_VOICE_SETTINGS } from "../voice/types";

const COLLAPSED_PROJECTS_STORAGE_KEY = "maxx.sidebar.collapsed-projects";
const PROJECTS_SECTION_COLLAPSED_STORAGE_KEY = "maxx.sidebar.projects-section-collapsed";
const CHATS_SECTION_COLLAPSED_STORAGE_KEY = "maxx.sidebar.chats-section-collapsed";

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

export function Sidebar({
  settingsQuery,
  onSettingsQueryChange,
}: {
  settingsQuery: string;
  onSettingsQueryChange: (query: string) => void;
}) {
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
  const automationsOpen = useAppStore((state) => state.automationsOpen);
  const setAutomationsOpen = useAppStore((state) => state.setAutomationsOpen);
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
        voice: DEFAULT_VOICE_SETTINGS,
        computerUse: DEFAULT_COMPUTER_USE_SETTINGS,
      },
      hostStatus?.name ?? "This computer",
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
  const attentionProjects = useMemo(
    () => [
      ...visibleProjects.map(({ project }) => project),
      ...(chatsProject ? [chatsProject] : []),
    ],
    [chatsProject, visibleProjects],
  );

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
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void ipc.onContextMenuAction((payload) => {
      if (payload.kind === "thread" && payload.threadID && payload.hostID) {
        if (payload.action === "pin") {
          setPinnedThreadIDs((current) => {
            const next = setThreadPinned(current, payload.threadID!, !payload.pinned);
            if (next !== current) persistPinnedThreadIDs(next);
            return next;
          });
        }
        if (payload.action === "rename") openRenameDialog(payload.hostID, payload.projectID, payload.threadID);
        if (payload.action === "delete") void removeThread(payload.projectID, payload.threadID);
      }
      if (payload.kind === "project" && payload.action === "remove_project" && payload.hostID) {
        void removeProject(payload.projectID, payload.hostID);
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [removeProject, removeThread]);

  const hosts = [
    { id: LOCAL_HOST_ID, name: hostStatus?.name ?? "This computer" },
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
      await pickFolderOnHost(LOCAL_HOST_ID, hostStatus?.name ?? "This computer");
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
    void ipc.openContextMenu({
      kind: "thread",
      x: event.clientX,
      y: event.clientY,
      hostID,
      projectID,
      threadID: thread.id,
      pinned,
    });
  };

  const openRenameDialog = (hostID: string, projectID: string, threadID: string) => {
    setRenamingThread({ hostID, projectID, threadID });
  };

  const openProjectMenu = (event: ReactMouseEvent, hostID: string, projectID: string) => {
    event.stopPropagation();
    const triggerBounds = event.currentTarget.getBoundingClientRect();
    void ipc.openContextMenu({
      kind: "project",
      x: triggerBounds.right,
      y: triggerBounds.bottom,
      hostID,
      projectID,
    });
  };

  const attentionItems = useMemo(
    () => attentionThreads(attentionProjects, activeTurns, unseenThreads, selectedThreadID),
    [activeTurns, attentionProjects, selectedThreadID, unseenThreads],
  );
  const attentionDisplay = useMemo(
    () => withStickyAttention(attentionItems, attentionProjects, stickyAttention, selectedThreadID),
    [attentionItems, attentionProjects, selectedThreadID, stickyAttention],
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

      {settingsOpen ? (
        <SettingsNavigation
          query={settingsQuery}
          onQueryChange={onSettingsQueryChange}
          onBack={() => setSettingsOpen(false)}
        />
      ) : (
        <>

      <div className="sidebar-heading-row" onMouseDown={beginWindowDrag}>
        <span className="sidebar-app-title">Maxx</span>
        <IconButton
          className={`sidebar-search-button ${searchOpen ? "active" : ""}`}
          label="Search"
          tooltip="Search (⌘K)"
          onClick={() => setSearchOpen(true)}
        >
          <Icons.search />
        </IconButton>
        <IconButton
          className={`attention-bell ${attentionFilterOpen ? "active" : ""} ${attentionItems.length > 0 ? "has-attention" : ""}`}
          label={attentionFilterOpen ? "Show all chats" : "Show unread and waiting chats"}
          tooltip={attentionFilterOpen ? "Show all chats (⌥⌘U)" : "Show unread and waiting (⌥⌘U)"}
          aria-pressed={attentionFilterOpen}
          onClick={toggleAttentionFilter}
        >
          <Icons.bell />
          <span className="bell-dot" aria-hidden="true" />
        </IconButton>
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        <Button variant="ghost" className="nav-row justify-start" onClick={() => startNewThread(null, LOCAL_HOST_ID)}>
          <Icons.compose data-icon="inline-start" />
          <span>New chat</span>
          <kbd>⌘N</kbd>
        </Button>
        <Button
          variant="ghost"
          className={`nav-row justify-start ${agentsOpen ? "active" : ""}`}
          onClick={() => setAgentsOpen(true)}
        >
          <Icons.robot data-icon="inline-start" />
          <span>Agents</span>
        </Button>
        <Button
          variant="ghost"
          className={`nav-row justify-start ${automationsOpen ? "active" : ""}`}
          onClick={() => setAutomationsOpen(true)}
        >
          <Icons.clock data-icon="inline-start" />
          <span>Automations</span>
        </Button>
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
            <Button
              type="button"
              variant="ghost"
              className="repositories-disclosure w-full justify-start"
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
            </Button>
            {remoteSessions.length === 0 ? (
              <IconButton
                className="repositories-add"
                label="Open project folder"
                tooltip="Open project folder"
                onClick={() => void pickFolder()}
              >
                <Icons.plus />
              </IconButton>
            ) : (
              <DropdownMenu open={hostPickerOpen} onOpenChange={setHostPickerOpen}>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="repositories-add" />}>
                  <Icons.plus />
                  <span className="sr-only">Open project folder</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" aria-label="Add project on host">
                  <DropdownMenuGroup>
                    {hosts.map((host) => (
                      <DropdownMenuItem
                        key={host.id}
                        onClick={() => void pickFolderOnHost(host.id, host.name)}
                      >
                        <Icons.computer />
                        <span>{isLocalHost(host.id) ? `${host.name} (this computer)` : host.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
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
                  <Button variant="ghost" className="empty-project-cta" onClick={() => void pickFolder()}>
                    <Icons.folder data-icon="inline-start" />
                    <span>Open a project folder</span>
                  </Button>
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
                        <header className="project-header">
                          <Button
                            type="button"
                            variant="ghost"
                            className="project-disclosure justify-start hover:bg-transparent!"
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
                          </Button>
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
                          <span className="project-header-actions">
                            <IconButton
                              className="project-menu"
                              size="icon-xs"
                              label="Project actions"
                              tooltip="Project actions"
                              onClick={(event) => openProjectMenu(event, hostId, project.id)}
                            >
                              <Icons.more />
                            </IconButton>
                            <IconButton
                              size="icon-xs"
                              label={`New chat in ${projectName(project)}`}
                              tooltip="New chat in this project"
                              onClick={() => startNewThread(project.id, hostId)}
                            >
                              <Icons.compose />
                            </IconButton>
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
                  <Button
                    type="button"
                    variant="ghost"
                    className="repositories-disclosure w-full justify-start"
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
                  </Button>
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
        <Button
          variant="ghost"
          className={`nav-row ${settingsOpen ? "active" : ""}`}
          onClick={() => setSettingsOpen(true)}
        >
          <Icons.settings data-icon="inline-start" />
          <span>Settings</span>
          <kbd>⌘,</kbd>
        </Button>
      </nav>
        </>
      )}
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
      <Button
        type="button"
        variant="ghost"
        className="thread-row-select pr-0! hover:bg-transparent!"
        onClick={onSelect}
        onDoubleClick={onRename}
        aria-busy={busy || undefined}
        aria-current={selected ? "page" : undefined}
        aria-label={statusLabel ? `${thread.title}, ${statusLabel}` : thread.title}
      >
        <ThreadStateMark activity={activity} unseen={unseen} />
        <span className="thread-title" title={thread.title}>{thread.title}</span>
        <span className="thread-time">{relativeTime(thread.updatedAt)}</span>
      </Button>
      <span className="thread-actions">
        <IconButton
          className="thread-pin"
          size="icon-xs"
          label={`${pinned ? "Unpin" : "Pin"} ${thread.title}`}
          tooltip={pinned ? "Unpin thread" : "Pin thread"}
          aria-pressed={pinned}
          onClick={onTogglePin}
        >
          {pinned ? <Icons.pinFilled /> : <Icons.pin />}
        </IconButton>
        <IconButton
          className="thread-delete"
          size="icon-xs"
          label={`Delete ${thread.title}`}
          tooltip="Delete thread"
          onClick={onDelete}
        >
          <Icons.trash />
        </IconButton>
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
        <Spinner className="size-3" />
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
