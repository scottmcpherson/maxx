import { createHash } from "node:crypto";
import path from "node:path";

export interface BuildInstanceSettings {
  userDataPath: string | null;
  listenPort: string | null;
}

/** Keep every checkout build isolated while the installed app remains canonical. */
export function buildInstanceSettings(
  appDataPath: string,
  appName: string,
  projectDirectory: string,
  development: boolean,
  checkoutBuild: boolean,
): BuildInstanceSettings {
  if (!development && !checkoutBuild) {
    return { userDataPath: null, listenPort: null };
  }
  const checkoutID = createHash("sha256")
    .update(path.resolve(projectDirectory))
    .digest("hex")
    .slice(0, 12);
  const kind = development ? "dev" : "build";
  const portSeed = createHash("sha256")
    .update(`${kind}:${path.resolve(projectDirectory)}`)
    .digest()
    .readUInt16BE(0);
  return {
    userDataPath: path.join(appDataPath, `${appName}-${kind}-${checkoutID}`),
    // Checkout builds cannot share the installed app's canonical port, but
    // their port must survive listener and app restarts for remembered peers.
    listenPort: String(40_000 + (portSeed % 9_000)),
  };
}
