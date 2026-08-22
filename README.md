# Maxx

Maxx is a macOS desktop agent workspace built from an Electron shell, a React
renderer, and a Rust sidecar. Electron owns the native window and the embedded
Chromium browser. Rust owns workspace persistence, provider processes, agent
turns, and the browser control broker.

## Layout

```text
apps/desktop/electron/                    Electron main process, preload, browser views
apps/desktop/src/                         React 19 renderer and UI contracts
apps/desktop/src-tauri/src/               Rust sidecar and provider/browser orchestration
apps/desktop/src-tauri/crates/maxx-core/  Provider-neutral contracts and persistence
apps/desktop/script/                      Desktop build, staging, and acceptance scripts
apps/mobile/                              Expo mobile client
shared/                                   Cross-app TypeScript contracts and helpers
script/                                   Workspace development orchestration
```

Remote webpages are rendered directly in sandboxed `WebContentsView` instances
using the persistent `persist:maxx-browser` Chromium partition. Human input,
agent automation, semantic snapshots, diagnostics, annotations, and optional
screenshots all address that same tab. The React app never renders browser
screenshots as the live page.

## Develop

```sh
pnpm install
pnpm dev                  # Supervise Vite, Electron, the Rust sidecar, and Expo Metro
pnpm dev --no-mobile      # Run only the desktop stack for this checkout
pnpm dev:status           # Print a machine-readable development health snapshot
pnpm dev:list             # List every primary/worktree development environment
pnpm dev:renderer         # Vite renderer only
pnpm dev:desktop          # Electron shell only (requires Vite and the sidecar)
pnpm mobile:ios           # Build/install the Expo dev client after native changes
pnpm mobile:identity      # Show this checkout's mobile name, bundle ID, and Metro port
pnpm test                 # frontend unit tests
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --workspace
pnpm build                # renderer + Electron main/preload
```

`pnpm dev` is the normal desktop and mobile development workflow and should run
in a persistent user-owned terminal. Renderer edits use Vite/React Fast Refresh,
mobile JavaScript edits use Expo Fast Refresh, and Electron or Rust changes are
rebuilt and restarted without stopping Vite or Metro. The mobile app retries its
saved connection while active, so a native-process restart does not require a new
pairing.

The primary checkout keeps Vite on `1420`, Metro on `8081`, and the normal Maxx
Mobile identity. Linked Git worktrees automatically derive stable, nonoverlapping
renderer, Metro, and Maxx listener ports from their paths. They also receive
checkout-specific application data, labeled desktop windows, and unique mobile
names, bundle IDs, URL schemes, and secure storage. Multiple `pnpm dev` sessions
can therefore run at once without manual port flags or replacing one another's
mobile builds. Each worktree is a separate Maxx host and needs one initial mobile
pairing.

Build the Expo dev client once with `pnpm mobile:ios`, and repeat that command
only after native dependency or Expo configuration changes. During normal
iteration, use focused tests and rendered desktop/mobile checks; run the full
relevant test, build, and packaged-smoke gate once at final handoff.

Build, sign, and smoke-test an isolated local macOS preview without opening a
persistent app window:

```sh
pnpm desktop:verify
```

Launch the built preview explicitly with `pnpm desktop:run`.

The primary checkout produces `Maxx Preview` with bundle ID `com.maxx.preview`.
Linked worktrees add their label and stable worktree ID so packaged previews can
run concurrently. These previews use isolated data and have updates disabled.

## macOS releases

Maxx publishes one universal macOS release that runs natively on Apple Silicon
and Intel Macs. A version tag on `main` runs the release workflow in this
repository. The workflow builds both Rust runtime architectures, packages a
universal Electron app, signs it with a Developer ID certificate, notarizes it
with Apple, and publishes DMG/ZIP update artifacts to the matching GitHub
release. It then downloads the published DMG, mounts it, and repeats the
signature, notarization-ticket, Gatekeeper, and application smoke checks.

This repository needs these GitHub Actions secrets:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting that `.p12`
- `APPLE_SIGNING_IDENTITY`: certificate subject without its type prefix, such as
  `Scott McPherson (B2FG8SZJA6)`
- `APPLE_ID`: Apple developer account email
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for notarization
- `APPLE_TEAM_ID`: Apple Developer team ID

Cut a release only from the intended commit on `main`:

```sh
VERSION="$(node -p "require('./apps/desktop/package.json').version")"
git tag "v$VERSION"
git push origin main "v$VERSION"
```

The in-app updater uses the `latest-mac.yml` and signed ZIP assets generated by
electron-builder from this repository's public GitHub releases.

The app bundle is written to `apps/desktop/release/mac-arm64/Maxx.app` on Apple
Silicon or `apps/desktop/release/mac/Maxx.app` on Intel. Browser cookies, site storage, downloads, and
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
