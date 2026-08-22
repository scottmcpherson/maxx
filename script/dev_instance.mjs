import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function hash(root, namespace) {
  return createHash("sha256").update(`${namespace}:${path.resolve(root)}`).digest();
}

function rangedPort(root, namespace, start, size) {
  return start + (hash(root, namespace).readUInt16BE(0) % size);
}

function safeLabel(value) {
  const label = value
    .trim()
    .replace(/^refs\/heads\//u, "")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return label || "detached";
}

export function deriveDevInstance(root, { primary, label }) {
  const resolvedRoot = path.resolve(root);
  const rootHash = createHash("sha256").update(resolvedRoot).digest("hex");
  const id = `w${rootHash.slice(0, 8)}`;
  const checkoutID = rootHash.slice(0, 12);
  const candidateLabel = safeLabel(label);
  const displayLabel = candidateLabel === "detached" ? `worktree-${rootHash.slice(0, 6)}` : candidateLabel;
  const rendererPort = primary ? 1420 : rangedPort(resolvedRoot, "renderer", 15_000, 2_000);
  const metroPort = primary ? 8081 : rangedPort(resolvedRoot, "metro", 17_000, 2_000);
  const listenPort = 40_000 + (hash(resolvedRoot, "dev").readUInt16BE(0) % 9_000);
  return {
    root: resolvedRoot,
    id,
    checkoutID,
    primary,
    label: displayLabel,
    rendererPort,
    rendererURL: `http://localhost:${rendererPort}`,
    metroPort,
    listenPort,
    mobileName: primary ? "Maxx Mobile" : `Maxx Mobile - ${displayLabel}`,
    mobileBundleID: primary ? "com.maxx.mobile" : `com.maxx.mobile.dev.${id}`,
    mobileScheme: primary ? "maxx-mobile" : `maxx-mobile-${id}`,
    previewName: primary ? "Maxx Preview" : `Maxx Preview - ${displayLabel}`,
    previewBundleID: primary ? "com.maxx.preview" : `com.maxx.preview.${id}`,
  };
}

function gitLabel(root) {
  try {
    const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    const branch = execFileSync("git", ["-C", root, "branch", "--show-current"], options).trim();
    if (branch) return branch;
    return "detached";
  } catch {
    return path.basename(root);
  }
}

export function loadDevInstance(root) {
  const resolvedRoot = path.resolve(root);
  let primary = false;
  try {
    primary = statSync(path.join(resolvedRoot, ".git")).isDirectory();
  } catch {
    // A missing or file-based .git entry is treated as a linked worktree.
  }
  return deriveDevInstance(resolvedRoot, { primary, label: gitLabel(resolvedRoot) });
}

export function devInstanceEnvironment(instance, environment = process.env) {
  return {
    ...environment,
    MAXX_DEV_INSTANCE_ID: instance.id,
    MAXX_DEV_LABEL: instance.label,
    MAXX_DEV_PRIMARY: instance.primary ? "1" : "0",
    MAXX_RENDERER_PORT: String(instance.rendererPort),
    MAXX_RENDERER_URL: instance.rendererURL,
    MAXX_METRO_PORT: String(instance.metroPort),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const instance = loadDevInstance(root);
  const fieldIndex = process.argv.indexOf("--field");
  if (fieldIndex >= 0) {
    const field = process.argv[fieldIndex + 1];
    if (!field || !(field in instance) || typeof instance[field] === "object") {
      process.stderr.write(`Unknown development-instance field: ${field || ""}\n`);
      process.exit(2);
    }
    process.stdout.write(`${instance[field]}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(instance)}\n`);
  }
}
