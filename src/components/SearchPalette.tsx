import { useEffect, useMemo, useRef, useState } from "react";
import { projectName } from "../contract/types";
import { useAppStore } from "../store/appStore";
import { relativeTime } from "../relativeTime";
import { Icons } from "./Icons";

interface PaletteEntry {
  hostID: string;
  projectID: string;
  projectLabel: string;
  threadID: string;
  title: string;
  provider: string;
  updatedAt: number;
}

const MAX_RESULTS = 50;

export function SearchPalette() {
  const workspace = useAppStore((state) => state.workspace);
  const remoteSessions = useAppStore((state) => state.remoteSessions);
  const selectThread = useAppStore((state) => state.selectThread);
  const setSearchOpen = useAppStore((state) => state.setSearchOpen);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo<PaletteEntry[]>(() => {
    const hosts = [
      { id: "local", name: "This computer", projects: workspace?.projects ?? [] },
      ...remoteSessions.map((session) => ({
        id: session.host.id,
        name: session.host.name,
        projects: session.workspace.projects,
      })),
    ];
    const all = hosts.flatMap((host) =>
      host.projects.flatMap((project) =>
        // Side threads open from their parent thread, not the palette.
        project.threads.filter((thread) => !thread.parentThreadID).map((thread) => ({
          hostID: host.id,
          projectID: project.id,
          projectLabel: `${host.name} · ${projectName(project)}`,
          threadID: thread.id,
          title: thread.title,
          provider: thread.provider,
          updatedAt: thread.updatedAt,
        })),
      ),
    );
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [remoteSessions, workspace]);

  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(() => {
    const matches = normalizedQuery
      ? entries.filter(
          (entry) =>
            entry.title.toLowerCase().includes(normalizedQuery) ||
            entry.projectLabel.toLowerCase().includes(normalizedQuery),
        )
      : entries;
    return matches.slice(0, MAX_RESULTS);
  }, [entries, normalizedQuery]);

  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedQuery]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const close = () => setSearchOpen(false);

  const openEntry = (entry: PaletteEntry) => {
    selectThread(entry.projectID, entry.threadID, entry.hostID);
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = results[activeIndex];
      if (entry) openEntry(entry);
    }
  };

  const profileColor = (provider: string) =>
    workspace?.providerProfiles.find((profile) => profile.provider === provider)?.colorHex ?? "#888";

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search threads"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <label className="palette-input-row">
          <Icons.search size={15} />
          <input
            autoFocus
            value={query}
            placeholder="Search threads…"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>esc</kbd>
        </label>
        {results.length > 0 ? (
          <>
            <p className="palette-section-label">{normalizedQuery ? "Threads" : "Recent"}</p>
            <ul className="palette-results" ref={listRef} role="listbox" aria-label="Matching threads">
              {results.map((entry, index) => (
                <li key={entry.threadID}>
                  <button
                    type="button"
                    role="option"
                    data-index={index}
                    aria-selected={index === activeIndex}
                    className={`palette-row ${index === activeIndex ? "active" : ""}`}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => openEntry(entry)}
                  >
                    <span className="palette-mark" style={{ color: profileColor(entry.provider) }} aria-hidden="true">
                      ◆
                    </span>
                    <span className="palette-title">{entry.title}</span>
                    <span className="palette-project">{entry.projectLabel}</span>
                    <span className="palette-time">{relativeTime(entry.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="palette-empty">
            {entries.length === 0 ? "No threads yet." : `No threads match “${query.trim()}”.`}
          </p>
        )}
        <footer className="palette-footer" aria-hidden="true">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}
