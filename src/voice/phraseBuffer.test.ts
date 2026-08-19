import { describe, expect, it } from "vitest";
import { SpeechPhraseBuffer, toSpeakableText } from "./phraseBuffer";

describe("SpeechPhraseBuffer", () => {
  it("emits a completed sentence before the model response finishes", () => {
    const buffer = new SpeechPhraseBuffer();
    expect(buffer.append("The first sentence. The sec")).toEqual(["The first sentence."]);
    expect(buffer.append("ond sentence is still arriving")).toEqual([]);
    expect(buffer.flush()).toEqual(["The second sentence is still arriving"]);
  });

  it("bounds long model output at a word boundary", () => {
    const buffer = new SpeechPhraseBuffer(40);
    const phrases = buffer.append("one two three four five six seven eight nine ten eleven twelve");
    expect(phrases).toEqual(["one two three four five six seven eight"]);
    expect(buffer.flush()).toEqual(["nine ten eleven twelve"]);
  });

  it("clear drops text that belongs to cancelled synthesis", () => {
    const buffer = new SpeechPhraseBuffer();
    buffer.append("Never speak this unfinished response");
    buffer.clear();
    expect(buffer.flush()).toEqual([]);
  });

  it("turns markdown into words instead of reading punctuation and URLs", () => {
    expect(toSpeakableText("## Result\nUse **Maxx** and [the guide](https://example.com)."))
      .toBe("Result Use Maxx and the guide.");
    expect(toSpeakableText("```ts\nconst secret = 1\n``` Done."))
      .toBe("Code block omitted. Done.");
  });
});
