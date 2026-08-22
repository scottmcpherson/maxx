import { describe, expect, it } from "vitest";
import { isProtectedHost, parseEndpoint, parsePairingPayload } from "./pairingPayload";

const invitation = {
  kind: "maxx-mobile-pairing",
  version: 1,
  protocolVersion: 7,
  host: { id: "host-1", name: "Studio Mac", address: "studio.tailnet.ts.net:7422" },
  pairing: {
    code: "ABCD-EFGH",
    expiresAt: 2_000,
    capabilities: ["workspace-read", "workspace-write", "agent-run", "voice-control"],
  },
};

describe("mobile pairing payload", () => {
  it("accepts a current invitation for a Tailscale endpoint", () => {
    expect(parsePairingPayload(JSON.stringify(invitation), 1_000)).toEqual({ ok: true, payload: invitation });
  });

  it("rejects expired and public-network invitations", () => {
    expect(parsePairingPayload(JSON.stringify(invitation), 2_000)).toMatchObject({ ok: false });
    expect(parsePairingPayload(JSON.stringify({
      ...invitation,
      host: { ...invitation.host, address: "example.com:7422" },
    }), 1_000)).toMatchObject({ ok: false });
  });

  it("rejects codes that do not grant the mobile capability set", () => {
    expect(parsePairingPayload(JSON.stringify({
      ...invitation,
      pairing: { ...invitation.pairing, capabilities: ["workspace-read"] },
    }), 1_000)).toEqual({ ok: false, error: "This pairing code does not grant Maxx Mobile access." });
  });

  it("parses Tailscale IPv4 and IPv6 without widening network scope", () => {
    expect(parseEndpoint("100.90.1.2")).toEqual({ host: "100.90.1.2", port: 7422, address: "100.90.1.2:7422" });
    expect(parseEndpoint("[fd7a:115c:a1e0::1]:9000")).toEqual({ host: "fd7a:115c:a1e0::1", port: 9000, address: "[fd7a:115c:a1e0::1]:9000" });
    expect(isProtectedHost("192.168.1.2")).toBe(false);
    expect(() => parseEndpoint("8.8.8.8:7422")).toThrow(/Tailscale/u);
  });
});
