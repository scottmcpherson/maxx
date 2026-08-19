// Voice contract shared by the renderer, host IPC and voice runtime.

/** Capture rate the STT socket is opened with; the worklet resamples to it. */
export const VOICE_SAMPLE_RATE = 16_000;

export type VoiceMode = "dictation" | "conversation";
export type SttProvider = "xai" | "openai-compatible";
export type TtsProvider = "openai-compatible";
export type TurnDetection = "manual" | "automatic";

/** Persisted in workspace.json. Deliberately carries no credential. */
export interface VoiceSettings {
  isEnabled: boolean;
  mode: VoiceMode;
  /** Opt-in to reusing the bearer the Grok CLI stores in ~/.grok/auth.json. */
  useGrokSignIn: boolean;
  sttProvider: SttProvider;
  sttApiBase: string;
  sttModel: string;
  language: string;
  ttsProvider: TtsProvider;
  ttsApiBase: string;
  ttsModel: string;
  voiceID: string;
  inputDeviceID: string | null;
  outputDeviceID: string | null;
  /** The host that owns STT/TTS execution. Capture and playback stay local. */
  speechHostID: string;
  turnDetection: TurnDetection;
  allowInterruption: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  isEnabled: false,
  mode: "dictation",
  useGrokSignIn: false,
  sttProvider: "xai",
  sttApiBase: "https://api.x.ai",
  sttModel: "",
  language: "en",
  ttsProvider: "openai-compatible",
  ttsApiBase: "",
  ttsModel: "",
  voiceID: "",
  inputDeviceID: null,
  outputDeviceID: null,
  speechHostID: "local",
  turnDetection: "automatic",
  allowInterruption: true,
};

/** Which credential dictation would use right now, and whether it has one. */
export interface VoiceCredentialStatus {
  source: "grokSignIn" | "environment" | "none" | string;
  detail: string;
  available: boolean;
  provider?: SttProvider;
  endpoint?: string;
  model?: string;
}

/** Result of an actual provider connection check. */
export interface VoiceProviderTestResult {
  provider: SttProvider;
  endpoint: string;
  model: string;
  ok: boolean;
  code: string;
  message: string;
}

/** A voice exposed by the selected provider's synthesis catalog. */
export interface VoiceProfile {
  id: string;
  name: string;
  model: string;
  language: string;
}

export interface VoiceTtsStartResult {
  session: number;
  mimeType: string;
  sampleRate: number;
  channels: number;
}

export interface VoiceTtsChunk {
  sequence: number;
  /** Base64-encoded interleaved little-endian PCM16. */
  chunk: string;
}

export interface VoiceTtsReadResult {
  chunks: VoiceTtsChunk[];
  done: boolean;
  error?: string;
}

export type VoiceSessionState = "connecting" | "listening" | "stopped";

export type VoiceEvent =
  | { kind: "state"; session: number; state: VoiceSessionState }
  | { kind: "interim"; session: number; text: string }
  | { kind: "final"; session: number; text: string }
  | { kind: "error"; session: number; message: string; hint: string | null; code?: string }
  | { kind: "telemetry"; session: number; metric: string; value: number };

/** Languages offered in Settings; mirrors `maxx_core::voice::VOICE_LANGUAGES`. */
export const VOICE_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "hi", label: "Hindi" },
  { code: "ru", label: "Russian" },
];
