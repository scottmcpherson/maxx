export class Utf8StreamDecoder {
  private readonly decoder = new TextDecoder("utf-8");

  decode(chunk: string | Uint8Array): string {
    if (typeof chunk === "string") return chunk;
    return this.decoder.decode(chunk, { stream: true });
  }
}
