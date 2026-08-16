import { useAppStore } from "../store/appStore";
import { Icons } from "./Icons";

/**
 * Explains why a remote project disappeared from the sidebar after its
 * connection dropped. This lives outside the zoom surface so it remains
 * visible even when the sidebar is collapsed or another pane is open.
 */
export function HostDisconnectNotice() {
  const notice = useAppStore((state) => state.hostDisconnectNotice);
  const dismiss = useAppStore((state) => state.clearHostDisconnectNotice);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);

  if (!notice) return null;

  return (
    <div className="host-disconnect-notice" role="alert" aria-live="assertive">
      <Icons.globe size={16} />
      <span className="host-disconnect-notice-copy">
        <strong>Connection to {notice.hostName} lost</strong>
        <small>Remote projects are hidden until the connection returns.</small>
      </span>
      <button
        type="button"
        className="host-disconnect-notice-action"
        onClick={() => {
          dismiss(notice.hostID);
          setSettingsOpen(true);
        }}
      >
        Open Settings
      </button>
      <button
        type="button"
        className="host-disconnect-notice-dismiss"
        title="Dismiss"
        aria-label="Dismiss connection notice"
        onClick={() => dismiss(notice.hostID)}
      >
        <Icons.close size={14} />
      </button>
    </div>
  );
}
