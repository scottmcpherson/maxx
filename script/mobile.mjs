import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devInstanceEnvironment, loadDevInstance } from "./dev_instance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mobileRoot = path.join(root, "apps", "mobile");
const expoBinary = path.join(mobileRoot, "node_modules", ".bin", "expo");
const instance = loadDevInstance(root);
const environment = devInstanceEnvironment(instance, {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, "--dns-result-order=ipv4first"].filter(Boolean).join(" "),
});
const action = process.argv[2];
const forwardedArguments = process.argv.slice(3);

function runExpo(args, label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`[mobile] ${label}: ${instance.mobileName} (${instance.mobileBundleID}), Metro ${instance.metroPort}\n`);
    const child = spawn(expoBinary, args, {
      cwd: mobileRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${code ?? signal ?? "unknown"})`));
    });
  });
}

async function main() {
  switch (action) {
    case "start":
      await runExpo([
        "start",
        "--dev-client",
        "--scheme",
        instance.mobileScheme,
        "--port",
        String(instance.metroPort),
        ...forwardedArguments,
      ], "Starting Metro");
      return;
    case "ios":
      await runExpo(["prebuild", "--platform", "ios", "--no-install"], "Preparing the iOS worktree variant");
      await runExpo(["run:ios", "--no-bundler", "--port", String(instance.metroPort), ...forwardedArguments], "Building the iOS worktree variant");
      return;
    case "config":
      await runExpo(["config", "--json"], "Reading the mobile worktree identity");
      return;
    case "identity":
      process.stdout.write(`MAXX_MOBILE_IDENTITY ${JSON.stringify({
        id: instance.id,
        label: instance.label,
        primary: instance.primary,
        name: instance.mobileName,
        bundleID: instance.mobileBundleID,
        scheme: instance.mobileScheme,
        metroPort: instance.metroPort,
      })}\n`);
      return;
    default:
      throw new Error("usage: node script/mobile.mjs [start|ios|config|identity]");
  }
}

main().catch((error) => {
  process.stderr.write(`[mobile] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
