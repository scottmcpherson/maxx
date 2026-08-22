import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadDevInstance } from "./dev_instance.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".maxx-dev", "state.json");
const instance = loadDevInstance(root);

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function httpReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function tcpReady(port) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port)) {
      resolve(false);
      return;
    }
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(800);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function sidecarReady() {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="]);
    return stdout.split("\n").some((command) => (
      command.includes(path.join(root, "apps", "desktop", "src-tauri", "target", "debug", "maxx"))
      && command.includes("--sidecar")
    ));
  } catch {
    return false;
  }
}

let state = null;
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch {
  // A missing state file means the managed development session is stopped.
}

const rendererPort = state?.rendererPort ?? instance.rendererPort;
const metroPort = state?.metroPort ?? instance.metroPort;
const listenPort = state?.listenPort ?? instance.listenPort;
const mobileEnabled = state?.mobileEnabled ?? true;
const [vite, metro, sidecar, mobileListener] = await Promise.all([
  httpReady(`http://localhost:${rendererPort}`),
  mobileEnabled ? httpReady(`http://localhost:${metroPort}/status`) : Promise.resolve(false),
  sidecarReady(),
  tcpReady(listenPort),
]);
const status = {
  ready: Boolean(
    state
    && processAlive(state.supervisorPid)
    && processAlive(state.services?.renderer?.pid)
    && processAlive(state.services?.electron?.pid)
    && vite
    && (!mobileEnabled || (processAlive(state.services?.metro?.pid) && metro))
    && sidecar
  ),
  instance: { id: instance.id, label: instance.label, primary: instance.primary },
  supervisor: processAlive(state?.supervisorPid),
  renderer: { process: processAlive(state?.services?.renderer?.pid), vite, port: rendererPort },
  mobile: { enabled: mobileEnabled, process: processAlive(state?.services?.metro?.pid), metro, port: metroPort, listener: mobileListener },
  desktop: { process: processAlive(state?.services?.electron?.pid), sidecar },
  listenPort,
  startedAt: state?.startedAt ?? null,
};

process.stdout.write(`MAXX_DEV_STATUS ${JSON.stringify(status)}\n`);
process.exitCode = status.ready ? 0 : 1;
