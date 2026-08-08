# Native macOS integration

What ships in the app today (menu bar, tray, notifications, updater), how the
pieces fit, and the one part that cannot be finished without the maintainer's
own signing key and hosting.

| Feature | Source | Status |
| --- | --- | --- |
| Application menu | `src-tauri/src/menu.rs`, `src/menu.ts` | Complete |
| Menu-bar extra (tray) | `src-tauri/src/tray.rs`, `src-tauri/icons/tray.png` | Complete |
| Background turn notifications | `src-tauri/src/notify.rs`, hooked in `src-tauri/src/state.rs` | Complete |
| Updater | `src-tauri/src/updater.rs`, `src/updates.ts`, `src/components/UpdateToast.tsx` | **Needs a key + endpoint** (below) |

---

## 1. Menu bar

`tauri::Builder::menu(menu::build)` in `src-tauri/src/lib.rs` installs the menu.

### The Edit submenu is functional, not decorative

Before this change the app never called `Builder::menu`, so Tauri applied
`Menu::default` — `enable_macos_default_menu` defaults to `true`. That default
is what gave the webview Cmd+C/V/X/A/Z: muda builds the predefined clipboard
items as `NSMenuItem`s with a selector and **no target**, so `copy:` / `paste:`
travel the responder chain into the `WKWebView`.

Calling `Builder::menu` replaces that default **wholesale**. A custom menu
without an Edit submenu silently removes copy and paste app-wide. `menu.rs`
therefore keeps Undo / Redo / Cut / Copy / Paste / Select All, and this is
asserted at review time with:

```bash
PID=$(pgrep -f 'Maxx\.app/Contents/MacOS/maxx')
osascript -e "tell application \"System Events\" to tell (first process whose unix id is $PID) \
  to get name of menu items of menu 1 of menu bar item \"Edit\" of menu bar 1"
# must list: Undo, Redo, missing value, Cut, Copy, Paste, Select All
```

### Structure

- **Maxx** — About, Check for Updates…, Settings… (⌘,), Services, Hide / Hide
  Others / Show All, Quit.
- **File** — New Thread (⌘N), Search… (⌘K), Close Window.
- **Edit** — the six predefined clipboard items (see above).
- **View** — Toggle Sidebar, Toggle Browser Pane, Zoom In (⌘=), Zoom Out (⌘-),
  Actual Size (⌘0), Full Screen.
- **Window** — Minimize, Zoom, Close. Carries `WINDOW_SUBMENU_ID` so Tauri
  wires the native window list.
- **Help** — carries `HELP_SUBMENU_ID` so macOS adds the Help search field.

### Menu vs. in-app keyboard handler

Custom items have no behaviour in Rust. They emit `menu://action` with a string
id, and `src/App.tsx` dispatches to the **existing** zustand actions
(`setSettingsOpen`, `startNewThread`, `setSearchOpen`, `toggleSidebar`,
`toggleBrowser`) or to the `ZoomControls` handle. There is one implementation of
each command, not a native and a web copy.

Deduplication works in two directions:

1. **The menu owns its accelerators.** `⌘,` `⌘N` `⌘K` `⌘=` `⌘-` `⌘0` are listed
   in `NATIVE_MENU_SHORTCUT_KEYS` (`src/menu.ts`). The `keydown` handler in
   `App.tsx` calls `isNativeMenuShortcut(event)` first and returns. AppKit
   already consumes key equivalents before the `WKWebView` sees them, so nothing
   double-fires in practice — the explicit check is there so the guarantee does
   not depend on that platform behaviour. The ⌘N / ⌘K / ⌘, branches were removed
   from the handler outright rather than left as unreachable code.
2. **The remappable bindings become accelerators at runtime.** Toggle Sidebar
   and Toggle Browser Pane are user-remappable in Settings → Keyboard Shortcuts,
   so their menu items carry no *static* accelerator — a fixed key equivalent
   would shadow whatever the user rebinds them to. Instead `App.tsx` renders the
   live binding with `menuAcceleratorFor` (`src/menu.ts`) and installs it
   through the `set_shortcut_accelerators` command (`src-tauri/src/menu.rs`),
   which rewrites the two items' key equivalents.

   This is not cosmetic. The browser pane's page lives in a **child**
   `WKWebView`; while it holds first responder, a `keydown` listener in the
   app's own webview never runs, so a shortcut implemented only there is dead
   exactly when the pane is in use. AppKit matches menu key equivalents before
   any webview sees the event, which is the only mechanism that survives the
   focus split. The `keydown` handler stays as the fallback for a binding muda
   has no `Code` for (`menuAcceleratorFor` returns `null`, the item is left
   bare). `menu.test.ts` asserts that no default remappable binding is claimed
   by the *static* `isNativeMenuShortcut` list.

