import { useEffect, useRef } from "react";
import { ChatProject, ChatThread, EventKind, projectName, providerDisplayName } from "../contract/types";
import { useAppStore } from "../store/appStore";
import { summaryToggleAction, summaryToggleActive } from "../summary";
import { beginWindowDrag } from "../windowDrag";
import { GitEnvironment } from "./GitEnvironment";
import { Icons } from "./Icons";

/**
 * The summary itself. One body, two containers: the pinned rail and the
 * popover that stands in for it on a window too narrow to seat the rail.
 */
function SummaryBody({
  project,
  thread,
  hostID,
}: {
  project: ChatProject;
  thread: ChatThread;
  hostID?: string | null;
}) {
  const providerColor = useAppStore((state) =>
    state.workspace?.providerProfiles.find((profile) => profile.provider === thread.provider)?.colorHex,
  );
  const commands = thread.runtimeEvents.filter((event) => event.kind === EventKind.command).length;
  const fileEvents = thread.runtimeEvents.filter((event) => event.kind === EventKind.fileChange);
  const changedFiles = new Set(fileEvents.flatMap((event) => event.payload.files?.map((file) => file.path) ?? [])).size;
  const pendingRequests = thread.interactionRequests.filter((request) => request.status === "pending").length;

  return (
    <>
      <section className="context-section">
        <h3>Open Context</h3>
        <div className="context-row">
          <Icons.folder size={14} />
          <span>{projectName(project)}</span>
        </div>
        <div className="context-row">
          <span className="provider-dot context-dot" style={{ background: providerColor ?? "#7657ee" }} />
          <span>{providerDisplayName(thread.provider)}</span>
          <span className="context-value">{thread.model || "Default"}</span>
        </div>
      </section>
      <GitEnvironment projectID={project.id} hostID={hostID} threadID={thread.id} />
      <section className="context-section">
        <h3>On This Thread</h3>
        <div className="context-row">
          <Icons.files size={14} />
          <span>Files changed</span>
          <span className="context-value">{changedFiles}</span>
        </div>
        <div className="context-row">
          <Icons.terminal size={14} />
          <span>Commands</span>
          <span className="context-value">{commands}</span>
        </div>
        <div className="context-row">
          <Icons.activity size={14} />
          <span>Requests</span>
          <span className="context-value">{pendingRequests}</span>
        </div>
      </section>
      <section className="context-section context-session">
        <h3>Runtime</h3>
        <p>{thread.providerSessionID ? `Session ${thread.providerSessionID.slice(0, 18)}` : "A provider session starts with the first prompt."}</p>
      </section>
    </>
  );
}

/**
 * The pinned rail: the summary seated as a column beside the transcript.
 *
 * No close affordance of its own — the title bar's [`SummaryToggle`] is the
 * one control for this surface, and a second button beside it would just be
 * the same toggle wearing a different label.
 */
export function ContextRail({
  project,
  thread,
  hostID,
}: {
  project: ChatProject;
  thread: ChatThread;
  hostID?: string | null;
}) {
  return (
    <aside className="context-rail" aria-label="Thread summary">
      <div className="context-rail-header" onMouseDown={beginWindowDrag}>
        <span>Thread Context</span>
      </div>
      <SummaryBody project={project} thread={thread} hostID={hostID} />
    </aside>
  );
}

/**
 * Title-bar control for the summary — Codex's "Toggle pinned summary".
 *
 * `fits` is the caller's verdict on whether the rail has anywhere to sit (see
 * `canFitPinnedSummary`, plus whatever else holds the slot). When it does, this
 * is a pin toggle; when it does not, the same click opens the summary as a
 * popover anchored here, which is the only way to reach it on a narrow window.
 */
export function SummaryToggle({
  project,
  thread,
  hostID,
  fits,
}: {
  project: ChatProject;
  thread: ChatThread;
  hostID?: string | null;
  fits: boolean;
}) {
  const pinned = useAppStore((state) => state.summaryPinned);
  const popoverOpen = useAppStore((state) => state.summaryPopoverOpen);
  const setSummaryPinned = useAppStore((state) => state.setSummaryPinned);
  const setSummaryPopoverOpen = useAppStore((state) => state.setSummaryPopoverOpen);
  const rootRef = useRef<HTMLDivElement>(null);

  // A popover only exists as a stand-in for the rail: once the rail can be
  // seated again — the user widened the window, or closed the browser — the
  // pinned rail takes over and the popover has nothing left to stand in for.
  useEffect(() => {
    if (fits && popoverOpen) setSummaryPopoverOpen(false);
  }, [fits, popoverOpen, setSummaryPopoverOpen]);

  // Dismissal is scoped to the whole control, not just the popover: a click on
  // the trigger has to reach `onClick` as a close, not be swallowed here as an
  // outside click and then reopened by the button.
  useEffect(() => {
    if (!popoverOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setSummaryPopoverOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setSummaryPopoverOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [popoverOpen, setSummaryPopoverOpen]);

  const active = summaryToggleActive({ pinned, fits, popoverOpen });
  const toggle = () => {
    switch (summaryToggleAction({ pinned, fits, popoverOpen })) {
      case "pin":
        setSummaryPinned(true);
        break;
      case "unpin":
        setSummaryPinned(false);
        break;
      case "openPopover":
        setSummaryPopoverOpen(true);
        break;
      case "closePopover":
        setSummaryPopoverOpen(false);
        break;
    }
  };

  return (
    <div className="summary-toggle" ref={rootRef}>
      <button
        className={`icon-button${active ? " is-active" : ""}`}
        title={fits ? "Toggle pinned summary" : "Show summary"}
        aria-label="Toggle pinned summary"
        aria-pressed={active}
        aria-haspopup={fits ? undefined : "dialog"}
        aria-expanded={fits ? undefined : popoverOpen}
        onClick={toggle}
      >
        <Icons.summary size={14} />
      </button>
      {popoverOpen && !fits && (
        <div className="summary-popover" role="dialog" aria-label="Thread summary">
          <SummaryBody project={project} thread={thread} hostID={hostID} />
        </div>
      )}
    </div>
  );
}
