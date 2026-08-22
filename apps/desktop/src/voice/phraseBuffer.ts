/**
 * Turns streamed model text into bounded, speakable phrases.
 *
 * The buffer deliberately knows nothing about a TTS provider. That keeps model
 * streaming, synthesis and playback independently cancellable and testable.
 */
export class SpeechPhraseBuffer {
  private pending = "";

  constructor(private readonly maxCharacters = 280) {
    if (maxCharacters < 32) throw new Error("Speech phrases must allow at least 32 characters.");
  }

  append(delta: string): string[] {
    this.pending += delta;
    return this.takeReady(false);
  }

  flush(): string[] {
    return this.takeReady(true);
  }

  clear(): void {
    this.pending = "";
  }

  get hasPendingText(): boolean {
    return this.pending.trim().length > 0;
  }

  private takeReady(flush: boolean): string[] {
    const phrases: string[] = [];
    while (this.pending.trim()) {
      const boundary = sentenceBoundary(this.pending, this.maxCharacters);
      if (boundary === null && !flush && this.pending.length <= this.maxCharacters) break;

      const end = boundary ?? boundedWordBoundary(this.pending, this.maxCharacters);
      const raw = this.pending.slice(0, end);
      this.pending = this.pending.slice(end).replace(/^\s+/, "");
      const phrase = toSpeakableText(raw);
      if (phrase) phrases.push(phrase);

      if (flush && this.pending.length <= this.maxCharacters) {
        const tail = toSpeakableText(this.pending);
        this.pending = "";
        if (tail) phrases.push(tail);
      }
    }
    return phrases;
  }
}

function sentenceBoundary(text: string, max: number): number | null {
  const limit = Math.min(text.length, max);
  const candidate = text.slice(0, limit);
  const expression = /(?:[.!?]["')\]]*|\n)\s+/g;
  let match: RegExpExecArray | null;
  let end: number | null = null;
  while ((match = expression.exec(candidate))) end = match.index + match[0].length;
  return end;
}

function boundedWordBoundary(text: string, max: number): number {
  if (text.length <= max) return text.length;
  const prefix = text.slice(0, max + 1);
  const whitespace = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"));
  return whitespace >= Math.floor(max / 2) ? whitespace + 1 : max;
}

/** Remove presentation-only Markdown while keeping the assistant's words. */
export function toSpeakableText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+] |\d+[.)] )\s*/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
