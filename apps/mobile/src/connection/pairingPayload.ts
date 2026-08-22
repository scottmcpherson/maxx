export const MAXX_PROTOCOL_VERSION = 7;
export const DEFAULT_MAXX_PORT = 7422;

export type PairingCapability =
  | "workspace-read"
  | "workspace-write"
  | "agent-run"
  | "terminal-control"
  | "browser-control"
  | "settings-manage"
  | "voice-control";

export const MOBILE_REQUIRED_CAPABILITIES: PairingCapability[] = [
  "workspace-read",
  "workspace-write",
  "agent-run",
  "voice-control",
];

export type MaxxMobilePairingPayload = {
  kind: "maxx-mobile-pairing";
  version: 1;
  protocolVersion: number;
  host: {
    id: string;
    name: string;
    address: string;
  };
  pairing: {
    code: string;
    expiresAt: number;
    capabilities: PairingCapability[];
  };
};

export type Endpoint = { host: string; port: number; address: string };

export function parseEndpoint(input: string): Endpoint {
  const value = input.trim();
  if (!value) throw new Error("The Maxx address is missing.");

  let host = value;
  let port = DEFAULT_MAXX_PORT;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) throw new Error("The IPv6 Maxx address is invalid.");
    host = value.slice(1, close);
    const suffix = value.slice(close + 1);
    if (suffix) {
      if (!suffix.startsWith(":")) throw new Error("The Maxx port is invalid.");
      port = parsePort(suffix.slice(1));
    }
  } else {
    const colon = value.lastIndexOf(":");
    if (colon > 0 && value.indexOf(":") === colon) {
      host = value.slice(0, colon);
      port = parsePort(value.slice(colon + 1));
    }
  }

  if (!isProtectedHost(host)) {
    throw new Error("Maxx Mobile connects only through Tailscale or loopback.");
  }
  const address = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  return { host, port, address };
}

export function isProtectedHost(host: string) {
  const normalized = host.trim().toLowerCase().replace(/\.$/u, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/u.test(normalized)) return true;
  if (normalized.endsWith(".ts.net")) return true;
  if (normalized.startsWith("fd7a:115c:a1e0:")) return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((value) => value >= 0 && value <= 255)
    && octets[0] === 100
    && octets[1] >= 64
    && octets[1] <= 127;
}

export function parsePairingPayload(raw: string, now = Math.floor(Date.now() / 1000)) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false as const, error: "This is not a Maxx pairing QR code." };
  }
  if (!value || typeof value !== "object") {
    return { ok: false as const, error: "This is not a Maxx pairing QR code." };
  }
  const candidate = value as Partial<MaxxMobilePairingPayload>;
  if (candidate.kind !== "maxx-mobile-pairing" || candidate.version !== 1) {
    return { ok: false as const, error: "This QR code was not created for Maxx Mobile." };
  }
  if (candidate.protocolVersion !== MAXX_PROTOCOL_VERSION) {
    return { ok: false as const, error: "This Maxx version is not compatible with the mobile app." };
  }
  if (!candidate.host?.id || !candidate.host.name || !candidate.host.address) {
    return { ok: false as const, error: "The pairing code is missing its Maxx identity." };
  }
  try {
    parseEndpoint(candidate.host.address);
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
  if (!candidate.pairing?.code || !candidate.pairing.expiresAt) {
    return { ok: false as const, error: "The pairing invitation is incomplete." };
  }
  if (candidate.pairing.expiresAt <= now) {
    return { ok: false as const, error: "This pairing invitation expired. Generate a new QR code on your Mac." };
  }
  if (!Array.isArray(candidate.pairing.capabilities)) {
    return { ok: false as const, error: "The pairing invitation has invalid permissions." };
  }
  if (!MOBILE_REQUIRED_CAPABILITIES.every((capability) => candidate.pairing!.capabilities.includes(capability))) {
    return { ok: false as const, error: "This pairing code does not grant Maxx Mobile access." };
  }
  return { ok: true as const, payload: candidate as MaxxMobilePairingPayload };
}

function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("The Maxx port is invalid.");
  }
  return port;
}
