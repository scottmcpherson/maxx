import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";

export type UpdateStatus =
  | { state: "checking" }
  | { state: "upToDate"; version: string }
  | { state: "available"; version: string; notes: string | null; date: string | null }
  | { state: "downloading"; version: string; percent: number | null }
  | { state: "ready"; version: string }
  | { state: "unavailable"; detail: string }
  | { state: "failed"; message: string };

type EmitStatus = (status: UpdateStatus) => void;

const INITIAL_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function releaseNotes(info: UpdateInfo): string | null {
  if (typeof info.releaseNotes === "string") return info.releaseNotes;
  if (!Array.isArray(info.releaseNotes)) return null;
  return info.releaseNotes.map((note) => note.note).filter(Boolean).join("\n\n") || null;
}

function availableStatus(info: UpdateInfo): UpdateStatus {
  return {
    state: "available",
    version: info.version,
    notes: releaseNotes(info),
    date: info.releaseDate ?? null,
  };
}

/** Main-process owner for release checks, downloads, signature verification, and relaunch. */
export class MaxxUpdater {
  private updater: AppUpdater | null = null;
  private available: UpdateInfo | null = null;
  private downloaded = false;
  private installWhenReady = false;

  constructor(
    private readonly emit: EmitStatus,
    private readonly prepareToQuit: () => void,
    private readonly packaged: boolean,
    private readonly currentVersion: string,
  ) {}

  async initialize(): Promise<void> {
    if (!this.packaged) return;

    const electronUpdater = await import("electron-updater");
    const updater = electronUpdater.autoUpdater;
    this.updater = updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.logger = console;

    updater.on("update-available", (info) => {
      this.available = info;
      this.emit(availableStatus(info));
    });
    updater.on("update-not-available", () => {
      this.available = null;
    });
    updater.on("download-progress", (progress: ProgressInfo) => {
      this.emit({
        state: "downloading",
        version: this.available?.version ?? "",
        percent: Number.isFinite(progress.percent) ? Math.round(progress.percent) : null,
      });
    });
    updater.on("update-downloaded", (info) => {
      this.downloaded = true;
      this.emit({ state: "ready", version: info.version });
      if (this.installWhenReady) this.quitAndInstall();
    });
    updater.on("error", (error) => {
      console.error("Maxx updater failed:", error);
      if (this.installWhenReady) this.emit({ state: "failed", message: error.message });
      this.installWhenReady = false;
    });

    const initial = setTimeout(() => void this.checkForUpdates(false), INITIAL_CHECK_DELAY_MS);
    initial.unref();
    const interval = setInterval(() => void this.checkForUpdates(false), CHECK_INTERVAL_MS);
    interval.unref();
  }

  async checkForUpdates(interactive: boolean): Promise<UpdateStatus | null> {
    const updater = this.updater;
    if (!this.packaged || !updater) {
      return {
        state: "unavailable",
        detail: "Updates are available in signed release builds.",
      };
    }

    if (interactive) this.emit({ state: "checking" });
    try {
      const result = await updater.checkForUpdates();
      if (result?.isUpdateAvailable) {
        this.available = result.updateInfo;
        const status = availableStatus(result.updateInfo);
        this.emit(status);
        return status;
      }
      const status: UpdateStatus = { state: "upToDate", version: this.currentVersion };
      if (interactive) this.emit(status);
      return status;
    } catch (cause) {
      const status: UpdateStatus = {
        state: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      };
      if (interactive) this.emit(status);
      else console.warn("Background update check failed:", status.message);
      return interactive ? status : null;
    }
  }

  async downloadAndInstall(): Promise<UpdateStatus> {
    const updater = this.updater;
    if (!updater || !this.available) {
      return { state: "failed", message: "No update is ready to download." };
    }
    this.installWhenReady = true;
    if (this.downloaded) {
      this.quitAndInstall();
      return { state: "ready", version: this.available.version };
    }

    const status: UpdateStatus = {
      state: "downloading",
      version: this.available.version,
      percent: 0,
    };
    this.emit(status);
    try {
      await updater.downloadUpdate();
      return status;
    } catch (cause) {
      this.installWhenReady = false;
      const failed: UpdateStatus = {
        state: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      };
      this.emit(failed);
      return failed;
    }
  }

  restartToInstall(): UpdateStatus {
    if (!this.updater || !this.available || !this.downloaded) {
      return { state: "failed", message: "No downloaded update is ready to install." };
    }
    this.quitAndInstall();
    return { state: "ready", version: this.available.version };
  }

  private quitAndInstall(): void {
    this.prepareToQuit();
    setImmediate(() => this.updater?.quitAndInstall(false, true));
  }
}
