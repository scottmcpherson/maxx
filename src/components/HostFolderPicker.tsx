import { useEffect, useState } from "react";
import { ipc } from "../ipc";
import type { FolderEntry } from "../host/types";
import { isLocalHost } from "../host/session";
import { Icons } from "./Icons";

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
  const [path, setPath] = useState<string>("");
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const load = async (next: string) => {
    try {
      const listed = await ipc.listFolder(next, hostId);
      setPath(next);
      setEntries(listed.filter((entry) => entry.kind === "directory"));
      setKnown((current) => [...new Set([...current, next, ...listed.map((entry) => entry.path)])]);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  };

  useEffect(() => {
    let cancelled = false;
    void ipc.homeFolder(hostId).then((home) => {
      if (!cancelled) void load(home.path);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [hostId]);

  const parent = path.replace(/\/[^/]+$/, "") || "/";

  const create = async () => {
    if (!newName.trim()) return;
    try {
      const created = await ipc.createFolder(path, newName.trim(), hostId);
      setKnown((current) => [...current, created.path]);
      setCreating(false);
      setNewName("");
      await load(path);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const choose = () => {
    if (!known.includes(path)) {
      setError("Choose a folder listed on this host");
      return;
    }
    onSelect(path);
  };

  return (
    <div className="host-folder-picker" role="dialog" aria-label={`Choose a folder on ${hostName}`}>
      <header className="host-folder-picker-header">
        <strong>Add project on {hostName}</strong>
        <span>{isLocalHost(hostId) ? "This Mac" : "Folders on the connected Mac"}</span>
      </header>
      <div className="host-folder-path" title={path}>{path || "…"}</div>
      <div className="host-folder-toolbar">
        <button type="button" className="icon-button" disabled={!path || parent === path} onClick={() => void load(parent)} aria-label="Go up">
          <Icons.chevronLeft size={15} />
        </button>
        <button type="button" className="text-button" onClick={() => setCreating(true)}>New folder</button>
      </div>
      {creating && (
        <div className="host-folder-create">
          <input
            value={newName}
            placeholder="Folder name"
            aria-label="New folder name"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
              if (event.key === "Escape") setCreating(false);
            }}
          />
          <button type="button" className="text-button" onClick={() => void create()}>Create</button>
        </div>
      )}
      <ul className="host-folder-list">
        {entries.map((entry) => (
          <li key={entry.path}>
            <button type="button" onClick={() => void load(entry.path)}>
              <Icons.folder size={15} />
              <span>{entry.name}</span>
            </button>
          </li>
        ))}
        {entries.length === 0 && <li className="host-folder-empty">No folders here</li>}
      </ul>
      {error && <p className="host-folder-error">{error}</p>}
      <footer className="host-folder-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" onClick={choose} disabled={!path}>Select this folder</button>
      </footer>
    </div>
  );
}
