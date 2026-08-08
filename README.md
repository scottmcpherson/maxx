# Maxx (Tauri v2 port)

Cross-platform port of the Maxx multi-provider AI agent terminal (SwiftUI →
Tauri v2 + Rust + React 19/TypeScript). The port plan and architecture mapping
live in [`../docs/tauri-port-workflow.md`](../docs/tauri-port-workflow.md).

## Layout

```
maxx-tauri/
├── src/                          # React 19 + TS strict frontend
│   ├── contract/                 # TS mirror of the runtime contract + timeline reducer (+ vitest)
│   ├── store/appStore.ts         # zustand app store (port of AppStore.swift)
│   └── components/               # Sidebar, ThreadView, EventCards, SettingsPanel
├── src-tauri/
│   ├── crates/maxx-core/         # pure domain crate: contract, normalizers (6 providers),
│   │                             #   ordering, stable IDs, stamping, persistence + migration
│   └── src/
│       ├── engine/               # process/JSON-RPC transports + provider engines
│       │   ├── claude.rs         #   claude stream-json control channel
│       │   ├── codex.rs          #   codex app-server JSON-RPC
│       │   ├── acp.rs            #   grok + cursor (ACP 1)
│       │   ├── pi.rs             #   pi JSONL RPC
│       │   ├── opencode.rs       #   opencode HTTP + SSE (managed or external server)
│       │   └── runtime.rs        #   orchestrator (terminal guarantee, routing)
│       ├── state.rs              # workspace state, turn loop, persistence
│       └── commands.rs           # Tauri command surface
└── dist/                         # built frontend (generated)
```

## Key invariants (shared with the Swift app)

- Every started turn emits exactly one `turn.terminal`; structured errors
  precede failed terminals; duplicate native completions are ignored.
- Replay ordering: sequence → timestamp → event ID; duplicate IDs dropped.
- `workspace.json` schema 5 is read/written with Swift-compatible JSON (exact
  field names, dates as seconds since 2001-01-01, legacy formats migrated).
- `RuntimeStableID` FNV-1a UUIDs are bit-identical to the Swift app (verified
  against a Swift reference script), so replayed native request IDs match.
- Native JSONL fixtures in `src-tauri/crates/maxx-core/tests/fixtures` are
  byte-identical copies of `MaxxTests/Fixtures`.

## Develop

```sh
pnpm install
pnpm tauri dev      # run the app
pnpm test           # frontend unit tests (vitest)
pnpm build          # tsc --noEmit + vite build
cd src-tauri
cargo test --workspace
cargo build
pnpm tauri build    # release bundle (from maxx-tauri/)
```
