import { Buffer } from "buffer";

export function pcm16Wav(pcm: Uint8Array, sampleRate: number, channels: number) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  // Expo's native file writer identifies typed arrays by constructor name.
  // The Buffer polyfill is a Uint8Array subclass named `Buffer`, which makes
  // Expo's iOS converter trap. Copy into a genuine Uint8Array at this boundary.
  return new Uint8Array(Buffer.concat([header, pcm]));
}
