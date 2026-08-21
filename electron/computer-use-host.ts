import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { shell, systemPreferences } from "electron";
import type { MacOSPermissionStatus } from "@trycua/cua-driver/electron";
import { computerUseMcpArgs, computerUseServeArgs } from "./computer-use-launch.js";

const execFileAsync = promisify(execFile);

interface EmbeddedConnection {
  driverVersion: string;
  mcp: {
    command: string;
    args: string[];
    environment: Array<{ name: string; value: string }>;
  };
}

export interface ComputerUseHostStatus {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  permissions: MacOSPermissionStatus;
  driverVersion?: string;
  message?: string;
}

export interface ComputerUseStartResult {
  ready: boolean;
  status: ComputerUseHostStatus;
  mcp?: {
    command: string;
    args: string[];
    environment: Record<string, string>;
  };
}

/** Owns the embedded Cua daemon under Maxx's signed macOS identity. */
export class ComputerUseHost {
  readonly #binaryPath: string;
  readonly #bundleID: string;
  readonly #development: boolean;
  #child: ChildProcess | null = null;
  #connection: EmbeddedConnection | undefined;
  #socketPath: string | undefined;
  #existingBrowserProfiles = false;
  #driverVersion: string | undefined;

  constructor(binaryPath: string, bundleID: string, development: boolean) {
    this.#binaryPath = binaryPath;
    this.#bundleID = bundleID;
    this.#development = development;
  }

  #permissions(): MacOSPermissionStatus {
    if (process.platform !== "darwin") return { accessibility: false, screenRecording: false };
    return {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
    };
  }

  status(enabled: boolean): ComputerUseHostStatus {
    const supported = process.platform === "darwin";
    const permissions = this.#permissions();
    const binaryPresent = existsSync(this.#binaryPath);
    return {
      supported,
      enabled,
      running: Boolean(this.#child && this.#child.exitCode === null && this.#connection),
      permissions,
      driverVersion: this.#driverVersion,
      ...(!supported
        ? { message: "Built-in Computer Use currently requires macOS." }
        : !binaryPresent
          ? { message: "The embedded Cua driver is missing. Rebuild Maxx to stage it." }
          : !permissions.accessibility || !permissions.screenRecording
            ? { message: "Allow Accessibility and Screen Recording for Maxx, then try again." }
            : {}),
    };
  }

  async start(
    enabled: boolean,
    requestPermissions: boolean,
    existingBrowserProfiles: boolean,
  ): Promise<ComputerUseStartResult> {
    const initial = this.status(enabled);
    const permissionAPI = requestPermissions
      ? await import("@trycua/cua-driver/electron")
      : null;
    const permissions = enabled && permissionAPI
      ? permissionAPI.requestMacOSPermissions()
      : initial.permissions;
    const status = { ...initial, permissions };
    if (!enabled || !status.supported || !existsSync(this.#binaryPath)
      || !status.permissions.accessibility || !status.permissions.screenRecording) {
      return { ready: false, status };
    }
    if (this.#child && this.#existingBrowserProfiles !== existingBrowserProfiles) {
      await this.stop();
    }
    const connection = this.#connection ?? await this.#startDriver(existingBrowserProfiles);
    this.#driverVersion = connection.driverVersion;
    const readyStatus = this.status(enabled);
    return {
      ready: true,
      status: readyStatus,
      mcp: {
        command: connection.mcp.command,
        args: [...connection.mcp.args],
        environment: Object.fromEntries(
          connection.mcp.environment.map(({ name, value }) => [name, value]),
        ),
      },
    };
  }

  async #startDriver(existingBrowserProfiles: boolean): Promise<EmbeddedConnection> {
    const socketPath = path.join(
      tmpdir(),
      `maxx-cua-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
    );
    const args = computerUseServeArgs(socketPath, this.#bundleID, existingBrowserProfiles);
    const child = spawn(this.#binaryPath, args, {
      env: {
        ...process.env,
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: this.#bundleID,
        CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
      },
      stdio: ["pipe", "ignore", this.#development ? "inherit" : "ignore"],
    });
    child.stdin?.on("error", () => undefined);
    this.#child = child;
    this.#socketPath = socketPath;
    this.#existingBrowserProfiles = existingBrowserProfiles;
    try {
      await waitForSocket(socketPath, child);
      const { stdout } = await execFileAsync(this.#binaryPath, ["--version"]);
      const driverVersion = stdout.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? stdout.trim();
      const connection: EmbeddedConnection = {
        driverVersion,
        mcp: {
          command: this.#binaryPath,
          args: computerUseMcpArgs(socketPath, this.#bundleID),
          environment: [],
        },
      };
      this.#connection = connection;
      child.once("exit", () => {
        if (this.#child !== child) return;
        this.#child = null;
        this.#connection = undefined;
        this.#driverVersion = undefined;
        void rm(socketPath, { force: true });
      });
      return connection;
    } catch (error) {
      child.kill("SIGTERM");
      this.#child = null;
      this.#socketPath = undefined;
      await rm(socketPath, { force: true });
      throw error;
    }
  }

  async openSettings(enabled: boolean): Promise<ComputerUseHostStatus> {
    const status = this.status(enabled);
    if (!status.permissions.accessibility) {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    } else if (!status.permissions.screenRecording) {
      const { openMacOSScreenRecordingSettings } = await import("@trycua/cua-driver/electron");
      await openMacOSScreenRecordingSettings();
    }
    return status;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const socketPath = this.#socketPath;
    this.#child = null;
    this.#connection = undefined;
    this.#socketPath = undefined;
    this.#driverVersion = undefined;
    if (child && child.exitCode === null) {
      child.stdin?.end();
      await waitForExit(child, 5_000);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    if (socketPath) await rm(socketPath, { force: true });
  }
}

function waitForSocket(socketPath: string, child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const tryConnect = () => {
      if (child.exitCode !== null) {
        reject(new Error(`Cua Driver exited during startup (${child.exitCode})`));
        return;
      }
      const socket = createConnection(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error("Cua Driver did not bind its embedded socket within 10 seconds"));
        } else {
          setTimeout(tryConnect, 50);
        }
      });
    };
    tryConnect();
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export function computerUseBinaryPath(projectDirectory: string, packaged: boolean): string {
  return packaged
    ? path.join(process.resourcesPath, "bin", "cua-driver")
    : path.join(projectDirectory, "build", "cua-driver");
}
