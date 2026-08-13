# Browser runtime

## Product boundary

The browser pane is a real Chromium surface embedded by Electron. React draws
only its chrome: tabs, address bar, progress/error UI, Chrome import controls,
annotation controls, and the rectangle where Electron places the selected
`WebContentsView`.

Every tab uses the persistent `persist:maxx-browser` session. The same
`webContents` is used for visible rendering, human input, agent input, DOM and
accessibility snapshots, console/network diagnostics, downloads, traces, and
explicit screenshots.

## Ownership

- Electron owns web contents, Chromium sessions, lifecycle events, CDP, native
  downloads, Chrome import, and the validated annotation bridge.
- Rust owns session/thread scoping, tab IDs, serialized operation admission,
  control epochs, provider tool schemas, persisted artifacts, and shutdown.
- React owns presentation and user intent. It never receives browser secrets or
  a continuous page-frame stream.

Electron and Rust communicate over private newline-delimited JSON on the
sidecar's stdin/stdout. Rust requests `browser.execute`; Electron returns a
typed operation result. Human input is a host event that advances the broker's
control epoch.

## Tool surface

The provider-neutral browser contract includes:

- open/select/close tab and navigate/back/forward/reload;
- semantic snapshot with stable references and incremental visible text;
- click, fill, press, hover, scroll, drag, wait, and evaluate;
- console and network list/get diagnostics with secret headers redacted;
- storage inspection/mutation, dialogs, upload, download status, resize, and
  device emulation;
- explicit bounded screenshots and traces.

Uploads are restricted to the active session's project roots. Top-level browser
navigation accepts only absolute HTTP(S) URLs. Permission requests from remote
content are denied.

## Snapshot and references

A snapshot walks visible interactive DOM elements and assigns references scoped
to the current document generation. Operations resolve those references in the
same renderer. A navigation invalidates the prior reference map; stale
references fail clearly and require a fresh snapshot. Coordinates are used only
after resolving a current DOM reference, not as the primary contract.

## Human control

Every page receives an isolated listener that reports pointer, wheel, keyboard,
and touch input through a CDP binding. Rust advances the control epoch for that
tab. An agent operation admitted under an older epoch is rejected, which makes
the visible user's action authoritative without a second browser or focus
heuristic.

## Capture policy

Screenshots are evidence artifacts, not the rendering transport. Viewport
captures use Electron's native page capture. Full-page captures use CDP and
scale down pages above the pixel budget. Screenshots and traces are rejected
above 20 MB; trace collection stops accumulating at that bound.

## Persistence and import

Chromium's partition persists cookies, cache, and site storage across launches.
Chrome import is explicit and profile-scoped. Valid cookies are copied into the
partition; saved credentials are held in an app-local `safeStorage` vault and
can be filled only for their exact origin after a user action.

## Annotation

Annotation mode is DOM-backed. Hover highlights the real target, hovering a
numbered marker reveals its saved instruction, and click opens a scoped
instruction editor. Confirmation emits bounded selector,
accessibility, text, instruction, geometry, and preview data. The overlay and
listeners are removed when the mode ends or the page navigates. The annotation
toolbar submits the staged annotations as an annotation-only chat message.
Annotation context is attached to the provider prompt as structured page
context; previews are presentation-only and are not used as page context.

## Acceptance checks

The browser implementation is accepted only when the packaged app demonstrates:

1. Google, Facebook, and the exact filtered Best Buy URL commit and become
   interactive without a Chromium-startup timeout.
2. Human navigation and provider-driven navigation operate on the same tab.
3. A provider can snapshot, fill/click/scroll, and capture a screenshot from
   that visible tab.
4. Restarting Maxx preserves browser session storage.
5. Browser pages cannot invoke Maxx IPC or navigate to local/privileged schemes.
6. Annotation selection produces usable prompt context without a screenshot
   being used as the page.
7. Marker hover reveals the saved instruction and toolbar Send creates the
   annotation-only user message.
