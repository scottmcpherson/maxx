import { useEffect } from "react";
import { useAppStore } from "../store/appStore";

const REFRESH_INTERVAL_MS = 2_000;

/**
 * Reconciles transient connection events with the sidecar's authoritative
 * status while the UI is showing an offline state.
 */
export function HostConnectionMonitor() {
  const offlineHostID = useAppStore((state) =>
    state.errorHostID ?? state.hostDisconnectNotice?.hostID ?? null,
  );
  const refreshHostStatus = useAppStore((state) => state.refreshHostStatus);

  useEffect(() => {
    if (!offlineHostID) return;
    void refreshHostStatus();
    const timer = window.setInterval(() => void refreshHostStatus(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [offlineHostID, refreshHostStatus]);

  return null;
}
