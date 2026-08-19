import type { VoiceConversation } from "../voice/useVoiceConversation";
import { Icons } from "./Icons";

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
      {snapshot.state === "idle" || snapshot.state === "ended" ? (
        <button
          type="button"
          className="voice-conversation-button primary"
          onClick={conversation.start}
          disabled={!conversation.canStart}
          title={conversation.canStart ? undefined : "Configure a TTS endpoint, model, and named voice in Settings first."}
        >
          <Icons.microphone size={13} />
          Start conversation
        </button>
      ) : (
        <button type="button" className="voice-conversation-button" onClick={conversation.end}>
          <Icons.stop size={13} />
          End
        </button>
      )}
      {snapshot.state !== "idle" && snapshot.state !== "ended" && (
        <button
          type="button"
          className={`voice-conversation-button${snapshot.muted ? " is-active" : ""}`}
          onClick={snapshot.muted ? conversation.unmute : conversation.mute}
          aria-pressed={snapshot.muted}
        >
          {snapshot.muted ? "Unmute" : "Mute"}
        </button>
      )}
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
