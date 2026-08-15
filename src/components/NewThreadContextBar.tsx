import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatProject } from "../contract/types";
import { projectName } from "../contract/types";
import type { GitBranchList, GitEnvironmentMode, GitRepositoryStatus } from "../git";
import { ipc } from "../ipc";
import { Icons } from "./Icons";

export interface NewThreadHostedProject {
  project: ChatProject;
  hostId: string;
  hostName: string;
}

type OpenMenu = "project" | "environment" | "branch" | null;

export function NewThreadContextBar({
  projects,
  remoteHosts,
  selected,
  environment,
  disabled,
  onSelectProject,
  onClearProject,
  onEnvironmentChange,
  onAddLocalProject,
  onAddRemoteProject,
}: {
  projects: NewThreadHostedProject[];
  remoteHosts: { id: string; name: string }[];
  selected?: NewThreadHostedProject;
  environment: GitEnvironmentMode;
  disabled: boolean;
  onSelectProject: (project: NewThreadHostedProject) => void;
  onClearProject: () => void;
  onEnvironmentChange: (environment: GitEnvironmentMode) => void;
  onAddLocalProject: () => void;
  onAddRemoteProject: (host: { id: string; name: string }) => void;
}) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [status, setStatus] = useState<GitRepositoryStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [branchSearch, setBranchSearch] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const newBranchRef = useRef<HTMLInputElement>(null);

  const reloadGit = async () => {
    if (!selected) return;
    const [nextStatus, nextBranches] = await Promise.all([
      ipc.gitStatus(selected.project.id, selected.hostId),
      ipc.gitBranches(selected.project.id, selected.hostId),
    ]);
    setStatus(nextStatus);
    setBranches(nextBranches);
  };

  useEffect(() => {
    let current = true;
    setStatus(null);
    setBranches(null);
    setOpenMenu(null);
    setGitError(null);
    if (!selected) return () => { current = false; };
    Promise.all([
      ipc.gitStatus(selected.project.id, selected.hostId),
      ipc.gitBranches(selected.project.id, selected.hostId),
    ]).then(([nextStatus, nextBranches]) => {
      if (!current) return;
      setStatus(nextStatus);
      setBranches(nextBranches);
    }).catch(() => {
      if (!current) return;
      setStatus(null);
      setBranches(null);
    });
    return () => { current = false; };
  }, [selected?.hostId, selected?.project.id]);

  useEffect(() => {
    if (!openMenu) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (creatingBranch) requestAnimationFrame(() => newBranchRef.current?.focus());
  }, [creatingBranch]);

  const filteredProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter(({ project, hostName }) =>
      `${projectName(project)} ${hostName}`.toLowerCase().includes(query),
    );
  }, [projectSearch, projects]);

  const filteredBranches = useMemo(() => {
    const query = branchSearch.trim().toLowerCase();
    return (branches?.branches ?? []).filter((branch) => branch.toLowerCase().includes(query));
  }, [branchSearch, branches?.branches]);

  const chooseBranch = async (branch: string) => {
    if (!selected) return;
    setGitBusy(true);
    setGitError(null);
    try {
      setBranches(await ipc.gitCheckout(selected.project.id, branch, selected.hostId));
      await reloadGit();
      setOpenMenu(null);
    } catch (reason) {
      setGitError(String(reason));
    } finally {
      setGitBusy(false);
    }
  };

  const createBranch = async () => {
    if (!selected || !newBranch.trim()) return;
    setGitBusy(true);
    setGitError(null);
    try {
      setBranches(await ipc.gitCreateBranch(selected.project.id, newBranch.trim(), selected.hostId));
      setNewBranch("");
      setCreatingBranch(false);
      await reloadGit();
      setOpenMenu(null);
    } catch (reason) {
      setGitError(String(reason));
    } finally {
      setGitBusy(false);
    }
  };

  const remote = selected?.hostId !== undefined && selected.hostId !== "local";
  const locationLabel = environment === "worktree"
    ? remote ? "New remote worktree" : "New worktree"
    : remote ? "Remote" : "Local";
  const currentBranch = branches?.current ?? status?.branch ?? "Branch";

  return (
    <div className="new-agent-context-row" ref={rootRef}>
      <div className="new-agent-context-controls">
        <div className="new-agent-context-control">
          <div className={`new-agent-project-chip${selected ? " has-project" : ""}`}>
            {selected && (
              <button
                type="button"
                className="new-agent-project-clear"
                aria-label={`Remove ${projectName(selected.project)} project`}
                title="Create chat without a project"
                disabled={disabled}
                onClick={onClearProject}
              >
                <Icons.close size={12} />
              </button>
            )}
            <button
              type="button"
              className={`new-agent-context-button${openMenu === "project" ? " is-active" : ""}`}
              aria-label="Choose project"
              aria-expanded={openMenu === "project"}
              disabled={disabled}
              onClick={() => setOpenMenu((current) => current === "project" ? null : "project")}
            >
              <Icons.folder size={15} />
              <span>{selected ? projectName(selected.project) : "Choose project"}</span>
            </button>
          </div>
          {openMenu === "project" && (
            <div className="new-agent-context-menu new-agent-project-menu" role="menu" aria-label="Projects">
              <label className="new-agent-menu-search">
                <Icons.search size={14} />
                <input
                  autoFocus
                  value={projectSearch}
                  placeholder="Search projects"
                  aria-label="Search projects"
                  onChange={(event) => setProjectSearch(event.target.value)}
                />
              </label>
              <div className="new-agent-menu-scroll">
                {filteredProjects.map((item) => {
                  const checked = item.project.id === selected?.project.id && item.hostId === selected.hostId;
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      key={`${item.hostId}:${item.project.id}`}
                      onClick={() => {
                        onSelectProject(item);
                        setProjectSearch("");
                        setOpenMenu(null);
                      }}
                    >
                      <Icons.folder size={15} />
                      <span className="new-agent-menu-label">
                        <b>{projectName(item.project)}</b>
                        {item.hostId !== "local" && <small>{item.hostName}</small>}
                      </span>
                      {checked && <Icons.check size={14} />}
                    </button>
                  );
                })}
                {filteredProjects.length === 0 && <p className="new-agent-menu-empty">No matching projects</p>}
              </div>
              <div className="new-agent-menu-separator" />
              {remoteHosts.map((host) => (
                <button type="button" role="menuitem" key={host.id} onClick={() => onAddRemoteProject(host)}>
                  <Icons.globe size={15} />
                  <span className="new-agent-menu-label"><b>New remote project</b><small>{host.name}</small></span>
                </button>
              ))}
              <button type="button" role="menuitem" onClick={onAddLocalProject}>
                <Icons.plus size={15} />
                <span className="new-agent-menu-label"><b>New project</b></span>
              </button>
            </div>
          )}
        </div>

        {selected && status && (
          <div className="new-agent-context-control">
            <button
              type="button"
              className={`new-agent-context-button${openMenu === "environment" ? " is-active" : ""}`}
              aria-label="Choose where to work"
              aria-expanded={openMenu === "environment"}
              disabled={disabled}
              onClick={() => setOpenMenu((current) => current === "environment" ? null : "environment")}
            >
              {remote ? <Icons.globe size={15} /> : <Icons.computer size={15} />}
              <span>{locationLabel}</span>
            </button>
            {openMenu === "environment" && (
              <div className="new-agent-context-menu new-agent-environment-menu" role="menu" aria-label="Work in">
                <header>Work in</header>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={environment === "current"}
                  onClick={() => { onEnvironmentChange("current"); setOpenMenu(null); }}
                >
                  {remote ? <Icons.globe size={15} /> : <Icons.computer size={15} />}
                  <span className="new-agent-menu-label"><b>{remote ? "Remote" : "Local"}</b></span>
                  {environment === "current" && <Icons.check size={14} />}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={environment === "worktree"}
                  onClick={() => { onEnvironmentChange("worktree"); setOpenMenu(null); }}
                >
                  <Icons.environment size={15} />
                  <span className="new-agent-menu-label"><b>{remote ? "New remote worktree" : "New worktree"}</b></span>
                  {environment === "worktree" && <Icons.check size={14} />}
                </button>
              </div>
            )}
          </div>
        )}

        {selected && branches && (
          <div className="new-agent-context-control">
            <button
              type="button"
              className={`new-agent-context-button${openMenu === "branch" ? " is-active" : ""}`}
              aria-label="Choose branch"
              aria-expanded={openMenu === "branch"}
              disabled={disabled || gitBusy}
              onClick={() => setOpenMenu((current) => current === "branch" ? null : "branch")}
            >
              <Icons.branch size={15} />
              <span>{currentBranch}</span>
            </button>
            {openMenu === "branch" && (
              <div className="new-agent-context-menu new-agent-branch-menu" role="menu" aria-label="Branches">
                <label className="new-agent-menu-search">
                  <Icons.search size={14} />
                  <input
                    autoFocus
                    value={branchSearch}
                    placeholder={`Search ${projectName(selected.project)} branches`}
                    aria-label="Search branches"
                    onChange={(event) => setBranchSearch(event.target.value)}
                  />
                </label>
                <header>Branches</header>
                <div className="new-agent-menu-scroll">
                  {filteredBranches.map((branch) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={branch === branches.current}
                      key={branch}
                      disabled={gitBusy}
                      onClick={() => void chooseBranch(branch)}
                    >
                      <Icons.branch size={15} />
                      <span className="new-agent-menu-label"><b>{branch}</b></span>
                      {branch === branches.current && <Icons.check size={14} />}
                    </button>
                  ))}
                  {filteredBranches.length === 0 && <p className="new-agent-menu-empty">No matching branches</p>}
                </div>
                {gitError && <p className="new-agent-menu-error">{gitError}</p>}
                <div className="new-agent-menu-separator" />
                {creatingBranch ? (
                  <form className="new-agent-create-branch" onSubmit={(event) => { event.preventDefault(); void createBranch(); }}>
                    <input
                      ref={newBranchRef}
                      value={newBranch}
                      placeholder="New branch name"
                      aria-label="New branch name"
                      disabled={gitBusy}
                      onChange={(event) => setNewBranch(event.target.value)}
                    />
                    <button type="submit" disabled={!newBranch.trim() || gitBusy}>Create</button>
                  </form>
                ) : (
                  <button type="button" role="menuitem" onClick={() => setCreatingBranch(true)}>
                    <Icons.plus size={15} />
                    <span className="new-agent-menu-label"><b>Create and checkout new branch…</b></span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {selected && remote && (
        <span className="new-agent-remote-host">
          {selected.hostName}<i aria-label="Connected" />
        </span>
      )}
    </div>
  );
}
