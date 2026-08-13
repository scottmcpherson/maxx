export interface TerminalWriter {
  write(data: string | Uint8Array, callback?: () => void): void;
}

export function decodeBase64Chunks(values: readonly string[]): Uint8Array {
  const decoded = values.map((value) => atob(value));
  const total = decoded.reduce((size, value) => size + value.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const value of decoded) {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
    offset += value.length;
  }
  return bytes;
}

/** Resolve only after xterm has parsed the batch, providing explicit
 * backpressure between the renderer and the next PTY read. */
export function writeTerminalBatch(
  terminal: TerminalWriter,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength === 0) return Promise.resolve();
  return new Promise((resolve) => terminal.write(bytes, resolve));
}
