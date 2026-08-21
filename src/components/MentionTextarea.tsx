import {
  TextareaHTMLAttributes,
  forwardRef,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { AgentDefinition } from "../contract/types";
import { splitMentions } from "../mentions";
import { Textarea } from "./ui/textarea";

/**
 * Composer textarea with live @mention highlighting. The textarea's own text is
 * transparent (caret kept visible); a mirror layer behind it renders the same
 * text with mention pills. The mirror must keep identical text metrics, so the
 * pill styling uses background + box-shadow only — no padding, margin, or
 * font-weight change that would shift glyphs relative to the caret.
 */
export const MentionTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & {
    agents: AgentDefinition[];
    value: string;
  }
>(function MentionTextarea({ agents, value, onScroll, ...rest }, forwarded) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const segments = useMemo(() => splitMentions(value, agents), [agents, value]);

  const setRefs = (node: HTMLTextAreaElement | null) => {
    innerRef.current = node;
    if (typeof forwarded === "function") forwarded(node);
    else if (forwarded) forwarded.current = node;
  };

  // Keep the mirror aligned when the textarea scrolls or re-lays-out.
  const syncScroll = () => {
    const mirror = mirrorRef.current;
    const textarea = innerRef.current;
    if (mirror && textarea) mirror.scrollTop = textarea.scrollTop;
  };
  useEffect(syncScroll);

  return (
    <div className="relative flex flex-col">
      <div
        ref={mirrorRef}
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-0.5 pt-0.5 pb-1.5 leading-normal text-foreground"
        aria-hidden="true"
      >
        {segments.map((segment, index) =>
          segment.kind === "mention" ? (
            <span
              key={index}
              className="rounded bg-primary/15 text-primary box-decoration-clone shadow-[0_0_0_2.5px_color-mix(in_oklch,var(--primary)_15%,transparent)]"
            >
              {segment.text}
            </span>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
        {/* Keeps a trailing newline from collapsing in the mirror. */}
        {"​"}
      </div>
      <Textarea
        ref={setRefs}
        variant="composer"
        className="relative min-h-6 max-h-45 resize-none px-0.5 pt-0.5 pb-1.5 leading-normal text-transparent caret-foreground"
        value={value}
        onScroll={(event) => {
          syncScroll();
          onScroll?.(event);
        }}
        {...rest}
      />
    </div>
  );
});
