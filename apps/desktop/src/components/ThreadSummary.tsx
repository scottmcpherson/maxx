import { useEffect } from "react";
import { ChatProject, ChatThread, EventKind, isChatsProject, projectName, providerDisplayName } from "../contract/types";
import { useAppStore } from "../store/appStore";
import { summaryToggleAction, summaryToggleActive } from "../summary";
import { beginWindowDrag } from "../windowDrag";
import { GitEnvironment } from "./GitEnvironment";
import { Icons } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { Separator } from "./ui/separator";
import { cn } from "../lib/utils";

function SummaryBody({ project, thread, hostID }: { project: ChatProject; thread: ChatThread; hostID?: string | null }) {
  const commands = thread.runtimeEvents.filter((event) => event.kind === EventKind.command).length;
  const fileEvents = thread.runtimeEvents.filter((event) => event.kind === EventKind.fileChange);
  const changedFiles = new Set(fileEvents.flatMap((event) => event.payload.files?.map((file) => file.path) ?? [])).size;
  const pendingRequests = thread.interactionRequests.filter((request) => request.status === "pending").length;
  const rowClass = "grid min-h-7 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 text-xs";
  const valueClass = "max-w-24 truncate text-[0.65625rem] tabular-nums text-muted-foreground";
  const headingClass = "mb-1.5 text-[0.6875rem] font-medium text-muted-foreground";

  return (
    <div>
      <section className="py-2.5">
        <h3 className={headingClass}>Open Context</h3>
        <div className={rowClass}><Icons.folder size={14} aria-hidden="true" /><span className="truncate">{projectName(project)}</span></div>
        <div className={rowClass}><ProviderIcon provider={thread.provider} size={14} /><span>{providerDisplayName(thread.provider)}</span><span className={valueClass}>{thread.model || "Default"}</span></div>
      </section>
      <Separator />
      {!isChatsProject(project) && (
        <>
          <GitEnvironment projectID={project.id} hostID={hostID} threadID={thread.id} />
          <Separator />
        </>
      )}
      <section className="py-2.5">
        <h3 className={headingClass}>On This Thread</h3>
        <div className={rowClass}><Icons.files size={14} aria-hidden="true" /><span>Files changed</span><span className={valueClass}>{changedFiles}</span></div>
        <div className={rowClass}><Icons.terminal size={14} aria-hidden="true" /><span>Commands</span><span className={valueClass}>{commands}</span></div>
        <div className={rowClass}><Icons.activity size={14} aria-hidden="true" /><span>Requests</span><span className={valueClass}>{pendingRequests}</span></div>
      </section>
      <Separator />
      <section className="py-2.5">
        <h3 className={headingClass}>Session</h3>
        <p className="text-xs leading-snug text-muted-foreground">{thread.providerSessionID ? `Session ${thread.providerSessionID.slice(0, 18)}` : "A provider session starts with the first prompt."}</p>
      </section>
    </div>
  );
}

export function ContextRail({ project, thread, hostID }: { project: ChatProject; thread: ChatThread; hostID?: string | null }) {
  return (
    <aside data-slot="context-rail" className="flex w-[238px] shrink-0 flex-col overflow-y-auto overscroll-contain bg-background px-3 pb-3.5 text-muted-foreground" aria-label="Thread summary">
      <div className="sticky top-0 flex h-10 shrink-0 items-center bg-background text-[0.6875rem] font-normal text-muted-foreground" onMouseDown={beginWindowDrag}>Thread Context</div>
      <Separator />
      <SummaryBody project={project} thread={thread} hostID={hostID} />
    </aside>
  );
}

export function SummaryToggle({ project, thread, hostID, fits }: { project: ChatProject; thread: ChatThread; hostID?: string | null; fits: boolean }) {
  const pinned = useAppStore((state) => state.summaryPinned);
  const popoverOpen = useAppStore((state) => state.summaryPopoverOpen);
  const setSummaryPinned = useAppStore((state) => state.setSummaryPinned);
  const setSummaryPopoverOpen = useAppStore((state) => state.setSummaryPopoverOpen);

  useEffect(() => {
    if (fits && popoverOpen) setSummaryPopoverOpen(false);
  }, [fits, popoverOpen, setSummaryPopoverOpen]);

  const active = summaryToggleActive({ pinned, fits, popoverOpen });
  const toggle = () => {
    switch (summaryToggleAction({ pinned, fits, popoverOpen })) {
      case "pin": setSummaryPinned(true); break;
      case "unpin": setSummaryPinned(false); break;
      case "openPopover": setSummaryPopoverOpen(true); break;
      case "closePopover": setSummaryPopoverOpen(false); break;
    }
  };

  return (
    <Popover open={popoverOpen && !fits} onOpenChange={setSummaryPopoverOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className={cn(active && "bg-muted text-foreground")} title={fits ? "Toggle pinned summary" : "Show summary"} aria-label="Toggle pinned summary" aria-pressed={active} aria-haspopup={fits ? undefined : "dialog"} aria-expanded={fits ? undefined : popoverOpen} onClick={toggle} />}>
        <Icons.summary aria-hidden="true" />
      </PopoverTrigger>
      {!fits && (
        <PopoverContent align="end" className="w-72">
          <PopoverHeader><PopoverTitle className="sr-only">Thread summary</PopoverTitle></PopoverHeader>
          <SummaryBody project={project} thread={thread} hostID={hostID} />
        </PopoverContent>
      )}
    </Popover>
  );
}
