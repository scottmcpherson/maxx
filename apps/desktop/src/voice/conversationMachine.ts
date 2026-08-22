export type ConversationState =
  | "idle"
  | "listening"
  | "transcribing"
  | "waitingForModel"
  | "speaking"
  | "interrupted"
  | "reconnecting"
  | "error"
  | "ended";

export interface ConversationSnapshot {
  state: ConversationState;
  muted: boolean;
  modelFinished: boolean;
  audioFinished: boolean;
  error: string | null;
}

export type ConversationAction =
  | { type: "start" }
  | { type: "speechStarted" }
  | { type: "transcriptFinal" }
  | { type: "modelStarted" }
  | { type: "audioStarted" }
  | { type: "modelFinished" }
  | { type: "audioFinished" }
  | { type: "interrupt" }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "fail"; message: string }
  | { type: "retry" }
  | { type: "end" };

export const IDLE_CONVERSATION: ConversationSnapshot = {
  state: "idle",
  muted: false,
  modelFinished: false,
  audioFinished: true,
  error: null,
};

/** Pure transition table for the renderer-owned voice conversation. */
export function transitionConversation(
  current: ConversationSnapshot,
  action: ConversationAction,
): ConversationSnapshot {
  if (action.type === "end") return { ...current, state: "ended", muted: false, error: null };
  if (action.type === "fail") return { ...current, state: "error", error: action.message };
  if (action.type === "mute") return { ...current, muted: true };
  if (action.type === "unmute") return { ...current, muted: false };

  switch (action.type) {
    case "start":
      return current.state === "idle" || current.state === "ended"
        ? { ...IDLE_CONVERSATION, state: "listening" }
        : current;
    case "speechStarted":
      return current.state === "listening" || current.state === "speaking"
        ? { ...current, state: "transcribing" }
        : current;
    case "transcriptFinal":
      return current.state === "listening" || current.state === "transcribing" || current.state === "speaking"
        ? { ...current, state: "waitingForModel", modelFinished: false, audioFinished: false }
        : current;
    case "modelStarted":
      return current.state === "waitingForModel" ? current : current;
    case "audioStarted":
      return current.state === "waitingForModel" || current.state === "speaking"
        ? { ...current, state: "speaking", audioFinished: false }
        : current;
    case "modelFinished": {
      const next = { ...current, modelFinished: true };
      return next.audioFinished && next.state !== "error"
        ? { ...next, state: next.muted ? "interrupted" : "listening" }
        : next;
    }
    case "audioFinished": {
      const next = { ...current, audioFinished: true };
      return next.modelFinished && next.state !== "error"
        ? { ...next, state: next.muted ? "interrupted" : "listening" }
        : next;
    }
    case "interrupt":
      return current.state === "speaking" || current.state === "waitingForModel"
        ? { ...current, state: "interrupted", modelFinished: false, audioFinished: true }
        : current;
    case "reconnecting":
      return current.state !== "idle" && current.state !== "ended"
        ? { ...current, state: "reconnecting" }
        : current;
    case "reconnected":
      return current.state === "reconnecting"
        ? { ...current, state: current.muted ? "interrupted" : "listening", error: null }
        : current;
    case "retry":
      return current.state === "error"
        ? { ...current, state: current.muted ? "interrupted" : "reconnecting", error: null }
        : current;
    default:
      return current;
  }
}
