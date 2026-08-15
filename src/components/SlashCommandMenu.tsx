import {
  KeyboardEvent,
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatProvider, ProviderCommandCatalog } from "../contract/types";
import { providerDisplayName } from "../contract/types";
import { ipc } from "../ipc";
import {
  applySlashCompletion,
  filterSlashCommands,
  slashTokenAt,
  type SlashCommandItem,
  type SlashToken,
} from "../slashCommands";
import { Icons } from "./Icons";

export interface SlashCommandMenuState {
  open: boolean;
  loading: boolean;
  error: string | null;
  candidates: SlashCommandItem[];
  activeIndex: number;
  provider: ChatProvider;
  refresh: () => void;
  retry: () => void;
  activate: (index: number) => void;
  complete: (item: SlashCommandItem) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  dismiss: () => void;
}

export function useSlashCommandMenu({
  provider,
  profileId,
  workingDirectory,
  hostId,
  textareaRef,
  setDraft,
}: {
  provider: ChatProvider;
  profileId?: string;
  workingDirectory?: string;
  hostId?: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setDraft: (value: string) => void;
}): SlashCommandMenuState {
  const [token, setToken] = useState<SlashToken | null>(null);
  const [catalog, setCatalog] = useState<ProviderCommandCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedToken, setDismissedToken] = useState("");
  const requestSequence = useRef(0);
  const loadingRef = useRef(false);
  const contextKey = `${hostId ?? "local"}:${provider}:${profileId ?? "default"}:${workingDirectory ?? ""}`;
  const tokenKey = token ? `${token.from}:${token.to}:${token.query}` : "";

  useEffect(() => {
    requestSequence.current += 1;
    setCatalog(null);
    setLoading(false);
    loadingRef.current = false;
    setError(null);
    setToken(null);
    setDismissedToken("");
    setActiveIndex(0);
  }, [contextKey]);

  const loadCatalog = useCallback(() => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    void ipc.listProviderCommands(provider, profileId, workingDirectory, hostId)
      .then((result) => {
        if (requestSequence.current !== sequence) return;
        setCatalog(result);
        setError(result.error ?? null);
      })
      .catch((cause) => {
        if (requestSequence.current !== sequence) return;
        setCatalog(null);
        setError(String(cause));
      })
      .finally(() => {
        if (requestSequence.current === sequence) {
          loadingRef.current = false;
          setLoading(false);
        }
      });
  }, [hostId, profileId, provider, workingDirectory]);

  const refresh = useCallback(() => {
    const element = textareaRef.current;
    if (!element) {
      setToken(null);
      return;
    }
    const caret = element.selectionStart ?? element.value.length;
    const next = element.selectionStart === element.selectionEnd
      ? slashTokenAt(element.value, caret)
      : null;
    setToken((current) => {
      if (next?.from !== current?.from || next?.query !== current?.query) setActiveIndex(0);
      return next;
    });
    if (next && !catalog && !loading) loadCatalog();
  }, [catalog, loadCatalog, loading, textareaRef]);

  const candidates = useMemo(
    () => filterSlashCommands((catalog?.items ?? []) as SlashCommandItem[], token?.query ?? ""),
    [catalog?.items, token?.query],
  );
  const open = !!token
    && dismissedToken !== tokenKey
    && (loading || !!error || !!catalog);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, candidates.length - 1)));
  }, [candidates.length]);

  const complete = useCallback((item: SlashCommandItem) => {
    const element = textareaRef.current;
    if (!element || !token) return;
    const result = applySlashCompletion(element.value, token, item);
    setDraft(result.text);
    setToken(null);
    setDismissedToken("");
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(result.caret, result.caret);
    });
  }, [setDraft, textareaRef, token]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "Escape") {
      setDismissedToken(tokenKey);
    } else if (event.key === "ArrowDown") {
      if (candidates.length > 0) setActiveIndex((index) => (index + 1) % candidates.length);
    } else if (event.key === "ArrowUp") {
      if (candidates.length > 0) {
        setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
      }
    } else if (event.key === "Tab") {
      const item = candidates[activeIndex] ?? candidates[0];
      if (item) complete(item);
    } else if (event.key === "Enter" && !event.shiftKey) {
      const item = candidates[activeIndex] ?? candidates[0];
      if (!item || !token) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      const typed = event.currentTarget.value.slice(token.from, token.to);
      if (typed === item.invocation) return false;
      complete(item);
    } else {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  return {
    open,
    loading,
    error,
    candidates,
    activeIndex,
    provider,
    refresh,
    retry: loadCatalog,
    activate: setActiveIndex,
    complete,
    onKeyDown,
    dismiss: () => {
      setToken(null);
      setDismissedToken("");
    },
  };
}

export function SlashCommandMenu({ menu }: { menu: SlashCommandMenuState }) {
  if (!menu.open) return null;
  return <OpenSlashCommandMenu menu={menu} />;
}

function OpenSlashCommandMenu({ menu }: { menu: SlashCommandMenuState }) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>("[aria-selected='true']");
    selected?.scrollIntoView({ block: "nearest" });
  }, [menu.activeIndex]);
  return (
    <div
      ref={listRef}
      id="composer-slash-menu"
      className="slash-command-menu"
      role="listbox"
      aria-label={`${providerDisplayName(menu.provider)} commands and skills`}
    >
      <div className="slash-command-menu-header">
        <span>Commands &amp; skills</span>
        <span>{providerDisplayName(menu.provider)}</span>
      </div>
      {menu.loading && menu.candidates.length === 0 && (
        <div className="slash-command-menu-state"><span className="mini-spinner" />Loading catalog…</div>
      )}
      {menu.error && menu.candidates.length === 0 && (
        <button type="button" className="slash-command-menu-state error" onMouseDown={(event) => event.preventDefault()} onClick={menu.retry}>
          <Icons.reload size={14} />
          <span><strong>Catalog unavailable</strong><small>{menu.error}</small></span>
        </button>
      )}
      {!menu.loading && !menu.error && menu.candidates.length === 0 && (
        <div className="slash-command-menu-state">No matching commands or skills</div>
      )}
      {menu.candidates.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === menu.activeIndex}
          className={`slash-command-menu-row ${index === menu.activeIndex ? "active" : ""}`}
          onMouseEnter={() => menu.activate(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            menu.complete(item);
          }}
        >
          <span className={`slash-command-menu-icon ${item.kind}`}>
            {item.kind === "skill" ? <Icons.sparkles size={15} /> : <Icons.terminal size={14} />}
          </span>
          <span className="slash-command-menu-copy">
            <strong>{item.displayName || item.invocation}</strong>
            <small>{item.description || item.argumentHint || item.source}</small>
          </span>
          <span className="slash-command-menu-meta">
            {item.scope || (item.kind === "skill" ? "Skill" : item.kind === "prompt" ? "Prompt" : "Command")}
          </span>
        </button>
      ))}
    </div>
  );
}
