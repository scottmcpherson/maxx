import { describe, expect, it } from "vitest";
import {
  gitCanPush,
  gitFileStatusLabel,
  gitHasStagedChanges,
  gitPrimaryAction,
  shouldRefreshGitAfterTurn,
  threadWorkingDirectory,
  type GitRepositoryStatus,
} from "./git";

function status(overrides: Partial<GitRepositoryStatus> = {}): GitRepositoryStatus {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "main",
    detached: false,
    head: "1234567",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    additions: 0,
    deletions: 0,
    files: [],
    remotes: ["origin"],
    ...overrides,
  };
}

describe("gitPrimaryAction", () => {
  it("prioritizes committing working tree changes", () => {
    expect(gitPrimaryAction(status({
      ahead: 2,
      files: [{ path: "src/app.ts", status: " M", staged: false, unstaged: true, untracked: false }],
    }))).toBe("commit");
  });

  it("offers push for commits ahead of the upstream or a branch without one", () => {
    expect(gitPrimaryAction(status({ ahead: 1 }))).toBe("push");
    expect(gitPrimaryAction(status({ upstream: null }))).toBe("push");
  });

  it("does not offer push for a detached head or an up-to-date branch", () => {
    expect(gitPrimaryAction(status({ ahead: 3, detached: true }))).toBe("none");
    expect(gitPrimaryAction(status())).toBe("none");
  });
});

describe("gitFileStatusLabel", () => {
  it("turns porcelain state into readable file labels", () => {
    expect(gitFileStatusLabel({ path: "new", status: "??", staged: false, unstaged: false, untracked: true })).toBe("Untracked");
    expect(gitFileStatusLabel({ path: "both", status: "MM", staged: true, unstaged: true, untracked: false })).toBe("Staged + modified");
    expect(gitFileStatusLabel({ path: "gone", status: " D", staged: false, unstaged: true, untracked: false })).toBe("Deleted");
  });
});

describe("gitCanPush", () => {
  it("requires a branch, a commit, and an unambiguous destination", () => {
    expect(gitCanPush(status())).toBe(true);
    expect(gitCanPush(status({ detached: true }))).toBe(false);
    expect(gitCanPush(status({ head: "" }))).toBe(false);
    expect(gitCanPush(status({ upstream: null, remotes: [] }))).toBe(false);
    expect(gitCanPush(status({ upstream: null, remotes: ["fork", "company"] }))).toBe(false);
    expect(gitCanPush(status({ upstream: null, remotes: ["fork"] }))).toBe(true);
  });
});

describe("gitHasStagedChanges", () => {
  it("distinguishes staged files from unstaged and untracked files", () => {
    expect(gitHasStagedChanges(status({
      files: [{ path: "staged", status: "M ", staged: true, unstaged: false, untracked: false }],
    }))).toBe(true);
    expect(gitHasStagedChanges(status({
      files: [{ path: "new", status: "??", staged: false, unstaged: false, untracked: true }],
    }))).toBe(false);
  });
});

describe("shouldRefreshGitAfterTurn", () => {
  it("refreshes when a running turn ends or is replaced by a queued turn", () => {
    expect(shouldRefreshGitAfterTurn("turn-1", undefined)).toBe(true);
    expect(shouldRefreshGitAfterTurn("turn-1", "turn-2")).toBe(true);
    expect(shouldRefreshGitAfterTurn(undefined, "turn-1")).toBe(false);
    expect(shouldRefreshGitAfterTurn("turn-1", "turn-1")).toBe(false);
  });
});

describe("threadWorkingDirectory", () => {
  it("uses an isolated worktree only for threads that own one", () => {
    expect(threadWorkingDirectory("/repo", {})).toBe("/repo");
    expect(threadWorkingDirectory("/repo", { workingDirectory: "/worktrees/chat/repo" }))
      .toBe("/worktrees/chat/repo");
  });
});
