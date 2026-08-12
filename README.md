# Maxx

Maxx is a macOS desktop agent workspace built from an Electron shell, a React
renderer, and a Rust sidecar. Electron owns the native window and the embedded
Chromium browser. Rust owns workspace persistence, provider processes, agent
turns, and the browser control broker.

## Layout

```text
electron/                       Electron main process, preload, browser views
src/                            React 19 renderer and UI contracts
src-tauri/src/                  Rust sidecar and provider/browser orchestration
src-tauri/crates/maxx-core/     Provider-neutral contracts and persistence
script/build_and_run.sh         Canonical packaged-app build and launch
```

Remote webpages are rendered directly in sandboxed `WebContentsView` instances
using the persistent `persist:maxx-browser` Chromium partition. Human input,
agent automation, semantic snapshots, diagnostics, annotations, and optional
screenshots all address that same tab. The React app never renders browser
screenshots as the live page.

## Develop

```sh
pnpm install
pnpm dev                  # Vite renderer
pnpm dev:desktop          # Electron shell (run Vite separately)
pnpm test                 # frontend unit tests
cargo test --manifest-path src-tauri/Cargo.toml --workspace
pnpm build                # renderer + Electron main/preload
```

Build and launch the actual macOS application with:

```sh
./script/build_and_run.sh --verify
```

The app bundle is written to `release/mac-arm64/Maxx.app` on Apple Silicon or
`release/mac/Maxx.app` on Intel. Browser cookies, site storage, downloads, and
the encrypted imported-credential vault live under Maxx application data and
are not packaged into the application.

## Security boundaries

- The app renderer and every remote page are separate sandboxed web contents.
- Only the app renderer receives the narrow preload bridge; remote pages never
  receive filesystem, sidecar, or Electron APIs.
- The main process validates IPC senders and allowlists commands.
- Browser navigation accepts only absolute HTTP(S) URLs.
- Chrome credentials are decrypted only in the main process, then re-encrypted
  with Electron `safeStorage`; plaintext is never returned to React or Rust.
- Media URLs are limited to picker-authorized files and Rust-validated message
  paths.
- Traces and screenshots are explicit, size-bounded artifacts.

See [docs/browser-runtime-engine-decision.md](docs/browser-runtime-engine-decision.md)
and [docs/native-integration.md](docs/native-integration.md) for the current
architecture and operational details.
