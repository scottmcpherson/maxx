import { useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { projectName } from "../contract/types";
import { useAppStore } from "../store/appStore";
import { relativeTime } from "../relativeTime";

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
  const searchOpen = useAppStore((state) => state.searchOpen);
  const selectThread = useAppStore((state) => state.selectThread);
  const setSearchOpen = useAppStore((state) => state.setSearchOpen);
  const [query, setQuery] = useState("");

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
    if (!searchOpen) setQuery("");
  }, [searchOpen]);

  const openEntry = (entry: PaletteEntry) => {
    selectThread(entry.projectID, entry.threadID, entry.hostID);
    setSearchOpen(false);
  };

  const profileColor = (provider: string) =>
    workspace?.providerProfiles.find((profile) => profile.provider === provider)?.colorHex ?? "var(--muted-foreground)";

  return (
    <CommandDialog
      open={searchOpen}
      onOpenChange={setSearchOpen}
      title="Search threads"
      description="Search and open a chat."
      showCloseButton={false}
    >
      <Command shouldFilter={false}>
        <CommandInput
          autoFocus
          value={query}
          placeholder="Search threads…"
          spellCheck={false}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>
            {entries.length === 0 ? "No threads yet." : `No threads match “${query.trim()}”.`}
          </CommandEmpty>
          {results.length > 0 && (
            <CommandGroup heading={normalizedQuery ? "Threads" : "Recent"}>
              {results.map((entry) => (
                <CommandItem
                  key={`${entry.hostID}:${entry.threadID}`}
                  value={`${entry.title} ${entry.projectLabel}`}
                  onSelect={() => openEntry(entry)}
                  className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,0.75fr)_auto] gap-2"
                >
                  <span className="shrink-0 text-[9px] leading-none" style={{ color: profileColor(entry.provider) }} aria-hidden="true">
                    ◆
                  </span>
                  <span className="truncate">{entry.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{entry.projectLabel}</span>
                  <CommandShortcut>{relativeTime(entry.updatedAt)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        <footer className="flex items-center gap-3 border-t px-2 py-2 text-xs text-muted-foreground" aria-hidden="true">
          <span><KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup> navigate</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>esc</Kbd> close</span>
        </footer>
      </Command>
    </CommandDialog>
  );
}
