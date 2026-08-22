import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatProject } from "../contract/types";
import { projectName } from "../contract/types";
import type { GitBranchList, GitEnvironmentMode, GitRepositoryStatus } from "../git";
import { ipc } from "../ipc";
import { Icons } from "./Icons";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

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
    <div className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-1" ref={rootRef}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div
          className={cn(
            "group relative flex items-center rounded-lg",
            selected && "hover:bg-muted focus-within:bg-muted",
          )}
        >
          <Popover open={openMenu === "project"} onOpenChange={(open) => setOpenMenu(open ? "project" : null)}>
            {selected && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="peer invisible absolute start-1 top-1/2 z-10 -translate-y-1/2 scale-80 rounded-full text-muted-foreground opacity-0 transition-[color,background-color,opacity,transform] hover:bg-foreground/25! hover:text-foreground group-hover:visible group-hover:scale-100 group-hover:opacity-100 focus-visible:visible focus-visible:scale-100 focus-visible:opacity-100"
                aria-label={`Remove ${projectName(selected.project)} project`}
                title="Create chat without a project"
                disabled={disabled}
                onClick={onClearProject}
              >
                <Icons.close />
              </Button>
            )}
            <PopoverTrigger
              render={(
                <Button
                  variant="ghost"
                  className={cn(selected && "group-hover:bg-transparent peer-focus-visible:[&_svg]:opacity-0 aria-expanded:bg-transparent")}
                  aria-label="Choose project"
                  disabled={disabled}
                />
              )}
            >
              <Icons.folder
                data-icon="inline-start"
                className={cn(selected && "transition-opacity group-hover:opacity-0")}
              />
              <span className="max-w-56 truncate">{selected ? projectName(selected.project) : "Choose project"}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-2" role="menu" aria-label="Projects">
              <Field>
                <FieldLabel htmlFor="project-search" className="sr-only">Search projects</FieldLabel>
                <Input
                  id="project-search"
                  autoFocus
                  value={projectSearch}
                  placeholder="Search projects"
                  aria-label="Search projects"
                  onChange={(event) => setProjectSearch(event.target.value)}
                />
              </Field>
              <div className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
                {filteredProjects.map((item) => {
                  const checked = item.project.id === selected?.project.id && item.hostId === selected.hostId;
                  return (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
                      role="menuitemradio"
                      aria-checked={checked}
                      key={`${item.hostId}:${item.project.id}`}
                      onClick={() => {
                        onSelectProject(item);
                        setProjectSearch("");
                        setOpenMenu(null);
                      }}
                    >
                      <Icons.folder data-icon="inline-start" />
                      <span className="flex min-w-0 flex-1 flex-col text-left">
                        <b className="truncate">{projectName(item.project)}</b>
                        {item.hostId !== "local" && <small className="truncate text-muted-foreground">{item.hostName}</small>}
                      </span>
                      {checked && <Icons.check aria-hidden="true" />}
                    </Button>
                  );
                })}
                {filteredProjects.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No matching projects</p>}
              </div>
              <Separator className="my-2" />
              {remoteHosts.map((host) => (
                <Button type="button" variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left" role="menuitem" key={host.id} onClick={() => { onAddRemoteProject(host); setOpenMenu(null); }}>
                  <Icons.globe data-icon="inline-start" />
                  <span className="flex flex-col text-left"><b>New remote project</b><small className="text-muted-foreground">{host.name}</small></span>
                </Button>
              ))}
              <Button type="button" variant="ghost" className="w-full justify-start gap-2 px-2" role="menuitem" onClick={() => { onAddLocalProject(); setOpenMenu(null); }}>
                <Icons.plus data-icon="inline-start" />
                <span><b>New project</b></span>
              </Button>
            </PopoverContent>
          </Popover>
        </div>

        {selected && status && (
          <Popover open={openMenu === "environment"} onOpenChange={(open) => setOpenMenu(open ? "environment" : null)}>
            <PopoverTrigger
              render={<Button variant="ghost" aria-label="Choose where to work" disabled={disabled} />}
            >
              {remote ? <Icons.globe data-icon="inline-start" /> : <Icons.computer data-icon="inline-start" />}
              <span>{locationLabel}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-2" role="menu" aria-label="Work in">
              <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Work in</p>
              <div className="flex flex-col gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start gap-2 px-2"
                  role="menuitemradio"
                  aria-checked={environment === "current"}
                  onClick={() => { onEnvironmentChange("current"); setOpenMenu(null); }}
                >
                  {remote ? <Icons.globe data-icon="inline-start" /> : <Icons.computer data-icon="inline-start" />}
                  <span className="flex-1 text-left"><b>{remote ? "Remote" : "Local"}</b></span>
                  {environment === "current" && <Icons.check aria-hidden="true" />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start gap-2 px-2"
                  role="menuitemradio"
                  aria-checked={environment === "worktree"}
                  onClick={() => { onEnvironmentChange("worktree"); setOpenMenu(null); }}
                >
                  <Icons.environment data-icon="inline-start" />
                  <span className="flex-1 text-left"><b>{remote ? "New remote worktree" : "New worktree"}</b></span>
                  {environment === "worktree" && <Icons.check aria-hidden="true" />}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}

        {selected && branches && (
          <Popover open={openMenu === "branch"} onOpenChange={(open) => setOpenMenu(open ? "branch" : null)}>
            <PopoverTrigger
              render={<Button variant="ghost" aria-label="Choose branch" disabled={disabled || gitBusy} />}
            >
              <Icons.branch data-icon="inline-start" />
              <span className="max-w-56 truncate">{currentBranch}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-2" role="menu" aria-label="Branches">
              <Field>
                <FieldLabel htmlFor="branch-search" className="sr-only">Search branches</FieldLabel>
                <Input
                  id="branch-search"
                  autoFocus
                  value={branchSearch}
                  placeholder={`Search ${projectName(selected.project)} branches`}
                  aria-label="Search branches"
                  onChange={(event) => setBranchSearch(event.target.value)}
                />
              </Field>
              <p className="mt-2 px-2 py-1 text-xs font-medium text-muted-foreground">Branches</p>
              <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {filteredBranches.map((branch) => (
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full justify-start gap-2 px-2"
                      role="menuitemradio"
                      aria-checked={branch === branches.current}
                      key={branch}
                      disabled={gitBusy}
                      onClick={() => void chooseBranch(branch)}
                    >
                      <Icons.branch data-icon="inline-start" />
                      <span className="flex-1 truncate text-left"><b>{branch}</b></span>
                      {branch === branches.current && <Icons.check aria-hidden="true" />}
                    </Button>
                  ))}
                  {filteredBranches.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No matching branches</p>}
              </div>
              {gitError && <p className="px-2 py-2 text-sm text-destructive" role="alert">{gitError}</p>}
              <Separator className="my-2" />
                {creatingBranch ? (
                  <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void createBranch(); }}>
                    <Input
                      ref={newBranchRef}
                      value={newBranch}
                      placeholder="New branch name"
                      aria-label="New branch name"
                      disabled={gitBusy}
                      onChange={(event) => setNewBranch(event.target.value)}
                    />
                    <Button type="submit" size="sm" disabled={!newBranch.trim() || gitBusy}>Create</Button>
                  </form>
                ) : (
                  <Button type="button" variant="ghost" className="w-full justify-start gap-2 px-2" role="menuitem" onClick={() => setCreatingBranch(true)}>
                    <Icons.plus data-icon="inline-start" />
                    <span><b>Create and checkout new branch…</b></span>
                  </Button>
                )}
            </PopoverContent>
          </Popover>
        )}
      </div>
      {selected && remote && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {selected.hostName}<span className="text-primary" aria-label="Connected">●</span>
        </span>
      )}
    </div>
  );
}
