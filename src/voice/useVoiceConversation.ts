import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventKind, type ChatThread, type ProviderRuntimeEvent } from "../contract/types";
import { isLocalHost } from "../host/session";
import { ipc } from "../ipc";
import { useAppStore } from "../store/appStore";
import { startMicrophoneCapture, type MicrophoneCapture } from "./capture";
import {
  IDLE_CONVERSATION,
  type ConversationSnapshot,
} from "./conversationMachine";
import {
  VoiceConversationController,
  type ConversationEffect,
} from "./conversationController";
import { SpeechSynthesisQueue } from "./speechQueue";
import { VoiceTtsPlayer } from "./tts";
import type { VoiceLatencySnapshot } from "./telemetry";
import { VoiceLatencyTelemetry } from "./telemetry";
import type { VoiceEvent, VoiceSettings } from "./types";
import { EnergyVad, shouldFinishUtterance } from "./vad";

export interface VoiceConversationBinding {
  projectID: string;
  threadID: string;
  /** Host that owns the selected project/thread and the canonical model turn. */
  executionHostID: string;
  thread: ChatThread;
}

export interface VoiceConversation {
  snapshot: ConversationSnapshot;
  status: string;
  isActive: boolean;
  canStart: boolean;
  telemetry: VoiceLatencySnapshot | null;
  start: () => void;
  end: () => void;
  mute: () => void;
  unmute: () => void;
  interrupt: () => void;
  retry: () => void;
  finishUtterance: () => void;
}

const STATUS_LABELS: Record<ConversationSnapshot["state"], string> = {
  idle: "Ready",
  listening: "Listening",
  transcribing: "Transcribing",
  waitingForModel: "Thinking",
  speaking: "Speaking",
  interrupted: "Interrupted",
  reconnecting: "Reconnecting",
  error: "Error",
  ended: "Ended",
};

export function isVoiceHostAvailable(
  hostID: string,
  remoteSessions: Array<{ host: { id: string } }>,
  hostStatus: { remotes: Array<{ id: string; connected: boolean }> } | null,
): boolean {
  if (isLocalHost(hostID)) return true;
  const session = remoteSessions.find((candidate) => candidate.host.id === hostID);
  const status = hostStatus?.remotes.find((candidate) => candidate.id === hostID);
  return Boolean(session && status?.connected !== false) || status?.connected === true;
}

/**
 * Renderer-owned hands-free conversation. This hook deliberately binds to a
 * mounted GUI thread; NewAgent never supplies a binding, so voice cannot
 * silently create a thread or change the selected runtime.
 */
