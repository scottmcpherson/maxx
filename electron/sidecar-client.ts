import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  HostRequest,
  HostResponse,
  JsonValue,
  SidecarEvent,
  SidecarRequest,
  SidecarResponse,
} from "./contracts.js";

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface SidecarClientOptions {
  executable: string;
  cwd: string;
  onEvent: (event: string, payload: JsonValue) => void;
  onHostRequest: (method: string, params: JsonValue) => Promise<JsonValue>;
  onLog?: (line: string) => void;
}

export class SidecarClient {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #onEvent: SidecarClientOptions["onEvent"];
  readonly #onHostRequest: SidecarClientOptions["onHostRequest"];
  #nextId = 1;
  #bufferedWrites: string[] = [];
  #ready = false;
  #shuttingDown = false;

  constructor(options: SidecarClientOptions) {
    this.#onEvent = options.onEvent;
    this.#onHostRequest = options.onHostRequest;
    this.#process = spawn(options.executable, ["--sidecar"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MAXX_DESKTOP_HOST: "electron" },
    });
    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => this.#readLine(line));
    this.#process.stderr.setEncoding("utf8");
    this.#process.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) options.onLog?.(line);
    });
    this.#process.once("error", (error) => this.#failAll(error));
    this.#process.once("exit", (code, signal) => this.#failAll(new Error(`Maxx runtime exited (${code ?? signal ?? "unknown"})`)));
  }

  request(method: string, params: JsonValue, timeoutMs = 120_000): Promise<JsonValue> {
    const id = this.#nextId++;
    const message: SidecarRequest = { type: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write(message);
    });
  }

  event(event: string, payload: JsonValue): void {
    this.#write({ type: "host_event", event, payload });
  }

  shutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.#pending.clear();
    this.#write({ type: "shutdown" });
    setTimeout(() => {
      if (!this.#process.killed) this.#process.kill("SIGTERM");
    }, 2_000).unref();
  }

  #readLine(line: string): void {
    let message: SidecarResponse | SidecarEvent | HostRequest | { type: "ready" };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.type === "ready") {
      this.#ready = true;
      for (const buffered of this.#bufferedWrites.splice(0)) this.#process.stdin.write(buffered);
      return;
    }
    if (message.type === "response") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else pending.resolve(message.result ?? null);
      return;
    }
    if (message.type === "event") {
      this.#onEvent(message.event, message.payload);
      return;
    }
    if (message.type === "host_request") void this.#handleHostRequest(message);
  }

  async #handleHostRequest(request: HostRequest): Promise<void> {
    let response: HostResponse;
    try {
      response = { type: "host_response", id: request.id, result: await this.#onHostRequest(request.method, request.params) };
    } catch (error) {
      const value = error as Error & { code?: string };
      response = { type: "host_response", id: request.id, error: { code: value.code ?? "host.error", message: value.message || String(error) } };
    }
    this.#write(response);
  }

  #write(value: object): void {
    const serialized = `${JSON.stringify(value)}\n`;
    if (this.#ready || (value as { type?: string }).type === "host_response") this.#process.stdin.write(serialized);
    else this.#bufferedWrites.push(serialized);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
