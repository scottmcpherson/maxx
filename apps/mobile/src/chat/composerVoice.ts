import type { VoiceSettings } from "../types";

export type ComposerPrimaryAction = "conversation" | "send" | "stop-conversation";

export function sttIsAvailable(settings: VoiceSettings | null | undefined) {
  if (!settings?.isEnabled || !settings.sttApiBase.trim()) return false;
  return settings.sttProvider === "xai" || settings.sttModel.trim().length > 0;
}

export function conversationIsAvailable(settings: VoiceSettings | null | undefined) {
  return sttIsAvailable(settings)
    && Boolean(settings?.ttsApiBase.trim())
    && Boolean(settings?.ttsModel.trim())
    && Boolean(settings?.voiceID.trim());
}

export function composerPrimaryAction(options: {
  conversationActive: boolean;
  hasContent: boolean;
  conversationAvailable: boolean;
}): ComposerPrimaryAction {
  if (options.conversationActive) return "stop-conversation";
  if (options.conversationAvailable && !options.hasContent) return "conversation";
  return "send";
}
