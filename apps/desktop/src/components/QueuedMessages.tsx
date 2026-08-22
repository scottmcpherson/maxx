import type { QueuedMessage } from "../messageQueue";
import { queuedMessageSummary } from "../messageQueue";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "./ui/item";
import { XIcon } from "lucide-react";

export function QueuedMessages({
  messages,
  isRunning,
  canSteer,
  actionPending,
  onSteer,
  onRetry,
  onRemove,
}: {
  messages: QueuedMessage[];
  isRunning: boolean;
  canSteer: boolean;
  actionPending: boolean;
  onSteer: (messageID: string) => void;
  onRetry: (messageID: string) => void;
  onRemove: (messageID: string) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" aria-label={`${messages.length} queued ${messages.length === 1 ? "message" : "messages"}`}>
      {messages.map((message, index) => {
        const summary = queuedMessageSummary(message);
        return (
          <Item key={message.id} variant="muted" size="sm" className="min-h-10 gap-2 border-border/70 px-2 py-1.5">
            <Badge variant="outline" className="size-5 justify-center rounded-full px-0 text-[0.65rem] text-muted-foreground" aria-label={`Queue position ${index + 1}`}>
              {index + 1}
            </Badge>
            <ItemContent className="min-w-0 gap-0">
              <ItemTitle className="text-xs text-muted-foreground">Queued</ItemTitle>
              <ItemDescription className="truncate text-xs" title={summary}>{summary}</ItemDescription>
            </ItemContent>
            <ItemActions className="gap-1">
            {isRunning && canSteer && message.kind === "prompt" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={actionPending}
                title="Send this message into the active turn"
                onClick={() => onSteer(message.id)}
              >
                Steer
              </Button>
            ) : !isRunning ? (
              <Button
                variant="outline"
                size="sm"
                disabled={actionPending}
                title="Retry sending this message"
                onClick={() => onRetry(message.id)}
              >
                Retry
              </Button>
            ) : null}
            <IconButton
              label="Remove queued message"
              tooltip="Remove from queue"
              size="icon-xs"
              disabled={actionPending}
              onClick={() => onRemove(message.id)}
            >
              <XIcon />
            </IconButton>
            </ItemActions>
          </Item>
        );
      })}
    </div>
  );
}
