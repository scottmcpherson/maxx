#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
APP_NAME="$(node "$WORKSPACE_ROOT/script/dev_instance.mjs" --field previewName)"
BUNDLE_ID="$(node "$WORKSPACE_ROOT/script/dev_instance.mjs" --field previewBundleID)"
APP_BUNDLE="$DESKTOP_DIR/release/mac-arm64/$APP_NAME.app"
if [[ "$(uname -m)" == "x86_64" ]]; then
  APP_BUNDLE="$DESKTOP_DIR/release/mac/$APP_NAME.app"
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

cd "$DESKTOP_DIR"
cargo build --release --manifest-path src-tauri/Cargo.toml
node script/stage_runtime.mjs
node script/stage_cua_driver.mjs
"$DESKTOP_DIR/node_modules/.bin/tsc" --noEmit
"$DESKTOP_DIR/node_modules/.bin/vite" build
"$DESKTOP_DIR/node_modules/.bin/tsc" -p electron/tsconfig.json
CSC_IDENTITY_AUTO_DISCOVERY=false "$DESKTOP_DIR/node_modules/.bin/electron-builder" --mac dir \
  --config.productName="$APP_NAME" \
  --config.appId="$BUNDLE_ID"
/usr/bin/codesign --force --deep --sign - "$APP_BUNDLE"
/usr/bin/codesign --verify --deep --strict "$APP_BUNDLE"

open_app() {
  /usr/bin/open -n "$APP_BUNDLE" --args --checkout-build "--bundle-id=$BUNDLE_ID"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY" --checkout-build "--bundle-id=$BUNDLE_ID"
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
    "$APP_BINARY" --app-smoke --checkout-build "--bundle-id=$BUNDLE_ID"
    ;;
  --browser-smoke|browser-smoke)
    "$APP_BINARY" --browser-smoke "--bundle-id=$BUNDLE_ID"
    ;;
  --hermes-browser-smoke|hermes-browser-smoke)
    "$APP_BINARY" --hermes-browser-smoke "--bundle-id=$BUNDLE_ID"
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify|--browser-smoke|--hermes-browser-smoke]" >&2
    exit 2
    ;;
esac