Note the one case that must keep working through the *web* handler: on a US
layout "zoom in" is often typed as ⌘⇧= (i.e. ⌘+). muda matches modifier flags
exactly, so the ⌘= accelerator does not fire and `App.tsx` still handles it.

---

## 2. Menu-bar extra (tray)

`src-tauri/src/tray.rs`, built from `.setup()`.

- Menu: Show Maxx · Hide Maxx · New Thread · Settings… · Quit Maxx (⌘Q).
  New Thread and Settings raise the window first, then emit the same
  `menu://action` event the menu bar uses.
- Left click toggles the window (hide only when it is already visible **and**
  focused, so a click from another app raises Maxx instead of hiding it). Right
  click opens the menu — `show_menu_on_left_click(false)` is what frees the left
  click for this.
- `src-tauri/icons/tray.png` is a 36×36 macOS **template** image: pure black
  plus alpha, so AppKit recolours it for light/dark menu bars and for the
  highlighted state. Do not swap in the full-colour app icon — a template uses
  the alpha channel only, so a colour icon renders as a black blob. tray-icon
  scales whatever you give it to 18 pt tall, so 36 px is exactly @2x.

### Closing the window does not orphan the app

`.on_window_event` intercepts `CloseRequested` for the `main` window,
`prevent_close()`s it, and hides the window instead. The window is never
destroyed, so:

- the tray's "Show Maxx" (and a left click) always bring it back;
- clicking the Dock icon brings it back: `app.run` handles `RunEvent::Reopen`
  (`src-tauri/src/lib.rs`) by calling `tray::show_main_window`. Without that arm
  the app just comes to the front with no window, because tao answers
  `applicationShouldHandleReopen` with `has_visible_windows` — false once the
  window is hidden — which tells AppKit to skip its own restore behaviour;
- every menu-bar action raises the window first (`menu::on_event`), for the same
  reason the tray's do: the store action would otherwise mutate state the user
  cannot see;
- the exit path is untouched — ⌘Q and the tray's Quit item (`app.exit(0)`) both
  terminate the process normally.

This is deliberately *not* the `RunEvent::ExitRequested` + `prevent_exit()`
approach: that one has to discriminate "last window destroyed" (`code == None`)
from "app.exit()" (`code == Some(_)`) to avoid breaking quit entirely.

---

## 3. Notifications

`src-tauri/src/notify.rs`, called from `AppState::run_turn` in
`src-tauri/src/state.rs` immediately after the `turn://finished` event — the one
place every provider's turn converges on.

**Trigger condition** (`should_notify`, unit-tested):

> terminal state is `Completed` or `Failed` **and** the main window is not both
> visible and focused.

- `Cancelled` and `Interrupted` are silent: the user (or a restart) just caused
  them, and re-announcing them is noise.
- A stream that ends with no terminal state at all is silent too.
- Foreground turns are silent by definition — the result is already on screen.

The notification title is the thread title (trimmed, elided at 64 characters on
a char boundary, falling back to "Maxx"); the body is "Turn completed." or
"Turn failed.".

**macOS delivery caveat.** The plugin calls
`notify_rust::set_application("com.apple.Terminal")` whenever `tauri::is_dev()`,
so under `pnpm tauri dev` notifications are posted **as Terminal** — they carry
Terminal's name and icon and are suppressed entirely if Terminal is muted in
System Settings → Notifications. Only a bundled build (`script/build_and_run.sh`
or `pnpm tauri build`) posts as `com.maxx.app` and triggers the standard
authorization prompt. Do not debug a missing dev-mode notification as a wiring
bug. Note also that `isPermissionGranted()` / `requestPermission()` are
hardcoded to `Granted` on desktop and tell you nothing about the real state.

Capabilities: `notification:allow-notify`,
`notification:allow-is-permission-granted`, `notification:allow-request-permission`
are granted to the `main` webview only. The Rust-side send does not need them;
they are there so the frontend can post its own notifications later without a
capability change.

