import { describe, expect, it } from "vitest";
import {
  applyInterim,
  commitFinal,
  discardSpan,
  EMPTY_DRAFT,
  releaseSpan,
  setDraftText,
} from "./dictation";

describe("dictation draft", () => {
  it("opens a span at the end of an empty draft", () => {
    const draft = applyInterim(EMPTY_DRAFT, "open the");
    expect(draft.text).toBe("open the");
    expect(draft.span).toEqual({ start: 0, end: 8 });
  });

  it("replaces the preview rather than appending to it", () => {
    let draft = applyInterim(EMPTY_DRAFT, "open");
    draft = applyInterim(draft, "open the");
    draft = applyInterim(draft, "open the file");
    expect(draft.text).toBe("open the file");
  });

  it("separates dictation from text the user already typed", () => {
    const typed = setDraftText("fix the bug in");
    const draft = applyInterim(typed, "provider runtime");
    expect(draft.text).toBe("fix the bug in provider runtime");
  });

  it("does not stack separators across repeated partials", () => {
    let draft = applyInterim(setDraftText("check"), "the");
    draft = applyInterim(draft, "the file");
    draft = applyInterim(draft, "the file now");
    expect(draft.text).toBe("check the file now");
  });

  it("keeps trailing whitespace the user typed", () => {
    expect(applyInterim(setDraftText("line\n"), "next").text).toBe("line\nnext");
    expect(applyInterim(setDraftText("word "), "next").text).toBe("word next");
  });

  it("commits a final and appends the next utterance after it", () => {
    let draft = applyInterim(EMPTY_DRAFT, "open the file");
    // The committed text is the server's re-transcription, which routinely
    // differs from the stitched preview — punctuation and casing especially.
    draft = commitFinal(draft, "Open the file.");
    expect(draft.text).toBe("Open the file.");
    expect(draft.span).toBeNull();

    draft = applyInterim(draft, "then rename it");
    expect(draft.text).toBe("Open the file. then rename it");
    // The span starts where the committed text ended: the separator space is
    // part of the span, so discarding the preview removes it too.
    expect(draft.span).toEqual({ start: 14, end: 29 });
  });

  it("ignores blank transcripts", () => {
    const draft = applyInterim(setDraftText("kept"), "   ");
    expect(draft.text).toBe("kept");
    expect(draft.span).toBeNull();
  });

  it("releases the span without disturbing its text", () => {
    const draft = releaseSpan(applyInterim(setDraftText("a"), "b"));
    expect(draft.text).toBe("a b");
    expect(draft.span).toBeNull();
  });

  it("discards the preview and its separator", () => {
    const draft = discardSpan(applyInterim(setDraftText("keep this"), "drop this"));
    expect(draft.text).toBe("keep this");
    expect(draft.span).toBeNull();
  });

  it("discarding with nothing in flight is a no-op", () => {
    const typed = setDraftText("untouched");
    expect(discardSpan(typed)).toEqual(typed);
  });

  it("preserves text after the span when one is open mid-draft", () => {
    // Not reachable from the UI today (spans always open at the end), but the
    // span arithmetic should not silently depend on that.
    const draft = applyInterim({ text: "start  end", span: { start: 6, end: 6 } }, "middle");
    expect(draft.text).toBe("start middle end");
  });

  it("a final after the user cleared the draft starts clean", () => {
    let draft = applyInterim(setDraftText("old"), "interim");
    draft = setDraftText("");
    draft = applyInterim(draft, "fresh");
    expect(draft.text).toBe("fresh");
  });
});
