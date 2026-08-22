import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDevInstance } from "./dev_instance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function worktreePaths() {
  try {
    return execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  } catch {
    return [root];
  }
}

const instances = worktreePaths().map((worktree) => {
  const instance = loadDevInstance(worktree);
  let state = null;
  try {
    state = JSON.parse(readFileSync(path.join(worktree, ".maxx-dev", "state.json"), "utf8"));
  } catch {
    // A stopped worktree has no live state.
  }
  return {
    root: worktree,
    id: instance.id,
    label: instance.label,
    primary: instance.primary,
    running: Boolean(state && processAlive(state.supervisorPid)),
    supervisorPid: state?.supervisorPid ?? null,
    rendererPort: instance.rendererPort,
    metroPort: instance.metroPort,
    listenPort: instance.listenPort,
    mobileEnabled: state?.mobileEnabled ?? null,
  };
});

process.stdout.write(`MAXX_DEV_INSTANCES ${JSON.stringify(instances)}\n`);
