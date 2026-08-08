#!/usr/bin/env bash
set -euo pipefail

# Browser payloads are pinned independently from the Maxx application so a
# release build cannot silently change its Chromium/CDP behavior.
VERSION="151.0.7922.71"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_ROOT="$ROOT_DIR/src-tauri/browser-runtime"

case "$(uname -m)" in
  arm64)
    PLATFORM="mac-arm64"
    SHA256="a873b850acb443ebd801cd6fc09b77806c379a13230f41bba260226d8877a5d9"
    ;;
  x86_64)
    PLATFORM="mac-x64"
    SHA256="0603577363df323e57f9dd9aa72c49253374ff6718c7c1a5d0d0f29c59772844"
    ;;
  *)
    echo "unsupported Maxx browser runtime architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

ARCHIVE_NAME="chrome-headless-shell-$PLATFORM.zip"
PAYLOAD_NAME="chrome-headless-shell-$PLATFORM"
DESTINATION="$RESOURCE_ROOT/$PAYLOAD_NAME"
VERSION_FILE="$DESTINATION/MAXX_BROWSER_VERSION"
EXECUTABLE="$DESTINATION/chrome-headless-shell"
URL="https://storage.googleapis.com/chrome-for-testing-public/$VERSION/$PLATFORM/$ARCHIVE_NAME"

if [[ -x "$EXECUTABLE" ]] && [[ -f "$VERSION_FILE" ]] &&
   [[ "$(<"$VERSION_FILE")" == "$VERSION" ]]; then
  exit 0
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/maxx-browser-runtime.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
ARCHIVE="$WORK_DIR/$ARCHIVE_NAME"

if [[ -n "${MAXX_BROWSER_ARCHIVE:-}" ]]; then
  cp "$MAXX_BROWSER_ARCHIVE" "$ARCHIVE"
else
  curl -fsSL --retry 3 -o "$ARCHIVE" "$URL"
fi

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$SHA256" ]]; then
  echo "browser runtime checksum mismatch: expected $SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi

unzip -q "$ARCHIVE" -d "$WORK_DIR/unpacked"
STAGED="$WORK_DIR/unpacked/$PAYLOAD_NAME"
if [[ ! -x "$STAGED/chrome-headless-shell" ]]; then
  echo "browser runtime archive does not contain $PAYLOAD_NAME/chrome-headless-shell" >&2
  exit 1
fi

printf '%s' "$VERSION" > "$STAGED/MAXX_BROWSER_VERSION"
mkdir -p "$RESOURCE_ROOT"
rm -rf "$DESTINATION"
mv "$STAGED" "$DESTINATION"

echo "Prepared Maxx browser runtime $VERSION for $PLATFORM"
