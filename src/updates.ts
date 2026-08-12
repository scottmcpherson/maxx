// Update-check status published by the Electron host. Distribution builds can
// add a signed updater without exposing update authority to either renderer.

export type UpdateStatus =
  | { state: "checking" }
  | { state: "upToDate"; version: string }
  | { state: "available"; version: string; notes: string | null }
  | { state: "unconfigured"; detail: string }
  | { state: "failed"; message: string };

export type UpdateStatusTone = "info" | "good" | "warning";

/** How long a settled status stays on screen; `checking` never auto-dismisses. */
export const UPDATE_STATUS_DISMISS_MS = 6000;

export function describeUpdateStatus(status: UpdateStatus): string {
  switch (status.state) {
    case "checking":
      return "Checking for updates…";
    case "upToDate":
      return `Maxx ${status.version} is up to date.`;
    case "available":
      return `Maxx ${status.version} is available.`;
    case "unconfigured":
      return `Updates are not configured. ${status.detail}`;
    case "failed":
      return `Update check failed. ${status.message}`;
  }
}

export function updateStatusTone(status: UpdateStatus): UpdateStatusTone {
  switch (status.state) {
    case "available":
      return "good";
    case "unconfigured":
    case "failed":
      return "warning";
    default:
      return "info";
  }
}

/** `checking` is a spinner state — it is replaced, not timed out. */
export function isSettledUpdateStatus(status: UpdateStatus): boolean {
  return status.state !== "checking";
}
