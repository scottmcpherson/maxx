import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import {
  UPDATE_STATUS_DISMISS_MS,
  describeUpdateStatus,
  isSettledUpdateStatus,
  updateStatusTone,
} from "../updates";

/**
 * Result of "Check for Updates…". The check is user-initiated, so it always
 * reports back — including "up to date" and "not configured", which are the two
 * outcomes a silent implementation would leave the user guessing about.
 */
export function UpdateToast() {
  const status = useAppStore((state) => state.updateStatus);
  const setUpdateStatus = useAppStore((state) => state.setUpdateStatus);

  useEffect(() => {
    if (!status || !isSettledUpdateStatus(status)) return;
    const timer = window.setTimeout(() => setUpdateStatus(null), UPDATE_STATUS_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [setUpdateStatus, status]);

  if (!status) return null;
  if (status.state === "available" || status.state === "downloading" || status.state === "ready") return null;

  return (
    <div className={`update-toast tone-${updateStatusTone(status)}`} role="status" aria-live="polite">
      <span className="update-toast-message">{describeUpdateStatus(status)}</span>
      <button
        type="button"
        className="update-toast-dismiss"
        title="Dismiss"
        aria-label="Dismiss update status"
        onClick={() => setUpdateStatus(null)}
      >
        ×
      </button>
    </div>
  );
}
