import { copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "build");
const output = path.join(outputDirectory, "maxx-runtime");
const universal = process.argv.includes("--universal");

mkdirSync(outputDirectory, { recursive: true });

if (universal) {
  const arm64 = path.join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "maxx");
  const x64 = path.join(root, "src-tauri", "target", "x86_64-apple-darwin", "release", "maxx");
  execFileSync("lipo", ["-create", arm64, x64, "-output", output], { stdio: "inherit" });
  const architectures = execFileSync("lipo", ["-archs", output], { encoding: "utf8" }).trim();
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    throw new Error(`Universal runtime is missing an architecture: ${architectures}`);
  }
  console.log(`Staged universal Maxx runtime (${architectures}).`);
} else {
  copyFileSync(path.join(root, "src-tauri", "target", "release", "maxx"), output);
  console.log("Staged the native Maxx runtime.");
}

chmodSync(output, 0o755);
