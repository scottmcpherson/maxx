// The dictation toggle, as a composer-shaped hook.
//
// Owns the draft text so transcripts and typing go through one place: a
// partial rewrites the span, typing releases it (see `dictation.ts`). Callers
// use `draft`/`setDraft` exactly as they would `useState`.

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../ipc";
import { matchesKeyboardShortcut } from "../keyboardShortcuts";
import type { KeyboardShortcutBinding } from "../keyboardShortcuts";
import {
  applyInterim,
  commitFinal,
  discardSpan,
  EMPTY_DRAFT,
  releaseSpan,
  setDraftText,
} from "./dictation";
import type { DictationDraft } from "./dictation";
import { DEFAULT_VOICE_SETTINGS } from "./types";
import type { VoiceSettings } from "./types";

/**
 * `starting` covers both opening the microphone and connecting the socket —
 * they run concurrently, and the user has no use for the distinction. It ends
 * when the backend reports `listening`.
 */
export type DictationState = "idle" | "starting" | "listening" | "stopping";

export interface Dictation {
  draft: string;
  /** Replace the draft from the UI. Releases any live transcript region. */
  setDraft: (text: string) => void;
  /** Clear after sending; also ends a running session. */
  clear: () => void;
  state: DictationState;
  isActive: boolean;
  error: string | null;
  dismissError: () => void;
  toggle: () => void;
  /** Stop and keep what was transcribed. */
  stop: () => void;
  /** Stop and drop the in-flight preview — Escape. */
  cancel: () => void;
}

export function useDictation(options: {
  /** Dictation is per-composer; changing this ends any running session. */
  boundTo: string | null;
  enabled: boolean;
  /** Client-owned snapshot passed to the selected speech execution host. */
  settings?: VoiceSettings;
  /** Bound here rather than in `App`: only the mounted composer can act on it. */
  shortcut?: KeyboardShortcutBinding;
}): Dictation {
  const { boundTo, enabled, shortcut, settings = DEFAULT_VOICE_SETTINGS } = options;
  const [draft, setDraftState] = useState<DictationDraft>(EMPTY_DRAFT);
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);

  // The session this composer owns. Events for any other session belong to a
  // stale run and are ignored.
  const sessionRef = useRef<number | null>(null);
  const captureRef = useRef<{ stop: () => Promise<void> } | null>(null);
  const sessionHostRef = useRef<string>(settings.speechHostID);
  const sessionSequenceRef = useRef(0);
  // Read inside the event listener, which is registered once.
  const stateRef = useRef<DictationState>("idle");
  stateRef.current = state;

  const releaseCapture = useCallback(async () => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) await capture.stop();
  }, []);

  const endSession = useCallback(
    async (mode: "keep" | "discard") => {
      const session = sessionRef.current;
      // The microphone is released immediately; the socket drains afterwards
      // so the sentence just spoken still arrives.
      await releaseCapture();
      if (mode === "discard") setDraftState((current) => discardSpan(current));
      else setDraftState((current) => releaseSpan(current));
      if (session !== null) {
        sessionRef.current = null;
        try {
          await ipc.voiceStop(session, sessionHostRef.current);
        } catch {
          /* Session already gone; nothing to stop. */
        }
      }
      setState("idle");
    },
    [releaseCapture],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void ipc
      .onVoiceEvent((event) => {
        if (event.session !== sessionRef.current) return;
        switch (event.kind) {
          case "state":
            if (event.state === "listening") setState("listening");
            if (event.state === "stopped") {
              // The backend can end a session on its own — a watchdog, or a
              // connection it could not recover. Tear the microphone down to
              // match rather than leaving it open against a dead socket.
              sessionRef.current = null;
              sessionSequenceRef.current = 0;
              void releaseCapture();
              setDraftState((current) => releaseSpan(current));
              setState("idle");
            }
            break;
          case "interim":
            setDraftState((current) => applyInterim(current, event.text));
            break;
          case "final":
            setDraftState((current) => commitFinal(current, event.text));
            break;
          case "error":
            setError(event.hint ? `${event.message} ${event.hint}` : event.message);
            break;
        }
      }, settings.speechHostID)
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [releaseCapture, settings.speechHostID]);

  // Switching composers stops dictation rather than letting audio feed a
  // draft the user can no longer see.
  useEffect(() => {
    return () => {
      if (sessionRef.current !== null) void endSession("keep");
    };
  }, [boundTo, endSession, settings.speechHostID]);

  const start = useCallback(async () => {
    setError(null);
    setState("starting");
    let session: number;
    try {
      // First: it validates settings and the credential, so a misconfigured
      // setup never opens the microphone at all.
      session = await ipc.voiceStart(settings, settings.speechHostID);
    } catch (reason) {
      setState("idle");
      setError(String(reason));
      return;
    }
    sessionRef.current = session;
    sessionHostRef.current = settings.speechHostID;
    sessionSequenceRef.current = 0;

    try {
      // Capture starts while the socket is still connecting; chunks buffer on
      // the Rust side so the first word of an utterance is not clipped.
      const { startMicrophoneCapture } = await import("./capture");
      captureRef.current = await startMicrophoneCapture((chunk) => {
        if (sessionRef.current !== session) return;
        const sequence = sessionSequenceRef.current;
        sessionSequenceRef.current += 1;
        void ipc.voiceSendAudio(session, chunk, sequence, sessionHostRef.current).catch((reason) => {
          if (sessionRef.current === session) setError(`Voice audio error: ${String(reason)}`);
        });
      }, { inputDeviceId: settings.inputDeviceID });
    } catch (reason) {
      sessionRef.current = null;
      void ipc.voiceStop(session, sessionHostRef.current).catch(() => {});
      setState("idle");
      setError(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "Maxx needs microphone access. Allow it in System Settings → Privacy & Security → Microphone."
          : `Could not open the microphone: ${String(reason)}`,
      );
    }
  }, [releaseCapture, settings]);

  const stop = useCallback(() => {
    if (sessionRef.current === null) return;
    setState("stopping");
    void endSession("keep");
  }, [endSession]);

  const cancel = useCallback(() => {
    if (sessionRef.current === null) return;
    setState("stopping");
    void endSession("discard");
  }, [endSession]);

  const toggle = useCallback(() => {
    if (!enabled) return;
    if (sessionRef.current === null) void start();
    else stop();
  }, [enabled, start, stop]);

  useEffect(() => {
    if (!shortcut || !enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeyboardShortcut(event, shortcut)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, shortcut, toggle]);

  const setDraft = useCallback((text: string) => {
    // Typing takes ownership: a partial must never overwrite the user's edit.
    setDraftState(setDraftText(text));
  }, []);

  const clear = useCallback(() => {
    if (sessionRef.current !== null) void endSession("keep");
    setDraftState(EMPTY_DRAFT);
  }, [endSession]);

  return {
    draft: draft.text,
    setDraft,
    clear,
    state,
    isActive: state !== "idle",
    error,
    dismissError: () => setError(null),
    toggle,
    stop,
    cancel,
  };
}
