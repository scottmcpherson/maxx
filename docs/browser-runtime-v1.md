# Maxx Browser Runtime v1

Status: implementation source of truth  
Owner: Maxx desktop runtime  
Last updated: 2026-08-04

## Objective

Give every Maxx provider, harness, model, and agent a shared, visible browser
that can be used for ordinary browsing and for application development and
debugging. The user and agent must operate the same browser state. The browser
must remain useful when providers change, and remote pages must never inherit
Maxx application privileges.

The production runtime is complete only when an agent can edit an application,
start its development server, open the correct page, diagnose a defect using
DOM, accessibility, console, and network evidence, fix it, verify the result in
the same visible tab, and leave persisted evidence of that verification.

## Non-negotiable invariants

1. **Remote content has no Maxx IPC.** Browser pages execute in the managed
   Chromium child process. React receives compressed pixels and typed browser
   state only. Tool calls terminate in Rust; no credential or privileged
   bridge is injected into the page.
2. **The provider does not choose its authority.** Project, thread, provider
   instance, provider session, capabilities, and assigned tabs come from an
   authenticated server-side session. They are never accepted as tool
   arguments.
3. **User and agent share observable state.** Agent actions occur in tabs the
   user can reveal. The UI shows control ownership and action progress.
4. **Human input wins.** Pointer or keyboard input invalidates the current
   agent control epoch. Long-running actions must stop before making a later
   mutation.
5. **One command stream per tab.** Actions are serialized. Separate agents get
   separate tabs by default; shared control is explicit.
6. **Observations precede actions.** Semantic accessibility/DOM references are
   the default. Coordinates are a vision fallback.
7. **Heavy data is referenced.** Screenshots, traces, recordings, downloads,
   and large response bodies live in the artifact store and are returned by
   URI, not inlined into model context.
8. **Capabilities fail closed.** An engine or provider that cannot implement a
   requested operation reports it as unsupported. It must not silently perform
   a weaker or differently scoped operation.
9. **No compatibility runtime.** Once the production Chromium engine passes
   the acceptance benchmark, the obsolete WKWebView automation path is
   removed rather than retained as a fallback.

## Architecture

```text
Provider process
    |  scoped URL + bearer token
    v
loopback MCP gateway
    |  authenticated BrowserSessionScope
    v
BrowserBroker ---- ArtifactStore
    |                   ^
    |                   |
    v                   |
BrowserEngine ----------+
    |
    v
visible Maxx browser tabs <----> React browser chrome
```

### Browser MCP gateway

The gateway binds to `127.0.0.1` on an ephemeral port and serves Streamable
HTTP MCP at `/mcp`. It validates the `Host`, `Origin`, and bearer token before
MCP dispatch. Tokens contain at least 256 bits of randomness; only their
SHA-256 hashes are retained. Sessions have a 30-minute idle timeout and an
eight-hour absolute lifetime, and are revoked when their provider session or
thread is stopped.

`BrowserSessionScope` contains:

- project ID
- thread ID
- provider and provider instance ID
- provider-native session ID when one exists
- agent ID when the turn belongs to a configured agent
- granted browser capabilities
- assigned tab IDs
- issued, last-used, and absolute-expiry timestamps

The gateway exposes one MCP server name, `maxx_browser`. Provider adapters are
responsible only for attaching its URL and token to the native provider
session. Browser behavior stays out of provider prompts and adapters. ACP
agents that advertise HTTP MCP receive the Streamable HTTP server directly.
Other ACP agents receive a standards-compatible stdio server that relays to
the same loopback gateway. Its endpoint and secret travel only through the
child environment, never command-line arguments or persisted configuration.

### Browser broker

The broker is the single source of truth for tabs, assignments, action queues,
control epochs, observations, and artifacts. It accepts an authenticated scope
plus a typed operation. The broker resolves the target tab from the scope and
operation, checks capabilities, serializes the action, and dispatches to the
engine.

Each action records:

