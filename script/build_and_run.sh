#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="Maxx"
BUNDLE_ID="com.maxx.app"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/src-tauri/target}"
APP_BUNDLE="$TARGET_DIR/debug/bundle/macos/Maxx.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/maxx"
APP_BINARY_PATTERN="${APP_BINARY//./\\.}"

# The native app and the Tauri port intentionally share a display name. Scope
# lifecycle management to this bundle's executable path so the Swift app and
# any unbundled Tauri dev server are left alone.
pkill -f "$APP_BINARY_PATTERN" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
# `--no-sign`: bundle.createUpdaterArtifacts is on, and the CLI refuses to build
# whenever plugins.updater.pubkey exists without TAURI_SIGNING_PRIVATE_KEY —
# which is every local build, since no signing key lives in this repo. Release
# builds sign for real; see docs/native-integration.md.
pnpm tauri build --debug --bundles app --no-sign

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    for _ in {1..30}; do
      pgrep -f "$APP_BINARY_PATTERN" >/dev/null && exit 0
      sleep 0.1
    done
    exit 1
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
