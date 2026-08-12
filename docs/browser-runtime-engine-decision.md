# Browser Runtime Engine Decision

Date: 2026-08-12
Status: accepted and implemented

## Decision

Maxx uses Electron as its desktop shell and renders each browser tab directly
in a sandboxed `WebContentsView`. The React application and remote webpages are
separate web contents. A persistent Electron session owns cookies, cache, site
storage, downloads, and imported Chrome state.

Electron's DevTools Protocol connection is attached to the same visible
`webContents`. Semantic snapshots, clicks, typing, scrolling, diagnostics,
traces, and on-demand screenshots therefore operate on exactly the page the
user sees. There is no headless browser, frame relay, synthetic UI transport,
or duplicate browser profile.

The provider-neutral broker remains in the Rust sidecar. It serializes agent
operations, scopes tabs to threads, increments control epochs, and cancels an
agent's pending control when real user input is observed. The Electron main
process is the browser engine adapter and sends typed operation results back to
Rust over a private JSONL stdio channel.

## Why this replaces the previous design

The earlier bundled Headless Shell design rendered captured frames in the UI.
That created two avoidable failure modes: the displayed frame could lag the
controlled page, and navigation success depended on an indirect capture/input
transport. It also made ordinary sites appear broken while Chromium was still
starting or waiting for a frame acknowledgement.

T3 Code and Codex Desktop demonstrate the more robust product boundary:
Chromium is the actual embedded view, while automation attaches to that same
view. Maxx now uses that boundary directly.

## Candidate evaluation

| Candidate | Direct page | Full automation | Persistent session | Result |
| --- | --- | --- | --- | --- |
| WKWebView child | Yes | No supported CDP surface | Yes | Rejected |
| Headless Chromium + frames | No | Yes | Yes | Removed |
| CEF child | Yes | Yes | Yes | Rejected: two desktop lifecycle owners |
| Electron `WebContentsView` | Yes | Yes, same target | Yes | Selected |

## Invariants

1. The visible tab is the automation target; no shadow tab is allowed.
2. Remote content never receives the Maxx preload bridge.
3. Only HTTP(S) top-level navigation is accepted.
4. Browser state is persistent, but tab ownership and control authorization
   remain explicit in Rust.
5. Heavy evidence is produced only by explicit bounded screenshot/trace calls.
6. DOM annotations contain selector/accessibility metadata and page geometry,
   never hidden credentials or arbitrary page script results.
7. Chrome import happens only after a user action and keeps plaintext secrets
   inside the Electron main process.

## Operational consequences

- Electron carries the Chromium runtime, so a separate browser payload and
  runtime preparation script no longer exist.
- Browser crashes are isolated to their renderer process and surfaced as tab
  lifecycle errors.
- The packaged app carries one Rust sidecar at `Resources/bin/maxx-runtime`.
- Apple Silicon and Intel builds use Electron's native architecture output.
