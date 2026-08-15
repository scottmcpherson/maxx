import type { ChatProvider } from "./contract/types";

export type SlashCommandKind = "command" | "skill" | "prompt";

export interface SlashCommandItem {
  id: string;
  name: string;
  invocation: string;
  displayName: string;
  description?: string;
  kind: SlashCommandKind;
  source: string;
  scope?: string;
  argumentHint?: string;
  provider: ChatProvider;
}

export interface SlashCommandCatalog {
  items: SlashCommandItem[];
  source: "live" | "unavailable";
  error?: string;
}

export interface SlashToken {
  from: number;
  to: number;
  query: string;
}

const QUERY_CHAR = /^[\p{L}\p{N}_:-]*$/u;

/**
 * The slash token ending at `caret`. Unlike a traditional CLI parser this is
 * intentionally valid mid-sentence, but only at a whitespace boundary. That
 * keeps `https://host/path` and `folder/name` inert while allowing
 * `please use /review` anywhere in the draft.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  if (safeCaret === 0) return null;
  let slash = safeCaret - 1;
  while (slash >= 0 && !/\s/u.test(text[slash])) slash -= 1;
  slash += 1;
  if (text[slash] !== "/") return null;
  if (slash > 0 && !/\s/u.test(text[slash - 1])) return null;
  const query = text.slice(slash + 1, safeCaret);
  if (!QUERY_CHAR.test(query)) return null;
  return { from: slash, to: safeCaret, query };
}

export function filterSlashCommands(
  items: SlashCommandItem[],
  query: string,
  limit = 40,
): SlashCommandItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items.slice(0, limit);
  return items
    .map((item, index) => ({ item, index, score: slashCommandScore(item, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || left.index - right.index
      || left.item.name.localeCompare(right.item.name),
    )
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function slashCommandScore(item: SlashCommandItem, needle: string): number {
  const name = item.name.toLocaleLowerCase();
  const display = item.displayName.toLocaleLowerCase();
  const invocation = item.invocation.replace(/^[$/]/u, "").toLocaleLowerCase();
  const metadata = [item.description, item.kind, item.source, item.scope]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  if (name === needle || invocation === needle) return 1_000;
  if (name.startsWith(needle)) return 900 - name.length;
  if (invocation.startsWith(needle)) return 860 - invocation.length;
  if (display.startsWith(needle)) return 820 - display.length;
  if (name.includes(needle)) return 560 - name.indexOf(needle);
  if (display.includes(needle)) return 520 - display.indexOf(needle);
  if (metadata.includes(needle)) return 120;
  return 0;
}

export function applySlashCompletion(
  text: string,
  token: SlashToken,
  item: SlashCommandItem,
): { text: string; caret: number } {
  const suffix = item.kind === "command" && !item.argumentHint
    ? ""
    : /\s/u.test(text[token.to] ?? "") ? "" : " ";
  const inserted = `${item.invocation}${suffix}`;
  return {
    text: text.slice(0, token.from) + inserted + text.slice(token.to),
    caret: token.from + inserted.length,
  };
}
