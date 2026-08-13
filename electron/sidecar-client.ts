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
  dataDirectory?: string;
  onEvent: (event: string, payload: JsonValue) => void;
  onHostRequest: (method: string, params: JsonValue) => Promise<JsonValue>;
  onLog?: (line: string) => void;
}

export class SidecarClient {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #onEvent: SidecarClientOptions["onEvent"];
  readonly #onHostRequest: SidecarClientOptions["onHostRequest"];
  readonly #exitPromise: Promise<void>;
  readonly #stderrLines: string[] = [];
  #resolveExit: (() => void) | null = null;
  #exitError: Error | null = null;
  #nextId = 1;
  #bufferedWrites: string[] = [];
  #ready = false;
  #shuttingDown = false;

  constructor(options: SidecarClientOptions) {
    this.#onEvent = options.onEvent;
    this.#onHostRequest = options.onHostRequest;
    this.#exitPromise = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.#process = spawn(options.executable, ["--sidecar"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MAXX_DESKTOP_HOST: "electron",
        ...(options.dataDirectory ? { MAXX_DATA_DIR: options.dataDirectory } : {}),
      },
    });
    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => this.#readLine(line));
    this.#process.stderr.setEncoding("utf8");
    this.#process.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.#stderrLines.push(line);
        if (this.#stderrLines.length > 12) this.#stderrLines.shift();
        options.onLog?.(line);
      }
    });
    this.#process.once("error", (error) => {
      this.#exitError = error;
      this.#failAll(error);
    });
    this.#process.once("exit", (code, signal) => {
      const diagnostics = this.#stderrLines.at(-1);
      const error = new Error(`Maxx runtime exited (${code ?? signal ?? "unknown"})${diagnostics ? `: ${diagnostics}` : ""}`);
      this.#exitError = error;
      this.#failAll(error);
      this.#resolveExit?.();
      this.#resolveExit = null;
    });
  }

  request(method: string, params: JsonValue, timeoutMs = 120_000): Promise<JsonValue> {
    if (this.#exitError) return Promise.reject(this.#exitError);
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
      pending.reject(new Error("Maxx runtime is shutting down"));
    }
    this.#pending.clear();
    this.#bufferedWrites = [];
    if (this.#ready) this.#process.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
    else this.#process.stdin.end();
    setTimeout(() => {
      if (!this.#process.killed) this.#process.kill("SIGTERM");
    }, 2_000).unref();
  }

  terminate(): void {
    if (!this.#process.killed) this.#process.kill("SIGTERM");
  }

  async waitForExit(timeoutMs = 2_000): Promise<boolean> {
    if (this.#process.exitCode !== null || this.#process.signalCode !== null) return true;
    return Promise.race([
      this.#exitPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
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
    if (this.#ready || (value as { type?: string }).type === "host_response") {
      this.#process.stdin.write(serialized);
    }
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
