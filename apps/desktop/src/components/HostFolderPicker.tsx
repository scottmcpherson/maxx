import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../ipc";
import { hostErrorMessage, isHostConnectionError } from "../host/errors";
import type { FolderEntry } from "../host/types";
import { isLocalHost } from "../host/session";
import { Icons } from "./Icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export interface FolderBreadcrumb {
  label: string;
  path: string;
}

export function folderBreadcrumbs(path: string, homePath: string): FolderBreadcrumb[] {
  if (!path) return [];
  const normalizedHome = homePath.replace(/\/$/, "");
  if (normalizedHome && (path === normalizedHome || path.startsWith(`${normalizedHome}/`))) {
    const relativeParts = path.slice(normalizedHome.length).split("/").filter(Boolean);
    return [
      { label: "Home", path: normalizedHome },
      ...relativeParts.map((part, index) => ({
        label: part,
        path: `${normalizedHome}/${relativeParts.slice(0, index + 1).join("/")}`,
      })),
    ];
  }
  if (path === "/") return [{ label: "/", path: "/" }];
  const parts = path.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...parts.map((part, index) => ({
      label: part,
      path: `/${parts.slice(0, index + 1).join("/")}`,
    })),
  ];
}

export function folderPickerError(reason: unknown, hostName: string): string {
  const message = hostErrorMessage(reason);
  if (isHostConnectionError(reason)) {
    return `${hostName} is disconnected. Reconnect it, then try again.`;
  }
  return message || "The folder could not be loaded.";
}