---

## 4. Updater — what remains for you to do

The plumbing is complete and exercised: the plugin is registered, the check runs
in Rust (the webview holds **no** updater permissions, so a page cannot ask the
app to install anything), and results reach the UI as `updater://status` and
render in `UpdateToast`.

What ships is **placeholder configuration**. `src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "endpoints": [],
    "pubkey": ""
  }
}
```

That block must exist even while empty — the plugin's `Config` has no default
for `pubkey`, and registering the plugin without a `plugins.updater` block makes
the app **fail to boot**. With it empty, `updater::check` short-circuits and
reports `Unconfigured` with a specific reason instead of a confusing network
error.

**No private key is generated or committed by this change, and none ever should
be.**

### Step 1 — generate a keypair

```bash
pnpm exec tauri signer generate -w ~/.tauri/maxx.key
```

Writes `~/.tauri/maxx.key` (private) and `~/.tauri/maxx.key.pub` (public). Keep
the private key out of the repository — `~/.tauri/` locally, a CI secret in
automation. If you set a password, remember it; it is needed for every signed
build.

### Step 2 — paste the public key into the config

Copy the **contents** of `~/.tauri/maxx.key.pub` into
`plugins.updater.pubkey`.

> Ordering note: once `pubkey` is non-empty, a plain `pnpm tauri build` **fails**
> with *"A public key has been found, but no private key. Make sure to set
> `TAURI_SIGNING_PRIVATE_KEY` environment variable."* Either export the key (step
> 4) or build with `--no-sign`.

### Step 3 — choose and fill in the endpoint

```json
"endpoints": ["https://your-host.example/maxx/updates/{{target}}/{{arch}}/{{current_version}}"]
```

- Must be `https` in release builds (non-https is a hard error; there is a
  `dangerousInsecureTransportProtocol` escape hatch for local testing only).
- Template variables: `{{current_version}}`, `{{target}}` (`darwin` on macOS),
  `{{arch}}` (`aarch64` / `x86_64`), `{{bundle_type}}` (`app`). A single static
  `.../latest.json` with no variables is equally valid.

### Step 4 — sign the build

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/maxx.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
pnpm tauri build
```

(`TAURI_SIGNING_PRIVATE_KEY_PATH` also works if you prefer to pass a path.)
`bundle.createUpdaterArtifacts` is already `true`, so this produces
`Maxx.app.tar.gz` and `Maxx.app.tar.gz.sig` next to the `.app`.

### Step 5 — publish the manifest

Serve JSON in this shape at the endpoint:

```json
{
  "version": "0.2.0",
  "notes": "What changed in this release.",
  "pub_date": "2026-08-01T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of Maxx.app.tar.gz.sig>",
      "url": "https://your-host.example/maxx/0.2.0/Maxx.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<contents of the x86_64 .sig>",
      "url": "https://your-host.example/maxx/0.2.0/Maxx-x64.app.tar.gz"
    }
  }
}
```

- `version` must parse as semver (a leading `v` is stripped).
- `pub_date`, if present, must be RFC 3339 or the whole response is rejected.
- Platform keys are looked up as `{os}-{arch}-{installer}` first, then
  `{os}-{arch}` — use the plain `darwin-aarch64` form.
- **HTTP 204** is the clean way for the server to say "no update".
- Signature verification is minisign against `pubkey` and happens **after
  download, before install** — a mismatched key fails at install time, not at
  check time.

### Step 6 (optional) — offer the install

`updater::check` deliberately reports and stops; it never installs behind the
user's back, and there is no install UI yet. When you add one, call
`update.download_and_install(|_, _| {}, || {})` followed by `app.restart()` from
Rust — keep it on the Rust side so the webview never needs `updater:default` in
`capabilities/default.json`.

### Verifying without a key or a host

- `pnpm tauri build --no-sign` proves the packaging path end to end and prints
  *"Updater signing is skipped due to --no-sign flag."*
- The `Unconfigured`, `UpToDate` and `Failed` paths are unit-tested in
  `src-tauri/src/updater.rs` and `src/updates.test.ts`.
- For a full round trip, generate a throwaway key and serve the manifest from
  `python3 -m http.server` — but note that plain `http` only works in a dev
  build.
