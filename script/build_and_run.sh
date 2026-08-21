#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="maxx.original"
BUNDLE_ID="com.maxx.original"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/release/mac-arm64/maxx.original.app"
if [[ "$(uname -m)" == "x86_64" ]]; then
  APP_BUNDLE="$ROOT_DIR/release/mac/maxx.original.app"
fi
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
RUNTIME_BINARY="$APP_BUNDLE/Contents/Resources/bin/maxx-runtime"
APP_BINARY_PATTERN="${APP_BINARY//./\.}"
RUNTIME_BINARY_PATTERN="${RUNTIME_BINARY//./\.}"

# Replace only this checkout's previous build. Installed Maxx and builds from
# other checkouts keep running with their own data directories and ports.
pkill -TERM -f "$APP_BINARY_PATTERN" >/dev/null 2>&1 || true
for _ in {1..30}; do
  if ! pgrep -f "$APP_BINARY_PATTERN" >/dev/null; then
    break
  fi
  sleep 0.1
done
pkill -f "$RUNTIME_BINARY_PATTERN" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
cargo build --release --manifest-path src-tauri/Cargo.toml
node script/stage_runtime.mjs
node script/stage_cua_driver.mjs
"$ROOT_DIR/node_modules/.bin/tsc" --noEmit
"$ROOT_DIR/node_modules/.bin/vite" build
"$ROOT_DIR/node_modules/.bin/tsc" -p electron/tsconfig.json
CSC_IDENTITY_AUTO_DISCOVERY=false "$ROOT_DIR/node_modules/.bin/electron-builder" --mac dir \
  --config.productName="$APP_NAME" \
  --config.appId="$BUNDLE_ID"
/usr/bin/codesign --force --deep --sign - "$APP_BUNDLE"
/usr/bin/codesign --verify --deep --strict "$APP_BUNDLE"

open_app() {
  /usr/bin/open -n "$APP_BUNDLE" --args --checkout-build
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY" --checkout-build
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
    "$APP_BINARY" --app-smoke --checkout-build
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
