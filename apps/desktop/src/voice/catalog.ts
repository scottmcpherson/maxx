import type { VoiceProfile } from "./types";

export interface ResolvedVoiceSelection {
  voiceID: string;
  model: string;
}

/** Resolve a typed provider voice ID exactly as a catalog selection would. */
export function resolveVoiceSelection(
  catalog: VoiceProfile[],
  voiceID: string,
  fallbackModel: string,
): ResolvedVoiceSelection {
  const resolvedVoiceID = voiceID.trim();
  const catalogVoice = catalog.find((voice) => voice.id === resolvedVoiceID);
  return {
    voiceID: resolvedVoiceID,
    model: (catalogVoice?.model ?? fallbackModel).trim(),
  };
}

