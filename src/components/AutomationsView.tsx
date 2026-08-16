import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  Automation,
  AutomationCreateRequest,
  AutomationKind,
  AutomationSchedule,
  AutomationStatus,
  AutomationUpdateRequest,
  ChatProvider,
} from "../contract/types";
import { ALL_PROVIDERS, providerDisplayName } from "../contract/types";
import { ipc } from "../ipc";
import { LOCAL_HOST_ID } from "../host/session";
import { useAppStore } from "../store/appStore";
import { beginWindowDrag } from "../windowDrag";
import { Icons } from "./Icons";

type ScheduleType = AutomationSchedule["type"];

interface AutomationDraft {
  title: string;
  kind: AutomationKind;
  prompt: string;
  scheduleType: ScheduleType;
  onceAt: string;
  intervalMinutes: string;
  cronExpression: string;
  timezone: string;
  provider: ChatProvider;
  model: string;
}

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function emptyDraft(): AutomationDraft {
  return {
    title: "",
    kind: "notification",
    prompt: "",
    scheduleType: "once",
    onceAt: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)),
    intervalMinutes: "60",
    cronExpression: "0 9 * * 1-5",
    timezone: localTimezone(),
    provider: "codex",
    model: "Default",
  };
}

function draftFromAutomation(automation: Automation): AutomationDraft {
  const schedule = automation.schedule;
  return {
    title: automation.title,
    kind: automation.kind,
    prompt: automation.prompt,
    scheduleType: schedule.type,
    onceAt: schedule.type === "once" ? localDateTimeValue(new Date(schedule.at)) : emptyDraft().onceAt,
    intervalMinutes: schedule.type === "interval" ? String(Math.max(1, Math.round(schedule.everySeconds / 60))) : "60",
    cronExpression: schedule.type === "cron" ? schedule.expression : "0 9 * * 1-5",
    timezone: schedule.timezone,
    provider: automation.runtime?.provider ?? "codex",
    model: automation.runtime?.model ?? "Default",
  };
}

