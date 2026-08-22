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
  isChatsProject,
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
import { DEFAULT_VOICE_SETTINGS } from "../voice/types";
import { useVoiceConversation } from "../voice/useVoiceConversation";
import { AgentAvatar } from "./AgentAvatar";
import { AgentHoverCard } from "./AgentHoverCard";
import { DictationButton, DictationStatus } from "./DictationButton";
import {
  composerPrimaryAction,
  VoiceConversationActionButton,
  VoiceConversationControls,
} from "./VoiceConversationControls";
import { ActivityCard, InteractionCard } from "./EventCards";
import { ContextRail, SummaryToggle } from "./ThreadSummary";
import { Icons } from "./Icons";
import { MentionMenu, useMentionMenu } from "./MentionMenu";
import { MentionTextarea } from "./MentionTextarea";
import { SlashCommandMenu, useSlashCommandMenu } from "./SlashCommandMenu";
import { MessageMedia } from "./MessageMedia";
import { AttachFilesButton, PendingAttachmentStrip, useComposerAttachments } from "./ComposerAttachments";
import { RuntimePicker } from "./RuntimePicker";
import { QueuedMessages } from "./QueuedMessages";
import { BrowserAnnotationPills } from "./BrowserAnnotationPills";
import { SideThreadPanel } from "./SideThreadPanel";
import { SideThreadResizer } from "./SideThreadResizer";
import { TerminalView, type TerminalViewHandle } from "./TerminalView";
import { HostFolderPicker } from "./HostFolderPicker";
import { NewThreadContextBar } from "./NewThreadContextBar";
import { ProjectFolderIcon } from "./ProjectFolderIcon";
import { createChatTextSelection } from "../sideChat";
import { TextSelectionPill } from "./TextSelectionPill";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription } from "./ui/alert";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Message, MessageContent } from "./ui/message";
import { Marker, MarkerContent } from "./ui/marker";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";
import { cn } from "../lib/utils";
import { TimelineDisclosure } from "./TimelineDisclosure";
import { SentAttachment } from "./SentAttachment";

// Stable references so Streamdown's memoization survives re-renders.
const markdownPlugins = { code };
const EMPTY_BROWSER_ANNOTATIONS = [] as const;

interface PrimaryTextSelection {
  selection: NonNullable<ReturnType<typeof createChatTextSelection>>;
  left: number;
  top: number;
}

function TextSelectionActions({
  selected,
  onAskInSideChat,
  onDismiss,
}: {
  selected: PrimaryTextSelection;
  onAskInSideChat: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithEscape);
    };
  }, [onDismiss]);
  return createPortal(
    <div
      ref={ref}
      className="fixed z-40 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      role="toolbar"
      aria-label="Selected text actions"
      style={{ left: selected.left, top: selected.top }}
    >
      <Button type="button" size="sm" variant="ghost" onClick={onAskInSideChat}>
        <Icons.bubble data-icon="inline-start" />
        <span>Ask in side chat</span>
      </Button>
    </div>,
    document.body,
  );
}

