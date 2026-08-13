import type { HostInfo } from "./session";

export type { HostInfo };

export type Capability =
  | "workspace-read"
  | "workspace-write"
  | "agent-run"
  | "terminal-control"
  | "browser-control"
  | "settings-manage"
  | "voice-control";

export type AccessPreset = "standard" | "full";

export interface PairingInvitation {
  code: string;
  expiresAt: number;
  capabilities: Capability[];
}

export interface RemoteHostStatus {
  id: string;
  name: string;
  address: string;
  capabilities: Capability[];
  connected: boolean;
  lastEventCursor: number;
  error: string;
}

export interface PairedDevice {
  id: string;
  name: string;
  capabilities: Capability[];
  createdAt: number;
  lastSeenAt: number;
}

export interface TailscaleNode {
  name: string;
  dnsName: string;
  addresses: string[];
  online: boolean;
}

export interface TailscaleDiscovery {
  installed: boolean;
  running: boolean;
  selfNode: TailscaleNode | null;
  peers: TailscaleNode[];
  error: string;
}

export interface HostStatus {
  id: string;
  name: string;
  protocolVersion: number;
  listening: boolean;
  bindAddress: string | null;
  shareAddress: string | null;
  pairing: PairingInvitation | null;
  remotes: RemoteHostStatus[];
  pairedDevices: PairedDevice[];
}

export interface FolderEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export interface MediaBytes {
  id?: string;
  kind?: "image" | "video" | "audio";
  mimeType: string;
  displayName: string;
  dataBase64: string;
}
