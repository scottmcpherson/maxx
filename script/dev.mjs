import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devInstanceEnvironment, loadDevInstance } from "./dev_instance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(root, "apps", "desktop");
const stateDirectory = path.join(root, ".maxx-dev");
const statePath = path.join(stateDirectory, "state.json");
const electronBinary = path.join(desktopRoot, "node_modules", ".bin", "electron");
const tscBinary = path.join(desktopRoot, "node_modules", ".bin", "tsc");
const viteBinary = path.join(desktopRoot, "node_modules", ".bin", "vite");
const instance = loadDevInstance(root);
const developmentEnvironment = devInstanceEnvironment(instance);
const mobileEnabled = !process.argv.includes("--no-mobile");
const services = new Map();
const expectedExits = new WeakSet();
const restartTimers = new Map();
const watchers = [];
const startedAt = new Date().toISOString();
let shuttingDown = false;
let shutdownPromise = null;
let changeTimer = null;
let pendingChange = null;
let applyingChange = false;

mkdirSync(stateDirectory, { recursive: true });

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function writeState() {
  const state = {
    root,
    instance: { id: instance.id, label: instance.label, primary: instance.primary },
    supervisorPid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    userDataDirectory: path.join(process.env.HOME || "", "Library", "Application Support", `maxx-dev-${instance.checkoutID}`),
    rendererPort: instance.rendererPort,
    metroPort: instance.metroPort,
    listenPort: instance.listenPort,
    mobileEnabled,
    services: Object.fromEntries([...services].map(([name, child]) => [name, { pid: child.pid }])),
  };
  const temporaryPath = `${statePath}.${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporaryPath, statePath);
}

function run(command, args, label, cwd = root) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`[dev] ${label}\n`);
    const child = spawn(command, args, { cwd, stdio: "inherit", env: developmentEnvironment });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${code ?? signal ?? "unknown"})`));
    });
  });
}

function signalProcessGroup(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function stopService(name) {
  const child = services.get(name);
  if (!child) return Promise.resolve();
  expectedExits.add(child);
  signalProcessGroup(child, "SIGTERM");
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const forceTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 3_000);
    child.once("close", () => {
      clearTimeout(forceTimer);
      resolve();
    });
  });
}

function scheduleServiceRestart(name, start, delay = 1_000) {
  if (shuttingDown || restartTimers.has(name)) return;
  process.stderr.write(`[dev] ${name} stopped; restarting\n`);
  const timer = setTimeout(() => {
    restartTimers.delete(name);
    if (!shuttingDown && !services.has(name)) start();
  }, delay);
  restartTimers.set(name, timer);
}

function startService(name, command, args, restartDelay = 1_000, cwd = root) {
  if (shuttingDown || services.has(name)) return;
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: developmentEnvironment,
    detached: process.platform !== "win32",
  });
  services.set(name, child);
  writeState();
  child.once("error", (error) => process.stderr.write(`[dev] ${name} failed to start: ${error.message}\n`));
  child.once("close", () => {
    if (services.get(name) === child) services.delete(name);
    writeState();
    if (!expectedExits.has(child)) scheduleServiceRestart(name, serviceStarters[name], restartDelay);
  });
}

const serviceStarters = {
  renderer: () => startService("renderer", viteBinary, ["--port", String(instance.rendererPort), "--strictPort"], 1_000, desktopRoot),
  metro: () => startService("metro", "node", ["script/mobile.mjs", "start"]),
  electron: () => startService("electron", electronBinary, [".", "--dev"], 750, desktopRoot),
};

async function waitForHTTP(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not become ready within ${timeoutMs} ms`);
}

function queueChange(kind) {
  pendingChange = pendingChange === "runtime" || kind === "runtime" ? "runtime" : "electron";
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    void applyPendingChange();
  }, 180);
}

async function applyPendingChange() {
  if (applyingChange || shuttingDown || !pendingChange) return;
  applyingChange = true;
  const kind = pendingChange;
  pendingChange = null;
  try {
    if (kind === "runtime") {
      await run("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"], "Rebuilding Rust sidecar", desktopRoot);
    }
    await run(tscBinary, ["-p", "electron/tsconfig.json"], "Compiling Electron main process", desktopRoot);
    await stopService("electron");
    serviceStarters.electron();
    process.stdout.write(`[dev] ${kind === "runtime" ? "Rust sidecar" : "Electron"} changes applied\n`);
  } catch (error) {
    process.stderr.write(`[dev] ${error instanceof Error ? error.message : String(error)}; keeping the last working desktop session\n`);
  } finally {
    applyingChange = false;
    if (pendingChange) void applyPendingChange();
  }
}

function watchDirectory(directory, kind, extensions) {
  if (!existsSync(directory)) return;
  const watcher = watch(directory, { recursive: true }, (_event, filename) => {
    if (!filename || extensions.some((extension) => filename.endsWith(extension))) queueChange(kind);
  });
  watchers.push(watcher);
}

function watchFile(file, kind) {
  if (!existsSync(file)) return;
  watchers.push(watch(file, () => queueChange(kind)));
}

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    process.stdout.write(`[dev] Stopping after ${signal}\n`);
    if (changeTimer) clearTimeout(changeTimer);
    for (const timer of restartTimers.values()) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await Promise.all([...services.keys()].map(stopService));
    rmSync(statePath, { force: true });
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => void shutdown(signal).finally(() => process.exit(0)));
}

process.on("uncaughtException", (error) => {
  process.stderr.write(`[dev] Supervisor failed: ${error.stack || error.message}\n`);
  void shutdown("uncaughtException").finally(() => process.exit(1));
});

async function main() {
  if (existsSync(statePath)) {
    let existing = null;
    try {
      existing = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      // An unreadable state file cannot describe a live managed session.
    }
    if (existing && processAlive(existing.supervisorPid)) {
      throw new Error(`${instance.label} is already running (PID ${existing.supervisorPid}); use pnpm dev:status`);
    }
  }
  writeState();
  await run("node", ["script/stage_cua_driver.mjs"], "Staging computer-use driver", desktopRoot);
  await run("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"], "Building Rust sidecar", desktopRoot);
  await run(tscBinary, ["-p", "electron/tsconfig.json"], "Compiling Electron main process", desktopRoot);

  serviceStarters.renderer();
  if (mobileEnabled) serviceStarters.metro();
  await waitForHTTP(instance.rendererURL, 30_000);
  serviceStarters.electron();

  watchDirectory(path.join(desktopRoot, "electron"), "electron", [".ts", ".tsx"]);
  watchDirectory(path.join(desktopRoot, "src-tauri", "src"), "runtime", [".rs"]);
  watchDirectory(path.join(desktopRoot, "src-tauri", "crates"), "runtime", [".rs", "Cargo.toml"]);
  watchFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), "runtime");

  const mobileSummary = mobileEnabled ? `Metro ${instance.metroPort}` : "mobile disabled";
  process.stdout.write(`[dev] Ready: ${instance.label} (${instance.id}), Vite ${instance.rendererPort}, ${mobileSummary}, Maxx ${instance.listenPort}.\n`);
  process.stdout.write(`[dev] ${mobileEnabled ? "Desktop and mobile use" : "Desktop uses"} Fast Refresh; native-process changes restart automatically.\n`);
  process.stdout.write(`[dev] Run \`pnpm dev:status\` from another terminal for a health snapshot.\n`);
}

main().catch((error) => {
  process.stderr.write(`[dev] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  void shutdown("startup failure").finally(() => process.exit(1));
});
