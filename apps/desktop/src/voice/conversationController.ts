import {
  IDLE_CONVERSATION,
  transitionConversation,
  type ConversationSnapshot,
} from "./conversationMachine";
import { SpeechPhraseBuffer } from "./phraseBuffer";

export type ConversationEffect =
  | { type: "submitTranscript"; text: string }
  | { type: "speak"; turnID: string; phrase: string }
  | { type: "interruptTurn"; turnID: string; spokenText: string }
  | { type: "cancelSpeech" }
  | { type: "cancelModel" }
  | { type: "restartListening" }
  | { type: "stopSession" };

export interface AssistantDelta {
  id: string;
  threadID: string;
  turnID: string;
  text: string;
}

/**
 * Provider-neutral conversation orchestration with no React, IPC or audio
 * dependencies. The UI hook executes the effects and feeds outcomes back in.
 */
export class VoiceConversationController {
  private value: ConversationSnapshot = IDLE_CONVERSATION;
  private readonly phrases = new SpeechPhraseBuffer();
  private readonly seenEvents: Set<string>;
  private activeTurnID: string | null = null;
  private finalSubmitted = false;
  private spoken = "";
  /** Terminal turn IDs remain fenced off from delayed remote runtime events. */
  private readonly finalizedTurnIDs = new Set<string>();

  constructor(
    private readonly threadID: string,
    historicalEventIDs: Iterable<string>,
    private readonly emit: (effect: ConversationEffect) => void,
    private readonly allowInterruption = true,
  ) {
    this.seenEvents = new Set(historicalEventIDs);
  }

  get snapshot(): ConversationSnapshot {
    return this.value;
  }

  get boundThreadID(): string {
    return this.threadID;
  }

  get interruptTarget(): { turnID: string; spokenText: string } | null {
    return this.activeTurnID
      ? { turnID: this.activeTurnID, spokenText: this.spoken.trim() }
      : null;
  }

  start(): void {
    this.value = transitionConversation(this.value, { type: "start" });
  }

  speechStarted(): void {
    if (this.value.state === "speaking" || this.value.state === "waitingForModel") {
      if (!this.allowInterruption) return;
      const turnID = this.activeTurnID;
      this.emit({ type: "cancelSpeech" });
      if (turnID) this.emit({ type: "interruptTurn", turnID, spokenText: this.spoken.trim() });
      else this.emit({ type: "cancelModel" });
      this.phrases.clear();
      this.activeTurnID = null;
      this.spoken = "";
      this.value = transitionConversation(this.value, { type: "interrupt" });
      this.value = { ...this.value, state: "listening" };
    }
    this.finalSubmitted = false;
    this.value = transitionConversation(this.value, { type: "speechStarted" });
  }

  transcriptFinal(text: string): void {
    const final = text.trim();
    if (!final) return;
    if (
      this.value.state !== "listening"
      && this.value.state !== "transcribing"
      && this.value.state !== "speaking"
    ) return;
    if (this.finalSubmitted) return;
    this.finalSubmitted = true;
    this.value = transitionConversation(this.value, { type: "transcriptFinal" });
    this.emit({ type: "submitTranscript", text: final });
  }

  /** Record only audio phrases that completed playback. */
  phraseCompleted(turnID: string, phrase: string): void {
    if (this.activeTurnID !== turnID || !phrase.trim()) return;
    this.spoken = this.spoken ? `${this.spoken} ${phrase.trim()}` : phrase.trim();
  }

  assistantDelta(event: AssistantDelta): void {
    if (event.threadID !== this.threadID || this.seenEvents.has(event.id)) return;
    this.seenEvents.add(event.id);
    // A provider/runtime event can arrive after the terminal event when the
    // host refreshes a thread from a remote transport. The terminal event is
    // the stream boundary; accepting text after it would enqueue audio after
    // playback completion has already been scheduled.
    if (this.finalizedTurnIDs.has(event.turnID)) return;
    if (this.value.state !== "waitingForModel" && this.value.state !== "speaking") return;
    if (this.activeTurnID && event.turnID !== this.activeTurnID) return;
    this.activeTurnID = event.turnID;
    for (const phrase of this.phrases.append(event.text)) {
      this.emit({ type: "speak", turnID: event.turnID, phrase });
    }
  }

