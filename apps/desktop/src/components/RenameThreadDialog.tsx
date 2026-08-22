import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { XIcon } from "lucide-react";
import { LOCAL_HOST_ID } from "../host/session";
import { useAppStore } from "../store/appStore";

export function RenameThreadDialog() {
  const target = useAppStore((state) => state.renamingThread);
  const workspace = useAppStore((state) => state.workspace);
  const remoteSessions = useAppStore((state) => state.remoteSessions);
  const renameThread = useAppStore((state) => state.renameThread);
  const setRenamingThread = useAppStore((state) => state.setRenamingThread);
  const targetWorkspace = target?.hostID === LOCAL_HOST_ID
    ? workspace
    : remoteSessions.find((session) => session.host.id === target?.hostID)?.workspace;
  const thread = target
    ? targetWorkspace?.projects
        .find((project) => project.id === target.projectID)
        ?.threads.find((candidate) => candidate.id === target.threadID)
    : undefined;
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(thread?.title ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(thread?.title ?? "");
    setSaving(false);
  }, [thread?.id, thread?.title]);

  useLayoutEffect(() => {
    if (target && thread) inputRef.current?.select();
  }, [target, thread]);

  useEffect(() => {
    if (target && targetWorkspace && !thread) setRenamingThread(null);
  }, [setRenamingThread, target, targetWorkspace, thread]);

  const close = () => {
    if (!saving) setRenamingThread(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || !thread) return;
    const nextTitle = title.trim();
    if (!nextTitle || saving) return;
    if (nextTitle === thread.title) {
      setRenamingThread(null);
      return;
    }
    setSaving(true);
    if (await renameThread(target.hostID, target.projectID, target.threadID, nextTitle)) {
      setRenamingThread(null);
    } else {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={Boolean(target && thread)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogClose
          disabled={saving}
          render={<Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" />}
        >
          <XIcon />
          <span className="sr-only">Close rename dialog</span>
        </DialogClose>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle id="rename-thread-title">Rename chat</DialogTitle>
            <DialogDescription>Keep it short and recognizable</DialogDescription>
          </DialogHeader>
          <Input
            ref={inputRef}
            autoFocus
            value={title}
            aria-label="Chat name"
            spellCheck={false}
            onChange={(event) => setTitle(event.target.value)}
            disabled={saving}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
