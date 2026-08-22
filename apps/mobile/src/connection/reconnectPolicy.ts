export const AUTO_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000] as const;

export type ReconnectReason = "startup" | "manual" | "automatic";

export function shouldShowReconnectProgress(reason: ReconnectReason) {
  return reason !== "automatic";
}

export function automaticReconnectDelay(attempt: number) {
  const index = Math.min(Math.max(0, Math.floor(attempt)), AUTO_RECONNECT_DELAYS_MS.length - 1);
  return AUTO_RECONNECT_DELAYS_MS[index];
}

export function shouldAutomaticallyReconnect(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return ![
    "different maxx host",
    "no longer has maxx mobile access",
    "rejected this device",
    "device credential was rejected",
    "host credentials were rejected",
    "not compatible with the mobile app",
  ].some((terminalMessage) => message.includes(terminalMessage));
}