- action ID and operation
- authorized session and tab IDs
- start/end timestamps
- control epoch before and after execution
- compact result or error
- produced artifact URIs

### Browser engine

The production engine is a Maxx-owned, pinned Chrome Headless Shell child
process controlled through Chrome DevTools Protocol. The same Chromium target
produces semantic snapshots, actions, developer diagnostics, artifacts, and
the JPEG frames shown in the React browser surface. Human pointer, wheel,
keyboard, and paste events return through Rust and are dispatched to that same
target.

The browser payload is a checksummed Chrome for Testing build bundled as a
Tauri resource. Runtime startup never discovers or launches an installed
Chrome. The profile and downloads live under Maxx application data so cookies,
site storage, and authenticated state survive application restarts; the v1 tab
registry itself begins fresh on restart.

WKWebView, an in-process CEF child, and an Electron shell were rejected at
their decision gates and are not retained as fallback runtimes. The recorded
rationale is in `docs/browser-runtime-engine-decision.md`.

## Browser tool contract

Every tool returns `tabId`, the resulting control epoch, and either an
observation ID or a compact mutation result. Mutating operations are annotated
as such in MCP metadata.

### Tabs and navigation

- `browser_status`
- `browser_list_tabs`
- `browser_open_tab`
- `browser_select_tab`
- `browser_close_tab`
- `browser_navigate`
- `browser_go_back`
- `browser_go_forward`
- `browser_reload`

### Observation and interaction

