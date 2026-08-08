import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useAppStore } from "../store/appStore";
import { Icons } from "./Icons";

export function RenameThreadDialog() {
  const target = useAppStore((state) => state.renamingThread);
  const workspace = useAppStore((state) => state.workspace);
  const renameThread = useAppStore((state) => state.renameThread);
  const setRenamingThread = useAppStore((state) => state.setRenamingThread);
  const thread = target
    ? workspace?.projects
        .find((project) => project.id === target.projectID)
        ?.threads.find((candidate) => candidate.id === target.threadID)
    : undefined;
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(thread?.title ?? "");
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (target && workspace && !thread) setRenamingThread(null);
  }, [setRenamingThread, target, thread, workspace]);

  if (!target || !thread) return null;

  const close = () => {
    if (!saving) setRenamingThread(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || saving) return;
    if (nextTitle === thread.title) {
      setRenamingThread(null);
      return;
    }
    setSaving(true);
    if (await renameThread(target.projectID, target.threadID, nextTitle)) {
      setRenamingThread(null);
    } else {
      setSaving(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  return (
    <div className="rename-thread-backdrop" onMouseDown={close}>
      <form
        className="rename-thread-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-thread-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="rename-thread-header">
          <div>
            <h2 id="rename-thread-title">Rename chat</h2>
            <p>Keep it short and recognizable</p>
          </div>
          <button
            type="button"
            className="icon-button rename-thread-close"
            aria-label="Close rename dialog"
            onClick={close}
            disabled={saving}
          >
            <Icons.close size={15} />
          </button>
        </header>
        <input
          ref={inputRef}
          className="rename-thread-input"
          autoFocus
          value={title}
          aria-label="Chat name"
          spellCheck={false}
          onChange={(event) => setTitle(event.target.value)}
        />
        <footer className="rename-thread-actions">
          <button type="button" className="rename-thread-button secondary" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="rename-thread-button primary"
            disabled={!title.trim() || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}
