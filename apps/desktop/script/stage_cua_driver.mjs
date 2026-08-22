import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.21.0";
const ARCHIVE_SHA256 = "5e327e58f6ce81d5c117fe5edec5f267e87e1b921e8c5a8aa4f7f21cbcf5f273";
const ARCHIVE = `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`;
const URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${ARCHIVE}`;
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repository, "build", "cua-driver");
const marker = path.join(repository, "build", ".cua-driver-version");
await mkdir(path.dirname(output), { recursive: true });

async function findDriver(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findDriver(candidate);
      if (nested) return nested;
    } else if (entry.name === "cua-driver" || entry.name === "cua-driver-rs") {
      return candidate;
    }
  }
  return null;
}

try {
  if ((await readFile(marker, "utf8")).trim() === VERSION) {
    await chmod(output, 0o755);
    process.stdout.write(`Cua Driver ${VERSION} is already staged at ${output}\n`);
    process.exit(0);
  }
} catch {
  // Missing or stale marker: download and verify the pinned release.
}

const temporary = await mkdtemp(path.join(tmpdir(), "maxx-cua-"));
try {
  const response = await fetch(URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`Cua Driver download failed (${response.status})`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== ARCHIVE_SHA256) {
    throw new Error(`Cua Driver checksum mismatch: expected ${ARCHIVE_SHA256}, received ${actual}`);
  }
  const archivePath = path.join(temporary, ARCHIVE);
  await writeFile(archivePath, archive);
  execFileSync("tar", ["-xzf", archivePath, "-C", temporary], { stdio: "inherit" });
  const driver = await findDriver(temporary);
  if (!driver) throw new Error("The Cua Driver archive did not contain cua-driver");
  await copyFile(driver, output);
  await chmod(output, 0o755);
  await writeFile(marker, `${VERSION}\n`);
  process.stdout.write(`Staged verified Cua Driver ${VERSION} at ${output}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