export function formatAutomationTimestamp(timestamp?: string | null): string {
  if (!timestamp) return "Not scheduled";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatAutomationSchedule(schedule: AutomationSchedule): string {
  if (schedule.type === "once") return `Once · ${formatAutomationTimestamp(schedule.at)}`;
  if (schedule.type === "interval") {
    const minutes = Math.max(1, Math.round(schedule.everySeconds / 60));
    const label = minutes >= 60 && minutes % 60 === 0
      ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
      : `${minutes} minute${minutes === 1 ? "" : "s"}`;
    return `Every ${label}`;
  }
  return `Cron · ${schedule.expression}`;
}

export function automationStatusLabel(status: AutomationStatus): string {
  return status === "needs_attention"
    ? "Needs attention"
    : status.charAt(0).toUpperCase() + status.slice(1);
}

function scheduleFromDraft(draft: AutomationDraft): AutomationSchedule {
  if (draft.scheduleType === "once") {
    const date = new Date(draft.onceAt);
    if (Number.isNaN(date.getTime())) throw new Error("Choose a valid date and time.");
    return { type: "once", at: date.toISOString(), timezone: localTimezone() };
  }
  if (draft.scheduleType === "interval") {
    const minutes = Number(draft.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error("Interval must be at least one minute.");
    return { type: "interval", everySeconds: Math.round(minutes * 60), timezone: draft.timezone };
  }
  if (!draft.cronExpression.trim()) throw new Error("Enter a cron expression.");
  return { type: "cron", expression: draft.cronExpression.trim(), timezone: draft.timezone };
}

function requestFromDraft(draft: AutomationDraft): AutomationCreateRequest {
  const request: AutomationCreateRequest = {
    title: draft.title.trim(),
    kind: draft.kind,
    prompt: draft.prompt.trim(),
    schedule: scheduleFromDraft(draft),
  };
  if (!request.title) throw new Error("Give this automation a name.");
  if (!request.prompt) throw new Error("Describe what should be delivered.");
  if (draft.kind === "agent_turn") {
    request.runtime = { provider: draft.provider, model: draft.model.trim() || "Default" };
  } else {
    request.runtime = null;
  }
  return request;
}

function displayKind(kind: AutomationKind): string {
  return kind === "agent_turn" ? "Agent turn" : "Notification";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AutomationsView() {
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);
  const setAutomationsOpen = useAppStore((state) => state.setAutomationsOpen);
  const workspace = useAppStore((state) => state.workspace);
  const refreshWorkspace = useAppStore((state) => state.refresh);
  const selectThread = useAppStore((state) => state.selectThread);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingID, setPendingID] = useState<string | null>(null);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationDraft | null>(null);

  const providerOptions = useMemo(() => {
    const configured = workspace?.providerProfiles
      .filter((profile) => profile.isEnabled)
      .map((profile) => profile.provider) ?? [];
    return [...new Set(configured.length > 0 ? configured : ALL_PROVIDERS)];
  }, [workspace?.providerProfiles]);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setAutomations(await ipc.listAutomations());
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void ipc.listAutomations().then((items) => {
      if (!cancelled) {
        setAutomations(items);
        setLoading(false);
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        setLoadError(errorMessage(error));
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void ipc.onAutomationChanged(() => {
      if (!disposed) void load();
    }).then((remove) => {
      if (disposed) remove();
      else unlisten = remove;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (draft) {
        setDraft(null);
        setEditingID(null);
      } else {
        setAutomationsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft, setAutomationsOpen]);

  const openNew = () => {
    setActionError(null);
    setEditingID(null);
    setDraft(emptyDraft());
  };

  const openEdit = (automation: Automation) => {
    setActionError(null);
    setEditingID(automation.id);
    setDraft(draftFromAutomation(automation));
  };

  const closeEditor = () => {
    setDraft(null);
    setEditingID(null);
  };

  const withPending = async (id: string, action: () => Promise<void>) => {
    setActionError(null);
    setPendingID(id);
    try {
      await action();
      await load();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingID(null);
    }
  };

  const togglePaused = (automation: Automation) => {
    const status = automation.status === "paused" ? "active" : "paused";
    void withPending(automation.id, async () => {
      await ipc.updateAutomation(automation.id, { status });
    });
  };

  const runNow = (automation: Automation) => {
    void withPending(automation.id, async () => {
      await ipc.runAutomation(automation.id);
    });
  };

  const remove = (automation: Automation) => {
    if (typeof window !== "undefined" && !window.confirm(`Delete “${automation.title}”?`)) return;
    void withPending(automation.id, async () => {
      await ipc.deleteAutomation(automation.id);
    });
  };

  const openAutomationChat = async (automation: Automation) => {
    const projectID = automation.runtime?.projectID;
    const threadID = automation.runtime?.threadID;
    if (!projectID || !threadID) return;
    await refreshWorkspace();
    selectThread(projectID, threadID, LOCAL_HOST_ID);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    setActionError(null);
    try {
      const request = requestFromDraft(draft);
      if (editingID) {
        const updates: AutomationUpdateRequest = {
          title: request.title,
          kind: request.kind,
          prompt: request.prompt,
          schedule: request.schedule,
          runtime: request.runtime,
        };
        const updated = await ipc.updateAutomation(editingID, updates);
        setAutomations((items) => items.map((item) => item.id === updated.id ? updated : item));
      } else {
        const created = await ipc.createAutomation(request);
        setAutomations((items) => [created, ...items]);
      }
      closeEditor();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const updateDraft = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  };

  return (
    <main className="automations-view">
      <header className={`automations-header${sidebarOpen ? "" : " sidebar-closed"}`} onMouseDown={beginWindowDrag}>
        <button type="button" className="agents-back" onClick={() => setAutomationsOpen(false)}>
          <Icons.chevronLeft size={15} />
          Back
        </button>
        <div className="automations-header-title"><Icons.clock size={16} /> Automations</div>
        {!draft && (
          <button type="button" className="agents-primary-button automations-new-button" onClick={openNew}>
            <Icons.plus size={14} /> New automation
          </button>
        )}
      </header>

      <div className="automations-content">
        {draft ? (
          <form className="automation-editor" onSubmit={(event) => void submit(event)}>
            <div className="settings-content-header automation-editor-header">
              <div>
                <h1>{editingID ? "Edit automation" : "New automation"}</h1>
                <p>Maxx runs schedules independently of the harness that created them.</p>
              </div>
              <button type="button" className="settings-secondary-button" onClick={closeEditor}>Cancel</button>
            </div>
            <label className="agent-field"><span>Name</span><input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder="Walk the dog" autoFocus /></label>
            <label className="agent-field"><span>What should happen?</span><textarea value={draft.prompt} onChange={(event) => updateDraft("prompt", event.target.value)} placeholder={draft.kind === "notification" ? "Walk the dog" : "Summarize new issues in this repository"} rows={3} /></label>
            <fieldset className="automation-fieldset"><legend>Action</legend><div className="automation-segmented">
              {(["notification", "agent_turn"] as const).map((kind) => <button key={kind} type="button" className={draft.kind === kind ? "selected" : ""} onClick={() => updateDraft("kind", kind)}>{displayKind(kind)}</button>)}
            </div>{draft.kind === "agent_turn" && <div className="automation-runtime-fields"><label className="agent-field"><span>Harness</span><select value={draft.provider} onChange={(event) => updateDraft("provider", event.target.value as ChatProvider)}>{providerOptions.map((provider) => <option key={provider} value={provider}>{providerDisplayName(provider)}</option>)}</select></label><label className="agent-field"><span>Model</span><input value={draft.model} onChange={(event) => updateDraft("model", event.target.value)} placeholder="Default" /></label></div>}</fieldset>
            <fieldset className="automation-fieldset"><legend>Schedule</legend><div className="automation-segmented">
              {(["once", "interval", "cron"] as const).map((type) => <button key={type} type="button" className={draft.scheduleType === type ? "selected" : ""} onClick={() => updateDraft("scheduleType", type)}>{type === "once" ? "Once" : type === "interval" ? "Interval" : "Cron"}</button>)}
            </div><div className="automation-schedule-fields">
              {draft.scheduleType === "once" && <label className="agent-field"><span>Date and time</span><input type="datetime-local" value={draft.onceAt} onChange={(event) => updateDraft("onceAt", event.target.value)} required /></label>}
              {draft.scheduleType === "interval" && <label className="agent-field"><span>Repeat every (minutes)</span><input type="number" min="1" step="1" value={draft.intervalMinutes} onChange={(event) => updateDraft("intervalMinutes", event.target.value)} required /></label>}
              {draft.scheduleType === "cron" && <label className="agent-field"><span>Cron expression</span><input value={draft.cronExpression} onChange={(event) => updateDraft("cronExpression", event.target.value)} placeholder="0 9 * * 1-5" required /></label>}
              <label className="agent-field"><span>Timezone</span><input value={draft.scheduleType === "once" ? localTimezone() : draft.timezone} onChange={(event) => updateDraft("timezone", event.target.value)} placeholder="America/New_York" disabled={draft.scheduleType === "once"} required /></label>
            </div></fieldset>
            {actionError && <div className="automation-error" role="alert">{actionError}</div>}
            <div className="automation-editor-actions"><span className="automation-editor-hint">Schedules are stored by Maxx and delivered through native notifications or the selected harness.</span><button type="submit" className="agents-primary-button">{editingID ? "Save changes" : "Create automation"}</button></div>
          </form>
        ) : (
          <div className="automations-list-wrap">
            <div className="settings-content-header automations-content-header"><div><h1>Automations</h1><p>Schedule notifications and agent turns across all of your harnesses.</p></div></div>
            {actionError && <div className="automation-error" role="alert">{actionError}</div>}
            {loading && <div className="automation-state" role="status">Loading automations…</div>}
            {!loading && loadError && <div className="automation-state automation-state-error" role="alert"><p>Couldn’t load automations.</p><small>{loadError}</small><button type="button" className="settings-secondary-button" onClick={() => void load()}>Try again</button></div>}
            {!loading && !loadError && automations.length === 0 && <div className="automation-state automation-empty"><Icons.clock size={28} /><h2>No automations yet</h2><p>Create a notification or an agent turn that Maxx can run for you.</p><button type="button" className="agents-primary-button" onClick={openNew}><Icons.plus size={14} /> New automation</button></div>}
            {!loading && !loadError && automations.length > 0 && <div className="automations-list">{automations.map((automation) => <AutomationCard key={automation.id} automation={automation} pending={pendingID === automation.id} onEdit={() => openEdit(automation)} onToggle={() => togglePaused(automation)} onRun={() => runNow(automation)} onDelete={() => remove(automation)} onOpenChat={() => void openAutomationChat(automation)} />)}</div>}
          </div>
        )}
      </div>
    </main>
  );
}

function AutomationCard({ automation, pending, onEdit, onToggle, onRun, onDelete, onOpenChat }: { automation: Automation; pending: boolean; onEdit: () => void; onToggle: () => void; onRun: () => void; onDelete: () => void; onOpenChat: () => void }) {
  const isPaused = automation.status === "paused";
  return <article className="automation-card">
    <div className="automation-card-main"><div className="automation-card-heading"><h2>{automation.title}</h2><span className={`automation-status status-${automation.status}`}><i />{automationStatusLabel(automation.status)}</span></div><p className="automation-prompt">{automation.prompt}</p><div className="automation-meta"><span><Icons.clock size={13} /> {formatAutomationSchedule(automation.schedule)}</span><span>{displayKind(automation.kind)}</span>{automation.kind === "agent_turn" && automation.runtime?.provider && <span>{providerDisplayName(automation.runtime.provider)} · {automation.runtime.model ?? "Default"}</span>}</div><div className="automation-runs"><span><b>Next</b>{formatAutomationTimestamp(automation.nextRunAt)}</span><span><b>Last run</b>{automation.lastRun ? `${automation.lastRun.status} · ${formatAutomationTimestamp(automation.lastRun.finishedAt ?? automation.lastRun.startedAt)}` : "Never"}</span></div></div>
    <div className="automation-card-actions">{automation.kind === "agent_turn" && automation.runtime?.threadID && <button type="button" className="settings-secondary-button" onClick={onOpenChat}>Open chat</button>}<button type="button" className="settings-secondary-button" disabled={pending || automation.status === "running"} onClick={onRun}>{pending ? "Working…" : "Run now"}</button><button type="button" className="settings-secondary-button" disabled={pending || automation.status === "running" || automation.status === "completed"} onClick={onToggle}>{isPaused ? "Resume" : "Pause"}</button><button type="button" className="settings-secondary-button" disabled={pending || automation.status === "running"} onClick={onEdit}>Edit</button><button type="button" className="automation-delete-button" disabled={pending || automation.status === "running"} onClick={onDelete}>Delete</button></div>
  </article>;
}
