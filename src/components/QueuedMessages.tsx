import type { QueuedMessage } from "../messageQueue";
import { queuedMessageSummary } from "../messageQueue";
import { Icons } from "./Icons";

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
    <div className="queued-messages" aria-label={`${messages.length} queued ${messages.length === 1 ? "message" : "messages"}`}>
      {messages.map((message, index) => {
        const summary = queuedMessageSummary(message);
        return (
          <div className="queued-message" key={message.id}>
            <span className="queued-message-position" aria-label={`Queue position ${index + 1}`}>
              {index + 1}
            </span>
            <span className="queued-message-copy" title={summary}>
              <strong>Queued</strong>
              <span>{summary}</span>
            </span>
            {isRunning && canSteer && message.kind === "prompt" ? (
              <button
                className="queued-message-action"
                disabled={actionPending}
                title="Send this message into the active turn"
                onClick={() => onSteer(message.id)}
              >
                Steer
              </button>
            ) : !isRunning ? (
              <button
                className="queued-message-action"
                disabled={actionPending}
                title="Retry sending this message"
                onClick={() => onRetry(message.id)}
              >
                Retry
              </button>
            ) : null}
            <button
              className="queued-message-remove"
              aria-label="Remove queued message"
              disabled={actionPending}
              title="Remove from queue"
              onClick={() => onRemove(message.id)}
            >
              <Icons.close size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
