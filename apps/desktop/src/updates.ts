// Update-check status published by the Electron host. Distribution builds can
// add a signed updater without exposing update authority to either renderer.

export type UpdateStatus =
  | { state: "checking" }
  | { state: "upToDate"; version: string }
  | { state: "available"; version: string; notes: string | null; date: string | null }
  | { state: "downloading"; version: string; percent: number | null }
  | { state: "ready"; version: string }
  | { state: "unavailable"; detail: string }
  | { state: "failed"; message: string };

export type ActionableUpdateStatus = Extract<
  UpdateStatus,
  { state: "available" | "downloading" | "ready" }
>;

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
    case "downloading":
      return status.percent === null
        ? `Downloading Maxx ${status.version}…`
        : `Downloading Maxx ${status.version}… ${status.percent}%`;
    case "ready":
      return `Maxx ${status.version} is ready to install.`;
    case "unavailable":
      return status.detail;
    case "failed":
      return `Update check failed. ${status.message}`;
  }
}

export function updateStatusTone(status: UpdateStatus): UpdateStatusTone {
  switch (status.state) {
    case "available":
    case "ready":
      return "good";
    case "unavailable":
    case "failed":
      return "warning";
    default:
      return "info";
  }
}

/** `checking` is a spinner state — it is replaced, not timed out. */
export function isSettledUpdateStatus(status: UpdateStatus): boolean {
  return status.state !== "checking" && status.state !== "downloading";
}

export function shouldShowUpdateButton(status: UpdateStatus | null): status is ActionableUpdateStatus {
  return status?.state === "available" || status?.state === "downloading" || status?.state === "ready";
}
