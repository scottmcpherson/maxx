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
import { microphoneErrorMessage, startMicrophoneCapture } from "./capture";

/**
 * `starting` covers both opening the microphone and connecting the socket —
 * they run concurrently, and the user has no use for the distinction. It ends
 * when the backend reports `listening`.
 */
export type DictationState = "idle" | "starting" | "listening" | "stopping";

const STOP_DRAIN_TIMEOUT_MS = 15_000;

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
  const startEpochRef = useRef(0);
  const audioSendsRef = useRef<Set<Promise<void>>>(new Set());
  const discardedSessionRef = useRef<number | null>(null);
  const stopDrainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside the event listener, which is registered once.
  const stateRef = useRef<DictationState>("idle");
  stateRef.current = state;

  const releaseCapture = useCallback(async () => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) await capture.stop();
  }, []);

  const clearStopDrainTimer = useCallback(() => {
    if (stopDrainTimerRef.current === null) return;
    clearTimeout(stopDrainTimerRef.current);
    stopDrainTimerRef.current = null;
  }, []);

  const finishSession = useCallback((session: number) => {
    if (sessionRef.current !== session) return;
    clearStopDrainTimer();
    sessionRef.current = null;
    sessionSequenceRef.current = 0;
    audioSendsRef.current.clear();
    const discarded = discardedSessionRef.current === session;
    discardedSessionRef.current = null;
    setDraftState((current) => discarded ? discardSpan(current) : releaseSpan(current));
    setState("idle");
  }, [clearStopDrainTimer]);

  const endSession = useCallback(
    async (mode: "keep" | "discard") => {
      startEpochRef.current += 1;
      const session = sessionRef.current;
      if (mode === "discard" && session !== null) discardedSessionRef.current = session;
      if (mode === "discard") setDraftState((current) => discardSpan(current));

      // The microphone is released immediately. Flush renderer-to-runtime IPC
      // before asking the speech session to drain so its final chunk cannot be
      // reordered behind voice_stop.
      await releaseCapture();
      await Promise.allSettled([...audioSendsRef.current]);

      if (session === null) {
        if (mode === "keep") setDraftState((current) => releaseSpan(current));
        setState("idle");
        return;
      }

      try {
        await ipc.voiceStop(session, sessionHostRef.current);
      } catch (reason) {
        if (sessionRef.current !== session) return;
        finishSession(session);
        setError(`Could not finish dictation: ${String(reason)}`);
        return;
      }

      // Batch transcription returns its final text after voice_stop. Keep the
      // session owned until the matching stopped event so that final is not
      // mistaken for a stale event. Recover if a remote host disappears while
      // draining and never delivers that terminal event.
      if (sessionRef.current === session) {
        clearStopDrainTimer();
        stopDrainTimerRef.current = setTimeout(() => {
          if (sessionRef.current !== session) return;
          finishSession(session);
          setError("Dictation did not finish. Check the speech host connection and try again.");
        }, STOP_DRAIN_TIMEOUT_MS);
      }
    },
    [clearStopDrainTimer, finishSession, releaseCapture],
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
              void releaseCapture();
              finishSession(event.session);
            }
            break;
          case "interim":
            if (discardedSessionRef.current === event.session) break;
            setDraftState((current) => applyInterim(current, event.text));
            break;
          case "final":
            if (discardedSessionRef.current === event.session) break;
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
  }, [finishSession, releaseCapture, settings.speechHostID]);

  // Switching composers stops dictation rather than letting audio feed a
  // draft the user can no longer see.
  useEffect(() => {
    return () => {
      if (stateRef.current !== "idle") void endSession("keep");
    };
  }, [boundTo, endSession, settings.speechHostID]);

  useEffect(() => {
    if (!enabled && stateRef.current !== "idle") void endSession("keep");
  }, [enabled, endSession]);

  const start = useCallback(async () => {
    const epoch = ++startEpochRef.current;
    setError(null);
    setState("starting");
    let session: number;
    try {
      // First: it validates settings and the credential, so a misconfigured
      // setup never opens the microphone at all.
      session = await ipc.voiceStart(settings, settings.speechHostID);
    } catch (reason) {
      if (epoch !== startEpochRef.current) return;
      setState("idle");
      setError(String(reason));
      return;
    }
    if (epoch !== startEpochRef.current) {
      void ipc.voiceStop(session, settings.speechHostID).catch(() => {});
      return;
    }
    sessionRef.current = session;
    sessionHostRef.current = settings.speechHostID;
    sessionSequenceRef.current = 0;
    audioSendsRef.current.clear();
    discardedSessionRef.current = null;

    try {
      // Capture starts while the socket is still connecting; chunks buffer on
      // the Rust side so the first word of an utterance is not clipped.
      const capture = await startMicrophoneCapture((chunk) => {
        if (sessionRef.current !== session) return;
        const sequence = sessionSequenceRef.current;
        sessionSequenceRef.current += 1;
        const send = ipc.voiceSendAudio(session, chunk, sequence, sessionHostRef.current);
        audioSendsRef.current.add(send);
        void send
          .catch((reason) => {
            if (sessionRef.current === session) setError(`Voice audio error: ${String(reason)}`);
          })
          .finally(() => audioSendsRef.current.delete(send));
      }, { inputDeviceId: settings.inputDeviceID });
      if (epoch !== startEpochRef.current || sessionRef.current !== session) {
        await capture.stop().catch(() => {});
        return;
      }
      captureRef.current = capture;
    } catch (reason) {
      if (epoch !== startEpochRef.current) return;
      sessionRef.current = null;
      void ipc.voiceStop(session, sessionHostRef.current).catch(() => {});
      setState("idle");
      setError(microphoneErrorMessage(reason));
    }
  }, [settings]);

  const stop = useCallback(() => {
    if (stateRef.current === "idle") return;
    setState("stopping");
    void endSession("keep");
  }, [endSession]);

  const cancel = useCallback(() => {
    if (stateRef.current === "idle") return;
    setState("stopping");
    void endSession("discard");
  }, [endSession]);

  const toggle = useCallback(() => {
    if (!enabled) return;
    if (stateRef.current === "idle") void start();
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
