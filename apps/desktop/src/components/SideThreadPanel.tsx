import { useMemo, useRef, useState } from "react";
import { buildTimeline } from "../contract/timeline";
import { AgentDefinition, ChatProject, ChatThread } from "../contract/types";
import { mentionedAgents } from "../mentions";
import { useAppStore } from "../store/appStore";
import { beginWindowDrag } from "../windowDrag";
import { AgentAvatar } from "./AgentAvatar";
import { Icons } from "./Icons";
import { AttachImagesButton, PendingImageStrip, useImageAttachments } from "./ImageAttachments";
import { MentionMenu, useMentionMenu } from "./MentionMenu";
import { MentionTextarea } from "./MentionTextarea";
import { QueuedMessages } from "./QueuedMessages";
import { ThreadTimeline, buildRows } from "./ThreadView";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";

/**
 * Slack-style reply panel for one side thread: agents answer here, and
 * mentioning a different agent brings it into the same conversation with the
 * full context.
 */
export function SideThreadPanel({
  project,
  thread,
  agentsByID,
  onClose,
}: {
  project: ChatProject;
  thread: ChatThread;
  agentsByID: Map<string, AgentDefinition>;
  onClose: () => void;
}) {
  const workspace = useAppStore((state) => state.workspace);
  const activeTurns = useAppStore((state) => state.activeTurnByThread);
  const queuedMessagesByThread = useAppStore((state) => state.queuedMessagesByThread);
  const sendingMessageByThread = useAppStore((state) => state.sendingMessageByThread);
  const sendAgentPrompt = useAppStore((state) => state.sendAgentPrompt);
  const retryQueuedMessage = useAppStore((state) => state.retryQueuedMessage);
  const removeQueuedMessage = useAppStore((state) => state.removeQueuedMessage);
  const cancelActiveTurn = useAppStore((state) => state.cancelActiveTurn);
  const resolveRequest = useAppStore((state) => state.resolveRequest);

  const agents = useMemo(() => workspace?.agents ?? [], [workspace]);
  const timeline = useMemo(() => buildTimeline(thread.runtimeEvents), [thread]);
  const terminalTurnIDs = useMemo(
    () => new Set(timeline.filter((item) => item.type === "terminal").map((item) => item.turnID)),
    [timeline],
  );
  const rows = useMemo(() => buildRows(thread, timeline), [thread, timeline]);
  const isRunning = !!activeTurns[thread.id];
  const queuedMessages = queuedMessagesByThread[thread.id] ?? [];
  const queueActionPending = !!sendingMessageByThread[thread.id];
  const currentAgent = thread.agentID ? agentsByID.get(thread.agentID) : undefined;

  // Attribute turns to agents: completed turns via the assistant message's
  // source event, the live/latest turn via the thread's current agent.
  const turnAgents = useMemo(() => {
    const map = new Map<string, AgentDefinition>();
    const turnByEventID = new Map(thread.runtimeEvents.map((event) => [event.id, event.turnID]));
    for (const message of thread.messages) {
      if (message.role !== "assistant" || !message.agentID || !message.sourceEventID) continue;
      const turnID = turnByEventID.get(message.sourceEventID);
      const agent = agentsByID.get(message.agentID);
      if (turnID && agent) map.set(turnID, agent);
    }
    const activeTurnID = activeTurns[thread.id];
    if (activeTurnID && currentAgent) map.set(activeTurnID, currentAgent);
    if (thread.lastTurnID && currentAgent && !map.has(thread.lastTurnID)) {
      map.set(thread.lastTurnID, currentAgent);
    }
    return map;
  }, [activeTurns, agentsByID, currentAgent, thread]);

  const participants = useMemo(() => {
    const seen = new Map<string, AgentDefinition>();
    for (const agent of turnAgents.values()) seen.set(agent.id, agent);
    if (currentAgent) seen.set(currentAgent.id, currentAgent);
    return [...seen.values()];
  }, [currentAgent, turnAgents]);

  // Turn start times for byline timestamps.
  const turnTimes = useMemo(() => {
    const map = new Map<string, number>();
    for (const event of thread.runtimeEvents) {
      const existing = map.get(event.turnID);
      if (existing === undefined || event.occurredAt < existing) {
        map.set(event.turnID, event.occurredAt);
      }
    }
    return map;
  }, [thread]);

  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const mentionMenu = useMentionMenu({ agents, textareaRef: draftRef, setDraft });
  const images = useImageAttachments();

  // Mentions address those agents (responding in mention order); an
  // unmentioned follow-up goes to whoever spoke last.
  const draftMentions = useMemo(() => mentionedAgents(draft, agents), [agents, draft]);
  const targetAgents = useMemo(
    () => (draftMentions.length > 0 ? draftMentions : currentAgent ? [currentAgent] : []),
    [currentAgent, draftMentions],
  );

  const resolvedStatus = (requestID: string | undefined): string | null => {
    if (!requestID) return null;
    const record = thread.interactionRequests.find((request) => request.id === requestID);
    return record && record.status !== "pending" ? record.status : null;
  };

  const submit = async () => {
    if ((!draft.trim() && images.paths.length === 0) || submitting || targetAgents.length === 0) return;
    setSubmitting(true);
    const sent = await sendAgentPrompt(
      project.id,
      thread.id,
      targetAgents.map((agent) => agent.id),
      draft.trim(),
      images.paths,
    );
    setSubmitting(false);
    if (!sent) return;
    setDraft("");
    images.clear();
    mentionMenu.dismiss();
    requestAnimationFrame(() => draftRef.current?.focus());
  };

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-border bg-background"
      aria-label="Side thread"
    >
      <header className="flex h-10 shrink-0 items-center gap-2.5 px-3.5 text-xs font-semibold text-muted-foreground" onMouseDown={beginWindowDrag}>
        <div className="flex shrink-0 items-center gap-1.5">
          <Icons.bubble size={14} />
          <span>Thread</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center" aria-label="Participating agents">
          {participants.map((agent) => (
            <span key={agent.id} className="-me-1 inline-flex shrink-0 rounded-full ring-2 ring-background" title={agent.name}>
              <AgentAvatar
                name={agent.name}
                colorHex={agent.colorHex}
                emoji={agent.emoji}
                imagePath={agent.imagePath}
                size={20}
              />
            </span>
          ))}
        </div>
        <IconButton label="Close thread" onClick={onClose}>
          <Icons.close />
        </IconButton>
      </header>

      <ThreadTimeline
        key={thread.id}
        projectID={project.id}
        threadID={thread.id}
        rows={rows}
        terminalTurnIDs={terminalTurnIDs}
        activeTurnID={activeTurns[thread.id]}
        resolvedStatus={resolvedStatus}
        onResolve={(requestID, decision) =>
          void resolveRequest(project.id, thread.id, requestID, decision)}
        agentsByID={agentsByID}
        turnAgents={turnAgents}
        turnTimes={turnTimes}
      />

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
        <div className="relative flex min-h-16 w-full flex-col gap-1 rounded-xl border border-border bg-card p-2.5 shadow-sm">
          <MentionMenu menu={mentionMenu} />
          <PendingImageStrip paths={images.paths} onRemove={images.remove} />
          <MentionTextarea
            ref={draftRef}
            agents={agents}
            rows={1}
            value={draft}
            aria-label="Reply in side thread"
            placeholder="Reply · @agent to bring in another"
            onChange={(event) => {
              setDraft(event.target.value);
              mentionMenu.refresh();
            }}
            onClick={mentionMenu.refresh}
            onKeyUp={(event) => {
              if (event.key.startsWith("Arrow")) mentionMenu.refresh();
            }}
            onKeyDown={(event) => {
              if (mentionMenu.onKeyDown(event)) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="-mx-0.5 -mb-0.5 flex min-h-7 items-end justify-between gap-2">
            {/* No single "replying to" addressee: any mix of agents can be
                mentioned in one reply, and the composer already shows them as
                pills. Unmentioned replies go to whoever spoke last. */}
            <AttachImagesButton disabled={false} onChoose={() => void images.choose()} />
            {isRunning ? (
              <div className="flex items-center gap-2.5">
                <IconButton
                  label="Stop generation"
                  variant="destructive"
                  size="icon-sm"
                  className="rounded-full"
                  onClick={() => void cancelActiveTurn(thread.id)}
                >
                  <Icons.stop />
                </IconButton>
                <IconButton
                  label={submitting ? "Queueing reply" : "Queue reply"}
                  variant="default"
                  size="icon-sm"
                  className="rounded-full"
                  disabled={submitting || (!draft.trim() && images.paths.length === 0) || targetAgents.length === 0}
                  onClick={() => void submit()}
                >
                  {submitting ? <Spinner /> : <Icons.arrowUp />}
                </IconButton>
              </div>
            ) : (
              <IconButton
                label="Send reply"
                variant="default"
                size="icon-sm"
                className="rounded-full"
                disabled={(!draft.trim() && images.paths.length === 0) || targetAgents.length === 0}
                onClick={() => void submit()}
              >
                <Icons.arrowUp />
              </IconButton>
            )}
          </div>
        </div>
      </footer>
    </aside>
  );
}
