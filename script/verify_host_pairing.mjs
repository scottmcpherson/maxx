#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const executable = resolve("src-tauri/target/debug/maxx");
const root = mkdtempSync(join(tmpdir(), "maxx-host-acceptance-"));

class Runtime {
  #child;
  #nextID = 1;
  #pending = new Map();
  #readyResolve;
  #readyReject;
  ready;
  events = [];

  constructor(name) {
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.#readyResolve = resolveReady;
      this.#readyReject = rejectReady;
    });
    this.#child = spawn(executable, ["--sidecar"], {
      cwd: process.cwd(),
      env: { ...process.env, MAXX_DATA_DIR: join(root, name) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => this.#receive(line));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) => {
      this.#fail(new Error(`${name} exited (${code ?? signal ?? "unknown"})`));
    });
  }

  request(method, params = {}, timeoutMs = 10_000) {
    const id = this.#nextID++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolveRequest, rejectRequest, timer });
      this.#write({ type: "request", id, method, params });
    });
  }

  shutdown() {
    if (!this.#child.killed) {
      this.#write({ type: "shutdown" });
      setTimeout(() => {
        if (!this.#child.killed) this.#child.kill("SIGTERM");
      }, 1_000).unref();
    }
  }

  #write(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "ready") {
      this.#readyResolve();
      return;
    }
    if (message.type === "event") {
      this.events.push(message);
      return;
    }
    if (message.type !== "response") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (message.error) pending.rejectRequest(new Error(message.error.message));
    else pending.resolveRequest(message.result);
  }

  #fail(error) {
    this.#readyReject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.rejectRequest(error);
    }
    this.#pending.clear();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejected(action, message) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

async function waitFor(check, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${message}; last value: ${JSON.stringify(last)}`);
}

const host = new Runtime("host");
const client = new Runtime("client");
let remoteID = null;

try {
  await Promise.all([host.ready, client.ready]);
  const hostStatus = await host.request("host_status");
  const clientStatus = await client.request("host_status");
  const address = await host.request("host_listen", { bindAddress: "127.0.0.1:0" });
  const invitation = await host.request("host_create_pairing", { preset: "standard" });
  assert(/^....-....$/.test(invitation.code), "host did not create a human-friendly pairing code");

  const connected = await client.request("host_connect", { address, code: invitation.code });
  remoteID = connected.id;
  assert(connected.connected === true, "client did not report a connected environment");
  assert(connected.capabilities.includes("workspace-read"), "standard pairing omitted workspace read access");
  const snapshot = await client.request("workspace_snapshot", { hostId: remoteID });
  assert(Array.isArray(snapshot.projects), "remote workspace request did not cross the sidecar bridge");
  await expectRejected(
    () => client.request("voice_status", { hostId: remoteID }),
    "standard pairing unexpectedly received voice-control access",
  );
  await expectRejected(
    () => client.request("future_unreviewed_method", { hostId: remoteID }),
    "an unclassified remote command did not fail closed",
  );

  const paired = await host.request("host_status");
  assert(paired.pairing === null, "one-time pairing code was not consumed");
  assert(paired.pairedDevices.some((device) => device.id === clientStatus.id), "host did not retain the paired device");

  await host.request("host_unlisten");
  await waitFor(async () => {
    const status = await client.request("host_status");
    return status.remotes.find((remote) => remote.id === remoteID)?.connected === false;
  }, "client did not detect the stopped host");

  await host.request("host_listen", { bindAddress: address });
  await waitFor(async () => {
    const status = await client.request("host_status");
    return status.remotes.find((remote) => remote.id === remoteID)?.connected === true;
  }, "client did not reconnect with its Keychain credential");

  await host.request("host_revoke_peer", { peerId: clientStatus.id });
  await waitFor(async () => {
    const status = await client.request("host_status");
    const remote = status.remotes.find((candidate) => candidate.id === remoteID);
    return remote?.connected === false && remote.error.length > 0;
  }, "revocation did not disconnect and reject the remembered client");

  await client.request("host_disconnect", { hostId: remoteID });
  remoteID = null;
  const finalHost = await host.request("host_status");
  const finalClient = await client.request("host_status");
  assert(finalHost.pairedDevices.length === 0, "revoked device remained authorized");
  assert(finalClient.remotes.length === 0, "forgotten environment remained in the client catalog");
  process.stdout.write(`MAXX_HOST_ACCEPTANCE ${JSON.stringify({
    ok: true,
    protocolVersion: finalHost.protocolVersion,
    pairingConsumed: true,
    keychainReconnect: true,
    revocation: true,
    remoteWorkspace: true,
    capabilitiesEnforced: true,
  })}\n`);
} finally {
  if (remoteID) {
    try {
      await client.request("host_disconnect", { hostId: remoteID }, 2_000);
    } catch {
      // The cleanup continues by terminating the isolated processes.
    }
  }
  host.shutdown();
  client.shutdown();
  rmSync(root, { recursive: true, force: true });
}