  modelFinished(turnID: string): boolean {
    if (this.activeTurnID && turnID !== this.activeTurnID) return false;
    if (this.finalizedTurnIDs.has(turnID)) return false;
    this.finalizedTurnIDs.add(turnID);
    // Keep the stale-event fence bounded for long-lived conversations.
    if (this.finalizedTurnIDs.size > 256) {
      const oldest = this.finalizedTurnIDs.values().next().value;
      if (oldest) this.finalizedTurnIDs.delete(oldest);
    }
    this.activeTurnID = turnID;
    for (const phrase of this.phrases.flush()) {
      this.emit({ type: "speak", turnID, phrase });
    }
    this.value = transitionConversation(this.value, { type: "modelFinished" });
    if (this.value.state === "listening") this.emit({ type: "restartListening" });
    return true;
  }

  /** Bind the canonical turn before its first assistant delta arrives. */
  modelStarted(turnID: string): void {
    if (!turnID || this.value.state !== "waitingForModel") return;
    if (!this.activeTurnID) this.activeTurnID = turnID;
  }

  playbackStarted(): void {
    this.value = transitionConversation(this.value, { type: "audioStarted" });
  }

  playbackFinished(): void {
    this.value = transitionConversation(this.value, { type: "audioFinished" });
    if (this.value.state === "listening") {
      this.activeTurnID = null;
      this.finalSubmitted = false;
      this.emit({ type: "restartListening" });
    }
  }

  resumeListening(): void {
    if (this.value.state === "interrupted") {
      this.value = { ...this.value, state: "listening", error: null };
    }
  }

  reconnecting(): void {
    this.value = transitionConversation(this.value, { type: "reconnecting" });
  }

  /** Drop transient output state while retaining the thread/session binding. */
  connectionLost(): void {
    this.phrases.clear();
    this.activeTurnID = null;
    this.finalSubmitted = false;
    this.spoken = "";
    this.value = transitionConversation(this.value, { type: "reconnecting" });
  }

  retry(): void {
    this.value = transitionConversation(this.value, { type: "retry" });
  }

  reconnected(): void {
    this.value = transitionConversation(this.value, { type: "reconnected" });
  }

  fail(message: string): void {
    this.emit({ type: "cancelSpeech" });
    this.value = transitionConversation(this.value, { type: "fail", message });
  }

  mute(muted: boolean): void {
    this.value = transitionConversation(this.value, { type: muted ? "mute" : "unmute" });
  }

  interrupt(): void {
    if (this.value.state !== "speaking" && this.value.state !== "waitingForModel") return;
    this.emit({ type: "cancelSpeech" });
    if (this.activeTurnID) {
      this.emit({ type: "interruptTurn", turnID: this.activeTurnID, spokenText: this.spoken.trim() });
    } else this.emit({ type: "cancelModel" });
    this.phrases.clear();
    this.spoken = "";
    this.value = transitionConversation(this.value, { type: "interrupt" });
    // A manual Interrupt is a control action, not an End action. Resume the
    // microphone immediately so the next utterance does not remain stuck in
    // the transient Interrupted state while the hook reopens STT.
    this.value = { ...this.value, state: "listening", error: null };
  }

  end(): void {
    if (this.value.state === "ended") return;
    this.emit({ type: "cancelSpeech" });
    if (this.value.state === "speaking" || this.value.state === "waitingForModel") {
      if (this.activeTurnID) {
        this.emit({ type: "interruptTurn", turnID: this.activeTurnID, spokenText: this.spoken.trim() });
      } else {
        this.emit({ type: "cancelModel" });
      }
    }
    this.emit({ type: "stopSession" });
    this.phrases.clear();
    this.spoken = "";
    this.value = transitionConversation(this.value, { type: "end" });
  }
}
