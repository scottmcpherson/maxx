import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Dispatch, SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { AgentDefinition, providerDisplayName } from "../contract/types";
import { ipc } from "../ipc";
import { useAppStore } from "../store/appStore";
import { beginWindowDrag } from "../windowDrag";
import { AGENT_COLORS, AgentAvatar } from "./AgentAvatar";
import { Icons } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";
import { RuntimePicker } from "./RuntimePicker";

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
 * Main-area agents section: a directory-style grid of agent cards, with a
 * detail editor when a card (or the ghost "new agent" card) is opened.
 */
export function AgentsView() {
  const workspace = useAppStore((state) => state.workspace);
  const saveAgents = useAppStore((state) => state.saveAgents);
  const setAgentsOpen = useAppStore((state) => state.setAgentsOpen);
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);
  const agents = useMemo(() => workspace?.agents ?? [], [workspace]);

  // null selectedID = grid; otherwise the detail editor for that agent.
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
      if (selectedID || isNew) backToGrid();
      else setAgentsOpen(false);
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
    if (isNew) {
      // Return to the grid so the new card is the visible result.
      backToGrid();
    } else {
      setDraft(cleaned);
    }
  };

  const remove = async () => {
    if (!draft) return;
    if (!isNew) {
      await saveAgents(agents.filter((agent) => agent.id !== draft.id));
    }
    backToGrid();
  };

  const shuffleColor = () => {
    if (!draft) return;
    const currentIndex = AGENT_COLORS.indexOf(draft.colorHex);
    setDraft({ ...draft, colorHex: AGENT_COLORS[(currentIndex + 1) % AGENT_COLORS.length] });
  };

  // Copies the picked file into the backend's agent-images store; the stored
  // path only persists with the agent on save (orphans are pruned then).
  const pickImage = async () => {
    if (!draft) return;
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (typeof picked !== "string") return;
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
    <main className="agents-view">
      {/* Same job as settings-titlebar: window drag + traffic-light clearance.
          Page identity lives in the content header (Settings pattern), so the
          grid does not repeat “Agents” up here. Detail mode keeps a Back control. */}
      <header
        className={`agents-header ${sidebarOpen ? "" : "sidebar-closed"}`}
        onMouseDown={beginWindowDrag}
      >
        {inDetail ? (
          <button type="button" className="agents-back" onClick={backToGrid}>
            <Icons.chevronRight size={13} className="back-chevron" />
            Agents
          </button>
        ) : null}
      </header>

      <div className="agents-content">
        {inDetail && draft ? (
          <AgentEditor
            draft={draft}
            setDraft={setDraft}
            isNew={isNew}
            canSave={canSave}
            onSave={() => void save()}
            onRemove={() => void remove()}
            onShuffleColor={shuffleColor}
            onPickImage={() => void pickImage()}
            onClearImage={clearImage}
          />
        ) : (
          <div className="agents-content-inner">
            <header className="settings-content-header agents-content-header">
              <div>
                <h1>Agents</h1>
                <p>
                  Preconfigured personas with pinned instructions and a runtime. Mention one in
                  a thread — “@Charlie please review this” — and it replies in a side thread.
                </p>
              </div>
            </header>
            <div className="agents-grid">
              {agents.map((agent) => {
                const threads = threadCounts.get(agent.id) ?? 0;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className="agent-card"
                    onClick={() => {
                      setIsNew(false);
                      setSelectedID(agent.id);
                    }}
                  >
                    <AgentAvatar
                      name={agent.name}
                      colorHex={agent.colorHex}
                      emoji={agent.emoji}
                      imagePath={agent.imagePath}
                      size={56}
                    />
                    <span className="agent-card-name">{agent.name}</span>
                    <span className="agent-card-runtime">
                      <ProviderIcon provider={agent.provider} size={12} />
                      {providerDisplayName(agent.provider)}
                      {agent.model && agent.model.toLowerCase() !== "default"
                        ? ` · ${agent.model}`
                        : ""}
                    </span>
                    {agent.instructions.trim() && (
                      <p className="agent-card-instructions">{agent.instructions.trim()}</p>
                    )}
                    <span className="agent-card-stat">
                      {threads === 0
                        ? "Not used yet"
                        : threads === 1
                          ? "1 thread"
                          : `${threads} threads`}
                    </span>
                  </button>
                );
              })}
              <button type="button" className="agent-card agent-card-ghost" onClick={startNew}>
                <span className="agent-card-ghost-plus">
                  <Icons.plus size={19} />
                </span>
                <span className="agent-card-name">New agent</span>
                <span className="agent-card-instructions">
                  {agents.length === 0
                    ? "Create your first agent persona."
                    : "Add another persona."}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
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
  onShuffleColor,
  onPickImage,
  onClearImage,
}: {
  draft: AgentDefinition;
  setDraft: Dispatch<SetStateAction<AgentDefinition | null>>;
  isNew: boolean;
  canSave: boolean;
  onSave: () => void;
  onRemove: () => void;
  onShuffleColor: () => void;
  onPickImage: () => void;
  onClearImage: () => void;
}) {
  const workspace = useAppStore((state) => state.workspace);
  return (
    <section className="agent-editor" aria-label="Agent editor">
      <div className="agent-editor-identity">
        <div className="agent-editor-avatar">
          <button
            type="button"
            className="agent-avatar-pick"
            title="Choose image"
            aria-label="Choose agent image"
            onClick={onPickImage}
          >
            <AgentAvatar
              name={draft.name || "?"}
              colorHex={draft.colorHex}
              emoji={draft.emoji}
              imagePath={draft.imagePath}
              size={64}
            />
          </button>
          {draft.imagePath ? (
            <button
              type="button"
              className="agent-avatar-shuffle"
              title="Remove image"
              aria-label="Remove agent image"
              onClick={onClearImage}
            >
              <Icons.close size={11} />
            </button>
          ) : (
            <button
              type="button"
              className="agent-avatar-shuffle"
              title="Shuffle avatar color"
              aria-label="Shuffle avatar color"
              onClick={onShuffleColor}
            >
              <Icons.shuffle size={12} />
            </button>
          )}
        </div>
        <div className="agent-editor-identity-fields">
          <label className="agent-field">
            <span>Name</span>
            <input
              // Remount per draft so autoFocus fires for each new agent.
              key={draft.id}
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
          </label>
        </div>
      </div>

      <label className="agent-field">
        <span>Instructions</span>
        <textarea
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
        <p className="agent-field-hint">
          Added to the system prompt whenever this agent handles a turn.
        </p>
      </label>

      <div className="agent-field">
        <span>Runtime</span>
        <div className="runtime-picker-field">
          <RuntimePicker
            provider={draft.provider}
            model={draft.model}
            effort={draft.effort}
            speed={draft.speed}
            profiles={workspace?.providerProfiles ?? []}
            workingDirectory={workspace?.projects[0]?.folderPath}
            placement="bottom"
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
        </div>
      </div>

      <div className="agent-editor-actions">
        <button type="button" className="agents-danger-button" onClick={onRemove}>
          {isNew ? "Discard" : "Delete agent"}
        </button>
        <button
          type="button"
          className="agents-primary-button"
          disabled={!canSave}
          onClick={onSave}
        >
          {isNew ? "Create agent" : "Save changes"}
        </button>
      </div>
    </section>
  );
}
