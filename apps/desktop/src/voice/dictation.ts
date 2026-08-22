// Draft bookkeeping for live dictation.
//
// While dictation runs, part of the composer text is owned by the transcript
// and is replaced on every partial. That region is the *span*. Text outside it
// is ordinary draft the user typed or already committed by speaking.
//
// Keeping the span explicit is what lets the preview live in the composer
// itself rather than in a separate overlay: each partial rewrites only the
// span, so the rest of the draft — including anything typed before dictation
// started — survives untouched.

export interface DictationSpan {
  start: number;
  end: number;
}

export interface DictationDraft {
  text: string;
  /** Region currently owned by the live transcript, or `null` when none is. */
  span: DictationSpan | null;
}

export const EMPTY_DRAFT: DictationDraft = { text: "", span: null };

/**
 * A space is inserted ahead of dictated text unless the draft is empty or
 * already ends in whitespace — so a trailing newline the user typed stays a
 * newline rather than becoming "line\n word".
 */
function separatorFor(before: string): string {
  if (!before) return "";
  return /\s$/.test(before) ? "" : " ";
}

/**
 * Replace the span's contents, opening a span at the end of the draft if none
 * is open. The separator lives *inside* the span so that repeated partials
 * recompute it identically instead of stacking spaces.
 */
function writeSpan(draft: DictationDraft, transcript: string): DictationDraft {
  const start = draft.span ? draft.span.start : draft.text.length;
  const end = draft.span ? draft.span.end : draft.text.length;
  const before = draft.text.slice(0, start);
  const after = draft.text.slice(end);
  const inserted = separatorFor(before) + transcript;
  return {
    text: before + inserted + after,
    span: { start, end: start + inserted.length },
  };
}

/** Live preview. Replaces whatever the previous preview showed. */
export function applyInterim(draft: DictationDraft, transcript: string): DictationDraft {
  const trimmed = transcript.trim();
  if (!trimmed) return draft;
  return writeSpan(draft, trimmed);
}

/**
 * Utterance complete. The text is written in the same place the preview was,
 * then the span closes so it becomes ordinary draft — the next utterance opens
 * a fresh span after it.
 */
export function commitFinal(draft: DictationDraft, transcript: string): DictationDraft {
  const trimmed = transcript.trim();
  if (!trimmed) return releaseSpan(draft);
  return { text: writeSpan(draft, trimmed).text, span: null };
}

/**
 * Stop tracking the span while keeping its text. Used when the user edits the
 * draft by hand: their caret is authoritative from then on, and a later
 * partial must not overwrite what they typed.
 */
export function releaseSpan(draft: DictationDraft): DictationDraft {
  return draft.span ? { text: draft.text, span: null } : draft;
}

/** Remove the in-flight preview entirely — the "never mind" path (Escape). */
export function discardSpan(draft: DictationDraft): DictationDraft {
  if (!draft.span) return draft;
  const text = draft.text.slice(0, draft.span.start) + draft.text.slice(draft.span.end);
  return { text, span: null };
}

/** Replace the whole draft, e.g. from typing or after sending. */
export function setDraftText(text: string): DictationDraft {
  return { text, span: null };
}
