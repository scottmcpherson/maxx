import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipc } from "../ipc";
import { hostErrorMessage, isHostConnectionError } from "../host/errors";
import type { FolderEntry } from "../host/types";
import { isLocalHost } from "../host/session";
import { Icons } from "./Icons";

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
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".host-folder-row") ?? []);
    const index = rows.indexOf(current);
    rows[index + direction]?.focus();
  };

  const retry = () => {
    if (path) void load(path);
    else void loadHome();
  };

  const local = isLocalHost(hostId);
  const disconnected = !local && error?.startsWith(`${hostName} is disconnected`);

  return createPortal(
    <div
      className="host-folder-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creatingFolder) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="host-folder-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-folder-picker-title"
        aria-busy={loading || creatingFolder}
        tabIndex={-1}
      >
        <header className="host-folder-picker-header">
          <h2 id="host-folder-picker-title">Choose a project folder</h2>
          <div className="host-folder-host">
            <Icons.computer size={13} />
            <span>{local ? "This Mac" : hostName}</span>
            {!local && <>
              <i className={disconnected ? "is-disconnected" : undefined} aria-hidden="true" />
              <span>{disconnected ? "Disconnected" : "Connected"}</span>
            </>}
          </div>
        </header>
        <div className="host-folder-toolbar">
          <button
            type="button"
            className="icon-button host-folder-tooltip host-folder-up"
            disabled={loading || !path || parent === path}
            onClick={() => void load(parent)}
            aria-label="Go to parent folder"
          >
            <Icons.chevronUp size={15} />
            <span className="host-folder-tooltip-label" aria-hidden="true">Parent folder</span>
          </button>
          <nav className="host-folder-breadcrumbs" aria-label="Current folder" title={path}>
            {breadcrumbs.length === 0 && <span>Loading…</span>}
            {breadcrumbs.map((breadcrumb, index) => (
              <span key={breadcrumb.path}>
                {index > 0 && <Icons.chevronRight size={12} />}
                <button
                  type="button"
                  disabled={loading || breadcrumb.path === path}
                  onClick={() => void load(breadcrumb.path)}
                >
                  {breadcrumb.label}
                </button>
              </span>
            ))}
          </nav>
          <button
            type="button"
            className="icon-button host-folder-tooltip host-folder-new"
            disabled={loading || creating || creatingFolder || !path}
            onClick={() => setCreating(true)}
            aria-label="New folder"
          >
            <Icons.folderPlus size={17} />
            <span className="host-folder-tooltip-label" aria-hidden="true">New folder&nbsp; ⇧⌘N</span>
          </button>
        </div>
        <div className="host-folder-browser">
          {error && (
            <div className="host-folder-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={retry} disabled={loading}>Retry</button>
            </div>
          )}
          <ul className="host-folder-list" ref={listRef} aria-label="Folders">
            {creating && (
              <li className="host-folder-create">
                <Icons.folder size={16} />
                <input
                  ref={newFolderInputRef}
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
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void create()}
                  disabled={!newName.trim() || creatingFolder}
                  aria-label="Create folder"
                  title="Create folder"
                >
                  {creatingFolder ? <span className="mini-spinner" /> : <Icons.check size={14} />}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => { setCreating(false); setNewName(""); }}
                  disabled={creatingFolder}
                  aria-label="Cancel new folder"
                  title="Cancel"
                >
                  <Icons.close size={14} />
                </button>
              </li>
            )}
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="host-folder-row"
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
                  <Icons.folder size={16} />
                  <span>{entry.name}</span>
                  <Icons.chevronRight className="host-folder-row-chevron" size={13} />
                </button>
              </li>
            ))}
            {!loading && entries.length === 0 && !creating && (
              <li className="host-folder-empty">
                <Icons.folderOpen size={24} />
                <strong>No subfolders</strong>
                <span>You can still add this folder as a project.</span>
              </li>
            )}
          </ul>
          {loading && (
            <div className="host-folder-loading" role="status">
              <span className="mini-spinner" />
              <span>Loading folder…</span>
            </div>
          )}
        </div>
        <footer className="host-folder-actions">
          <div className="host-folder-current" title={path}>
            <span>Current folder</span>
            <strong>{path || "Loading…"}</strong>
          </div>
          <button type="button" className="secondary" onClick={onCancel} disabled={creatingFolder}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={choose}
            disabled={!path || !known.includes(path) || loading || creatingFolder}
          >
            Add project
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
