// @-mention parsing for preconfigured agents. A mention is "@" followed by an
// agent's name (case-insensitive, longest name wins) ending on a word boundary.

import { AgentDefinition } from "./contract/types";

export interface MentionMatch {
  agent: AgentDefinition;
  /** Index of the "@" in the text. */
  index: number;
  /** Length of the mention including the "@". */
  length: number;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function boundaryAt(text: string, index: number): boolean {
  const char = text[index];
  return char === undefined || !WORD_CHAR.test(char);
}

/** All agent mentions in `text`, in order of appearance. */
export function findMentions(text: string, agents: AgentDefinition[]): MentionMatch[] {
  const byLength = [...agents]
    .filter((agent) => agent.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const matches: MentionMatch[] = [];
  const lower = text.toLowerCase();
  let at = lower.indexOf("@");
  while (at !== -1) {
    // "@" must start a token: begin-of-text or a non-word character before it.
    if (at === 0 || !WORD_CHAR.test(text[at - 1])) {
      for (const agent of byLength) {
        const name = agent.name.toLowerCase();
        if (
          lower.startsWith(name, at + 1)
          && boundaryAt(text, at + 1 + name.length)
        ) {
          matches.push({ agent, index: at, length: name.length + 1 });
          at += name.length;
          break;
        }
      }
    }
    at = lower.indexOf("@", at + 1);
  }
  return matches;
}

/** First agent mentioned in `text`, if any. */
export function findMention(text: string, agents: AgentDefinition[]): MentionMatch | null {
  return findMentions(text, agents)[0] ?? null;
}

/**
 * Agents mentioned in `text`, deduped, in order of first mention. This is the
 * response order: each agent's turn runs after the previous one completes.
 */
export function mentionedAgents(text: string, agents: AgentDefinition[]): AgentDefinition[] {
  const seen = new Set<string>();
  const ordered: AgentDefinition[] = [];
  for (const match of findMentions(text, agents)) {
    if (seen.has(match.agent.id)) continue;
    seen.add(match.agent.id);
    ordered.push(match.agent);
  }
  return ordered;
}

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; agent: AgentDefinition };

/** Split `text` into plain and mention segments for styled rendering. */
export function splitMentions(text: string, agents: AgentDefinition[]): MentionSegment[] {
  const matches = findMentions(text, agents);
  if (matches.length === 0) return [{ kind: "text", text }];
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    segments.push({
      kind: "mention",
      text: text.slice(match.index, match.index + match.length),
      agent: match.agent,
    });
    cursor = match.index + match.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

export interface MentionQuery {
  /** Text typed after the "@", up to the caret. */
  query: string;
  /** Index of the "@" in the text. */
  start: number;
}

/**
 * The "@partial" token being typed at `caret`, for autocomplete. Returns null
 * when the caret is not in a mention token (no "@", or a space/newline between
 * the "@" and the caret beyond what agent names could contain).
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const head = text.slice(0, caret);
  const at = head.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && WORD_CHAR.test(head[at - 1])) return null;
  const query = head.slice(at + 1);
  // Agent names can contain single spaces, but a newline or a double space
  // means the token is over.
  if (/\n/.test(query) || /\s\s/.test(query) || query.startsWith(" ")) return null;
  if (query.length > 48) return null;
  return { query, start: at };
}

/** Agents whose names match the autocomplete `query` (prefix-first). */
export function filterAgentsForMention(
  agents: AgentDefinition[],
  query: string,
): AgentDefinition[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return agents;
  const prefixed = agents.filter((agent) => agent.name.toLowerCase().startsWith(normalized));
  const contained = agents.filter(
    (agent) =>
      !agent.name.toLowerCase().startsWith(normalized)
      && agent.name.toLowerCase().includes(normalized),
  );
  return [...prefixed, ...contained];
}

/** Replace the mention token at `start`..`caret` with the agent's full name. */
export function applyMentionCompletion(
  text: string,
  caret: number,
  start: number,
  agent: AgentDefinition,
): { text: string; caret: number } {
  const inserted = `@${agent.name} `;
  const next = text.slice(0, start) + inserted + text.slice(caret);
  return { text: next, caret: start + inserted.length };
}
