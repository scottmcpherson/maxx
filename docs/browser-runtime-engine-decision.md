# Browser Runtime Engine Decision

Date: 2026-08-04  
Status: accepted and implemented

## Decision

Maxx owns a pinned Chrome Headless Shell child process and controls it over
Chrome DevTools Protocol (CDP). The Maxx browser pane displays frames captured
from that process and forwards human pointer, wheel, keyboard, and paste input
through the same broker used by agents. Semantic DOM/accessibility operations,
console and network diagnostics, storage, trace capture, uploads, downloads,
and screenshots all target that same Chromium tab.

Release builds bundle the browser payload. They do not discover or launch a
user-installed browser. `script/prepare_browser_runtime.sh` pins Chrome for
Testing `151.0.7922.71`, verifies a platform-specific SHA-256 digest, and stages
the complete payload as a Tauri resource. Application setup resolves only that
resource and fails closed if it is missing.

## Candidate evaluation

| Candidate | Same Chromium state for pixels and tools | Tauri/AppKit integration | Security boundary | Distribution cost | Decision |
| --- | --- | --- | --- | --- | --- |
| WKWebView child | Yes, but no supported full CDP surface | Already present | Remote child view can be isolated | Low | Rejected: cannot meet developer-tools contract |
| CEF in-process child | Yes | Requires CEF-owned macOS application/message-loop integration inside Tauri's existing Tao/WRY lifecycle | Good if carefully isolated | Highest: framework, helpers, entitlements, focus and shutdown interop | Rejected at lifecycle gate |
| Electron shell | Yes | Requires replacing the Tauri shell or embedding a second desktop shell | Electron isolation can work | High: duplicates window, IPC, updater, tray, signing, and permissions | Rejected at shell-replacement gate |
| Managed, bundled Chromium/CDP | Yes | Ordinary child process; React remains the only Maxx webview | Strong: remote content is pixels and typed CDP data, never Maxx IPC | Moderate: one pinned browser payload | Accepted |

## Evidence from existing implementations

T3 Code demonstrates the useful shape of the product, not the architecture
Maxx must copy. Its Electron preview manager keeps `WebContents` per tab,
attaches Electron's CDP debugger, captures screencast frames, injects
Playwright's selector runtime, and increments a control epoch on human input.
Its browser sessions use persistent, scope-derived Electron partitions.

Maxx retains the strong ideas:

- one authoritative tab and session registry;
- semantic references before coordinates;
- CDP as the developer-tools surface;
- a serialized command stream and control epoch per tab;
- persisted browser storage; and
- explicit artifacts for heavy evidence.

Maxx does not adopt Electron-specific `WebContents`, a renderer-to-guest IPC
bridge, or extraction of Playwright's private bundled source. The broker and
tool contract are provider- and engine-neutral Rust types, and browser pages
never execute inside a privileged Maxx webview.

## Why CEF was stopped before a product spike

The macOS CEF sample and current Rust bindings require application-level CEF
initialization and macOS message-loop behavior. Maxx already has an
`NSApplication`, window loop, webview lifecycle, updater, tray, and shutdown
path owned through Tauri/Tao/WRY. A CEF child therefore is not a narrow engine
swap: it creates two owners for the most failure-sensitive desktop lifecycle.
Rendering and CDP capability would not answer the hard integration question.
The lifecycle gate fails before implementation, so carrying a rejected CEF
branch would add risk without producing decision-changing evidence.

## Why Electron was stopped before a shell migration

T3 Code proves Electron can deliver the required browser behaviors. For Maxx,
the remaining question is whether those behaviors justify replacing a working
Tauri product shell. They do not. An Electron migration would need to replace
or bridge every existing Tauri command, window/menu/tray path, updater,
notification permission, voice/media path, bundle/signing path, and Rust state
lifecycle. A nested Electron helper would retain both shells and their attack
surface. The managed-process design gets the same Chromium/CDP substrate
without either cost.

## Operational consequences

- The browser starts lazily on the first tab.
- Its profile and downloads live under Maxx application data, not the bundle.
- The payload version changes only through an explicit script and checksum
  update followed by the browser conformance suite and packaged-app tests.
- Separate releases are built for Apple Silicon and Intel so each bundle
  carries only its native payload.
- Browser crashes are isolated from the Maxx UI process. The persistent profile
  preserves cookies and site storage, while the v1 broker deliberately starts
  with a fresh tab registry after an application restart.
- The visual transport can move from demand-driven JPEG frames to CDP
  screencast frames without changing provider tools, session scopes, or tab
  ownership.

## Revisit triggers

Re-evaluate the engine only if one of these becomes true:

1. Tauri ships a supported Chromium webview with full CDP on macOS.
2. The frame transport cannot meet measured interaction latency after adopting
   CDP screencast delivery.
3. A required browser capability cannot be exposed by Chrome Headless Shell.
4. Bundle size becomes more costly than replacing the application shell.
