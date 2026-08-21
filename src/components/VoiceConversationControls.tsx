import type { VoiceConversation } from "../voice/useVoiceConversation";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription } from "./ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { MicOffIcon, MicIcon, SquareIcon, AudioLinesIcon } from "lucide-react";
import { cn } from "../lib/utils";

export type ComposerPrimaryAction = "conversation" | "send" | "stop-conversation";

export function composerPrimaryAction({
  conversationActive,
  hasContent,
  voiceEnabled,
}: {
  conversationActive: boolean;
  hasContent: boolean;
  voiceEnabled: boolean;
}): ComposerPrimaryAction {
  if (conversationActive) return "stop-conversation";
  if (voiceEnabled && !hasContent) return "conversation";
  return "send";
}

export function VoiceConversationActionButton({
  active = false,
  onClick,
  disabled = false,
  title,
}: {
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const label = active ? "Stop conversation" : "Start conversation";
  return (
    <div className="shrink-0" aria-label={label} title={title ?? label}>
      <Tooltip>
        <TooltipTrigger render={<Button variant={active ? "destructive" : "default"} size="icon-sm" className="rounded-full" aria-label={label} disabled={disabled} onClick={onClick} />}>
          {active ? <SquareIcon /> : <AudioLinesIcon />}
        </TooltipTrigger>
        <TooltipContent>{title ?? label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function VoiceConversationControls({
  conversation,
  visible,
  manual,
}: {
  conversation: VoiceConversation;
  visible: boolean;
  manual: boolean;
}) {
  if (!visible) return null;
  const { snapshot } = conversation;
  if (snapshot.state === "idle" || snapshot.state === "ended") return null;
  const canInterrupt = snapshot.state === "speaking" || snapshot.state === "waitingForModel";
  const canFinish = manual && snapshot.state === "transcribing";
  const canRetry = snapshot.state === "error" || snapshot.state === "reconnecting";
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Voice conversation controls">
      <Badge variant={snapshot.error ? "destructive" : "secondary"} role="status" aria-live="polite" className="gap-1.5">
        <span className={cn("size-1.5 rounded-full bg-primary", snapshot.error && "bg-destructive")} aria-hidden="true" />
        {conversation.status}
        {snapshot.muted && <span>Muted</span>}
      </Badge>
      <Button
        type="button"
        variant={snapshot.muted ? "secondary" : "outline"}
        size="sm"
        onClick={snapshot.muted ? conversation.unmute : conversation.mute}
        aria-pressed={snapshot.muted}
      >
        {snapshot.muted ? <MicIcon data-icon="inline-start" /> : <MicOffIcon data-icon="inline-start" />}
        {snapshot.muted ? "Unmute" : "Mute"}
      </Button>
      {canFinish && (
        <Button type="button" variant="outline" size="sm" onClick={conversation.finishUtterance}>
          Finish utterance
        </Button>
      )}
      {canInterrupt && (
        <Button type="button" variant="destructive" size="sm" onClick={conversation.interrupt}>
          Interrupt
        </Button>
      )}
      {canRetry && (
        <Button type="button" variant="outline" size="sm" onClick={conversation.retry}>
          Retry
        </Button>
      )}
      {snapshot.error && <Alert variant="destructive" className="px-2 py-1"><AlertDescription className="text-xs">{snapshot.error}</AlertDescription></Alert>}
    </div>
  );
}
