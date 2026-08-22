import { Buffer } from "buffer";
import * as Crypto from "expo-crypto";
import TcpSocket from "react-native-tcp-socket";
import { MAXX_PROTOCOL_VERSION, parseEndpoint } from "./pairingPayload";
import { Utf8StreamDecoder } from "./utf8Stream";

const REQUEST_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 12_000;

type SocketType = ReturnType<typeof TcpSocket.createConnection>;

type Welcome = {
  type: "welcome";
  protocolVersion: number;
  host: { id: string; name: string };
  capabilities: string[];
  eventCursor: number;
  resyncRequired: boolean;
};

type HostEvent = { cursor: number; event: string; payload: unknown };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type HostConnectionResult = {
  client: MaxxHostClient;
  hostId: string;
  hostName: string;
  capabilities: string[];
  credential?: string;
};

export class MaxxHostClient {
  private socket: SocketType;
  private buffer = "";
  private nextID = 1;
  private pending = new Map<number, Pending>();
  private eventListeners = new Set<(event: HostEvent) => void>();
  private closeListeners = new Set<(error?: Error) => void>();
  private closed = false;
  private readonly decoder: Utf8StreamDecoder;

  private constructor(socket: SocketType, decoder = new Utf8StreamDecoder()) {
    this.socket = socket;
    this.decoder = decoder;
    socket.setNoDelay(true);
    socket.setKeepAlive(true);
    socket.on("data", (data) => this.receive(this.decoder.decode(data)));
    socket.on("error", (error) => this.finish(error));
    socket.on("close", () => this.finish());
  }

  static async pair(options: {
    address: string;
    code: string;
    clientId: string;
    clientName: string;
  }): Promise<HostConnectionResult> {
    const credential = createDeviceCredential();
    const credentialHash = await hashCredential(credential);
    const result = await this.open(options.address, {
      clientId: options.clientId,
      clientName: options.clientName,
      auth: { type: "pairing", code: options.code, credentialHash },
      afterCursor: 0,
    });
    return { ...result, credential };
  }

  static reconnect(options: {
    address: string;
    credential: string;
    clientId: string;
    clientName: string;
  }) {
    return this.open(options.address, {
      clientId: options.clientId,
      clientName: options.clientName,
      auth: { type: "credential", credential: options.credential },
      afterCursor: 0,
    });
  }

  private static open(
    address: string,
    hello: {
      clientId: string;
      clientName: string;
      auth: Record<string, string>;
      afterCursor: number;
    },
  ): Promise<HostConnectionResult> {
    const endpoint = parseEndpoint(address);
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = TcpSocket.createConnection(
        { host: endpoint.host, port: endpoint.port, connectTimeout: HANDSHAKE_TIMEOUT_MS },
        () => {
          socket.write(`${JSON.stringify({
            type: "hello",
            protocol: { name: "maxx-environment", version: MAXX_PROTOCOL_VERSION },
            client: { id: hello.clientId, name: hello.clientName },
            auth: hello.auth,
            afterCursor: hello.afterCursor,
          })}\n`);
        },
      );
      const decoder = new Utf8StreamDecoder();
      let handshakeBuffer = "";
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("The Maxx pairing response timed out."));
      }, HANDSHAKE_TIMEOUT_MS);

      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error(`Could not connect to ${endpoint.address}: ${error.message}`));
      };
      socket.once("error", onError);
      socket.on("data", function onHandshakeData(data) {
        if (settled) return;
        handshakeBuffer += decoder.decode(data);
        const newline = handshakeBuffer.indexOf("\n");
        if (newline < 0) return;
        const first = handshakeBuffer.slice(0, newline).replace(/\r$/u, "");
        const remainder = handshakeBuffer.slice(newline + 1);
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(first) as Record<string, unknown>;
        } catch {
          onError(new Error("Maxx returned an invalid pairing response."));
          return;
        }
        if (frame.type === "error") {
          onError(new Error(typeof frame.message === "string" ? frame.message : "Maxx rejected this device."));
          return;
        }
        if (frame.type !== "welcome" || frame.protocolVersion !== MAXX_PROTOCOL_VERSION) {
          onError(new Error("This Maxx version is not compatible with the mobile app."));
          return;
        }
        const welcome = frame as unknown as Welcome;
        if (!welcome.host?.id) {
          onError(new Error("Maxx did not identify itself."));
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.removeListener("error", onError);
        socket.removeListener("data", onHandshakeData);
        const client = new MaxxHostClient(socket, decoder);
        if (remainder) client.receive(remainder);
        resolve({
          client,
          hostId: welcome.host.id,
          hostName: welcome.host.name || "Maxx",
          capabilities: welcome.capabilities || [],
        });
      });
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Maxx is disconnected."));
    const id = this.nextID++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.socket.write(`${JSON.stringify({ type: "request", id, method, params })}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  onEvent(listener: (event: HostEvent) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.rejectPending(new Error("Maxx disconnected."));
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (frame.type === "response" && typeof frame.id === "number") {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        this.pending.delete(frame.id);
        clearTimeout(pending.timeout);
        if (frame.error && typeof frame.error === "object") {
          const message = (frame.error as Record<string, unknown>).message;
          pending.reject(new Error(typeof message === "string" ? message : "The Maxx command failed."));
        } else {
          pending.resolve(frame.result);
        }
      } else if (frame.type === "event" && typeof frame.event === "string") {
        const event = {
          cursor: typeof frame.cursor === "number" ? frame.cursor : 0,
          event: frame.event,
          payload: frame.payload,
        };
        for (const listener of this.eventListeners) listener(event);
      }
    }
  }

  private finish(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error || new Error("Maxx disconnected."));
    for (const listener of this.closeListeners) listener(error);
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createDeviceCredential() {
  return `maxx_device_${Buffer.from(Crypto.getRandomBytes(32)).toString("hex")}`;
}

export async function hashCredential(credential: string) {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `maxx-host-credential:v1:${credential}`,
  );
  return `v1:${digest}`;
}