export function HostFolderPicker({
  hostId,
  hostName,
  onSelect,
  onCancel,
}: {
  hostId: string;
  hostName: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [homePath, setHomePath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newName, setNewName] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (next: string) => {
    setLoading(true);
    try {
      const listed = await ipc.listFolder(next, hostId);
      setPath(next);
      setEntries(listed.filter((entry) => entry.kind === "directory"));
      setKnown((current) => [...new Set([...current, next, ...listed.map((entry) => entry.path)])]);
      setError(null);
    } catch (reason) {
      setError(folderPickerError(reason, hostName));
    } finally {
      setLoading(false);
    }
  }, [hostId, hostName]);

  const loadHome = useCallback(async () => {
    setLoading(true);
    try {
      const home = await ipc.homeFolder(hostId);
      setHomePath(home.path);
      await load(home.path);
    } catch (reason) {
      setError(folderPickerError(reason, hostName));
      setLoading(false);
    }
  }, [hostId, hostName, load]);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    if (creating) newFolderInputRef.current?.focus();
  }, [creating]);

  const parent = path.replace(/\/[^/]+$/, "") || "/";
  const breadcrumbs = folderBreadcrumbs(path, homePath);

  const create = async () => {
    if (!newName.trim() || creatingFolder) return;
    setCreatingFolder(true);
    try {
      const created = await ipc.createFolder(path, newName.trim(), hostId);
      setKnown((current) => [...current, created.path]);
      setCreating(false);
      setNewName("");
      await load(created.path);
    } catch (reason) {
      setError(folderPickerError(reason, hostName));
    } finally {
      setCreatingFolder(false);
    }
  };

  const choose = useCallback(() => {
    if (!known.includes(path)) {
      setError("Choose a folder listed on this host");
      return;
    }
    onSelect(path);
  }, [known, onSelect, path]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (creating) {
          setCreating(false);
          setNewName("");
        } else if (!creatingFolder) {
          onCancel();
        }
        return;
      }
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (path && !loading && !creatingFolder) setCreating(true);
        return;
      }
      if (event.key === "Enter" && document.activeElement === dialogRef.current && path && !loading) {
        event.preventDefault();
        choose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [choose, creating, creatingFolder, loading, onCancel, path]);

  const moveFolderFocus = (current: HTMLButtonElement, direction: -1 | 1) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-folder-row]") ?? []);
    const index = rows.indexOf(current);
    rows[index + direction]?.focus();
  };

  const retry = () => {
    if (path) void load(path);
    else void loadHome();
  };

  const local = isLocalHost(hostId);
  const disconnected = !local && error?.startsWith(`${hostName} is disconnected`);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !creatingFolder) onCancel(); }}>
      <DialogContent
        ref={dialogRef}
        className="flex h-[min(720px,calc(100vh-2rem))] max-w-3xl flex-col gap-0 overflow-hidden p-0"
        aria-busy={loading || creatingFolder}
        showCloseButton={false}
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Choose a project folder</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <Icons.computer aria-hidden="true" />
            <span>{local ? "This computer" : hostName}</span>
            {!local && <>
              <span className={disconnected ? "text-destructive" : "text-primary"} aria-hidden="true">●</span>
              <span>{disconnected ? "Disconnected" : "Connected"}</span>
            </>}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-5 py-2">
          <IconButton
            label="Go to parent folder"
            disabled={loading || !path || parent === path}
            onClick={() => void load(parent)}
          >
            <Icons.chevronUp />
          </IconButton>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm" aria-label="Current folder" title={path}>
            {breadcrumbs.length === 0 && <span className="text-muted-foreground">Loading…</span>}
            {breadcrumbs.map((breadcrumb, index) => (
              <span className="flex shrink-0 items-center gap-1" key={breadcrumb.path}>
                {index > 0 && <Icons.chevronRight aria-hidden="true" />}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={loading || breadcrumb.path === path}
                  onClick={() => void load(breadcrumb.path)}
                >
                  {breadcrumb.label}
                </Button>
              </span>
            ))}
          </nav>
          <IconButton
            label="New folder"
            tooltip="New folder · ⇧⌘N"
            disabled={loading || creating || creatingFolder || !path}
            onClick={() => setCreating(true)}
          >
            <Icons.folderPlus />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {error && (
            <Alert variant="destructive" className="m-4">
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{error}</span>
                <Button type="button" variant="outline" size="sm" onClick={retry} disabled={loading}>Retry</Button>
              </AlertDescription>
            </Alert>
          )}
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 py-2" ref={listRef} aria-label="Folders">
            {creating && (
              <li className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2">
                <Icons.folder aria-hidden="true" />
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="new-folder-name" className="sr-only">New folder name</FieldLabel>
                  <Input
                    ref={newFolderInputRef}
                    id="new-folder-name"
                    value={newName}
                    placeholder="Folder name"
                    aria-label="New folder name"
                    disabled={creatingFolder}
                    onChange={(event) => setNewName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void create();
                      }
                    }}
                  />
                </Field>
                <IconButton label="Create folder" disabled={!newName.trim() || creatingFolder} onClick={() => void create()}>
                  {creatingFolder ? <Spinner /> : <Icons.check />}
                </IconButton>
                <IconButton label="Cancel new folder" disabled={creatingFolder} onClick={() => { setCreating(false); setNewName(""); }}>
                  <Icons.close />
                </IconButton>
              </li>
            )}
            {entries.map((entry) => (
              <li key={entry.path}>
                <Button
                  type="button"
                  variant="ghost"
                  className="group h-auto w-full justify-start gap-3 px-3 py-2 text-left"
                  data-folder-row
                  disabled={loading || creatingFolder}
                  onClick={() => void load(entry.path)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      moveFolderFocus(event.currentTarget, 1);
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      moveFolderFocus(event.currentTarget, -1);
                    } else if (event.key === "ArrowLeft" && parent !== path) {
                      event.preventDefault();
                      void load(parent);
                    }
                  }}
                >
                  <Icons.folder aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <Icons.chevronRight className="text-muted-foreground" aria-hidden="true" />
                </Button>
              </li>
            ))}
            {!loading && entries.length === 0 && !creating && (
              <li className="flex flex-1 items-center justify-center">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><Icons.folderOpen /></EmptyMedia>
                    <EmptyTitle>No subfolders</EmptyTitle>
                    <EmptyDescription>You can still add this folder as a project.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </li>
            )}
          </ul>
          {loading && (
            <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground" role="status">
              <Spinner />
              <span>Loading folder…</span>
            </div>
          )}
        </div>
        <DialogFooter className="flex-row items-center justify-between gap-3 border-t px-5 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5" title={path}>
            <span className="text-xs text-muted-foreground">Current folder</span>
            <strong className="truncate text-sm">{path || "Loading…"}</strong>
          </div>
          <Button type="button" variant="outline" onClick={onCancel} disabled={creatingFolder}>Cancel</Button>
          <Button
            type="button"
            onClick={choose}
            disabled={!path || !known.includes(path) || loading || creatingFolder}
          >
            Add project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
