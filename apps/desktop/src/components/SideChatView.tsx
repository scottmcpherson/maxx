import { useMemo, useRef, useState } from "react";
import { buildTimeline } from "../contract/timeline";
import type { ChatProject, ChatTextSelection, ChatThread } from "../contract/types";
import { buildRows, ThreadTimeline } from "./ThreadView";
import { useAppStore } from "../store/appStore";
import { threadWorkingDirectory } from "../git";
import { AttachFilesButton, PendingAttachmentStrip, useComposerAttachments } from "./ComposerAttachments";
import { Icons } from "./Icons";
import { MentionTextarea } from "./MentionTextarea";
import { QueuedMessages } from "./QueuedMessages";
import { RuntimePicker } from "./RuntimePicker";
import { TextSelectionPill } from "./TextSelectionPill";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";

export function SideChatView({
  project,
  thread,
  hostID,
  pendingSelections,
  onClearSelections,
}: {
  project: ChatProject;
  thread: ChatThread;
  hostID?: string;
  pendingSelections: ChatTextSelection[];
  onClearSelections: () => void;
}) {
  const workspace = useAppStore((state) => state.workspace);
  const remoteSessions = useAppStore((state) => state.remoteSessions);
  const activeTurns = useAppStore((state) => state.activeTurnByThread);
  const queuedMessagesByThread = useAppStore((state) => state.queuedMessagesByThread);
  const sendingMessageByThread = useAppStore((state) => state.sendingMessageByThread);
  const sendSideChatPrompt = useAppStore((state) => state.sendSideChatPrompt);
  const retryQueuedMessage = useAppStore((state) => state.retryQueuedMessage);
  const removeQueuedMessage = useAppStore((state) => state.removeQueuedMessage);
  const cancelActiveTurn = useAppStore((state) => state.cancelActiveTurn);
  const resolveRequest = useAppStore((state) => state.resolveRequest);
  const updateThreadRuntime = useAppStore((state) => state.updateThreadRuntime);
  const timeline = useMemo(() => buildTimeline(thread.runtimeEvents), [thread.runtimeEvents]);
  const terminalTurnIDs = useMemo(
    () => new Set(timeline.filter((item) => item.type === "terminal").map((item) => item.turnID)),
    [timeline],
  );
  const rows = useMemo(() => buildRows(thread, timeline), [thread, timeline]);
  const profiles = useMemo(() => {
    if (!hostID || hostID === "local") return workspace?.providerProfiles ?? [];
    return remoteSessions.find((session) => session.host.id === hostID)?.workspace.providerProfiles
      ?? workspace?.providerProfiles
      ?? [];
  }, [hostID, remoteSessions, workspace]);
  const isRunning = Boolean(activeTurns[thread.id]);
  const queuedMessages = queuedMessagesByThread[thread.id] ?? [];
  const queueActionPending = Boolean(sendingMessageByThread[thread.id]);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const composerAttachments = useComposerAttachments();

  const resolvedStatus = (requestID: string | undefined): string | null => {
    if (!requestID) return null;
    const record = thread.interactionRequests.find((request) => request.id === requestID);
    return record && record.status !== "pending" ? record.status : null;
  };

  const submit = async () => {
    if ((!draft.trim() && composerAttachments.attachments.length === 0 && pendingSelections.length === 0) || submitting) return;
    setSubmitting(true);
    const sent = await sendSideChatPrompt(
      project.id,
      thread.id,
      draft.trim(),
      composerAttachments.payload.attachmentPaths,
      pendingSelections,
      composerAttachments.payload.attachmentIds,
    );
    setSubmitting(false);
    if (!sent) return;
    setDraft("");
    composerAttachments.clear();
    onClearSelections();
    requestAnimationFrame(() => draftRef.current?.focus());
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background" aria-label="Side chat">
      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Icons.bubble /></EmptyMedia>
            <EmptyTitle>Side chat</EmptyTitle>
            <EmptyDescription>Ask a focused question with the full context of the primary chat.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ThreadTimeline
          key={thread.id}
          projectID={project.id}
          threadID={thread.id}
          hostID={hostID}
          rows={rows}
          terminalTurnIDs={terminalTurnIDs}
          activeTurnID={activeTurns[thread.id]}
          resolvedStatus={resolvedStatus}
          onResolve={(requestID, decision) => void resolveRequest(project.id, thread.id, requestID, decision)}
        />
      )}

      <footer className="flex shrink-0 flex-col gap-2 px-4 pb-4">
        <QueuedMessages
          messages={queuedMessages}
          isRunning={isRunning}
          canSteer={false}
          actionPending={queueActionPending}
          onSteer={() => {}}
          onRetry={(messageID) => void retryQueuedMessage(thread.id, messageID)}
          onRemove={(messageID) => removeQueuedMessage(thread.id, messageID)}
        />
        <div
          className="relative flex min-h-16 w-full flex-col gap-1 rounded-xl border border-border bg-card p-2.5 shadow-sm"
          onPaste={composerAttachments.onPaste}
          onDragOver={composerAttachments.onDragOver}
          onDrop={composerAttachments.onDrop}
        >
          <TextSelectionPill selections={pendingSelections} onClear={onClearSelections} />
          <PendingAttachmentStrip attachments={composerAttachments.attachments} onRemove={composerAttachments.remove} />
          <MentionTextarea
            ref={draftRef}
            agents={[]}
            rows={1}
            value={draft}
            aria-label="Message side chat"
            placeholder="Ask in side chat"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="-mx-0.5 -mb-0.5 flex min-h-7 items-end justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <AttachFilesButton onChoose={() => void composerAttachments.choose()} />
              <RuntimePicker
                provider={thread.provider}
                model={thread.model}
                effort={thread.effort}
                speed={thread.speed}
                profiles={profiles}
                workingDirectory={threadWorkingDirectory(project.folderPath, thread)}
                hostId={hostID}
                disabled={isRunning}
                triggerVariant="ghost"
                onChange={(next) => void updateThreadRuntime(
                  project.id,
                  thread.id,
                  next.provider,
                  next.model,
                  next.effort,
                  next.speed,
                )}
              />
            </div>
            <div className="flex items-center gap-2.5">
              {isRunning && (
                <IconButton className="rounded-full" label="Stop generation" variant="destructive" size="icon-sm" onClick={() => void cancelActiveTurn(thread.id)}>
                  <Icons.stop />
                </IconButton>
              )}
              <IconButton
                label={submitting ? "Sending message" : "Send message"}
                variant="default"
                size="icon-sm"
                className="rounded-full"
                disabled={submitting || (!draft.trim() && composerAttachments.attachments.length === 0 && pendingSelections.length === 0)}
                onClick={() => void submit()}
              >
                {submitting ? <Spinner /> : <Icons.arrowUp />}
              </IconButton>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
