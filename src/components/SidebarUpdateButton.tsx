import { useAppStore } from "../store/appStore";
import { shouldShowUpdateButton } from "../updates";
import { Icons } from "./Icons";

export function SidebarUpdateButton() {
  const status = useAppStore((state) => state.updateStatus);
  const installUpdate = useAppStore((state) => state.installUpdate);
  const restartToInstallUpdate = useAppStore((state) => state.restartToInstallUpdate);

  if (!shouldShowUpdateButton(status) || !status) return null;

  const downloading = status.state === "downloading";
  const ready = status.state === "ready";
  const label = downloading
    ? `Downloading update${status.percent === null ? "" : `… ${status.percent}%`}`
    : ready
      ? "Restart to update"
      : "Update available";

  return (
    <button
      type="button"
      className={`nav-row sidebar-update-button${downloading ? " is-downloading" : ""}`}
      disabled={downloading}
      onClick={() => void (ready ? restartToInstallUpdate() : installUpdate())}
      title={label}
    >
      {ready ? <Icons.reload size={15} /> : <Icons.download size={15} />}
      <span>{label}</span>
      <small>{status.version}</small>
    </button>
  );
}