export function useVoiceConversation(options: {
  binding: VoiceConversationBinding | null;
  enabled: boolean;
  settings: VoiceSettings;
}): VoiceConversation {
  const { binding, enabled, settings } = options;
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const refresh = useAppStore((state) => state.refresh);
  const remoteSessions = useAppStore((state) => state.remoteSessions);
  const hostStatus = useAppStore((state) => state.hostStatus);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const sendPromptRef = useRef(sendPrompt);
  sendPromptRef.current = sendPrompt;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const [snapshot, setSnapshot] = useState<ConversationSnapshot>(IDLE_CONVERSATION);
  const [telemetry, setTelemetry] = useState<VoiceLatencySnapshot | null>(null);
  const controllerRef = useRef<VoiceConversationController | null>(null);
  const activeBindingRef = useRef<VoiceConversationBinding | null>(null);
  const controllerTokenRef = useRef<object | null>(null);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const voiceConfigKey = [
    settings.isEnabled,
    settings.mode,
    settings.sttProvider,
    settings.sttApiBase,
    settings.sttModel,
    settings.ttsProvider,
    settings.ttsApiBase,
    settings.ttsModel,
    settings.voiceID,
    settings.language,
    settings.inputDeviceID,
    settings.outputDeviceID,
    settings.speechHostID,
    settings.turnDetection,
    settings.allowInterruption,
  ].join("\0");
  const bindingKey = binding
    ? `${binding.projectID}:${binding.threadID}:${binding.executionHostID}:${voiceConfigKey}`
    : "none";
  const bindingKeyRef = useRef(bindingKey);
  const activeBindingKeyRef = useRef<string | null>(null);

  const captureRef = useRef<MicrophoneCapture | null>(null);
  const captureStartPromiseRef = useRef<Promise<void> | null>(null);
  const sessionRef = useRef<number | null>(null);
  const sessionHostRef = useRef<string>(settings.speechHostID);
  const sessionOwnerRef = useRef<{ session: number; epoch: number } | null>(null);
  const sessionSequenceRef = useRef(0);
  const sessionStoppingRef = useRef(false);
  const sttEpochRef = useRef(0);
  const sttStartPromiseRef = useRef<Promise<void> | null>(null);
  const sttStopPromiseRef = useRef<Promise<void> | null>(null);
  const sttStopRequestedRef = useRef(false);
  const vadRef = useRef(new EnergyVad());
  const processedEventIDsRef = useRef<Set<string>>(new Set());
  const finalTextRef = useRef<string | null>(null);
  const voiceTurnIDRef = useRef<string | null>(null);
  const pendingVoiceTurnRef = useRef(false);
  const spokenPlaybackRef = useRef<Set<Promise<unknown>>>(new Set());
  const terminationPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const reconnectTerminationRef = useRef<{
    binding: VoiceConversationBinding;
    turn: { turnID: string; spokenText: string };
  } | null>(null);
  const generationRef = useRef(0);
  const playbackGenerationRef = useRef(0);
  const telemetryRef = useRef<VoiceLatencyTelemetry | null>(null);
  const notifyRef = useRef<() => void>(() => {});
  const playerRef = useRef<VoiceTtsPlayer | null>(null);
  if (!playerRef.current) {
    playerRef.current = new VoiceTtsPlayer(ipc, {
      onFirstChunk: () => {
        telemetryRef.current?.mark("firstAudioChunkAccepted");
        telemetryRef.current?.mark("firstPlaybackScheduled");
        notifyRef.current();
      },
    });
  }
  const queueRef = useRef<SpeechSynthesisQueue | null>(null);
  if (!queueRef.current) queueRef.current = new SpeechSynthesisQueue(playerRef.current);

  const notify = useCallback(() => {
    if (mountedRef.current) {
      setSnapshot(controllerRef.current?.snapshot ?? IDLE_CONVERSATION);
      setTelemetry(telemetryRef.current?.snapshot() ?? null);
    }
  }, []);
  notifyRef.current = notify;

  const cleanupResources = useCallback(async () => {
    generationRef.current += 1;
    playbackGenerationRef.current += 1;

    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) await capture.stop().catch(() => {});

    const pendingCaptureStart = captureStartPromiseRef.current;
    const pendingSttStart = sttStartPromiseRef.current;
    const pendingSttStop = sttStopPromiseRef.current;
    sttStopRequestedRef.current = true;
    sttEpochRef.current += 1;

    const session = sessionRef.current;
    const sessionHost = sessionHostRef.current;
    sessionRef.current = null;
    sessionOwnerRef.current = null;
    sessionStoppingRef.current = false;
    if (session !== null && !pendingSttStop) {
      try {
        await ipc.voiceStop(session, sessionHost);
      } catch {
        /* The speech host may already have disconnected. */
      }
    }

    // Both starts can be in flight before their refs are populated. Their
    // generation checks dispose any late microphone/socket that finishes now.
    await pendingCaptureStart?.catch(() => {});
    await pendingSttStart?.catch(() => {});
    await pendingSttStop?.catch(() => {});
    await queueRef.current?.cancel();
    vadRef.current.reset();
    finalTextRef.current = null;
    voiceTurnIDRef.current = null;
    pendingVoiceTurnRef.current = false;
    spokenPlaybackRef.current.clear();
  }, []);

  const terminateCanonicalTurn = useCallback(async (
    target: VoiceConversationBinding | null,
    turn: { turnID: string; spokenText: string } | null,
  ) => {
    if (!target || !turn) return;
    await ipc.voiceInterruptTurn(
      target.projectID,
      target.threadID,
      turn.turnID,
      turn.spokenText,
      target.executionHostID,
    );
    if (mountedRef.current) await refreshRef.current();
  }, []);

  const queueTermination = useCallback((
    target: VoiceConversationBinding | null,
    turn: { turnID: string; spokenText: string } | null,
  ): Promise<void> => {
    if (!target || !turn) return Promise.resolve();
    const work = terminationPromiseRef.current.then(() => terminateCanonicalTurn(target, turn));
    terminationPromiseRef.current = work.catch(() => {});
    return work;
  }, [terminateCanonicalTurn]);

  const runEffectRef = useRef<(effect: ConversationEffect, token: object) => void>(() => {});

  const fail = useCallback((reason: unknown) => {
    const controller = controllerRef.current;
    const target = activeBindingRef.current;
    const turn = controller?.interruptTarget
      ?? (voiceTurnIDRef.current ? { turnID: voiceTurnIDRef.current, spokenText: "" } : null);
    controllerTokenRef.current = null;
    activeRef.current = false;
    controller?.fail(String(reason));
    void queueTermination(target, turn)
      .catch(() => {})
      .finally(() => cleanupResources());
    notify();
  }, [cleanupResources, notify, queueTermination]);

  const ensureCapture = useCallback(async () => {
    if (captureRef.current) return;
    if (captureStartPromiseRef.current) return captureStartPromiseRef.current;
    const generation = generationRef.current;
    const start = async () => {
      const capture = await startMicrophoneCapture(
        (chunk) => {
          if (!activeRef.current || generation !== generationRef.current || settingsRef.current.isEnabled === false) return;
          if (controllerRef.current?.snapshot.muted) return;
          const state = controllerRef.current?.snapshot.state;
          if (!settingsRef.current.allowInterruption && (state === "speaking" || state === "waitingForModel")) return;
          const session = sessionRef.current;
          if (session === null || sessionStoppingRef.current) return;
          const sequence = sessionSequenceRef.current;
          sessionSequenceRef.current += 1;
          void ipc.voiceSendAudio(session, chunk, sequence, sessionHostRef.current).catch((reason) => {
            telemetryRef.current?.droppedInput();
            if (activeRef.current) fail(`Voice audio error: ${String(reason)}`);
          });
        },
        {
          inputDeviceId: settingsRef.current.inputDeviceID,
          onLevel: (level) => {
            if (!activeRef.current || controllerRef.current?.snapshot.muted) return;
            const event = vadRef.current.update(level);
            if (event === "speech.started") {
              const wasSpeaking = controllerRef.current?.snapshot.state === "speaking"
                || controllerRef.current?.snapshot.state === "waitingForModel";
              controllerRef.current?.speechStarted();
              notify();
              if (wasSpeaking && !settingsRef.current.allowInterruption) return;
              if (sessionRef.current === null && !sessionStoppingRef.current) {
                void startSttSessionRef.current();
              }
            } else if (
              event && shouldFinishUtterance(settingsRef.current.turnDetection, event)
            ) {
              void finishUtteranceRef.current();
            }
          },
        },
      );
      if (
        !activeRef.current
        || generation !== generationRef.current
        || controllerRef.current?.snapshot.muted
      ) {
        await capture.stop().catch(() => {});
        return;
      }
      captureRef.current = capture;
    };
    const promise = start().finally(() => {
      if (captureStartPromiseRef.current === promise) captureStartPromiseRef.current = null;
    });
    captureStartPromiseRef.current = promise;
    return promise;
  }, [fail, notify]);

  const startSttSessionRef = useRef<() => Promise<void>>(async () => {});
  const finishUtteranceRef = useRef<() => Promise<void>>(async () => {});

  const startSttSession = useCallback(async () => {
    if (sttStartPromiseRef.current) return sttStartPromiseRef.current;
    if (
      !activeRef.current
      || controllerRef.current?.snapshot.muted
      || sessionRef.current !== null
      || sessionStoppingRef.current
    ) return;
    const currentSettings = settingsRef.current;
    const generation = generationRef.current;
    const epoch = ++sttEpochRef.current;
    sttStopRequestedRef.current = false;
    const start = async () => {
      try {
        const session = await ipc.voiceStart(currentSettings, currentSettings.speechHostID);
        if (
          !activeRef.current
          || generation !== generationRef.current
          || epoch !== sttEpochRef.current
          || sttStopRequestedRef.current
          || controllerRef.current?.snapshot.muted
        ) {
          await ipc.voiceStop(session, currentSettings.speechHostID).catch(() => {});
          return;
        }
        sessionRef.current = session;
        sessionOwnerRef.current = { session, epoch };
        sessionHostRef.current = currentSettings.speechHostID;
        sessionSequenceRef.current = 0;
        sessionStoppingRef.current = false;
        finalTextRef.current = null;
        if (controllerRef.current?.snapshot.state === "reconnecting") {
          controllerRef.current.reconnected();
          telemetryRef.current?.reconnected();
          notify();
        }
      } catch (reason) {
        if (
          activeRef.current
          && epoch === sttEpochRef.current
          && !sttStopRequestedRef.current
          && !controllerRef.current?.snapshot.muted
        ) {
          fail(`Could not connect to the speech host: ${String(reason)}`);
        }
      }
    };
    const promise = start().finally(() => {
      if (sttStartPromiseRef.current === promise) sttStartPromiseRef.current = null;
    });
    sttStartPromiseRef.current = promise;
    return promise;
  }, [fail]);
  startSttSessionRef.current = startSttSession;

  const stopSttSession = useCallback(async () => {
    sttStopRequestedRef.current = true;
    sttEpochRef.current += 1;
    const pendingStart = sttStartPromiseRef.current;
    if (pendingStart) await pendingStart.catch(() => {});

    const session = sessionRef.current;
    const owner = sessionOwnerRef.current;
    if (session === null || !owner) return;
    if (sttStopPromiseRef.current) return sttStopPromiseRef.current;

    sessionStoppingRef.current = true;
    const stop = ipc.voiceStop(session, sessionHostRef.current)
      .catch((reason) => {
        if (sessionOwnerRef.current?.session === owner.session && sessionOwnerRef.current?.epoch === owner.epoch) {
          sessionRef.current = null;
          sessionOwnerRef.current = null;
          sessionStoppingRef.current = false;
        }
        if (activeRef.current && !controllerRef.current?.snapshot.muted) {
          fail(`Could not finish the utterance: ${String(reason)}`);
        }
      })
      .finally(() => {
        // A successful command drains asynchronously. The matching stopped
        // event, not command completion, releases ownership and restarts STT.
        sttStopPromiseRef.current = null;
      });
    sttStopPromiseRef.current = stop;
    return stop;
  }, [fail]);
  finishUtteranceRef.current = stopSttSession;

  const handleVoiceEvent = useCallback((event: VoiceEvent) => {
    if (!activeRef.current || event.session !== sessionRef.current || sessionOwnerRef.current?.session !== event.session) return;
    if (event.kind === "state") {
      if (event.state === "stopped") {
        sessionRef.current = null;
        sessionOwnerRef.current = null;
        sessionStoppingRef.current = false;
        sttStopPromiseRef.current = null;
        sttStopRequestedRef.current = false;
        sessionSequenceRef.current = 0;
        const state = controllerRef.current?.snapshot.state;
        if (
          activeRef.current
          && !controllerRef.current?.snapshot.muted
          && (settingsRef.current.allowInterruption || (state !== "speaking" && state !== "waitingForModel"))
        ) {
          void startSttSessionRef.current();
        }
      }
      return;
    }
    if (event.kind === "interim") {
      telemetryRef.current?.mark("firstPartial");
      notify();
      return;
    }
    if (event.kind === "error") {
      fail(event.hint ? `${event.message} ${event.hint}` : event.message);
      return;
    }
    if (event.kind !== "final") return;
    if (
      !settingsRef.current.allowInterruption
      && (controllerRef.current?.snapshot.state === "speaking"
        || controllerRef.current?.snapshot.state === "waitingForModel")
    ) return;
    const final = event.text.trim();
    if (!final || finalTextRef.current === final) return;
    telemetryRef.current?.mark("finalTranscript");
    finalTextRef.current = final;
    controllerRef.current?.transcriptFinal(final);
    notify();
    void stopSttSession();
  }, [fail, notify, stopSttSession]);

  useEffect(() => {
    mountedRef.current = true;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void ipc.onVoiceEvent(handleVoiceEvent, settings.speechHostID).then((unlisten) => {
      if (cancelled) unlisten();
      else dispose = unlisten;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [handleVoiceEvent, settings.speechHostID]);

  const waitForPlayback = useCallback(async (_turnID: string, generation: number) => {
    // A terminal event may race the last text delta. Drain the serial queue
    // and re-check once across a microtask so deltas already delivered in the
    // same renderer turn cannot be spoken after Listening resumes.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await queueRef.current?.drain();
      await Promise.allSettled([...spokenPlaybackRef.current]);
      await Promise.resolve();
      if (!queueRef.current?.hasWork && spokenPlaybackRef.current.size === 0) break;
    }
    if (!activeRef.current || generation !== playbackGenerationRef.current) return;
    controllerRef.current?.playbackFinished();
    voiceTurnIDRef.current = null;
    pendingVoiceTurnRef.current = false;
    notify();
  }, [notify]);

  const runEffect = useCallback((effect: ConversationEffect, token: object) => {
    if (controllerTokenRef.current !== token) return;
    const currentBinding = activeBindingRef.current;
    if (!currentBinding) return;
    switch (effect.type) {
      case "submitTranscript": {
        const submit = async () => {
          await terminationPromiseRef.current;
          if (controllerTokenRef.current !== token || !activeRef.current || activeBindingRef.current !== currentBinding) return;
          const state = useAppStore.getState();
          if (
            state.selectedProjectID !== currentBinding.projectID
            || state.selectedThreadID !== currentBinding.threadID
            || state.selectedHostID !== currentBinding.executionHostID
          ) {
            fail("The selected project or thread changed. Conversation stopped for safety.");
            return;
          }
          if (state.activeTurnByThread[currentBinding.threadID]) {
            fail("The selected thread is still processing another turn.");
            return;
          }
          if (
            state.sendingMessageByThread[currentBinding.threadID]
            || (state.queuedMessagesByThread[currentBinding.threadID]?.length ?? 0) > 0
          ) {
            fail("The selected thread is already dispatching another message.");
            return;
          }
          pendingVoiceTurnRef.current = true;
          const sent = await sendPromptRef.current(effect.text, []);
          if (controllerTokenRef.current !== token || !activeRef.current || activeBindingRef.current !== currentBinding) {
            const staleTurn = useAppStore.getState().activeTurnByThread[currentBinding.threadID];
            if (staleTurn) {
              await queueTermination(currentBinding, { turnID: staleTurn, spokenText: "" }).catch(() => {});
            }
            return;
          }
          if (!sent) {
            fail("Maxx could not send the voice turn to the selected thread.");
            return;
          }
          const activeTurn = useAppStore.getState().activeTurnByThread[currentBinding.threadID];
          if (activeTurn) {
            voiceTurnIDRef.current = activeTurn;
            controllerRef.current?.modelStarted(activeTurn);
          }
        };
        void submit().catch((reason) => {
          if (controllerTokenRef.current === token) fail(reason);
        });
        break;
      }
      case "speak": {
        const generation = playbackGenerationRef.current;
        controllerRef.current?.playbackStarted();
        notify();
        if (!settingsRef.current.allowInterruption) void stopSttSession();
        const promise = queueRef.current!.enqueue(
          settingsRef.current,
          effect.phrase,
          settingsRef.current.voiceID || null,
          settingsRef.current.speechHostID,
        );
        const completion = promise
          .then((completed) => {
            if (completed && generation === playbackGenerationRef.current) {
              controllerRef.current?.phraseCompleted(effect.turnID, effect.phrase);
            }
          })
          .catch((reason) => {
            telemetryRef.current?.rejectedOutput();
            if (
              controllerTokenRef.current === token
              && activeRef.current
              && generation === playbackGenerationRef.current
            ) fail(`Voice playback failed: ${String(reason)}`);
          })
          .finally(() => {
            spokenPlaybackRef.current.delete(completion);
          });
        spokenPlaybackRef.current.add(completion);
        break;
      }
      case "interruptTurn": {
        voiceTurnIDRef.current = null;
        pendingVoiceTurnRef.current = false;
        void queueTermination(currentBinding, { turnID: effect.turnID, spokenText: effect.spokenText })
          .catch((reason) => {
            if (controllerTokenRef.current === token) {
              fail(`Could not interrupt the selected turn: ${String(reason)}`);
            }
          });
        break;
      }
      case "cancelSpeech":
        playbackGenerationRef.current += 1;
        void queueRef.current?.cancel();
        break;
      case "cancelModel": {
        const turnID = voiceTurnIDRef.current;
        if (turnID) {
          void ipc.cancelTurn(turnID, currentBinding.executionHostID).catch((reason) => {
            if (controllerTokenRef.current === token) fail(reason);
          });
        }
        break;
      }
      case "restartListening":
        finalTextRef.current = null;
        vadRef.current.reset();
        void startSttSessionRef.current();
        break;
      case "stopSession":
        activeRef.current = false;
        controllerTokenRef.current = null;
        void terminationPromiseRef.current.finally(() => cleanupResources());
        break;
    }
  }, [cleanupResources, fail, notify, queueTermination, stopSttSession]);
  runEffectRef.current = runEffect;

  const start = useCallback(() => {
    if (!enabled || !binding || settings.mode !== "conversation") return;
    if (!settings.ttsApiBase.trim() || !settings.ttsModel.trim() || !settings.voiceID.trim()) {
      setSnapshot({ ...IDLE_CONVERSATION, state: "error", error: "Conversation requires a TTS endpoint, model, and named voice." });
      return;
    }
    if (controllerRef.current && snapshot.state !== "ended" && snapshot.state !== "error") return;
    const token = {};
    const controller = new VoiceConversationController(
      binding.thread.id,
      binding.thread.runtimeEvents.map((event) => event.id),
      (effect) => {
        if (controllerTokenRef.current !== token) return;
        runEffectRef.current(effect, token);
      },
      settings.allowInterruption,
    );
    controllerTokenRef.current = token;
    controllerRef.current = controller;
    activeBindingRef.current = binding;
    activeBindingKeyRef.current = bindingKey;
    processedEventIDsRef.current = new Set(binding.thread.runtimeEvents.map((event) => event.id));
    telemetryRef.current = new VoiceLatencyTelemetry(
      crypto.randomUUID(),
      settings.speechHostID === "local" ? "local" : "remote",
      `${settings.sttProvider}/${settings.ttsProvider}`,
    );
    generationRef.current += 1;
    playbackGenerationRef.current += 1;
    sttStopRequestedRef.current = false;
    activeRef.current = true;
    finalTextRef.current = null;
    voiceTurnIDRef.current = null;
    pendingVoiceTurnRef.current = false;
    controllerRef.current.start();
    notify();
    void ensureCapture()
      .then(() => {
        if (controllerTokenRef.current !== token || !activeRef.current) return;
        telemetryRef.current?.mark("captureStarted");
        notify();
        return startSttSessionRef.current();
      })
      .catch((reason) => {
        if (controllerTokenRef.current === token) {
          fail(`Could not open the microphone: ${String(reason)}`);
        }
      });
  }, [binding, enabled, ensureCapture, fail, notify, settings.allowInterruption, settings.mode, settings.ttsApiBase, settings.ttsModel, snapshot.state, voiceConfigKey]);

  const end = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller || snapshot.state === "ended") return;
    const target = activeBindingRef.current;
    const turn = controller.interruptTarget
      ?? (voiceTurnIDRef.current ? { turnID: voiceTurnIDRef.current, spokenText: "" } : null);
    controllerTokenRef.current = null;
    activeRef.current = false;
    controller.end();
    void queueTermination(target, turn)
      .catch(() => {})
      .finally(() => cleanupResources());
    notify();
  }, [cleanupResources, notify, queueTermination, snapshot.state]);

  const mute = useCallback(() => {
    controllerRef.current?.mute(true);
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) void capture.stop().catch(() => {});
    vadRef.current.reset();
    // Keep ownership until the matching stopped event. Clearing it when the
    // command resolves can erase a replacement session started by that event.
    void stopSttSession();
    notify();
  }, [notify, stopSttSession]);

  const unmute = useCallback(() => {
    controllerRef.current?.mute(false);
    controllerRef.current?.resumeListening();
    const token = controllerTokenRef.current;
    if (!token) return;
    activeRef.current = true;
    notify();
    void ensureCapture()
      .then(() => {
        if (controllerTokenRef.current !== token || !activeRef.current) return;
        return startSttSessionRef.current();
      })
      .catch((reason) => {
        if (controllerTokenRef.current === token) {
          fail(`Could not reopen the microphone: ${String(reason)}`);
        }
      });
  }, [ensureCapture, fail, notify]);

  const interrupt = useCallback(() => {
    controllerRef.current?.interrupt();
    notify();
    void startSttSessionRef.current();
  }, [notify]);

  const retry = useCallback(() => {
    if (!binding || !enabled) return;
    if (!controllerRef.current) {
      start();
      return;
    }
    controllerRef.current?.retry();
    const token = controllerTokenRef.current;
    if (!token) return;
    activeRef.current = true;
    generationRef.current += 1;
    playbackGenerationRef.current += 1;
    sttStopRequestedRef.current = false;
    notify();
    const pendingTermination = reconnectTerminationRef.current;
    reconnectTerminationRef.current = null;
    const prepare = pendingTermination
      ? queueTermination(pendingTermination.binding, pendingTermination.turn)
      : Promise.resolve();
    void prepare
      .then(() => ensureCapture())
      .then(() => {
        if (controllerTokenRef.current !== token || !activeRef.current) return;
        return startSttSessionRef.current();
      })
      .catch((reason) => {
        if (controllerTokenRef.current === token) {
          fail(`Could not reconnect to voice: ${String(reason)}`);
        }
      });
  }, [binding, enabled, ensureCapture, fail, notify, queueTermination, start]);

  const finishUtterance = useCallback(() => {
    if (settings.turnDetection !== "manual") return;
    void finishUtteranceRef.current();
  }, [settings.turnDetection]);

  useEffect(() => {
    if (bindingKeyRef.current === bindingKey) return;
    bindingKeyRef.current = bindingKey;
    const previousController = controllerRef.current;
    const previousBinding = activeBindingRef.current;
    const previousTurn = previousController?.interruptTarget
      ?? (voiceTurnIDRef.current ? { turnID: voiceTurnIDRef.current, spokenText: "" } : null);
    controllerTokenRef.current = null;
    activeRef.current = false;
    controllerRef.current = null;
    activeBindingRef.current = null;
    activeBindingKeyRef.current = null;
    reconnectTerminationRef.current = null;
    void queueTermination(previousBinding, previousTurn)
      .catch(() => {})
      .finally(() => cleanupResources());
    setSnapshot(IDLE_CONVERSATION);
    setTelemetry(null);
  }, [bindingKey, cleanupResources, queueTermination]);

  useEffect(() => {
    const thread = binding?.thread;
    if (
      !thread
      || !activeRef.current
      || !controllerRef.current
      || activeBindingKeyRef.current !== bindingKey
    ) return;
    for (const event of thread.runtimeEvents) {
      if (processedEventIDsRef.current.has(event.id)) continue;
      processedEventIDsRef.current.add(event.id);
      processRuntimeEvent(event, controllerRef.current, voiceTurnIDRef, pendingVoiceTurnRef, waitForPlayback, playbackGenerationRef.current, notify, fail, () => {
        telemetryRef.current?.mark("firstModelToken");
        notify();
      });
    }
  }, [binding?.thread?.runtimeEvents, bindingKey, fail, notify, waitForPlayback]);

  useEffect(() => {
    if (!activeRef.current || !binding) return;
    const monitoredHostIDs = [settings.speechHostID, binding.executionHostID];
    const missingHost = monitoredHostIDs.some((hostID) => !isLocalHost(hostID) && !isVoiceHostAvailable(hostID, remoteSessions, hostStatus));
    if (!missingHost) return;
    const controller = controllerRef.current;
    const target = activeBindingRef.current;
    const turn = controller?.interruptTarget
      ?? (voiceTurnIDRef.current ? { turnID: voiceTurnIDRef.current, spokenText: "" } : null);
    controllerRef.current?.connectionLost();
    reconnectTerminationRef.current = target && turn ? { binding: target, turn } : null;
    activeRef.current = false;
    void queueTermination(target, turn)
      .catch(() => {})
      .finally(() => cleanupResources());
    notify();
  }, [binding, cleanupResources, hostStatus, notify, queueTermination, remoteSessions, settings.speechHostID]);

  useEffect(() => {
    return () => {
      const controller = controllerRef.current;
      const target = activeBindingRef.current;
      const turn = controller?.interruptTarget
        ?? (voiceTurnIDRef.current ? { turnID: voiceTurnIDRef.current, spokenText: "" } : null);
      controllerTokenRef.current = null;
      mountedRef.current = false;
      activeRef.current = false;
      void queueTermination(target, turn)
        .catch(() => {})
        .finally(() => cleanupResources());
      telemetryRef.current = null;
      void queueRef.current?.dispose();
    };
  }, [cleanupResources, queueTermination]);

  const isActive = snapshot.state !== "idle" && snapshot.state !== "ended";
  const canStart = enabled
    && settings.mode === "conversation"
    && settings.ttsApiBase.trim().length > 0
    && settings.ttsModel.trim().length > 0
    && settings.voiceID.trim().length > 0;
  return useMemo(() => ({
    snapshot,
    status: STATUS_LABELS[snapshot.state],
    isActive,
    canStart,
    telemetry,
    start,
    end,
    mute: () => mute(),
    unmute: () => unmute(),
    interrupt: () => interrupt(),
    retry: () => retry(),
    finishUtterance: () => finishUtterance(),
  }), [canStart, end, finishUtterance, interrupt, isActive, mute, retry, snapshot, start, telemetry, unmute]);
}

