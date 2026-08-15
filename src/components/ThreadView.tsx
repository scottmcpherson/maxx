import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { buildTimeline } from "../contract/timeline";
import { bylineAnchors, buildRows, rendersRow, TimelineRow } from "../contract/timelineRows";
import {
  AgentDefinition,
  ChatProject,
  ChatThread,
  ProviderProfile,
  projectName,
  RuntimeInteractionDecision,
} from "../contract/types";
import { formatKeyboardShortcut } from "../keyboardShortcuts";
import { parseMessageContent } from "../media";
import { providerSupportsSteering } from "../messageQueue";
import { mentionedAgents, splitMentions } from "../mentions";
import { relativeTime } from "../relativeTime";
import { useAppStore } from "../store/appStore";
import { showsPinnedSummary } from "../summary";
import { beginWindowDrag } from "../windowDrag";
import { ipc } from "../ipc";
import {
  threadWorkingDirectory,
} from "../git";
import { useDictation } from "../voice/useDictation";
import { AgentAvatar } from "./AgentAvatar";
import { AgentHoverCard } from "./AgentHoverCard";
import { DictationButton, DictationStatus } from "./DictationButton";
import { ActivityCard, InteractionCard } from "./EventCards";
import { ContextRail, SummaryToggle } from "./ThreadSummary";
import { Icons } from "./Icons";
import { MentionMenu, useMentionMenu } from "./MentionMenu";
import { MentionTextarea } from "./MentionTextarea";
import { SlashCommandMenu, useSlashCommandMenu } from "./SlashCommandMenu";
import { MessageMedia } from "./MessageMedia";
import { AttachImagesButton, PendingImageStrip, useImageAttachments } from "./ImageAttachments";
import { RuntimePicker } from "./RuntimePicker";
import { QueuedMessages } from "./QueuedMessages";
import { BrowserAnnotationPills } from "./BrowserAnnotationPills";
import { GitEnvironment } from "./GitEnvironment";
import { SideThreadPanel } from "./SideThreadPanel";
import { SideThreadResizer } from "./SideThreadResizer";
import { TerminalView, type TerminalViewHandle } from "./TerminalView";
import { HostFolderPicker } from "./HostFolderPicker";
import { NewThreadContextBar } from "./NewThreadContextBar";

// Stable references so Streamdown's memoization survives re-renders.
const markdownPlugins = { code };
const EMPTY_BROWSER_ANNOTATIONS = [] as const;

function Markdown({
  text,
  isAnimating,
  projectID,
  threadID,
  hostID,
}: {
  text: string;
  isAnimating: boolean;
  projectID?: string;
  threadID?: string;
  hostID?: string;
}) {
  const segments = useMemo(() => parseMessageContent(text), [text]);
  return (
    <div className="message-content">
      {segments.map((segment) => segment.kind === "markdown" ? (
        <Streamdown
          key={segment.id}
          className="markdown-body"
          animated
          plugins={markdownPlugins}
          isAnimating={isAnimating}
        >
          {segment.text}
        </Streamdown>
      ) : projectID && threadID ? (
        <MessageMedia key={segment.id} media={segment.media} projectID={projectID} threadID={threadID} hostID={hostID} />
      ) : null)}
    </div>
  );
}

export type { TimelineRow };
export { buildRows };

/**
 * `summaryFits` comes from `App`, which owns the two pane widths the rail has
 * to fit around. It is the *layout* verdict only; whether the slot is already
 * taken (an open side thread) is decided here.
 */
