import { Buffer } from "buffer";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import type { MaxxHostClient } from "../connection/MaxxHostClient";
import type { VoiceSettings } from "../types";
import { pcm16Wav } from "./mobileWav";

type TtsStart = {
  session: number;
  sampleRate: number;
  channels: number;
  mimeType: string;
};

type TtsRead = {
  chunks: Array<{ sequence: number; chunk: string }>;
  done: boolean;
  error?: string;
};

const MAX_READ_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** Renderer-owned mobile playback for the desktop host's bounded PCM stream. */
export class MobileTtsPlayer {
  private generation = 0;
  private session: number | null = null;
  private client: MaxxHostClient | null = null;
  private player: AudioPlayer | null = null;
  private file: File | null = null;
  private resolvePlayback: (() => void) | null = null;

  async play(client: MaxxHostClient, settings: VoiceSettings, text: string) {
    await this.cancel();
    const generation = ++this.generation;
    this.client = client;
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const start = await client.request<TtsStart>("voice_tts_start", {
      settings,
      text,
      voiceId: settings.voiceID,
    });
    if (generation !== this.generation) {
      void client.request("voice_tts_cancel", { session: start.session }).catch(() => undefined);
      return;
    }
    validateStart(start);
    this.session = start.session;

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let afterSequence = -1;
    let emptyReads = 0;
    while (generation === this.generation) {
      const read = await client.request<TtsRead>("voice_tts_read", {
        session: start.session,
        afterSequence,
        maxBytes: MAX_READ_BYTES,
      });
      if (generation !== this.generation) return;
      if (read.error) throw new Error(read.error);
      if (!Array.isArray(read.chunks)) throw new Error("The speech host returned invalid audio.");
      if (!read.chunks.length) {
        if (read.done) break;
        emptyReads += 1;
        if (emptyReads > 8) throw new Error("The speech host returned too many empty audio reads.");
        continue;
      }
      emptyReads = 0;
      for (const item of read.chunks) {
        if (item.sequence !== afterSequence + 1) throw new Error("The speech host returned audio out of order.");
        const bytes = Buffer.from(item.chunk, "base64");
        if (!bytes.length || bytes.length % 2) throw new Error("The speech host returned invalid PCM audio.");
        totalBytes += bytes.length;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("The spoken response was too large to play safely.");
        chunks.push(bytes);
        afterSequence = item.sequence;
      }
      if (read.done) break;
    }
    if (generation !== this.generation || !chunks.length) return;

    const wav = pcm16Wav(Buffer.concat(chunks), start.sampleRate, start.channels);
    const file = new File(Paths.cache, `maxx-voice-${Date.now()}-${generation}.wav`);
    if (file.exists) file.delete();
    file.create({ overwrite: true });
    file.write(wav);
    this.file = file;

    const player = createAudioPlayer(file.uri, { updateInterval: 80, keepAudioSessionActive: true });
    this.player = player;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        subscription.remove();
        this.resolvePlayback = null;
        if (error) reject(error);
        else resolve();
      };
      const subscription = player.addListener("playbackStatusUpdate", (status) => {
        if (status.error) finish(new Error(status.error));
        else if (status.didJustFinish) finish();
      });
      this.resolvePlayback = () => finish();
      player.play();
    });
    if (generation === this.generation) this.releaseLocalPlayback();
  }

  async cancel() {
    this.generation += 1;
    this.resolvePlayback?.();
    this.resolvePlayback = null;
    const session = this.session;
    const client = this.client;
    this.session = null;
    this.client = null;
    this.releaseLocalPlayback();
    if (session !== null && client) {
      await client.request("voice_tts_cancel", { session }).catch(() => undefined);
    }
  }

  private releaseLocalPlayback() {
    const player = this.player;
    this.player = null;
    if (player) {
      player.pause();
      player.remove();
    }
    const file = this.file;
    this.file = null;
    if (file?.exists) file.delete();
  }
}

function validateStart(start: TtsStart) {
  if (!Number.isSafeInteger(start.session) || start.session < 0) throw new Error("The speech host returned an invalid session.");
  if (!Number.isFinite(start.sampleRate) || start.sampleRate <= 0) throw new Error("The speech host returned an invalid sample rate.");
  if (!Number.isSafeInteger(start.channels) || start.channels < 1 || start.channels > 2) throw new Error("The speech host returned an invalid channel count.");
  if (!start.mimeType.toLowerCase().includes("pcm") && !start.mimeType.toLowerCase().includes("l16")) {
    throw new Error(`Unsupported speech audio format: ${start.mimeType}`);
  }
}
