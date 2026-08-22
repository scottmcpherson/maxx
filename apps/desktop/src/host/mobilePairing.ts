import type { Capability, HostStatus } from "./types";

export const MOBILE_CAPABILITIES: Capability[] = [
  "workspace-read",
  "workspace-write",
  "agent-run",
  "voice-control",
];

export type MobilePairingPayload = {
  kind: "maxx-mobile-pairing";
  version: 1;
  protocolVersion: number;
  host: { id: string; name: string; address: string };
  pairing: { code: string; expiresAt: number; capabilities: Capability[] };
};

export function mobilePairingPayload(status: HostStatus): MobilePairingPayload | null {
  const pairing = status.pairing;
  const address = status.shareAddress;
  if (
    !pairing
    || !address
    || pairing.capabilities.length !== MOBILE_CAPABILITIES.length
    || !MOBILE_CAPABILITIES.every((capability) => pairing.capabilities.includes(capability))
  ) {
    return null;
  }
  return {
    kind: "maxx-mobile-pairing",
    version: 1,
    protocolVersion: status.protocolVersion,
    host: { id: status.id, name: status.name, address },
    pairing: {
      code: pairing.code,
      expiresAt: pairing.expiresAt,
      capabilities: pairing.capabilities,
    },
  };
}
