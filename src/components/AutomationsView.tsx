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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

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
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);

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
    setDeleteTarget(automation);
  };

  const confirmRemove = async () => {
    const automation = deleteTarget;
    if (!automation) return;
    void withPending(automation.id, async () => {
      await ipc.deleteAutomation(automation.id);
    });
    setDeleteTarget(null);
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
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b px-4" onMouseDown={beginWindowDrag}>
        {!draft && (
          <Button type="button" className="ml-auto" onClick={openNew}><Icons.plus data-icon="inline-start" /> New automation</Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {draft ? (
          <form className="mx-auto flex max-w-3xl flex-col gap-6" onSubmit={(event) => void submit(event)}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold">{editingID ? "Edit automation" : "New automation"}</h1>
                <p className="text-sm text-muted-foreground">Maxx runs schedules independently of the harness that created them.</p>
              </div>
              <Button type="button" variant="outline" onClick={closeEditor}>Cancel</Button>
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="automation-name">Name</FieldLabel>
                <Input id="automation-name" value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder="Walk the dog" autoFocus />
              </Field>
              <Field>
                <FieldLabel htmlFor="automation-prompt">What should happen?</FieldLabel>
                <Textarea id="automation-prompt" value={draft.prompt} onChange={(event) => updateDraft("prompt", event.target.value)} placeholder={draft.kind === "notification" ? "Walk the dog" : "Summarize new issues in this repository"} rows={3} />
              </Field>
              <FieldSet>
                <FieldLegend variant="label">Action</FieldLegend>
                <ToggleGroup value={[draft.kind]} onValueChange={(value) => { if (value[0]) updateDraft("kind", value[0] as AutomationKind); }}>
                  <ToggleGroupItem value="notification">Notification</ToggleGroupItem>
                  <ToggleGroupItem value="agent_turn">Agent turn</ToggleGroupItem>
                </ToggleGroup>
                {draft.kind === "agent_turn" && (
                  <FieldGroup className="mt-3">
                    <Field>
                      <FieldLabel htmlFor="automation-provider">Harness</FieldLabel>
                      <NativeSelect id="automation-provider" value={draft.provider} onChange={(event) => updateDraft("provider", event.target.value as ChatProvider)}>
                        {providerOptions.map((provider) => <NativeSelectOption key={provider} value={provider}>{providerDisplayName(provider)}</NativeSelectOption>)}
                      </NativeSelect>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="automation-model">Model</FieldLabel>
                      <Input id="automation-model" value={draft.model} onChange={(event) => updateDraft("model", event.target.value)} placeholder="Default" />
                    </Field>
                  </FieldGroup>
                )}
              </FieldSet>
              <FieldSet>
                <FieldLegend variant="label">Schedule</FieldLegend>
                <ToggleGroup value={[draft.scheduleType]} onValueChange={(value) => { if (value[0]) updateDraft("scheduleType", value[0] as ScheduleType); }}>
                  <ToggleGroupItem value="once">Once</ToggleGroupItem>
                  <ToggleGroupItem value="interval">Interval</ToggleGroupItem>
                  <ToggleGroupItem value="cron">Cron</ToggleGroupItem>
                </ToggleGroup>
                <FieldGroup className="mt-3">
                  {draft.scheduleType === "once" && <Field><FieldLabel htmlFor="automation-once">Date and time</FieldLabel><Input id="automation-once" type="datetime-local" value={draft.onceAt} onChange={(event) => updateDraft("onceAt", event.target.value)} required /></Field>}
                  {draft.scheduleType === "interval" && <Field><FieldLabel htmlFor="automation-interval">Repeat every (minutes)</FieldLabel><Input id="automation-interval" type="number" min="1" step="1" value={draft.intervalMinutes} onChange={(event) => updateDraft("intervalMinutes", event.target.value)} required /></Field>}
                  {draft.scheduleType === "cron" && <Field><FieldLabel htmlFor="automation-cron">Cron expression</FieldLabel><Input id="automation-cron" value={draft.cronExpression} onChange={(event) => updateDraft("cronExpression", event.target.value)} placeholder="0 9 * * 1-5" required /></Field>}
                  <Field>
                    <FieldLabel htmlFor="automation-timezone">Timezone</FieldLabel>
                    <Input id="automation-timezone" value={draft.scheduleType === "once" ? localTimezone() : draft.timezone} onChange={(event) => updateDraft("timezone", event.target.value)} placeholder="America/New_York" disabled={draft.scheduleType === "once"} required />
                  </Field>
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
            {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <FieldDescription>Schedules are stored by Maxx and delivered through native notifications or the selected harness.</FieldDescription>
              <Button type="submit">{editingID ? "Save changes" : "Create automation"}</Button>
            </div>
          </form>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-6">
            <div><h1 className="text-xl font-semibold">Automations</h1><p className="text-sm text-muted-foreground">Schedule notifications and agent turns across all of your harnesses.</p></div>
            {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
            {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner /> Loading automations…</div>}
            {!loading && loadError && <Alert variant="destructive"><AlertTitle>Couldn’t load automations.</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-3"><small>{loadError}</small><Button type="button" variant="outline" size="sm" onClick={() => void load()}>Try again</Button></AlertDescription></Alert>}
            {!loading && !loadError && automations.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><Icons.clock /></EmptyMedia><EmptyTitle>No automations yet</EmptyTitle><EmptyDescription>Create a notification or an agent turn that Maxx can run for you.</EmptyDescription></EmptyHeader><EmptyContent><Button type="button" onClick={openNew}><Icons.plus data-icon="inline-start" /> New automation</Button></EmptyContent></Empty>}
            {!loading && !loadError && automations.length > 0 && <div className="flex flex-col gap-3">{automations.map((automation) => <AutomationCard key={automation.id} automation={automation} pending={pendingID === automation.id} onEdit={() => openEdit(automation)} onToggle={() => togglePaused(automation)} onRun={() => runNow(automation)} onDelete={() => remove(automation)} onOpenChat={() => void openAutomationChat(automation)} />)}</div>}
          </div>
        )}
      </div>
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && pendingID === null) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete automation?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.title ?? "This automation"}” will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingID !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pendingID !== null}
              onClick={() => void confirmRemove()}
            >
              Delete automation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function AutomationCard({ automation, pending, onEdit, onToggle, onRun, onDelete, onOpenChat }: { automation: Automation; pending: boolean; onEdit: () => void; onToggle: () => void; onRun: () => void; onDelete: () => void; onOpenChat: () => void }) {
  const isPaused = automation.status === "paused";
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle className="flex flex-wrap items-center gap-2"><span className="truncate">{automation.title}</span><Badge variant={automation.status === "needs_attention" ? "destructive" : automation.status === "active" ? "default" : "secondary"}>{automationStatusLabel(automation.status)}</Badge></CardTitle>
          <CardDescription className="mt-2">{automation.prompt}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5"><Icons.clock /> {formatAutomationSchedule(automation.schedule)}</span>
          <span>{displayKind(automation.kind)}</span>
          {automation.kind === "agent_turn" && automation.runtime?.provider && <span>{providerDisplayName(automation.runtime.provider)} · {automation.runtime.model ?? "Default"}</span>}
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <span className="flex flex-col gap-0.5"><b>Next</b><span className="text-muted-foreground">{formatAutomationTimestamp(automation.nextRunAt)}</span></span>
          <span className="flex flex-col gap-0.5"><b>Last run</b><span className="text-muted-foreground">{automation.lastRun ? `${automation.lastRun.status} · ${formatAutomationTimestamp(automation.lastRun.finishedAt ?? automation.lastRun.startedAt)}` : "Never"}</span></span>
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap justify-end gap-2">
        {automation.kind === "agent_turn" && automation.runtime?.threadID && <Button type="button" variant="outline" size="sm" onClick={onOpenChat}>Open chat</Button>}
        <Button type="button" variant="outline" size="sm" disabled={pending || automation.status === "running"} onClick={onRun}>{pending ? "Working…" : "Run now"}</Button>
        <Button type="button" variant="outline" size="sm" disabled={pending || automation.status === "running" || automation.status === "completed"} onClick={onToggle}>{isPaused ? "Resume" : "Pause"}</Button>
        <Button type="button" variant="outline" size="sm" disabled={pending || automation.status === "running"} onClick={onEdit}>Edit</Button>
        <Button type="button" variant="destructive" size="sm" disabled={pending || automation.status === "running"} onClick={onDelete}>Delete</Button>
      </CardFooter>
    </Card>
  );
}
