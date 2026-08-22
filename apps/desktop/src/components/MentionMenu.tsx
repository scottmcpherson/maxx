import { KeyboardEvent, RefObject, useCallback, useState } from "react";
import { AgentDefinition, providerDisplayName } from "../contract/types";
import {
  MentionQuery,
  applyMentionCompletion,
  filterAgentsForMention,
  mentionQueryAt,
} from "../mentions";
import { AgentAvatar } from "./AgentAvatar";
import { Command, CommandGroup, CommandItem } from "./ui/command";
import { cn } from "../lib/utils";

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
    <Command
      className="absolute -inset-x-px bottom-[calc(100%+0.4375rem)] z-40 w-auto! max-h-60 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
      role="listbox"
      aria-label="Mention an agent"
    >
      <CommandGroup heading="Agents">
        {menu.candidates.map((agent, index) => (
        <CommandItem
          key={agent.id}
          role="option"
          aria-selected={index === menu.activeIndex}
          className={cn(
            "min-h-8 cursor-pointer gap-2 rounded-lg px-2 py-1 text-sm",
            index === menu.activeIndex && "bg-muted text-foreground",
          )}
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
          <span className="shrink-0">{agent.name}</span>
          <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
            {providerDisplayName(agent.provider)}
            {agent.model && agent.model.toLowerCase() !== "default" ? ` · ${agent.model}` : ""}
          </span>
        </CommandItem>
        ))}
      </CommandGroup>
    </Command>
  );
}
