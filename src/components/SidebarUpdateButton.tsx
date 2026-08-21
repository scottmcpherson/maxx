import { useAppStore } from "../store/appStore";
import { shouldShowUpdateButton } from "../updates";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
    <Button
      type="button"
      variant="ghost"
      className={`nav-row sidebar-update-button${downloading ? " is-downloading" : ""}`}
      disabled={downloading}
      onClick={() => void (ready ? restartToInstallUpdate() : installUpdate())}
      title={label}
    >
      {downloading ? <Spinner data-icon="inline-start" /> : ready ? <Icons.reload data-icon="inline-start" /> : <Icons.download data-icon="inline-start" />}
      <span>{label}</span>
      <small>{status.version}</small>
    </Button>
  );
}