- `browser_snapshot`
- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_hover`
- `browser_scroll`
- `browser_drag`
- `browser_wait`
- `browser_evaluate`
- `browser_screenshot`

### Developer tools

- `browser_console_list`
- `browser_console_get`
- `browser_network_list`
- `browser_network_get`
- `browser_trace_start`
- `browser_trace_stop`
- `browser_resize`
- `browser_emulate`
- `browser_storage`
- `browser_handle_dialog`
- `browser_upload`
- `browser_downloads`

### Snapshot shape

A snapshot contains:

- observation ID and document generation
- URL, title, loading state, viewport, and focused element
- compact accessibility tree with stable element references
- relevant visible text and interactive controls
- recent console errors and failed requests
- pending dialog/download/permission state
- recent action timeline
- optional screenshot artifact URI

References are scoped to a tab and document generation. Navigation invalidates
them. A stale reference returns `browser.stale-reference` with the current
generation and a direction to request a fresh snapshot.

## Concurrency and takeover

- A provider session receives a sticky tab assignment.
- A tab has one serialized action queue and one active controller lease.
- Separate agent sessions receive separate tabs unless the user explicitly
  assigns a shared tab.
- Pointer, keyboard, touch, drag, or scroll input from the user increments the
  tab's control epoch.
- An action reads the epoch before execution and checks it immediately before
  every mutation and after every awaited engine operation.
- A changed epoch terminates the action as `browser.human-takeover`.
- Cancelling a provider turn cancels queued browser actions for that turn and
  revokes leases acquired only for that turn.

## Security and privacy

- Allow only loopback listeners and reject unexpected host headers.
- Do not log or persist plaintext bearer tokens.
- Never put tokens in provider prompts, browser JavaScript, artifacts, or
  visible transcripts.
- Redact `Cookie`, `Set-Cookie`, `Authorization`, proxy authorization, and
  configured secret patterns from network data by default.
- Restrict upload and download paths to the active project and an explicit
  Maxx artifact directory.
- Page requests for microphone, camera, screen capture, geolocation,
  notifications, clipboard, and filesystem access receive no ambient Maxx
  grant and therefore fail closed in v1. Application-level grants never imply
  page grants. A future page-permission UI must add an explicit human decision;
  an agent tool alone may not grant these capabilities.
- Dangerous browser capabilities can be omitted from a provider session; tool
  discovery and invocation both enforce the same grants.
- A development origin may be opened in managed Chromium because it is not a
  Tauri webview and receives no Maxx IPC. That origin must never be loaded into
  a second privileged Tauri webview.

## Provider lifecycle requirements

Browser MCP credentials are native-session scoped. Therefore every provider
runtime must provide an unambiguous `(provider instance, Maxx thread)` process
or session boundary.

- Codex: one app-server process per `(provider instance, thread)` unless the
  app-server protocol proves it can attach different MCP configuration to
  individual native threads.
- Claude: attach the generated MCP configuration when starting the existing
  per-thread streaming process.
- ACP providers: populate `mcpServers` in `session/new` and `session/load`,
  selecting HTTP or the Maxx stdio relay from the advertised ACP capability.
  If a Hermes model change rebuilds the native agent, reload the same session
  with the same MCP attachment rather than leaving the new model tool-less.
- OpenCode: one owned server per `(provider instance, thread)`, then register
  the remote MCP server with that instance.
- Pi: attach one private temporary extension that registers the remote MCP
  server for the existing per-thread process, and remove it when that process
  ends.

Provider instructions may explain when the tools are useful, but must not be
the security boundary or the only means of tool discovery.

## Capability benchmark

All production engine candidates are evaluated with the same harness. A
candidate passes only if every required case is demonstrated in a visible Maxx
tab and leaves machine-readable evidence.

### Browsing and interaction

- [x] Open, select, list, and close multiple tabs.
- [x] Navigate public, authenticated, and localhost pages.
- [x] Inspect a semantic snapshot and activate referenced controls.
- [x] Fill text or select values, press shortcuts, hover, scroll, and drag.
- [x] Handle same-origin iframe content, open shadow DOM, dialogs, uploads, and
      downloads. Page permissions fail closed; v1 intentionally has no
      agent-controlled permission grant.
- [x] Resize the viewport and emulate a mobile device.

### Development and debugging

- [x] Capture console entries with level, source, timestamp, and stack.
- [x] Inspect request/response metadata and bodies with secret redaction.
- [x] Diagnose failed requests and JavaScript errors with source location and
      stack evidence.
- [x] Read and modify storage for the assigned tab.
- [x] Record a performance trace and return it by artifact URI.
- [x] Capture screenshots and a replayable action timeline.

### Safety and collaboration

- [x] A remote page cannot invoke a Tauri command.
- [x] Expired, revoked, cross-thread, and cross-tab credentials are rejected.
- [x] Human input interrupts an in-flight agent mutation.
- [x] Two agents can operate isolated tabs concurrently.
- [x] Explicit shared-tab control remains serialized.
- [x] Stopping a turn interrupts pending actions; removing its thread closes
      assigned tabs and revokes its session.

## Implementation sequence and gates

### M0 — Contract and decision harness

- [x] Freeze architecture, invariants, tool catalog, and benchmark in this
      document.
- [x] Add typed Rust contract and a fake engine.
- [x] Add conformance tests for authorization, expiry, references, control
      epochs, serialization, redaction, and artifacts.

Exit: engine-independent tests prove the broker contract.

### M1 — Secure MCP gateway

- [x] Start the loopback Streamable HTTP server during app setup.
- [x] Issue, validate, bind, revoke, and expire scoped credentials.
- [x] Expose browser tools and resource-backed artifacts through MCP.
- [x] Reject invalid host/origin/token combinations before protocol dispatch.

Exit: MCP Inspector can connect with a valid token; every negative scope test
fails closed.

### M2 — Chromium engine decision

- [x] Implement the managed-Chrome/CDP engine and shared pixel surface.
- [x] Evaluate CEF at the macOS application-lifecycle gate and reject it before
      a product spike because it requires a second application/message-loop
      owner.
- [x] Evaluate Electron against the demonstrated T3 Code architecture and
      reject it because it requires replacing or duplicating the Tauri shell.
- [x] Record the decision and retain no rejected compatibility runtime.

Exit: the selected bundled Chromium engine passes the runtime benchmark and is
present in a rebuilt macOS application bundle. Release signing remains the
normal release-pipeline responsibility; the recorded acceptance bundle is a
local debug bundle built with `--no-sign`.

### M3 — Shared browser product

- [x] Replace the single-pane state with broker-owned tabs.
- [x] Render tabs, loading, assignment, and controller state in React.
- [x] Implement action queues, observation generations, artifact storage, and
      human takeover.
- [x] Remove the obsolete WKWebView implementation after Chromium parity.

Exit: user and agent operate the same visible tabs with reliable takeover.

### M4 — Provider integration

- [x] Correct Codex and OpenCode lifecycle scope.
- [x] Integrate Codex end to end.
- [x] Integrate Claude, ACP providers, OpenCode, Pi, and Hermes model changes.
- [x] Maintain a tested provider/capability matrix; unsupported combinations
      fail closed.

Exit: every enabled provider discovers browser tools in a fresh normal UI
thread and can complete the browsing subset of the benchmark.

### M5 — End-to-end verification

- [x] Run a fixture application in the packaged app's browser.
- [x] Agent diagnoses the seeded defect using semantic, console, and network
      evidence.
- [x] Agent fixes the defect and verifies it in the same visible tab.
- [x] User takeover, cancellation, persistent profile state, separate-tab
      concurrency, and shared-tab serialization are covered by the broker and
      packaged-browser acceptance paths. Live tabs intentionally do not
      restore after an application restart in v1.
- [x] `pnpm test`, `pnpm build`, Rust tests, and
      `./script/build_and_run.sh --verify` pass.

Exit: the objective and every benchmark item have current evidence recorded
below.

## Verification record

Append dated evidence here. A checked implementation box without corresponding
evidence is not completion evidence.

### 2026-08-04

- Engine decision: inspected the previous Maxx WKWebView boundary and T3 Code's
  session registry, broker, Chromium/CDP manager, human takeover, and MCP
  attachment points. Accepted a bundled managed Chrome Headless Shell/CDP
  engine; removed the WKWebView browser implementation.
- Packaging: `script/prepare_browser_runtime.sh` staged checksummed Chrome for
  Testing `151.0.7922.71`; `./script/build_and_run.sh --verify` produced and
  launched the unsigned debug bundle at
  `/private/tmp/maxx-browser-runtime-target/debug/bundle/macos/Maxx.app`.
- Browser integration: the ignored live-Chrome test launched the bundled
  payload, opened a tab, captured a semantic snapshot and shared visual frame,
  acted through a semantic reference, stored a trace artifact, and verified a
  download. The ignored gateway integration test rejected missing authority
  and exercised scoped browser tools over the real loopback server.
- Security and broker: unit coverage rejects scope, upload traversal, secret
  headers, invalid navigation/device inputs, stale authority, and unscoped
  artifacts. It proves in-flight and queued human interruption, separate-tab
  concurrency, and shared-tab serialization.
- Provider matrix, exercised through fresh normal Maxx UI threads:
  - Codex used list, snapshot, console, network list, and response-body tools to
    diagnose the fixture.
  - Claude diagnosed the defect, changed `payload.value` to `payload.total`,
    reloaded the same tab, clicked the increment control, and observed `43`.
  - Grok ACP, Cursor ACP, OpenCode, Pi, and Hermes each discovered the native
    `maxx_browser` server and read the visible fixture through list/snapshot.
  - Hermes repeated the probe after switching the same thread from Grok 4.5 to
    Grok 4.3 and returned the same tab ID and visible total, proving MCP
    reattachment after its agent rebuild.
- Restart evidence: after relaunch, the persistent Chromium profile was reused;
  the fresh tab registry navigated to the fixture and displayed its reset value
  `42`, as designed.
- Automated verification:
  - `pnpm test`: 21 files, 213 tests passed.
  - Rust library suite: 76 passed, 2 ignored by default; both ignored live
    integrations passed when run explicitly.
  - `cargo fmt --check`, `pnpm build`, and the packaged rebuild passed.
