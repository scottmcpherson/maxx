import type { VoiceConversation } from "../voice/useVoiceConversation";
import { Icons } from "./Icons";

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
    <button
      type="button"
      className={`send-button voice-conversation-action${active ? " stop" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
    >
      {active ? <Icons.stop size={14} /> : <Icons.waveform size={16} />}
    </button>
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
    <div className="voice-conversation-controls" aria-label="Voice conversation controls">
      <span
        className={`voice-conversation-status state-${snapshot.state}`}
        role="status"
        aria-live="polite"
      >
        <span className="voice-conversation-dot" aria-hidden="true" />
        {conversation.status}
        {snapshot.muted && <span className="voice-conversation-muted">Muted</span>}
      </span>
      <button
        type="button"
        className={`voice-conversation-button${snapshot.muted ? " is-active" : ""}`}
        onClick={snapshot.muted ? conversation.unmute : conversation.mute}
        aria-pressed={snapshot.muted}
      >
        {snapshot.muted ? "Unmute" : "Mute"}
      </button>
      {canFinish && (
        <button type="button" className="voice-conversation-button" onClick={conversation.finishUtterance}>
          Finish utterance
        </button>
      )}
      {canInterrupt && (
        <button type="button" className="voice-conversation-button interrupt" onClick={conversation.interrupt}>
          Interrupt
        </button>
      )}
      {canRetry && (
        <button type="button" className="voice-conversation-button" onClick={conversation.retry}>
          Retry
        </button>
      )}
      {snapshot.error && <span className="voice-conversation-error">{snapshot.error}</span>}
    </div>
  );
}
