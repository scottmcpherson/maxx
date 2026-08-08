// Voice dictation contract shared with the Rust side.

/** Capture rate the STT socket is opened with; the worklet resamples to it. */
export const VOICE_SAMPLE_RATE = 16_000;

/** Persisted in workspace.json. Deliberately carries no credential. */
export interface VoiceSettings {
  isEnabled: boolean;
  /** Opt-in to reusing the bearer the Grok CLI stores in ~/.grok/auth.json. */
  useGrokSignIn: boolean;
  language: string;
  apiBase: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  isEnabled: false,
  useGrokSignIn: false,
  language: "en",
  apiBase: "https://api.x.ai",
};

/** Which credential dictation would use right now, and whether it has one. */
export interface VoiceCredentialStatus {
  source: "grokSignIn" | "environment" | "none";
  detail: string;
  available: boolean;
}

export type VoiceSessionState = "connecting" | "listening" | "stopped";

export type VoiceEvent =
  | { kind: "state"; session: number; state: VoiceSessionState }
  | { kind: "interim"; session: number; text: string }
  | { kind: "final"; session: number; text: string }
  | { kind: "error"; session: number; message: string; hint: string | null };

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
