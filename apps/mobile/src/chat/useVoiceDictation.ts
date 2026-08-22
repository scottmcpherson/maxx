import { Buffer } from "buffer";
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from "expo-audio";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MaxxHostClient } from "../connection/MaxxHostClient";
import type { VoiceEvent } from "../types";

export type VoiceCaptureOptions = { stopOnSilence?: boolean };

const SPEECH_RMS_THRESHOLD = 650;
const END_OF_UTTERANCE_MS = 850;

export function useVoiceDictation(client: MaxxHostClient | null, onText: (text: string, final: boolean) => void) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const sessionRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  const sendChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const stopRef = useRef<() => void>(() => undefined);
  const stopOnSilenceRef = useRef(false);
  const speechStartedRef = useRef(false);
  const lastSpeechAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const { stream } = useAudioStream({
    sampleRate: 16_000,
    channels: 1,
    encoding: "int16",
    onBuffer: ({ data }) => {
      const session = sessionRef.current;
      if (session === null || !client) return;
      const sequence = sequenceRef.current++;
      const chunk = Buffer.from(data).toString("base64");
      sendChainRef.current = sendChainRef.current.then(() => client.request("voice_send_audio", { session, sequence, chunk }));
      sendChainRef.current.catch((cause) => {
        if (!cancelledRef.current && sessionRef.current === session) setError(message(cause));
      });
      if (stopOnSilenceRef.current) {
        const now = Date.now();
        if (pcmRms(data) >= SPEECH_RMS_THRESHOLD) {
          speechStartedRef.current = true;
          lastSpeechAtRef.current = now;
        } else if (speechStartedRef.current && now - lastSpeechAtRef.current >= END_OF_UTTERANCE_MS) {
          stopOnSilenceRef.current = false;
          stopRef.current();
        }
      }
    },
  });

  useEffect(() => {
    if (!client) return;
    const remove = client.onEvent((event) => {
      if (event.event !== "voice://event") return;
      const voice = event.payload as VoiceEvent;
      if (voice.session !== sessionRef.current) return;
      if ((voice.kind === "interim" || voice.kind === "final") && !cancelledRef.current) {
        onTextRef.current(voice.text, voice.kind === "final");
      }
      if (voice.kind === "error") {
        if (!cancelledRef.current) setError(voice.hint || voice.message);
        setRecording(false);
        sessionRef.current = null;
        stream.stop();
        void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      }
      if (voice.kind === "state" && voice.state === "stopped") {
        setRecording(false);
        sessionRef.current = null;
        stream.stop();
        void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      }
    });
    return () => { remove(); };
  }, [client, stream]);

  const start = useCallback(async (options: VoiceCaptureOptions = {}) => {
    if (!client || recording) return;
    setError("");
    cancelledRef.current = false;
    stopOnSilenceRef.current = options.stopOnSilence === true;
    speechStartedRef.current = false;
    lastSpeechAtRef.current = 0;
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error("Microphone permission is required for voice input.");
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const session = await client.request<number>("voice_start");
    sessionRef.current = session;
    sequenceRef.current = 0;
    sendChainRef.current = Promise.resolve();
    try {
      await stream.start();
      setRecording(true);
    } catch (cause) {
      sessionRef.current = null;
      await client.request("voice_stop", { session }).catch(() => undefined);
      throw cause;
    }
  }, [client, recording, stream]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (session === null || !client) return;
    stream.stop();
    setRecording(false);
    let failure: unknown;
    try {
      await sendChainRef.current;
    } catch (cause) {
      failure = cause;
    }
    try {
      await client.request("voice_stop", { session });
    } catch (cause) {
      failure ||= cause;
    } finally {
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
    if (failure) {
      if (sessionRef.current === session) sessionRef.current = null;
      throw failure;
    }
    // Batch transcription emits its final text after voice_stop returns. Keep
    // ownership until the matching stopped event so that final is not rejected
    // as belonging to a stale session.
  }, [client, stream]);

  stopRef.current = () => { void stop().catch((cause) => setError(message(cause))); };

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    stopOnSilenceRef.current = false;
    setError("");
    await stop();
  }, [stop]);

  useEffect(() => () => {
    const session = sessionRef.current;
    if (session === null) return;
    stream.stop();
    sessionRef.current = null;
    if (client) void client.request("voice_stop", { session }).catch(() => undefined);
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
  }, [client, stream]);

  return { recording, error, start, stop, cancel };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function pcmRms(data: ArrayBuffer | ArrayBufferView) {
  const bytes = Buffer.from(data as ArrayBuffer);
  const sampleCount = Math.floor(bytes.length / 2);
  if (!sampleCount) return 0;
  let sumSquares = 0;
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const sample = bytes.readInt16LE(offset);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}