function Markdown({
  text,
  isAnimating,
  projectID,
  threadID,
  hostID,
  tone = "primary",
}: {
  text: string;
  isAnimating: boolean;
  projectID?: string;
  threadID?: string;
  hostID?: string;
  tone?: "primary" | "muted";
}) {
  const segments = useMemo(() => parseMessageContent(text), [text]);
  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-3">
      {segments.map((segment) => segment.kind === "markdown" ? (
        <Streamdown
          key={segment.id}
          className={cn("markdown-body w-full", tone === "muted" ? "text-muted-foreground" : "text-foreground")}
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
  const requestSideChat = useAppStore((state) => state.requestSideChat);
  const toggleBrowserShortcut = useAppStore((state) => state.keyboardShortcuts.toggleBrowser);
  const dictationShortcut = useAppStore((state) => state.keyboardShortcuts.toggleDictation);
  const pendingVoiceConversationThreadID = useAppStore((state) => state.pendingVoiceConversationThreadID);
  const consumeVoiceConversationRequest = useAppStore((state) => state.consumeVoiceConversationRequest);
  const voiceSettings = useAppStore((state) => state.workspace?.voice ?? DEFAULT_VOICE_SETTINGS);
  const voiceEnabled = voiceSettings.isEnabled;
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
  const [primaryTextSelection, setPrimaryTextSelection] = useState<PrimaryTextSelection | null>(null);

  const projectWorkspace = useMemo(() => {
    if (!selectedHostID || selectedHostID === "local") return workspace;
    return remoteSessions.find((session) => session.host.id === selectedHostID)?.workspace ?? workspace;
  }, [remoteSessions, selectedHostID, workspace]);
  const project = useMemo(
    () => projectWorkspace?.projects.find((candidate) => candidate.id === selectedProjectID),
    [projectWorkspace, selectedProjectID],
  );
  const selectedRemoteHost = useMemo(
    () => remoteSessions.find((session) => session.host.id === selectedHostID)?.host,
    [remoteSessions, selectedHostID],
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

  const voiceConversation = useVoiceConversation({
    binding: project && thread && thread.surface !== "terminal"
      ? {
          projectID: project.id,
          threadID: thread.id,
          executionHostID: selectedHostID,
          thread,
        }
      : null,
    enabled: voiceEnabled && thread?.surface !== "terminal",
    settings: voiceSettings,
  });
  // Dictation owns the draft: a transcript rewrites the region it owns, while
  // typing takes that region back. Conversation owns the microphone while it
  // is active, including the dictation keyboard shortcut.
  const dictation = useDictation({
    boundTo: selectedThreadID,
    enabled: voiceEnabled && !voiceConversation.isActive && thread?.surface !== "terminal",
    settings: voiceSettings,
    shortcut: dictationShortcut,
  });
  useEffect(() => {
    if (
      !thread
      || pendingVoiceConversationThreadID !== thread.id
      || !voiceConversation.canStart
      || voiceConversation.snapshot.state !== "idle"
    ) return;
    consumeVoiceConversationRequest(thread.id);
    voiceConversation.start();
  }, [consumeVoiceConversationRequest, pendingVoiceConversationThreadID, thread, voiceConversation]);
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
  const composerAttachments = useComposerAttachments();
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

  useEffect(() => composerAttachments.discard(), [composerAttachments.discard, selectedThreadID]);
  useEffect(() => setPrimaryTextSelection(null), [selectedThreadID]);

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
    return <main className="flex flex-1 min-w-0 items-center justify-center gap-2 bg-background text-sm text-muted-foreground"><Spinner />Loading workspace…</main>;
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
  const hasComposerContent = draft.trim().length > 0
    || composerAttachments.attachments.length > 0
    || browserAnnotations.length > 0;
  const primaryComposerAction = composerPrimaryAction({
    conversationActive: voiceConversation.isActive,
    hasContent: hasComposerContent,
    voiceEnabled,
  });
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
    if ((!draft.trim() && composerAttachments.attachments.length === 0 && browserAnnotations.length === 0) || submitting) return;
    // A mention routes the message to those agents in a side thread; the main
    // thread's provider never sees it. Multiple mentions respond in sequence.
    const mentioned = mentionedAgents(draft, agents);
    setSubmitting(true);
    const sent = await (mentioned.length > 0
      ? startSideThread(project.id, thread.id, mentioned.map((agent) => agent.id), draft.trim(), composerAttachments.payload.attachmentPaths, [...browserAnnotations], composerAttachments.payload.attachmentIds)
      : sendPrompt(draft.trim(), composerAttachments.payload.attachmentPaths, [...browserAnnotations], composerAttachments.payload.attachmentIds));
    setSubmitting(false);
    if (!sent) return;
    // Sending is a turn boundary: anything still being transcribed has already
    // gone with the message, so the microphone closes with it.
    dictation.clear();
    composerAttachments.clear();
    clearBrowserAnnotations(thread.id);
    mentionMenu.dismiss();
    slashCommandMenu.dismiss();
    requestAnimationFrame(() => draftRef.current?.focus());
  };
  const changedFiles = new Set(
    thread.runtimeEvents.flatMap((event) => event.payload.files?.map((file) => file.path) ?? []),
  ).size;
  const askSelectionInSideChat = () => {
    if (!primaryTextSelection) return;
    requestSideChat({
      id: crypto.randomUUID(),
      parentThreadID: thread.id,
      selection: primaryTextSelection.selection,
    });
    window.getSelection()?.removeAllRanges();
    setPrimaryTextSelection(null);
  };

  return (
    <div className="workspace-stage flex h-full min-h-0 min-w-0 flex-1 bg-background" aria-hidden={browserExpanded} inert={browserExpanded}>
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <header className={cn("flex h-10 shrink-0 items-center gap-2 px-3 [-webkit-app-region:drag]", !sidebarOpen && "ps-12")} onMouseDown={beginWindowDrag}>
          {!sidebarOpen && <span className="window-sidebar-toggle-cutout" aria-hidden="true" />}
          <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
            {!sidebarOpen && (
              <>
                <IconButton label="New agent" tooltip="New agent" onClick={() => startNewThread()}>
                  <Icons.compose />
                </IconButton>
                <span className="h-4 w-px bg-border" aria-hidden="true" />
              </>
            )}
          </div>
          <div
            className="flex min-w-0 flex-1 items-center gap-2 truncate text-sm"
            title={`${projectName(project)} / ${thread.title}`}
          >
            {!isChatsProject(project) && (
              <ProjectFolderIcon
                remote={Boolean(selectedRemoteHost)}
                hostName={selectedRemoteHost?.name}
              />
            )}
            <span className="max-w-40 shrink truncate text-muted-foreground">{projectName(project)}</span>
            <span className="shrink-0 text-muted-foreground" aria-hidden="true">/</span>
            <span className="min-w-0 flex-1 truncate text-foreground">{thread.title}</span>
            {selectedRemoteHost && <span className="sr-only">Remote project on {selectedRemoteHost.name}</span>}
          </div>
          <div className="flex items-center justify-end gap-2 [-webkit-app-region:no-drag]">
            <SummaryToggle project={project} thread={thread} hostID={selectedHostID} fits={summarySlotFree} />
            {terminalModeEnabled && !isChatsProject(project) && (
              <IconButton
                className={cn(terminalSurface && "bg-muted text-foreground")}
                label={terminalSurface ? "Return to GUI chat" : "Open terminal chat"}
                tooltip={
                  terminalSurface
                    ? "Return to GUI chat"
                    : isRunning
                      ? "Wait for the current turn before opening terminal mode"
                      : !thread.providerSessionID
                        ? "Send a first message before opening terminal mode"
                        : "Open this chat in terminal mode"
                }
                aria-pressed={terminalSurface}
                disabled={switchingSurface || (!terminalSurface && (isRunning || !thread.providerSessionID))}
                onClick={() => void toggleTerminalSurface()}
              >
                {switchingSurface ? <Spinner /> : <Icons.terminal />}
              </IconButton>
            )}
            {(!selectedHostID || selectedHostID === "local") && (
            <IconButton
              className={cn(browserOpen && "bg-muted text-foreground")}
              label="Toggle right sidebar"
              tooltip={`${browserOpen ? "Hide" : "Show"} right sidebar (${formatKeyboardShortcut(toggleBrowserShortcut)})`}
              aria-pressed={browserOpen}
              onClick={() => toggleBrowser()}
            >
              <Icons.panel />
            </IconButton>
            )}
          </div>
        </header>

        {(surfaceError || (terminalSurface ? error : null)) && (
          <Alert variant="destructive" className="mx-auto mt-2 w-[calc(100%-3rem)] max-w-3xl py-1.5"><AlertDescription className="text-xs">{surfaceError || error}</AlertDescription></Alert>
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
          onTextSelection={(selection, rect) => setPrimaryTextSelection({
            selection,
            left: Math.max(12, Math.min(rect.left + rect.width / 2, window.innerWidth - 170)),
            top: Math.min(window.innerHeight - 48, rect.bottom + 8),
          })}
        />

        {primaryTextSelection && (
          <TextSelectionActions
            selected={primaryTextSelection}
            onAskInSideChat={askSelectionInSideChat}
            onDismiss={() => setPrimaryTextSelection(null)}
          />
        )}

        <footer className="flex shrink-0 flex-col gap-2 px-4 pb-4">
          {error && <Alert variant="destructive" className="mx-auto w-full max-w-3xl py-1.5"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
          {changedFiles > 0 && (
            <div className="mx-auto flex w-full max-w-3xl gap-1.5">
              <Badge variant="outline"><Icons.files data-icon="inline-start" />{changedFiles} {changedFiles === 1 ? "File Changed" : "Files Changed"}</Badge>
            </div>
          )}
          <DictationStatus dictation={dictation} />
          <VoiceConversationControls
            conversation={voiceConversation}
            visible={voiceEnabled && thread.surface !== "terminal"}
            manual={voiceSettings.turnDetection === "manual"}
          />
          <QueuedMessages
            messages={queuedMessages}
            isRunning={isRunning}
            canSteer={providerSupportsSteering(thread.provider)}
            actionPending={queueActionPending}
            onSteer={(messageID) => void steerQueuedMessage(thread.id, messageID)}
            onRetry={(messageID) => void retryQueuedMessage(thread.id, messageID)}
            onRemove={(messageID) => removeQueuedMessage(thread.id, messageID)}
          />
          <div
            className="relative mx-auto flex w-full max-w-3xl min-h-16 flex-col gap-1 rounded-xl border border-border bg-card p-2.5 shadow-sm"
            onPaste={composerAttachments.onPaste}
            onDragOver={composerAttachments.onDragOver}
            onDrop={composerAttachments.onDrop}
          >
            <SlashCommandMenu menu={slashCommandMenu} />
            <MentionMenu menu={mentionMenu} />
            <BrowserAnnotationPills
              annotations={[...browserAnnotations]}
              onClear={() => {
                clearBrowserAnnotations(thread.id);
                requestAnimationFrame(() => draftRef.current?.focus());
              }}
            />
            <PendingAttachmentStrip attachments={composerAttachments.attachments} onRemove={composerAttachments.remove} />
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
            <div className="-mx-0.5 -mb-0.5 flex min-h-7 items-end justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1">
                <AttachFilesButton disabled={false} onChoose={() => void composerAttachments.choose()} />
                <RuntimePicker
                provider={thread.provider}
                model={thread.model}
                effort={thread.effort}
                speed={thread.speed}
                profiles={projectWorkspace?.providerProfiles ?? workspace.providerProfiles}
                hostId={selectedHostID}
                workingDirectory={threadWorkingDirectory(project.folderPath, thread)}
                disabled={isRunning}
                triggerVariant="ghost"
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
              <div className="flex items-center gap-2">
                <DictationButton
                  dictation={dictation}
                  visible={voiceEnabled}
                  disabled={voiceConversation.isActive}
                  shortcut={dictationShortcut}
                />
                {primaryComposerAction === "stop-conversation" ? (
                  <VoiceConversationActionButton
                    active
                    onClick={voiceConversation.end}
                  />
                ) : isRunning ? (
                  <>
                    <IconButton className="rounded-full" label="Stop generation" tooltip="Stop generation" variant="destructive" size="icon-sm" onClick={() => void cancelActiveTurn(thread.id)}>
                      <Icons.stop />
                    </IconButton>
                    <IconButton
                      label={submitting ? "Queueing message" : "Queue message"}
                      tooltip={submitting ? "Queueing message" : "Queue message"}
                      variant="default"
                      size="icon-sm"
                      className="rounded-full"
                      title={submitting ? "Queueing message" : "Queue message"}
                      disabled={submitting || (!draft.trim() && composerAttachments.attachments.length === 0 && browserAnnotations.length === 0)}
                      onClick={() => void submit()}
                    >
                      <Icons.arrowUp />
                    </IconButton>
                  </>
                ) : primaryComposerAction === "send" ? (
                  <IconButton className="rounded-full" label={submitting ? "Sending message" : "Send message"} tooltip={submitting ? "Sending message" : "Send message"} variant="default" size="icon-sm" disabled={submitting || !hasComposerContent} onClick={() => void submit()}>
                    <Icons.arrowUp />
                  </IconButton>
                ) : (
                  <VoiceConversationActionButton
                    onClick={voiceConversation.start}
                    disabled={!voiceConversation.canStart || dictation.isActive || submitting}
                    title={!voiceConversation.canStart
                      ? "Configure a TTS endpoint, model, and named voice in Settings first."
                      : dictation.isActive
                        ? "Stop dictation before starting a conversation."
                        : undefined}
                  />
                )}
              </div>
            </div>
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
        showSummaryRail && <ContextRail project={project} thread={thread} hostID={selectedHostID} />
      ))}
    </div>
  );
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
  onTextSelection,
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
  /** Primary-chat text selection action. Omitted in child/side timelines. */
  onTextSelection?: (selection: NonNullable<ReturnType<typeof createChatTextSelection>>, rect: DOMRect) => void;
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
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", !ready && "invisible")}
      initial="instant"
      resize={resizeMode}
      role="log"
      onPointerUp={(event) => {
        if (!onTextSelection) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
        const chatSelection = createChatTextSelection(selection.toString());
        if (!chatSelection) return;
        onTextSelection(chatSelection, range.getBoundingClientRect());
      }}
    >
      <RevealTimeline whenReady={markReady} />
      <StickToBottom.Content className="mx-auto flex h-max min-h-full w-[calc(100%-2rem)] max-w-3xl flex-col gap-3 overflow-x-hidden pb-6 pt-2">
        {rows.map((row) => {
          if (row.kind === "user") {
            const anchored = sideThreadsByMessage?.get(row.messageID) ?? [];
            return (
              <Message key={row.key} align="end" className="flex flex-col items-end gap-1.5">
                <MessageContent className="items-end gap-1.5">
                {row.attachments.length > 0 && (
                  <div className="flex w-fit max-w-[min(82%,35rem)] flex-wrap justify-end gap-1.5">
                    {row.attachments.map((attachment) => (
                      <SentAttachment key={attachment.id} attachment={attachment} projectID={projectID} threadID={threadID} hostID={hostID} />
                    ))}
                  </div>
                )}
                <TextSelectionPill selections={row.textSelections} />
                <BrowserAnnotationPills annotations={row.annotations} readonly />
                {row.text && (
                  <Bubble variant="muted" align="end">
                    <BubbleContent className="whitespace-pre-wrap text-foreground select-text"><MentionText text={row.text} agents={mentionAgents} /></BubbleContent>
                  </Bubble>
                )}
                {anchored.length > 0 && onOpenSideThread && (
                  <div className="flex justify-end gap-1.5">
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
                </MessageContent>
              </Message>
            );
          }
          if (row.kind === "system") {
            return (
              <Marker key={row.key} variant="separator" className="justify-center py-1 text-xs"><MarkerContent className="flex items-center gap-1.5"><Icons.arrowUp aria-hidden="true" />{row.text}</MarkerContent></Marker>
            );
          }
          if (row.kind === "assistant") {
            return (
              <Message key={row.key} align="start"><MessageContent><Bubble variant="ghost" align="start"><BubbleContent className="w-full p-0 leading-relaxed text-foreground"><Markdown text={row.text} isAnimating={false} projectID={projectID} threadID={threadID} hostID={hostID} /></BubbleContent></Bubble></MessageContent></Message>
            );
          }
          if (row.kind === "terminalArchive") {
            return (
              <details key={row.key} className="overflow-hidden rounded-lg border border-border bg-muted/50">
                <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 text-sm text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden"><Icons.terminal aria-hidden="true" />Terminal session</summary>
                <pre className="max-h-[26.25rem] overflow-auto border-t border-border p-3 font-mono text-xs leading-snug text-foreground select-text">{row.text}</pre>
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
                <Message key={row.key} align="start"><MessageContent><Bubble variant="ghost" align="start"><BubbleContent className="w-full p-0 leading-relaxed text-foreground"><Markdown text={item.text} isAnimating={activeTurnID === item.turnID} projectID={projectID} threadID={threadID} hostID={hostID} /></BubbleContent></Bubble></MessageContent></Message>
              );
            case "reasoning":
              return (
                <TimelineDisclosure key={row.key} summary="Thought briefly" contentClassName="leading-relaxed">
                  <Markdown text={item.text} isAnimating={activeTurnID === item.turnID} tone="muted" />
                </TimelineDisclosure>
              );
            case "status":
              return <div key={row.key} className="px-2 text-xs text-muted-foreground">{item.text}</div>;
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
              return <Badge key={row.key} variant={item.state === "failed" ? "destructive" : "secondary"} className="mx-2 w-fit">Turn {item.state}</Badge>;
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
              <div className="mt-2 flex items-center gap-2 text-xs font-medium text-muted-foreground first:mt-0">
                <AgentAvatar
                  name={byline.name}
                  colorHex={byline.colorHex}
                  emoji={byline.emoji}
                  imagePath={byline.imagePath}
                  size={18}
                />
                <span>{byline.name}</span>
                {bylineTime !== undefined && (
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">{relativeTime(bylineTime)}</span>
                )}
              </div>
              {rendered}
            </Fragment>
          );
        })}
        {rows.length === 0 && <p className="m-auto text-center text-sm text-muted-foreground">Send a message to begin.</p>}
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
      className="cursor-default font-medium text-primary"
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
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      size="sm"
      className="h-7 gap-1.5 rounded-full pe-2 ps-1 text-xs"
      title={side.title}
      onClick={onOpen}
    >
      <span className="inline-flex items-center">
        {participants.slice(0, 3).map((agent) => (
          <AgentAvatar
            key={agent.id}
            name={agent.name}
            colorHex={agent.colorHex}
            emoji={agent.emoji}
            imagePath={agent.imagePath}
          />
        ))}
        {participants.length === 0 && <Icons.bubble aria-hidden="true" />}
      </span>
      <span className="font-medium">
        {busy ? "Replying…" : replies === 1 ? "1 reply" : `${replies} replies`}
      </span>
      {busy ? (
        <Spinner className="size-3" />
      ) : (
        <span className="text-xs tabular-nums text-muted-foreground">{relativeTime(side.updatedAt)}</span>
      )}
    </Button>
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
    <IconButton label="Scroll to bottom" tooltip="Scroll to bottom" className="absolute bottom-3 start-1/2 -translate-x-1/2 rounded-full border border-border bg-card shadow-lg" onClick={() => void scrollToBottom()}>
      <Icons.arrowDown />
    </IconButton>
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
  const addThread = useAppStore((state) => state.addThread);
  const requestVoiceConversation = useAppStore((state) => state.requestVoiceConversation);
  const runtime = useAppStore((state) => state.newThreadRuntime);
  const setRuntime = useAppStore((state) => state.setNewThreadRuntime);
  const surface = useAppStore((state) => state.newThreadSurface);
  const setSurface = useAppStore((state) => state.setNewThreadSurface);
  const environment = useAppStore((state) => state.newThreadEnvironment);
  const setEnvironment = useAppStore((state) => state.setNewThreadEnvironment);
  const addProject = useAppStore((state) => state.addProject);
  const hostStatus = useAppStore((state) => state.hostStatus);
  const terminalModeEnabled = useAppStore((state) => state.terminalModeEnabled);
  const setNewThreadProject = useAppStore((state) => state.setNewThreadProject);
  const error = useAppStore((state) => state.error);
  const hosted = [
    ...projects.filter((project) => !isChatsProject(project)).map((project) => ({
      project,
      hostId: "local",
      hostName: hostStatus?.name ?? "This computer",
    })),
    ...remotes.flatMap((session) =>
      session.workspace.projects.filter((project) => !isChatsProject(project)).map((project) => ({
        project,
        hostId: session.host.id,
        hostName: session.host.name,
      })),
    ),
  ];
  const selectedProject = hosted.find((item) =>
    item.project.id === initialProjectID && item.hostId === initialHostID,
  ) ?? hosted.find((item) => item.project.id === initialProjectID);
  const projectID = selectedProject?.project.id ?? null;
  const selectedContextHostID = selectedProject?.hostId ?? "local";
  const dictationShortcut = useAppStore((state) => state.keyboardShortcuts.toggleDictation);
  const voiceSettings = useAppStore((state) => state.workspace?.voice ?? DEFAULT_VOICE_SETTINGS);
  const voiceEnabled = voiceSettings.isEnabled;
  const conversationReady = voiceEnabled
    && voiceSettings.ttsApiBase.trim().length > 0
    && voiceSettings.ttsModel.trim().length > 0
    && voiceSettings.voiceID.trim().length > 0;
  const dictation = useDictation({
    boundTo: "new-agent",
    enabled: voiceEnabled && surface === "gui",
    settings: voiceSettings,
    shortcut: dictationShortcut,
  });
  const { draft, setDraft } = dictation;
  const primaryComposerAction = composerPrimaryAction({
    conversationActive: false,
    hasContent: draft.trim().length > 0,
    voiceEnabled: voiceEnabled && surface === "gui",
  });
  const [sending, setSending] = useState(false);
  const [addingOnHost, setAddingOnHost] = useState<{ id: string; name: string } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const composerAttachments = useComposerAttachments();

  useEffect(() => textRef.current?.focus(), []);
  const addLocalProject = async () => {
    const folder = await ipc.openProjectDialog();
    if (folder) await addProject(folder, "local");
  };

  const submit = async () => {
    if ((!draft.trim() && (surface === "terminal" || composerAttachments.attachments.length === 0)) || sending) return;
    const prompt = draft.trim();
    const attachmentPaths = surface === "terminal" ? [] : composerAttachments.payload.attachmentPaths;
    const attachmentIds = surface === "terminal" ? [] : composerAttachments.payload.attachmentIds;
    dictation.clear();
    setSending(true);
    const created = await createThreadAndSend(
      projectID,
      runtime.provider,
      runtime.model,
      prompt,
      attachmentPaths,
      runtime.effort,
      runtime.speed,
      surface,
      environment,
      selectedContextHostID,
      attachmentIds,
    );
    setSending(false);
    if (created) composerAttachments.clear();
    else setDraft(prompt);
    requestAnimationFrame(() => textRef.current?.focus());
  };

  const startConversation = async () => {
    if (!conversationReady || sending) return;
    setSending(true);
    const thread = await addThread(
      projectID,
      runtime.provider,
      runtime.model,
      "Voice conversation",
      runtime.effort,
      runtime.speed,
      "gui",
      environment,
    );
    if (thread) {
      composerAttachments.discard();
      requestVoiceConversation(thread.id);
    } else {
      setSending(false);
    }
  };

  return (
    <main className="relative flex min-w-0 flex-1 flex-col bg-background">
      <header
        className={cn("h-10 shrink-0 [-webkit-app-region:drag]", !sidebarOpen && "ps-12")}
        onMouseDown={beginWindowDrag}
      >
        {!sidebarOpen && <span className="window-sidebar-toggle-cutout" aria-hidden="true" />}
      </header>
      <div className="m-auto w-[min(45rem,calc(100%-3rem))] -translate-y-[3vh]">
          <h1 data-slot="new-thread-heading" className="mb-4 text-center text-xl font-semibold tracking-tight text-foreground">
            {selectedProject
              ? <>What should we work on in <span className="border-b border-dotted border-muted-foreground">{projectName(selectedProject.project)}</span>?</>
              : "What should we work on?"}
          </h1>
          {surface === "gui" && <DictationStatus dictation={dictation} />}
          <div className="rounded-2xl bg-card/80 shadow-xl">
            <NewThreadContextBar
              projects={hosted}
              remoteHosts={remotes.map((session) => session.host)}
              selected={selectedProject}
              environment={environment}
              disabled={sending}
              onSelectProject={(item) => {
                setNewThreadProject(item.project.id, item.hostId);
              }}
              onClearProject={() => {
                setNewThreadProject(null, "local");
                setSurface("gui");
              }}
              onEnvironmentChange={setEnvironment}
              onAddLocalProject={() => void addLocalProject()}
              onAddRemoteProject={setAddingOnHost}
            />
            <div
              className="flex flex-col gap-1 rounded-xl border border-border bg-card p-2.5"
              onPaste={composerAttachments.onPaste}
              onDragOver={composerAttachments.onDragOver}
              onDrop={composerAttachments.onDrop}
            >
            {surface === "gui" && <PendingAttachmentStrip attachments={composerAttachments.attachments} onRemove={composerAttachments.remove} />}
            <Textarea
              ref={textRef}
              variant="composer"
              className="min-h-6 max-h-45 resize-none"
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
            <div className="-mx-0.5 -mb-0.5 flex min-h-7 items-end justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1">
                {surface === "gui" && <AttachFilesButton disabled={sending} onChoose={() => void composerAttachments.choose()} />}
                <RuntimePicker
                  provider={runtime.provider}
                  model={runtime.model}
                  effort={runtime.effort}
                  speed={runtime.speed}
                  profiles={
                    selectedContextHostID === "local"
                      ? profiles
                      : remotes.find((session) => session.host.id === selectedContextHostID)
                          ?.workspace.providerProfiles ?? profiles
                  }
                  hostId={selectedContextHostID}
                  workingDirectory={selectedProject?.project.folderPath}
                  placement="bottom"
                  triggerVariant="ghost"
                  onChange={setRuntime}
                />
              </div>
              <div className="flex items-center gap-2">
                {terminalModeEnabled && selectedProject && (
                  <IconButton
                    className={cn("rounded-full", surface === "terminal" && "bg-muted text-foreground")}
                    label={surface === "terminal" ? "Use GUI chat" : "Start in terminal mode"}
                    tooltip={surface === "terminal" ? "Use GUI chat" : "Start in terminal mode"}
                    aria-pressed={surface === "terminal"}
                    disabled={sending}
                    onClick={() => {
                      const next = surface === "terminal" ? "gui" : "terminal";
                      if (next === "terminal") {
                        dictation.stop();
                        composerAttachments.discard();
                      }
                      setSurface(next);
                      requestAnimationFrame(() => textRef.current?.focus());
                    }}
                  >
                    <Icons.terminal />
                  </IconButton>
                )}
                {surface === "gui" && (
                  <DictationButton
                    dictation={dictation}
                    visible={voiceEnabled}
                    disabled={sending}
                    shortcut={dictationShortcut}
                  />
                )}
                {surface === "gui" && composerAttachments.attachments.length === 0 && primaryComposerAction === "conversation" ? (
                  <VoiceConversationActionButton
                    onClick={() => void startConversation()}
                    disabled={!conversationReady || sending || dictation.isActive}
                    title={!conversationReady
                      ? "Configure a TTS endpoint, model, and named voice in Settings first."
                      : dictation.isActive
                        ? "Stop dictation before starting a conversation."
                        : "Create a chat and start a voice conversation"}
                  />
                ) : (
                  <IconButton className="rounded-full" label={surface === "terminal" ? "Start terminal chat" : "Start agent"} tooltip={surface === "terminal" ? "Start terminal chat" : "Start agent"} variant="default" size="icon-sm" disabled={(!draft.trim() && (surface === "terminal" || composerAttachments.attachments.length === 0)) || sending} onClick={() => void submit()}>
                    {sending ? <Spinner /> : <Icons.arrowUp />}
                  </IconButton>
                )}
              </div>
            </div>
            </div>
          </div>
          {error && <Alert variant="destructive" className="mt-2 py-1.5"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
        </div>
      {addingOnHost && (
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
      )}
    </main>
  );
}
