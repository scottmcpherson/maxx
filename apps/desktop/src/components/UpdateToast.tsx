import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import {
  UPDATE_STATUS_DISMISS_MS,
  describeUpdateStatus,
  isSettledUpdateStatus,
  updateStatusTone,
} from "../updates";
import { Alert, AlertAction, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { XIcon } from "lucide-react";
import { cn } from "../lib/utils";

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
    <Alert
      variant={updateStatusTone(status) === "warning" ? "destructive" : "default"}
      className={cn(
        "fixed inset-s-4 bottom-4 z-50 flex w-fit max-w-[min(35rem,calc(100vw-2rem))] items-center gap-2 rounded-lg bg-popover px-3 py-2 text-popover-foreground shadow-lg",
        updateStatusTone(status) === "good" && "border-primary/50 text-primary",
      )}
      role="status"
      aria-live="polite"
    >
      <AlertDescription className="select-text text-sm">{describeUpdateStatus(status)}</AlertDescription>
      <AlertAction>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Dismiss"
          aria-label="Dismiss update status"
          onClick={() => setUpdateStatus(null)}
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}
