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
  return {
    userDataPath: path.join(appDataPath, `${appName}-${kind}-${checkoutID}`),
    // Port zero asks the OS for an available port. The runtime reports the
    // actual value in the address users copy from Connections.
    listenPort: "0",
  };
}