export function ThreadView({
  summaryFits,
  browserExpanded = false,
}: {
  summaryFits: boolean;
  browserExpanded?: boolean;
}) {
  const workspace = useAppStore((state) => state.workspace);
  const remoteSessions = useAppStore((state) => state.remoteSessions);
  const selectedHostID = useAppStore((state) => state.selectedHostID);
  const selectedProjectID = useAppStore((state) => state.selectedProjectID);
  const selectedThreadID = useAppStore((state) => state.selectedThreadID);
  const activeTurns = useAppStore((state) => state.activeTurnByThread);
  const queuedMessagesByThread = useAppStore((state) => state.queuedMessagesByThread);
  const sendingMessageByThread = useAppStore((state) => state.sendingMessageByThread);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const steerQueuedMessage = useAppStore((state) => state.steerQueuedMessage);
  const retryQueuedMessage = useAppStore((state) => state.retryQueuedMessage);
  const removeQueuedMessage = useAppStore((state) => state.removeQueuedMessage);
  const startSideThread = useAppStore((state) => state.startSideThread);
  const openSideThreadID = useAppStore((state) => state.openSideThreadID);
  const setOpenSideThreadID = useAppStore((state) => state.setOpenSideThreadID);
  const cancelActiveTurn = useAppStore((state) => state.cancelActiveTurn);
  const resolveRequest = useAppStore((state) => state.resolveRequest);
  const updateThreadRuntime = useAppStore((state) => state.updateThreadRuntime);
  const startNewThread = useAppStore((state) => state.startNewThread);
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);
  const summaryPinned = useAppStore((state) => state.summaryPinned);
  const browserOpen = useAppStore((state) => state.browserOpen);
  const toggleBrowser = useAppStore((state) => state.toggleBrowser);
  const toggleBrowserShortcut = useAppStore((state) => state.keyboardShortcuts.toggleBrowser);
  const dictationShortcut = useAppStore((state) => state.keyboardShortcuts.toggleDictation);
  const voiceEnabled = useAppStore((state) => state.workspace?.voice.isEnabled ?? false);
  const error = useAppStore((state) => state.error);
  const browserAnnotations = useAppStore((state) => selectedThreadID
    ? state.browserAnnotationsByThread[selectedThreadID] ?? EMPTY_BROWSER_ANNOTATIONS
    : EMPTY_BROWSER_ANNOTATIONS);
  const clearBrowserAnnotations = useAppStore((state) => state.clearBrowserAnnotations);
  const terminalModeEnabled = useAppStore((state) => state.terminalModeEnabled);
  const refresh = useAppStore((state) => state.refresh);
  const terminalViewRef = useRef<TerminalViewHandle>(null);
  const [switchingSurface, setSwitchingSurface] = useState(false);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);

  const projectWorkspace = useMemo(() => {
    if (!selectedHostID || selectedHostID === "local") return workspace;
    return remoteSessions.find((session) => session.host.id === selectedHostID)?.workspace ?? workspace;
  }, [remoteSessions, selectedHostID, workspace]);
  const project = useMemo(
    () => projectWorkspace?.projects.find((candidate) => candidate.id === selectedProjectID),
    [projectWorkspace, selectedProjectID],
  );
  const thread = useMemo(
    () => project?.threads.find((candidate) => candidate.id === selectedThreadID),
    [project, selectedThreadID],
  );
  const timeline = useMemo(
    () => (thread ? buildTimeline(thread.runtimeEvents) : []),
    [thread],
  );
  const terminalTurnIDs = useMemo(
    () => new Set(timeline.filter((item) => item.type === "terminal").map((item) => item.turnID)),
    [timeline],
  );
  const rows = useMemo(() => buildRows(thread, timeline), [thread, timeline]);

  const agents = useMemo(() => projectWorkspace?.agents ?? workspace?.agents ?? [], [projectWorkspace, workspace]);
  const agentsByID = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  // Side threads branched off this thread, grouped by their anchor message.
  const sideThreadsByMessage = useMemo(() => {
    const map = new Map<string, ChatThread[]>();
    if (!project || !thread) return map;
    for (const candidate of project.threads) {
      if (candidate.parentThreadID !== thread.id || !candidate.anchorMessageID) continue;
      const bucket = map.get(candidate.anchorMessageID);
      if (bucket) bucket.push(candidate);
      else map.set(candidate.anchorMessageID, [candidate]);
    }
    return map;
  }, [project, thread]);
  const busySideThreadIDs = useMemo(
    () => new Set(Object.keys(activeTurns)),
    [activeTurns],
  );
  const openSideThread = useMemo(
    () =>
      openSideThreadID && project
        ? project.threads.find(
            (candidate) =>
              candidate.id === openSideThreadID && candidate.parentThreadID === thread?.id,
          ) ?? null
        : null,
    [openSideThreadID, project, thread],
  );

  // Dictation owns the draft: a transcript rewrites the region it owns, while
  // typing takes that region back. Both go through one setter so neither can
  // clobber the other.
  const dictation = useDictation({
    boundTo: selectedThreadID,
    enabled: voiceEnabled && thread?.surface !== "terminal",
    shortcut: dictationShortcut,
  });
  const { draft, setDraft } = dictation;
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const mentionMenu = useMentionMenu({ agents, textareaRef: draftRef, setDraft });
  const slashCommandMenu = useSlashCommandMenu({
    provider: thread?.provider ?? "codex",
    profileId: thread?.providerInstanceID,
    workingDirectory: project?.folderPath,
    hostId: selectedHostID,
    textareaRef: draftRef,
    setDraft,
  });
  const images = useImageAttachments();
  const [submitting, setSubmitting] = useState(false);
  const focusAfterNewThreadRef = useRef(selectedThreadID === null);

  useEffect(() => {
    const element = draftRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [draft]);

  useEffect(() => {
    if (selectedThreadID === null) {
      focusAfterNewThreadRef.current = true;
      return;
    }
    if (!focusAfterNewThreadRef.current) return;
    focusAfterNewThreadRef.current = false;
    const frame = requestAnimationFrame(() => draftRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selectedThreadID]);

  useEffect(() => images.clear(), [images.clear, selectedThreadID]);

  // Turning the experiment off must not strand an existing terminal chat with
  // its return control hidden. Restore that chat's persisted GUI surface as
  // soon as it is selected.
  const terminalProjectID = project?.id;
  const terminalThreadID = thread?.id;
  const selectedSurface = thread?.surface;
  useEffect(() => {
    if (
      terminalModeEnabled
      || !terminalProjectID
      || !terminalThreadID
      || selectedSurface !== "terminal"
    ) return;
    let cancelled = false;
    setSwitchingSurface(true);
    setSurfaceError(null);
    void ipc.terminalStop(terminalProjectID, terminalThreadID, null, selectedHostID)
      .then(() => refresh())
      .catch((cause) => {
        if (!cancelled) setSurfaceError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setSwitchingSurface(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh, selectedHostID, selectedSurface, terminalModeEnabled, terminalProjectID, terminalThreadID]);

  if (!workspace) {
    return <main className="thread-view loading"><span className="loading-orb" />Loading workspace…</main>;
  }

  if (!thread || !project) {
    return (
      <NewAgentView
        projects={workspace.projects}
        remotes={remoteSessions}
        initialProjectID={selectedProjectID}
        initialHostID={selectedHostID}
        sidebarOpen={sidebarOpen}
      />
    );
  }

  const isRunning = !!activeTurns[thread.id];
  const queuedMessages = queuedMessagesByThread[thread.id] ?? [];
  const queueActionPending = !!sendingMessageByThread[thread.id];
  const terminalSurface = thread.surface === "terminal";
  // The reply panel and the rail share one slot, so an open side thread leaves
  // the rail nowhere to sit — same as a window too narrow for it, and the
  // toggle falls back to the popover for both.
  const summarySlotFree = summaryFits && !openSideThread;
  const showSummaryRail = showsPinnedSummary({ pinned: summaryPinned, fits: summarySlotFree });
  const resolvedStatus = (requestID: string | undefined): string | null => {
    if (!requestID) return null;
    const record = thread.interactionRequests.find((request) => request.id === requestID);
    return record && record.status !== "pending" ? record.status : null;
  };
  const toggleTerminalSurface = async () => {
    if (switchingSurface || (!terminalSurface && (isRunning || !thread.providerSessionID))) return;
    setSwitchingSurface(true);
    setSurfaceError(null);
    try {
      if (terminalSurface) {
        await ipc.terminalStop(
          project.id,
          thread.id,
          terminalViewRef.current?.archiveText() || null,
          selectedHostID,
        );
      } else {
        dictation.stop();
        clearBrowserAnnotations(thread.id);
        setOpenSideThreadID(null);
        await ipc.terminalStart(project.id, thread.id, 32, 120, selectedHostID);
      }
      await refresh();
    } catch (cause) {
      setSurfaceError(String(cause));
    } finally {
      setSwitchingSurface(false);
    }
  };
  const submit = async () => {
    if ((!draft.trim() && images.paths.length === 0 && browserAnnotations.length === 0) || submitting) return;
    // A mention routes the message to those agents in a side thread; the main
    // thread's provider never sees it. Multiple mentions respond in sequence.
    const mentioned = mentionedAgents(draft, agents);
    setSubmitting(true);
    const sent = await (mentioned.length > 0
      ? startSideThread(project.id, thread.id, mentioned.map((agent) => agent.id), draft.trim(), images.paths, [...browserAnnotations])
      : sendPrompt(draft.trim(), images.paths, [...browserAnnotations]));
    setSubmitting(false);
    if (!sent) return;
    // Sending is a turn boundary: anything still being transcribed has already
    // gone with the message, so the microphone closes with it.
    dictation.clear();
    images.clear();
    clearBrowserAnnotations(thread.id);
    mentionMenu.dismiss();
    slashCommandMenu.dismiss();
    requestAnimationFrame(() => draftRef.current?.focus());
  };
  const changedFiles = new Set(
    thread.runtimeEvents.flatMap((event) => event.payload.files?.map((file) => file.path) ?? []),
  ).size;
  // Latest usage snapshot with an explicit context measurement. Billing-style
  // events (turn or session cumulative token totals) never set contextTokens,
  // so summing their fields here would overcount the live context. Zero means
  // "no model call this turn" (e.g. a locally-handled slash command), not an
  // empty context.
  const usage = [...thread.runtimeEvents]
    .reverse()
    .find((event) => (event.payload.usage?.contextTokens ?? 0) > 0)?.payload.usage;
  const contextUsed = usage?.contextTokens;

  return (
    <div className="workspace-stage" aria-hidden={browserExpanded} inert={browserExpanded}>
      <main className="thread-view">
        <header className={`thread-header ${sidebarOpen ? "" : "sidebar-closed"}`} onMouseDown={beginWindowDrag}>
          <div className="thread-header-side collapsed-titlebar-controls">
            {!sidebarOpen && (
              <>
                <button className="icon-button" title="New agent" onClick={() => startNewThread()}>
                  <Icons.compose size={15} />
                </button>
                <span className="titlebar-divider" aria-hidden="true" />
              </>
            )}
          </div>
          <button className="thread-title-button" title={thread.title}>
            <span>{thread.title}</span>
            <Icons.chevronDown size={11} />
          </button>
          <div className="thread-header-side end">
            <GitEnvironment projectID={project.id} hostID={selectedHostID} threadID={thread.id} />
            <SummaryToggle project={project} thread={thread} fits={summarySlotFree} />
            {terminalModeEnabled && (
              <button
                className={`icon-button terminal-surface-toggle${terminalSurface ? " is-active" : ""}`}
                title={
                  terminalSurface
                    ? "Return to GUI chat"
                    : isRunning
                      ? "Wait for the current turn before opening terminal mode"
                      : !thread.providerSessionID
                        ? "Send a first message before opening terminal mode"
                        : "Open this chat in terminal mode"
                }
                aria-label={terminalSurface ? "Return to GUI chat" : "Open terminal chat"}
                aria-pressed={terminalSurface}
                disabled={switchingSurface || (!terminalSurface && (isRunning || !thread.providerSessionID))}
                onClick={() => void toggleTerminalSurface()}
              >
                {switchingSurface ? <span className="mini-spinner" /> : <Icons.terminal size={14} />}
              </button>
            )}
            {(!selectedHostID || selectedHostID === "local") && (
            <button
              className={`icon-button${browserOpen ? " is-active" : ""}`}
              title={`${browserOpen ? "Hide" : "Show"} right sidebar (${formatKeyboardShortcut(toggleBrowserShortcut)})`}
              aria-label="Toggle right sidebar"
              aria-pressed={browserOpen}
              onClick={() => toggleBrowser()}
            >
              <Icons.panel size={14} />
            </button>
            )}
          </div>
        </header>

        {(surfaceError || (terminalSurface ? error : null)) && (
          <div className="error-banner terminal-surface-error">{surfaceError || error}</div>
        )}
        {terminalSurface ? (
          <TerminalView
            key={`${selectedHostID ?? "local"}:${thread.id}`}
            ref={terminalViewRef}
            project={project}
            thread={thread}
            hostID={selectedHostID}
            initialTurnRunning={isRunning}
            onReturnToGUI={() => void toggleTerminalSurface()}
          />
        ) : (
        <>
        <ThreadTimeline
          key={thread.id}
          projectID={project.id}
          threadID={thread.id}
          hostID={selectedHostID}
          rows={rows}
          terminalTurnIDs={terminalTurnIDs}
          activeTurnID={activeTurns[thread.id]}
          resolvedStatus={resolvedStatus}
          onResolve={(requestID, decision) =>
            void resolveRequest(project.id, thread.id, requestID, decision)}
          sideThreadsByMessage={sideThreadsByMessage}
          busySideThreadIDs={busySideThreadIDs}
          openSideThreadID={openSideThreadID}
          agentsByID={agentsByID}
          onOpenSideThread={setOpenSideThreadID}
        />

        <footer className="composer-zone">
          {error && <div className="error-banner">{error}</div>}
          {changedFiles > 0 && (
            <div className="activity-chips">
              <span><Icons.files size={13} />{changedFiles} {changedFiles === 1 ? "File Changed" : "Files Changed"}</span>
            </div>
          )}
          <DictationStatus dictation={dictation} />
          <QueuedMessages
            messages={queuedMessages}
            isRunning={isRunning}
            canSteer={providerSupportsSteering(thread.provider)}
            actionPending={queueActionPending}
            onSteer={(messageID) => void steerQueuedMessage(thread.id, messageID)}
            onRetry={(messageID) => void retryQueuedMessage(thread.id, messageID)}
            onRemove={(messageID) => removeQueuedMessage(thread.id, messageID)}
          />
          <div className="composer">
            <SlashCommandMenu menu={slashCommandMenu} />
            <MentionMenu menu={mentionMenu} />
            <BrowserAnnotationPills
              annotations={[...browserAnnotations]}
              onClear={() => {
                clearBrowserAnnotations(thread.id);
                requestAnimationFrame(() => draftRef.current?.focus());
              }}
            />
            <PendingImageStrip paths={images.paths} onRemove={images.remove} />
            <MentionTextarea
              ref={draftRef}
              agents={agents}
              rows={1}
              value={draft}
              aria-label="Send follow-up"
              aria-controls={slashCommandMenu.open ? "composer-slash-menu" : undefined}
              aria-expanded={slashCommandMenu.open}
              placeholder={agents.length > 0 ? "Send follow-up · / commands · @ agents" : "Send follow-up · / for commands and skills"}
              onChange={(event) => {
                setDraft(event.target.value);
                mentionMenu.refresh();
                slashCommandMenu.refresh();
              }}
              onClick={() => {
                mentionMenu.refresh();
                slashCommandMenu.refresh();
              }}
              onKeyUp={(event) => {
                if (event.key.startsWith("Arrow")) {
                  mentionMenu.refresh();
                  slashCommandMenu.refresh();
                }
              }}
              onKeyDown={(event) => {
                if (slashCommandMenu.onKeyDown(event)) return;
                if (mentionMenu.onKeyDown(event)) return;
                // Escape abandons the utterance in flight rather than keeping
                // a half-transcribed sentence in the draft.
                if (event.key === "Escape" && dictation.isActive) {
                  event.preventDefault();
                  dictation.cancel();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="composer-toolbar">
              <div className="composer-leading-actions">
                <AttachImagesButton disabled={false} onChoose={() => void images.choose()} />
                <RuntimePicker
                provider={thread.provider}
                model={thread.model}
                effort={thread.effort}
                speed={thread.speed}
                profiles={projectWorkspace?.providerProfiles ?? workspace.providerProfiles}
                hostId={selectedHostID}
                workingDirectory={threadWorkingDirectory(project.folderPath, thread)}
                disabled={isRunning}
                onChange={(next) => {
                  if (selectedProjectID) {
                    void updateThreadRuntime(
                      selectedProjectID,
                      thread.id,
                      next.provider,
                      next.model,
                      next.effort,
                      next.speed,
                    );
                  }
                }}
                />
              </div>
              {/* Grouped so the toolbar keeps two flex children and the model
                  picker stays pinned to the leading edge. */}
              <div className="composer-actions">
                <DictationButton
                  dictation={dictation}
                  enabled={voiceEnabled}
                  shortcut={dictationShortcut}
                />
                {isRunning ? (
                  <>
                    <button className="send-button stop" title="Stop generation" onClick={() => void cancelActiveTurn(thread.id)}>
                      <Icons.stop size={14} />
                    </button>
                    <button
                      className="send-button"
                      title={submitting ? "Queueing message" : "Queue message"}
                      disabled={submitting || (!draft.trim() && images.paths.length === 0 && browserAnnotations.length === 0)}
                      onClick={() => void submit()}
                    >
                      <Icons.arrowUp size={16} />
                    </button>
                  </>
                ) : (
                  <button className="send-button" title={submitting ? "Sending message" : "Send message"}
                    disabled={submitting || (!draft.trim() && images.paths.length === 0 && browserAnnotations.length === 0)} onClick={() => void submit()}>
                    <Icons.arrowUp size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="composer-meta">
            <span><Icons.branch size={12} />{project ? projectName(project) : "Project"}</span>
            <span>{thread.providerSessionID ? `Session ${thread.providerSessionID.slice(0, 12)}` : "This Mac"}</span>
            {contextUsed ? (
              <span
                className="composer-context"
                title={
                  usage?.contextWindow
                    ? `${contextUsed.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens`
                    : `${contextUsed.toLocaleString()} tokens in context`
                }
              >
                {formatTokens(contextUsed)}
                {usage?.contextWindow ? ` / ${formatTokens(usage.contextWindow)}` : ""}
              </span>
            ) : null}
          </div>
        </footer>
        </>
        )}
      </main>
      {!terminalSurface && (openSideThread && project ? (
        <>
          <SideThreadResizer />
          <SideThreadPanel
            project={project}
            thread={openSideThread}
            agentsByID={agentsByID}
            onClose={() => setOpenSideThreadID(null)}
          />
        </>
      ) : (
        showSummaryRail && <ContextRail project={project} thread={thread} />
      ))}
    </div>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return `${count}`;
}

/**
 * Owns StickToBottom for one thread mount. Hides the viewport until the library
 * has applied its initial bottom snap so long threads never paint at scrollTop=0.
 */
export function ThreadTimeline({
  projectID,
  threadID,
  hostID,
  rows,
  terminalTurnIDs,
  activeTurnID,
  resolvedStatus,
  onResolve,
  sideThreadsByMessage,
  busySideThreadIDs,
  openSideThreadID,
  onOpenSideThread,
  agentsByID,
  turnAgents,
  turnTimes,
}: {
  projectID: string;
  threadID: string;
  hostID?: string;
  rows: TimelineRow[];
  terminalTurnIDs: Set<string>;
  activeTurnID: string | undefined;
  resolvedStatus: (requestID: string | undefined) => string | null;
  onResolve: (requestID: string, decision: RuntimeInteractionDecision) => void;
  /** Side threads anchored to a user message of this thread. */
  sideThreadsByMessage?: Map<string, ChatThread[]>;
  busySideThreadIDs?: Set<string>;
  openSideThreadID?: string | null;
  onOpenSideThread?: (threadID: string) => void;
  agentsByID?: Map<string, AgentDefinition>;
  /** Agent attribution per turn: renders a byline above each agent reply. */
  turnAgents?: Map<string, AgentDefinition>;
  /** Turn start times (Apple epoch seconds) for byline timestamps. */
  turnTimes?: Map<string, number>;
}) {
  const [ready, setReady] = useState(false);
  const showProviderDiagnostics = useAppStore((state) => state.showProviderDiagnostics);
  // Keep resize instant while the thread is settling (markdown/code layout
  // still resizing). Smooth stickiness only after that avoids a bounce.
  const [resizeMode, setResizeMode] = useState<"instant" | "smooth">("instant");
  const markReady = useMemo(() => () => setReady(true), []);

  // Agents referenced by mention rendering inside user bubbles.
  const mentionAgents = useMemo(
    () => (agentsByID ? [...agentsByID.values()] : []),
    [agentsByID],
  );

  const bylineByRowKey = useMemo(
    () => bylineAnchors(rows, turnAgents, terminalTurnIDs, showProviderDiagnostics),
    [rows, showProviderDiagnostics, terminalTurnIDs, turnAgents],
  );

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => setResizeMode("smooth"), 350);
    return () => window.clearTimeout(timer);
  }, [ready]);

  return (
    <StickToBottom
      className={`timeline-viewport${ready ? " is-ready" : ""}`}
      initial="instant"
      resize={resizeMode}
      role="log"
    >
      <RevealTimeline whenReady={markReady} />
      <StickToBottom.Content className="timeline">
        {rows.map((row) => {
          if (row.kind === "user") {
            const anchored = sideThreadsByMessage?.get(row.messageID) ?? [];
            return (
              <div key={row.key} className="user-message-row">
                {row.attachments.length > 0 && (
                  <div className="user-image-grid">
                    {row.attachments.map((attachment) => (
                      <MessageMedia
                        key={attachment.id}
                        media={{ kind: "image", destination: `attachment:${attachment.id}`, altText: attachment.displayName }}
                        projectID={projectID}
                        threadID={threadID}
                        hostID={hostID}
                      />
                    ))}
                  </div>
                )}
                <BrowserAnnotationPills annotations={row.annotations} readonly />
                {row.text && <div className="user-bubble"><MentionText text={row.text} agents={mentionAgents} /></div>}
                {anchored.length > 0 && onOpenSideThread && (
                  <div className="reply-chip-row">
                    {anchored.map((side) => (
                      <SideThreadChip
                        key={side.id}
                        side={side}
                        agentsByID={agentsByID}
                        busy={busySideThreadIDs?.has(side.id) ?? false}
                        active={side.id === openSideThreadID}
                        onOpen={() => onOpenSideThread(side.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          }
          if (row.kind === "system") {
            return (
              <div key={row.key} className="handoff-row">
                <Icons.arrowUp size={11} />
                <span>{row.text}</span>
              </div>
            );
          }
          if (row.kind === "assistant") {
            return (
              <div key={row.key} className="assistant-block">
                <Markdown
                  text={row.text}
                  isAnimating={false}
                  projectID={projectID}
                  threadID={threadID}
                  hostID={hostID}
                />
              </div>
            );
          }
          if (row.kind === "terminalArchive") {
            return (
              <details key={row.key} className="terminal-archive-row">
                <summary><Icons.terminal size={13} />Terminal session</summary>
                <pre>{row.text}</pre>
              </details>
            );
          }
          const byline = bylineByRowKey.get(row.key);
          const item = row.item;
          if (!rendersRow(item, terminalTurnIDs, showProviderDiagnostics)) return null;
          const rendered = (() => {
          switch (item.type) {
            case "assistantText":
              return (
                <div key={row.key} className="assistant-block">
                  <Markdown
                    text={item.text}
                    isAnimating={activeTurnID === item.turnID}
                    projectID={projectID}
                    threadID={threadID}
                    hostID={hostID}
                  />
                </div>
              );
            case "reasoning":
              return (
                <details key={row.key} className="reasoning-block">
                  <summary>Thought briefly</summary>
                  <Markdown text={item.text} isAnimating={activeTurnID === item.turnID} />
                </details>
              );
            case "status":
              return <div key={row.key} className="status-line">{item.text}</div>;
            case "interaction":
              return (
                <InteractionCard
                  key={row.key}
                  event={item.event}
                  resolved={resolvedStatus(item.event.requestID)}
                  onResolve={(decision: RuntimeInteractionDecision) => {
                    if (item.event.requestID) onResolve(item.event.requestID, decision);
                  }}
                />
              );
            case "terminal":
              return <div key={row.key} className={`terminal-line terminal-${item.state}`}>Turn {item.state}</div>;
            case "card":
              return <ActivityCard key={row.key} event={item.event} threadID={threadID} />;
            default:
              return null;
          }
          })();
          if (!byline || rendered === null) return rendered;
          const bylineTime = turnTimes?.get(item.turnID);
          return (
            <Fragment key={`byline-${row.key}`}>
              <div className="agent-byline">
                <AgentAvatar
                  name={byline.name}
                  colorHex={byline.colorHex}
                  emoji={byline.emoji}
                  imagePath={byline.imagePath}
                  size={18}
                />
                <span className="agent-byline-name">{byline.name}</span>
                {bylineTime !== undefined && (
                  <span className="agent-byline-time">{relativeTime(bylineTime)}</span>
                )}
              </div>
              {rendered}
            </Fragment>
          );
        })}
        {rows.length === 0 && <p className="timeline-empty">Send a message to begin.</p>}
      </StickToBottom.Content>
      <ScrollToBottomButton />
    </StickToBottom>
  );
}

/** Message text with agent mentions rendered as accent tokens. */
function MentionText({ text, agents }: { text: string; agents: AgentDefinition[] }) {
  const segments = useMemo(() => splitMentions(text, agents), [agents, text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "mention" ? (
          <MentionToken key={index} text={segment.text} agent={segment.agent} />
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

/** One @mention token; hovering it pops the agent's identity card. */
function MentionToken({ text, agent }: { text: string; agent: AgentDefinition }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <span
      ref={spanRef}
      className="mention-token"
      onMouseEnter={() => {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          if (spanRef.current) setAnchor(spanRef.current.getBoundingClientRect());
        }, 140);
      }}
      onMouseLeave={() => {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = null;
        setAnchor(null);
      }}
    >
      {text}
      {anchor && <AgentHoverCard agent={agent} anchor={anchor} />}
    </span>
  );
}

/** Slack-style reply chip under a mention message: participants, count, time. */
function SideThreadChip({
  side,
  agentsByID,
  busy,
  active,
  onOpen,
}: {
  side: ChatThread;
  agentsByID?: Map<string, AgentDefinition>;
  busy: boolean;
  active: boolean;
  onOpen: () => void;
}) {
  // Every agent that spoke in the side thread, current responder last.
  const participants = useMemo(() => {
    const ids = new Map<string, AgentDefinition>();
    for (const message of side.messages) {
      if (!message.agentID) continue;
      const agent = agentsByID?.get(message.agentID);
      if (agent) ids.set(agent.id, agent);
    }
    const current = side.agentID ? agentsByID?.get(side.agentID) : undefined;
    if (current) ids.set(current.id, current);
    return [...ids.values()];
  }, [agentsByID, side]);
  const replies = side.messages.filter((message) => message.role === "assistant").length;

  return (
    <button
      type="button"
      className={`reply-chip ${active ? "active" : ""}`}
      title={side.title}
      onClick={onOpen}
    >
      <span className="reply-chip-avatars">
        {participants.slice(0, 3).map((agent) => (
          <AgentAvatar
            key={agent.id}
            name={agent.name}
            colorHex={agent.colorHex}
            emoji={agent.emoji}
            imagePath={agent.imagePath}
            size={16}
          />
        ))}
        {participants.length === 0 && <Icons.bubble size={13} />}
      </span>
      <span className="reply-chip-label">
        {busy ? "Replying…" : replies === 1 ? "1 reply" : `${replies} replies`}
      </span>
      {busy ? (
        <span className="mini-spinner reply-chip-spinner" />
      ) : (
        <span className="reply-chip-time">{relativeTime(side.updatedAt)}</span>
      )}
    </button>
  );
}

/** Waits for the first instant stick-to-bottom, then reveals the viewport. */
function RevealTimeline({ whenReady }: { whenReady: () => void }) {
  const { scrollToBottom, scrollRef } = useStickToBottomContext();
  const revealedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const reveal = () => {
      if (cancelled || revealedRef.current) return;
      revealedRef.current = true;
      whenReady();
    };

    // use-stick-to-bottom's "instant" still schedules via rAF, so content can
    // paint once at the top. Hide until that snap (or a short fallback) finishes.
    const result = scrollToBottom({ animation: "instant", ignoreEscapes: true });
    void Promise.resolve(result).then((stuck) => {
      if (stuck || scrollRef.current) reveal();
    });
    const fallback = window.setTimeout(reveal, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
    };
  }, [scrollToBottom, scrollRef, whenReady]);

  return null;
}

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button className="scroll-to-bottom" title="Scroll to bottom" onClick={() => void scrollToBottom()}>
      <Icons.arrowDown size={14} />
    </button>
  );
}

function NewAgentView({
  projects,
  remotes,
  initialProjectID,
  initialHostID,
  sidebarOpen,
}: {
  projects: ChatProject[];
  remotes: { host: { id: string; name: string }; workspace: { projects: ChatProject[]; providerProfiles?: ProviderProfile[] } }[];
  initialProjectID: string | null;
  initialHostID: string;
  sidebarOpen: boolean;
}) {
  const profiles = useAppStore((state) => state.workspace?.providerProfiles ?? []);
  const createThreadAndSend = useAppStore((state) => state.createThreadAndSend);
  const runtime = useAppStore((state) => state.newThreadRuntime);
  const setRuntime = useAppStore((state) => state.setNewThreadRuntime);
  const surface = useAppStore((state) => state.newThreadSurface);
  const setSurface = useAppStore((state) => state.setNewThreadSurface);
  const environment = useAppStore((state) => state.newThreadEnvironment);
  const setEnvironment = useAppStore((state) => state.setNewThreadEnvironment);
  const addProject = useAppStore((state) => state.addProject);
  const hostStatus = useAppStore((state) => state.hostStatus);
  const terminalModeEnabled = useAppStore((state) => state.terminalModeEnabled);
  const error = useAppStore((state) => state.error);
  const hosted = [
    ...projects.map((project) => ({ project, hostId: "local", hostName: hostStatus?.name ?? "This Mac" })),
    ...remotes.flatMap((session) =>
      session.workspace.projects.map((project) => ({
        project,
        hostId: session.host.id,
        hostName: session.host.name,
      })),
    ),
  ];
  const initialProject = hosted.find((item) => item.project.id === initialProjectID && item.hostId === initialHostID)
    ?? hosted.find((item) => item.project.id === initialProjectID)
    ?? hosted.find((item) => item.hostId === initialHostID)
    ?? hosted[0];
  const [selectionKey, setSelectionKey] = useState(
    initialProject ? `${initialProject.hostId}:${initialProject.project.id}` : "",
  );
  const selectedProject = hosted.find((item) => `${item.hostId}:${item.project.id}` === selectionKey) ?? hosted[0];
  const projectID = selectedProject?.project.id ?? "";
  const dictationShortcut = useAppStore((state) => state.keyboardShortcuts.toggleDictation);
  const voiceEnabled = useAppStore((state) => state.workspace?.voice.isEnabled ?? false);
  const dictation = useDictation({
    boundTo: "new-agent",
    enabled: voiceEnabled && surface === "gui",
    shortcut: dictationShortcut,
  });
  const { draft, setDraft } = dictation;
  const [sending, setSending] = useState(false);
  const [addingOnHost, setAddingOnHost] = useState<{ id: string; name: string } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const images = useImageAttachments();

  useEffect(() => textRef.current?.focus(), []);
  useEffect(() => {
    if (initialProjectID) {
      const next = hosted.find((item) => item.project.id === initialProjectID && item.hostId === initialHostID)
        ?? hosted.find((item) => item.project.id === initialProjectID);
      if (next) setSelectionKey(`${next.hostId}:${next.project.id}`);
      setEnvironment("current");
    }
  }, [initialHostID, initialProjectID, setEnvironment]);

  const addLocalProject = async () => {
    const folder = await ipc.openProjectDialog();
    if (folder) await addProject(folder, "local");
  };

  const submit = async () => {
    if (!projectID || (!draft.trim() && (surface === "terminal" || images.paths.length === 0)) || sending) return;
    const prompt = draft.trim();
    const imagePaths = surface === "terminal" ? [] : images.paths;
    dictation.clear();
    setSending(true);
    const created = await createThreadAndSend(
      projectID,
      runtime.provider,
      runtime.model,
      prompt,
      imagePaths,
      runtime.effort,
      runtime.speed,
      surface,
      environment,
    );
    setSending(false);
    if (created) images.clear();
    else setDraft(prompt);
    requestAnimationFrame(() => textRef.current?.focus());
  };

  return (
    <main className="new-agent-stage">
      <header
        className={`new-agent-titlebar ${sidebarOpen ? "" : "sidebar-closed"}`}
        onMouseDown={beginWindowDrag}
      />
      {hosted.length === 0 ? (
        <div className="empty-workspace-copy">
          <div className="empty-logo">M</div>
          <h1>Open a project to start</h1>
          <p>Use the plus button beside Repositories to choose a working folder.</p>
        </div>
      ) : (
        <div className="new-agent-center">
          <h1 className="new-agent-heading">What should we work on in <span>{projectName(selectedProject.project)}</span>?</h1>
          {surface === "gui" && <DictationStatus dictation={dictation} />}
          <div className="new-agent-composer-shell">
            <NewThreadContextBar
              projects={hosted}
              remoteHosts={remotes.map((session) => session.host)}
              selected={selectedProject}
              environment={environment}
              disabled={sending}
              onSelectProject={(item) => {
                setSelectionKey(`${item.hostId}:${item.project.id}`);
                setEnvironment("current");
              }}
              onEnvironmentChange={setEnvironment}
              onAddLocalProject={() => void addLocalProject()}
              onAddRemoteProject={setAddingOnHost}
            />
            <div className="new-agent-composer">
            {surface === "gui" && <PendingImageStrip paths={images.paths} onRemove={images.remove} />}
            <textarea
              ref={textRef}
              value={draft}
              aria-label="New agent prompt"
              placeholder="Plan, build, or ask anything"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && dictation.isActive) {
                  event.preventDefault();
                  dictation.cancel();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="composer-toolbar">
              <div className="composer-leading-actions">
                {surface === "gui" && <AttachImagesButton disabled={sending} onChoose={() => void images.choose()} />}
                <RuntimePicker
                  provider={runtime.provider}
                  model={runtime.model}
                  effort={runtime.effort}
                  speed={runtime.speed}
                  profiles={
                    selectedProject.hostId === "local"
                      ? profiles
                      : remotes.find((session) => session.host.id === selectedProject.hostId)
                          ?.workspace.providerProfiles ?? profiles
                  }
                  hostId={selectedProject.hostId}
                  workingDirectory={selectedProject.project.folderPath}
                  placement="bottom"
                  onChange={setRuntime}
                />
              </div>
              <div className="composer-actions">
                {terminalModeEnabled && (
                  <button
                    className={`icon-button new-chat-terminal-toggle${surface === "terminal" ? " is-active" : ""}`}
                    title={surface === "terminal" ? "Use GUI chat" : "Start in terminal mode"}
                    aria-label={surface === "terminal" ? "Use GUI chat" : "Start in terminal mode"}
                    aria-pressed={surface === "terminal"}
                    disabled={sending}
                    onClick={() => {
                      const next = surface === "terminal" ? "gui" : "terminal";
                      if (next === "terminal") {
                        dictation.stop();
                        images.clear();
                      }
                      setSurface(next);
                      requestAnimationFrame(() => textRef.current?.focus());
                    }}
                  >
                    <Icons.terminal size={15} />
                  </button>
                )}
                {surface === "gui" && (
                  <DictationButton
                    dictation={dictation}
                    enabled={voiceEnabled}
                    shortcut={dictationShortcut}
                  />
                )}
                <button className="send-button" title={surface === "terminal" ? "Start terminal chat" : "Start agent"} disabled={(!draft.trim() && (surface === "terminal" || images.paths.length === 0)) || !projectID || sending} onClick={() => void submit()}>
                  {sending ? <span className="mini-spinner" /> : <Icons.arrowUp size={16} />}
                </button>
              </div>
            </div>
            </div>
          </div>
          {error && <div className="error-banner">{error}</div>}
          <p className="new-agent-hint">
            {surface === "terminal"
              ? "Terminal mode · attachments, dictation, annotations, and @agent side threads are unavailable"
              : "Enter to send · Shift+Enter for a new line"}
          </p>
        </div>
      )}
      {addingOnHost && createPortal(
        <div className="host-folder-overlay">
          <HostFolderPicker
            hostId={addingOnHost.id}
            hostName={addingOnHost.name}
            onSelect={(folder) => {
              const hostID = addingOnHost.id;
              setAddingOnHost(null);
              void addProject(folder, hostID);
            }}
            onCancel={() => setAddingOnHost(null)}
          />
        </div>,
        document.body,
      )}
    </main>
  );
}
