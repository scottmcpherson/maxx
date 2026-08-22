# Native macOS integration

Electron owns the macOS application lifecycle. The Rust executable is a private
sidecar and has no window-system responsibility.

## Components

| Concern | Owner |
| --- | --- |
| Main window, menu, tray, notifications | `apps/desktop/electron/main.ts` |
| Restricted renderer bridge | `apps/desktop/electron/preload.cts` |
| Visible Chromium tabs and CDP automation | `apps/desktop/electron/browser-manager.ts` |
| Chrome cookies and credential import | `apps/desktop/electron/chrome-importer.ts` |
| Workspace, providers, browser broker | `apps/desktop/src-tauri/src/sidecar.rs` and Rust modules |

The main React renderer is sandboxed with context isolation and no Node.js.
Remote browser tabs are separate sandboxed `WebContentsView`s using the
`persist:maxx-browser` session and do not receive a preload script. IPC accepts
messages only from the main renderer and only for an explicit allowlist.

## Window and menu lifecycle

Closing the window hides it so the tray and Dock can reopen it. Quit shuts down
browser views and asks the Rust sidecar to stop before Electron exits. The
native application, Edit, View, and Window menus preserve macOS responder-chain
behavior even while a browser view has keyboard focus. Remappable sidebar
accelerators are installed in the native menu at runtime.

## Browser lifecycle

Each tab owns one visible `WebContentsView`. The manager publishes start,
commit, stop, title, history, and renderer-crash state to React. Popups are
redirected into the selected tab and non-HTTP(S) top-level navigation is denied.
Downloads go to the Maxx browser-downloads directory and publish progress.

Electron CDP is used for semantic snapshots and agent input. A binding installed
in every committed document reports real pointer, wheel, touch, and keyboard
input to the Rust control broker. That increments the tab control epoch so a
human immediately takes precedence over an in-flight agent action.

## Chrome import

The browser banner discovers Chrome profiles but performs no import until the
user chooses one. The main process copies Chrome's SQLite databases before
reading them, obtains the Chrome Safe Storage key from macOS Keychain, and
imports valid cookies into the persistent Electron session.

Passwords are not exposed to React, Rust, logs, or browser diagnostics. They
are decrypted in the main process, immediately re-encrypted with Electron
`safeStorage`, and written to a mode-0600 vault. Filling is a separate explicit
action for the current origin; the main process injects values into a visible
login form and returns only success or failure.

## Annotation

Annotation mode installs a temporary DOM overlay into the current page. Hover
highlights the actual element; click opens an instruction editor over the
target. Confirming returns a bounded payload with the instruction, selector,
tag, accessibility role/name, visible text, page rectangle, and a small local
preview. The main process validates and sizes the payload before React can
attach it to a prompt. Hovering a numbered page marker shows its saved
instruction. Cancelling restores the annotations that existed before the
session; the toolbar Send action submits the staged group directly as a chat
message, and both pending and sent groups render as one hoverable summary.
Disabling annotation removes the overlay and listeners from the page.

## Media and permissions

The `maxx-media` protocol serves only picker-authorized files, app-owned
agent/chat image directories, or files that Rust has resolved as belonging to
the current thread. Remote browser views receive no microphone, camera,
geolocation, notification, or filesystem permission. The app renderer can
request microphone access for voice dictation only.

## Build and verification

The canonical local workflow is:

```sh
pnpm desktop:verify
```

It builds the optimized Rust sidecar, type-checks and bundles React, compiles
Electron, creates the `.app`, ad-hoc signs it, and runs the packaged smoke test
without leaving a persistent window open. Launch the preview explicitly with
`pnpm desktop:run`. Distribution signing, notarization, and a production updater
require the maintainer's Apple credentials and release endpoint.