export function processRuntimeEvent(
  event: ProviderRuntimeEvent,
  controller: VoiceConversationController,
  voiceTurnIDRef: { current: string | null },
  pendingVoiceTurnRef: { current: boolean },
  waitForPlayback: (turnID: string, generation: number) => Promise<void>,
  generation: number,
  notify: () => void,
  fail: (reason: unknown) => void,
  markModelToken: () => void,
): void {
  if (event.kind === EventKind.assistantTextDelta || event.kind === "assistant.text.done") {
    if (voiceTurnIDRef.current && event.turnID !== voiceTurnIDRef.current) return;
    if (!voiceTurnIDRef.current && !pendingVoiceTurnRef.current) return;
    if (!voiceTurnIDRef.current) voiceTurnIDRef.current = event.turnID;
    if (event.payload.text && event.kind === EventKind.assistantTextDelta) {
      controller.assistantDelta({
        id: event.id,
        threadID: event.threadID,
        turnID: event.turnID,
        text: event.payload.text,
      });
      markModelToken();
      notify();
    }
    return;
  }
  if (event.kind !== EventKind.turnTerminal) return;
  if (voiceTurnIDRef.current && event.turnID !== voiceTurnIDRef.current) return;
  if (!voiceTurnIDRef.current && !pendingVoiceTurnRef.current) return;
  voiceTurnIDRef.current = event.turnID;
  pendingVoiceTurnRef.current = false;
  if (event.payload.terminalState === "failed") {
    fail(event.payload.error?.message ?? "The selected model turn failed.");
    notify();
    return;
  }
  controller.modelFinished(event.turnID);
  notify();
  void waitForPlayback(event.turnID, generation);
}

export function conversationStatusLabel(state: ConversationSnapshot["state"]): string {
  return STATUS_LABELS[state];
}
