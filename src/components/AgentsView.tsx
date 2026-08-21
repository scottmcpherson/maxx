import { Dispatch, SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { AgentDefinition, providerDisplayName } from "../contract/types";
import { ipc } from "../ipc";
import { useAppStore } from "../store/appStore";
import { beginWindowDrag } from "../windowDrag";
import { AGENT_COLORS, AgentAvatar } from "./AgentAvatar";
import { Icons } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";
import { RuntimePicker } from "./RuntimePicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

/** Seconds since 2001-01-01, the workspace document's date encoding. */
const appleNow = () => Date.now() / 1000 - 978_307_200;

function newAgentDraft(): AgentDefinition {
  const now = appleNow();
  return {
    id: crypto.randomUUID(),
    name: "",
    instructions: "",
    provider: "claude",
    model: "Default",
    effort: null,
    speed: null,
    colorHex: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)],
    emoji: null,
    imagePath: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Main-area agents section: a directory-style grid of agent cards with a
 * shared modal editor for creating and updating agents.
 */
export function AgentsView() {
  const workspace = useAppStore((state) => state.workspace);
  const saveAgents = useAppStore((state) => state.saveAgents);
  const setAgentsOpen = useAppStore((state) => state.setAgentsOpen);
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);
  const agents = useMemo(() => workspace?.agents ?? [], [workspace]);

  // A selected ID opens the shared create/edit dialog over the grid.
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDefinition | null>(null);
  const [isNew, setIsNew] = useState(false);

  // Threads each agent has participated in (as current or past responder).
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of workspace?.projects ?? []) {
      for (const thread of project.threads) {
        const participants = new Set<string>();
        if (thread.agentID) participants.add(thread.agentID);
        for (const message of thread.messages) {
          if (message.agentID) participants.add(message.agentID);
        }
        for (const id of participants) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [workspace]);

  // Load the draft when a card is opened. Reads agents through a ref so
  // background workspace refreshes (streaming turns) never clobber edits.
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  useEffect(() => {
    if (isNew) return;
    if (!selectedID) {
      setDraft(null);
      return;
    }
    const selected = agentsRef.current.find((agent) => agent.id === selectedID);
    if (selected) setDraft({ ...selected });
    else setSelectedID(null);
  }, [isNew, selectedID]);

  const backToGrid = () => {
    setIsNew(false);
    setSelectedID(null);
    setDraft(null);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      // Let inputs keep Escape for their own blur/cancel behaviour.
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (!selectedID && !isNew) setAgentsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isNew, selectedID, setAgentsOpen]);

  const startNew = () => {
    const fresh = newAgentDraft();
    setIsNew(true);
    setSelectedID(fresh.id);
    setDraft(fresh);
  };

  // Fields that constitute a real edit (timestamps excluded).
  const comparable = (agent: AgentDefinition) =>
    JSON.stringify([
      agent.name.trim(),
      agent.instructions,
      agent.provider,
      agent.model,
      agent.effort ?? null,
      agent.speed ?? null,
      agent.colorHex,
      agent.emoji?.trim() || null,
      agent.imagePath ?? null,
    ]);
  const savedAgent = agents.find((agent) => agent.id === draft?.id);
  const dirty =
    !!draft && (isNew || !savedAgent || comparable(draft) !== comparable(savedAgent));
  const canSave = !!draft && draft.name.trim().length > 0 && dirty;

  const save = async () => {
    if (!draft || !canSave) return;
    const cleaned: AgentDefinition = {
      ...draft,
      name: draft.name.trim(),
      emoji: draft.emoji?.trim() || null,
      updatedAt: appleNow(),
    };
    const next = isNew
      ? [...agents, cleaned]
      : agents.map((agent) => (agent.id === cleaned.id ? cleaned : agent));
    await saveAgents(next);
    backToGrid();
  };

  const remove = async () => {
    if (!draft) return;
    if (!isNew) {
      await saveAgents(agents.filter((agent) => agent.id !== draft.id));
    }
    backToGrid();
  };

  // Copies the picked file into the backend's agent-images store; the stored
  // path only persists with the agent on save (orphans are pruned then).
  const pickImage = async () => {
    if (!draft) return;
    const picked = await ipc.openAgentImageDialog();
    if (!picked) return;
    try {
      const stored = await ipc.importAgentImage(draft.id, picked);
      setDraft((current) => (current ? { ...current, imagePath: stored } : current));
    } catch (error) {
      console.error("agent image import failed", error);
    }
  };

  const clearImage = () => {
    setDraft((current) => (current ? { ...current, imagePath: null } : current));
  };

  const inDetail = !!draft && (isNew || !!selectedID);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {/* Same job as settings-titlebar: window drag + traffic-light clearance.
          Page identity lives in the content header (Settings pattern). */}
      <header
        className="flex h-12 shrink-0 items-center border-b px-4"
        onMouseDown={beginWindowDrag}
      >
        {!sidebarOpen && <span className="w-8" aria-hidden="true" />}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <header>
            <div>
              <h1 className="text-xl font-semibold">Agents</h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Preconfigured personas with pinned instructions and a harness/model. Mention one in
                a thread — “@Charlie please review this” — and it replies in a side thread.
              </p>
            </div>
          </header>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => {
              const threads = threadCounts.get(agent.id) ?? 0;
              return (
                <Button
                  key={agent.id}
                  type="button"
                  variant="card"
                  className="h-56 min-w-0 flex-col items-stretch justify-start gap-4 overflow-hidden whitespace-normal p-5 text-left"
                  onClick={() => {
                    setIsNew(false);
                    setSelectedID(agent.id);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <AgentAvatar
                      name={agent.name}
                      colorHex={agent.colorHex}
                      emoji={agent.emoji}
                      imagePath={agent.imagePath}
                      size={48}
                    />
                    <span className="min-w-0 flex-1 truncate text-base font-medium">
                      {agent.name}
                    </span>
                  </span>
                  <span className="line-clamp-3 min-w-0 break-words text-sm leading-relaxed text-muted-foreground">
                    {agent.instructions.trim() || "No instructions added."}
                  </span>
                  <span className="mt-auto flex w-full min-w-0 items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <ProviderIcon provider={agent.provider} size={12} />
                      <span className="truncate">
                        {providerDisplayName(agent.provider)}
                        {agent.model && agent.model.toLowerCase() !== "default"
                          ? ` · ${agent.model}`
                          : ""}
                      </span>
                    </span>
                    <span className="shrink-0">
                      {threads === 0
                        ? "Not used yet"
                        : threads === 1
                          ? "1 thread"
                          : `${threads} threads`}
                    </span>
                  </span>
                </Button>
              );
            })}
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-56 flex-col items-center justify-center gap-3 border-dashed p-5"
              onClick={startNew}
            >
              <span className="flex size-10 items-center justify-center rounded-full bg-muted">
                <Icons.plus />
              </span>
              <span className="text-base font-medium">New agent</span>
              <span className="text-center text-sm text-muted-foreground">
                {agents.length === 0
                  ? "Create your first agent persona."
                  : "Add another persona."}
              </span>
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={inDetail}
        onOpenChange={(open) => {
          if (!open) backToGrid();
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-2xl"
          aria-label="Agent editor"
        >
          {draft && (
            <AgentEditor
              draft={draft}
              setDraft={setDraft}
              isNew={isNew}
              canSave={canSave}
              onSave={() => void save()}
              onRemove={() => void remove()}
              onPickImage={() => void pickImage()}
              onClearImage={clearImage}
            />
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}

function AgentEditor({
  draft,
  setDraft,
  isNew,
  canSave,
  onSave,
  onRemove,
  onPickImage,
  onClearImage,
}: {
  draft: AgentDefinition;
  setDraft: Dispatch<SetStateAction<AgentDefinition | null>>;
  isNew: boolean;
  canSave: boolean;
  onSave: () => void;
  onRemove: () => void;
  onPickImage: () => void;
  onClearImage: () => void;
}) {
  const workspace = useAppStore((state) => state.workspace);
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false);
  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <DialogHeader className="shrink-0 pr-8">
        <DialogTitle>{isNew ? "Create agent" : "Edit agent"}</DialogTitle>
        <DialogDescription>Configure this agent's persona and harness/model.</DialogDescription>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto md:grid-cols-[9rem_minmax(0,1fr)]">
        <div className="flex justify-center md:sticky md:top-0 md:items-start">
          <div className="relative w-fit">
            <AgentAvatar
              name={draft.name || "?"}
              colorHex={draft.colorHex}
              emoji={draft.emoji}
              imagePath={draft.imagePath}
              size={112}
            />
            <Popover open={avatarEditorOpen} onOpenChange={setAvatarEditorOpen}>
              <PopoverTrigger
                render={(
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute right-0 bottom-0 rounded-full"
                    title="Edit avatar"
                    aria-label="Edit agent avatar"
                  />
                )}
              >
                <Icons.pencil />
              </PopoverTrigger>
              <PopoverContent side="right" align="center" className="w-64">
                <PopoverHeader>
                  <PopoverTitle>Edit avatar</PopoverTitle>
                  <PopoverDescription>Choose a color or use a custom image.</PopoverDescription>
                </PopoverHeader>
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Color</span>
                  <div className="grid grid-cols-5 gap-1">
                    {AGENT_COLORS.map((color) => {
                      const selected = !draft.imagePath && draft.colorHex === color;
                      return (
                        <Button
                          key={color}
                          type="button"
                          variant={selected ? "secondary" : "ghost"}
                          size="icon-sm"
                          className="rounded-full"
                          aria-label={`Use avatar color ${color}`}
                          aria-pressed={selected}
                          onClick={() => {
                            setDraft((current) => current
                              ? { ...current, colorHex: color, imagePath: null }
                              : current);
                          }}
                        >
                          <span
                            className="size-5 rounded-full"
                            style={{ backgroundColor: color }}
                            aria-hidden="true"
                          />
                        </Button>
                      );
                    })}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setAvatarEditorOpen(false);
                      onPickImage();
                    }}
                  >
                    Choose image…
                  </Button>
                  {draft.imagePath && (
                    <Button
                      type="button"
                      variant="destructive"
                      className="w-full"
                      onClick={() => {
                        onClearImage();
                        setAvatarEditorOpen(false);
                      }}
                    >
                      Remove image
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="agent-name">Name</FieldLabel>
            <Input
              // Remount per draft so autoFocus fires for each new agent.
              key={draft.id}
              id="agent-name"
              value={draft.name}
              placeholder="Charlie"
              aria-label="Agent name"
              autoFocus={isNew}
              onChange={(event) =>
                setDraft((current) => current
                  ? { ...current, name: event.target.value }
                  : current)
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-instructions">Instructions</FieldLabel>
            <Textarea
              id="agent-instructions"
              className="min-h-36"
              value={draft.instructions}
              rows={7}
              placeholder="You are Charlie, a meticulous code reviewer. Focus on correctness and name concrete risks."
              aria-label="Agent instructions"
              onChange={(event) =>
                setDraft((current) => current
                  ? { ...current, instructions: event.target.value }
                  : current)
              }
            />
            <FieldDescription>
              Added to the system prompt whenever this agent handles a turn.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Harness/Model</FieldLabel>
            <RuntimePicker
              provider={draft.provider}
              model={draft.model}
              effort={draft.effort}
              speed={draft.speed}
              profiles={workspace?.providerProfiles ?? []}
              placement="top"
              triggerShowsProvider
              onChange={(next) =>
                setDraft((current) => current
                  ? {
                      ...current,
                      provider: next.provider,
                      model: next.model,
                      effort: next.effort ?? null,
                      speed: next.speed ?? null,
                    }
                  : current)
              }
            />
          </Field>
        </FieldGroup>
      </div>
      <DialogFooter className="shrink-0 flex-row items-center justify-between gap-3">
        <Button type="button" variant="destructive" onClick={onRemove}>
          {isNew ? "Discard" : "Delete agent"}
        </Button>
        <Button type="submit" disabled={!canSave}>
          {isNew ? "Create agent" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
