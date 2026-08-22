export interface GitChangedFile {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitRepositoryStatus {
  repositoryRoot: string;
  branch: string;
  detached: boolean;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  additions: number;
  deletions: number;
  files: GitChangedFile[];
  remotes: string[];
}

export interface GitBranchList {
  current: string | null;
  branches: string[];
}

export interface GitCommitResult {
  status: GitRepositoryStatus;
  message: string;
}

export type GitEnvironmentMode = "current" | "worktree";

export function threadWorkingDirectory(
  projectFolder: string,
  thread: { workingDirectory?: string | null },
): string {
  return thread.workingDirectory || projectFolder;
}

export type GitPrimaryAction = "commit" | "push" | "none";

export function gitCanPush(status: GitRepositoryStatus): boolean {
  return !status.detached
    && status.head.length > 0
    && (status.upstream !== null || status.remotes.includes("origin") || status.remotes.length === 1);
}

export function gitHasStagedChanges(status: GitRepositoryStatus): boolean {
  return status.files.some((file) => file.staged);
}

export function shouldRefreshGitAfterTurn(
  previousTurnID: string | undefined,
  currentTurnID: string | undefined,
): boolean {
  return Boolean(previousTurnID && previousTurnID !== currentTurnID);
}

export function gitPrimaryAction(status: GitRepositoryStatus): GitPrimaryAction {
  if (status.files.length > 0) return "commit";
  if (gitCanPush(status) && (status.ahead > 0 || status.upstream === null)) return "push";
  return "none";
}

export function gitFileStatusLabel(file: GitChangedFile): string {
  if (file.untracked) return "Untracked";
  if (file.status.includes("U") || file.status === "AA" || file.status === "DD") return "Conflict";
  if (file.status.includes("R")) return "Renamed";
  if (file.status.includes("D")) return "Deleted";
  if (file.status.includes("A")) return "Added";
  return file.staged && file.unstaged ? "Staged + modified" : file.staged ? "Staged" : "Modified";
}
