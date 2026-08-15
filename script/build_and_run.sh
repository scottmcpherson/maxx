#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="Maxx"
BUNDLE_ID="com.maxx.app"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/release/mac-arm64/Maxx.app"
if [[ "$(uname -m)" == "x86_64" ]]; then
  APP_BUNDLE="$ROOT_DIR/release/mac/Maxx.app"
fi
APP_BINARY="$APP_BUNDLE/Contents/MacOS/Maxx"
RUNTIME_BINARY="$APP_BUNDLE/Contents/Resources/bin/maxx-runtime"
APP_BINARY_PATTERN="${APP_BINARY//./\.}"
RUNTIME_BINARY_PATTERN="${RUNTIME_BINARY//./\.}"
ANY_MAXX_APP_PATTERN='/Maxx\.app/Contents/MacOS/Maxx$'

# Electron's single-instance lock is shared by every Maxx bundle. Leaving a
# build from another checkout alive makes macOS foreground that older app
# instead of this freshly built bundle, so replace the active Maxx instance.
pkill -TERM -f "$ANY_MAXX_APP_PATTERN" >/dev/null 2>&1 || true
for _ in {1..30}; do
  if ! pgrep -f "$ANY_MAXX_APP_PATTERN" >/dev/null; then
    break
  fi
  sleep 0.1
done
pkill -f "$RUNTIME_BINARY_PATTERN" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
cargo build --release --manifest-path src-tauri/Cargo.toml
node script/stage_runtime.mjs
"$ROOT_DIR/node_modules/.bin/tsc" --noEmit
"$ROOT_DIR/node_modules/.bin/vite" build
"$ROOT_DIR/node_modules/.bin/tsc" -p electron/tsconfig.json
"$ROOT_DIR/node_modules/.bin/electron-builder" --mac dir

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
    "$APP_BINARY" --app-smoke
    open_app
    for _ in {1..50}; do
      pgrep -f "$APP_BINARY_PATTERN" >/dev/null && exit 0
      sleep 0.1
    done
    echo "Maxx did not stay running after launch" >&2
    exit 1
    ;;
  --browser-smoke|browser-smoke)
    "$APP_BINARY" --browser-smoke
    ;;
  --hermes-browser-smoke|hermes-browser-smoke)
    "$APP_BINARY" --hermes-browser-smoke
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify|--browser-smoke|--hermes-browser-smoke]" >&2
    exit 2
    ;;
esac
