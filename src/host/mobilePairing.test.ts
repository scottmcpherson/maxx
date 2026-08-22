import { describe, expect, it } from "vitest";
import { mobilePairingPayload } from "./mobilePairing";
import type { HostStatus } from "./types";

function status(): HostStatus {
  return {
    id: "host-1",
    name: "Scott's Mac",
    protocolVersion: 7,
    listening: true,
    bindAddress: "0.0.0.0:7422",
    shareAddress: "maxx.tailnet.ts.net:7422",
    pairing: {
      code: "ABCD-EFGH",
      expiresAt: 1_800_000_000,
      capabilities: ["workspace-read", "workspace-write", "agent-run", "voice-control"],
    },
    remotes: [],
    pairedDevices: [],
  };
}

describe("mobilePairingPayload", () => {
  it("encodes the host identity, endpoint, one-time invitation, and protocol version", () => {
    expect(mobilePairingPayload(status())).toEqual({
      kind: "maxx-mobile-pairing",
      version: 1,
      protocolVersion: 7,
      host: { id: "host-1", name: "Scott's Mac", address: "maxx.tailnet.ts.net:7422" },
      pairing: {
        code: "ABCD-EFGH",
        expiresAt: 1_800_000_000,
        capabilities: ["workspace-read", "workspace-write", "agent-run", "voice-control"],
      },
    });
  });

  it("does not create a mobile invitation from a lower-privilege pairing code", () => {
    const host = status();
    host.pairing!.capabilities = ["workspace-read"];
    expect(mobilePairingPayload(host)).toBeNull();
  });

  it("does not present a full-access computer invitation as a mobile QR code", () => {
    const host = status();
    host.pairing!.capabilities = [
      "workspace-read",
      "workspace-write",
      "agent-run",
      "terminal-control",
      "browser-control",
      "settings-manage",
      "voice-control",
    ];
    expect(mobilePairingPayload(host)).toBeNull();
  });

  it("requires a shareable Tailscale endpoint", () => {
    const host = status();
    host.shareAddress = null;
    expect(mobilePairingPayload(host)).toBeNull();
  });
});
