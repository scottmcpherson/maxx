import { KeyboardEvent, RefObject, useCallback, useState } from "react";
import { AgentDefinition, providerDisplayName } from "../contract/types";
import {
  MentionQuery,
  applyMentionCompletion,
  filterAgentsForMention,
  mentionQueryAt,
} from "../mentions";
import { AgentAvatar } from "./AgentAvatar";

export interface MentionMenuState {
  open: boolean;
  candidates: AgentDefinition[];
  activeIndex: number;
  /** Re-read the textarea's value/caret; call from onChange/onClick/onKeyUp. */
  refresh: () => void;
  complete: (agent: AgentDefinition) => void;
  /** Returns true when the key event was consumed by the menu. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  dismiss: () => void;
}

/** Autocomplete for "@agent" tokens inside a composer textarea. */
export function useMentionMenu({
  agents,
  textareaRef,
  setDraft,
}: {
  agents: AgentDefinition[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setDraft: (value: string) => void;
}): MentionMenuState {
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const candidates = query ? filterAgentsForMention(agents, query.query) : [];
  const open = !!query && candidates.length > 0;

  const refresh = useCallback(() => {
    const element = textareaRef.current;
    if (!element || agents.length === 0) {
      setQuery(null);
      return;
    }
    const caret = element.selectionStart ?? element.value.length;
    setQuery((current) => {
      const next = mentionQueryAt(element.value, caret);
      if (next?.start !== current?.start || next?.query !== current?.query) setActiveIndex(0);
      return next;
    });
  }, [agents.length, textareaRef]);

  const complete = useCallback(
    (agent: AgentDefinition) => {
      const element = textareaRef.current;
      if (!element || !query) return;
      const caret = element.selectionStart ?? element.value.length;
      const result = applyMentionCompletion(element.value, caret, query.start, agent);
      setDraft(result.text);
      setQuery(null);
      requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(result.caret, result.caret);
      });
    },
    [query, setDraft, textareaRef],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown") {
      setActiveIndex((index) => (index + 1) % candidates.length);
    } else if (event.key === "ArrowUp") {
      setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      complete(candidates[Math.min(activeIndex, candidates.length - 1)]);
    } else if (event.key === "Escape") {
      setQuery(null);
    } else {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  return {
    open,
    candidates,
    activeIndex,
    refresh,
    complete,
    onKeyDown,
    dismiss: () => setQuery(null),
  };
}

export function MentionMenu({ menu }: { menu: MentionMenuState }) {
  if (!menu.open) return null;
  return (
    <div className="mention-menu" role="listbox" aria-label="Mention an agent">
      <div className="mention-menu-label">Agents</div>
      {menu.candidates.map((agent, index) => (
        <button
          key={agent.id}
          type="button"
          role="option"
          aria-selected={index === menu.activeIndex}
          className={`mention-menu-row ${index === menu.activeIndex ? "active" : ""}`}
          onMouseDown={(event) => {
            // Keep focus in the textarea while completing.
            event.preventDefault();
            menu.complete(agent);
          }}
        >
          <AgentAvatar
            name={agent.name}
            colorHex={agent.colorHex}
            emoji={agent.emoji}
            imagePath={agent.imagePath}
            size={18}
          />
          <span className="mention-menu-name">{agent.name}</span>
          <span className="mention-menu-provider">
            {providerDisplayName(agent.provider)}
            {agent.model && agent.model.toLowerCase() !== "default" ? ` · ${agent.model}` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}
