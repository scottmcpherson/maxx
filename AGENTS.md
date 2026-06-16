# Agent Development Guide

A file for [guiding coding agents](https://agents.md/).

## Commands

- **Build:** `zig build`
  - If you're on macOS and don't need to build the macOS app, use
    `-Demit-macos-app=false` to skip building the app bundle and speed up
    compilation.
- **Test (Zig):** `zig build test`
  - Prefer to run targeted tests with `-Dtest-filter` because the full
    test suite is slow to run.
- **Test filter (Zig)**: `zig build test -Dtest-filter=<test name>`
- **Formatting (Zig)**: `zig fmt .`
- **Formatting (Swift)**: `swiftlint lint --strict --fix`
- **Formatting (other)**: `prettier -w .`
- **Post-work check:** After making a feature or request change, create a dev
  build and launch it for user testing with `zig build run`; then use computer
  use with screenshots to test the app.

## libghostty-vt

- Build: `zig build -Demit-lib-vt`
- Build WASM: `zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall`
- Test: `zig build test-lib-vt -Dtest-filter=<filter>`
  - Prefer this when the change is in a libghostty-vt file
- All C enums in `include/ghostty/vt/` must have a `_MAX_VALUE = GHOSTTY_ENUM_MAX_VALUE`
  sentinel as the last entry to force int enum sizing (pre-C23 portability).

## Directory Structure

- Shared Zig core: `src/`
- macOS app: `macos/`
- GTK (Linux and FreeBSD) app: `src/apprt/gtk`

## Architecture Guardrails

- **No inference.** Maxx is the visible terminal-native runtime/control plane,
  not the workflow brain. It may display **mechanical facts** (process
  lifecycle, session/PTY ids, exit codes, timestamps, tab/worktree
  associations, the terminal bell/progress) and **agent-declared facts**
  (workflow meaning declared through the control API, a hook event, or
  metadata). It must never derive **workflow truth** — _complete_, _blocked_,
  _tests passed_, _PR created_, _ready for review_ — by scraping terminal
  output, parsing agent prose, or guessing from process/branch/path/worktree
  names, PR URLs, or idle time. If an agent has no explicit declaration path for
  a status, document the gap rather than infer it. See
  [`docs/no-inference.md`](docs/no-inference.md).

## Review Guidelines

- Codex GitHub review should focus on concrete correctness, security, privacy,
  data-loss, authorization, persistence, and regression risks. Avoid style or
  cleanup comments unless they would cause a real user-visible failure.
- Prefer invariant-level review over line-by-line drip feedback. When a finding
  reveals a bug pattern, audit sibling paths in the same pass and mention the
  whole class: for example all idempotent mutators that can refresh retention
  recency, read-side limits that need write-side limits, create-time declarations
  that must match post-create declarations, or authorization checks that must run
  before identifier lookups.
- For persistent control/session state, review every new durable field through
  creation, mutation, no-op retry, archive/cancel/restart, app relaunch,
  downgrade/newer-schema handling, corrupt-file recovery, retention, shutdown
  flush, and permission/validation failure. The read path, write path, and
  recovery path must be symmetric.
- Persistent registry changes must explicitly consider file-size bounds before
  reading and before writing, bounded audit/history retention, preservation of
  the last readable file on write failure, unsupported newer-schema files, and
  whether sensitive data such as environment variables or tokens are being
  written to disk.
- Control API changes must enforce capabilities before revealing object
  existence or doing side effects. Denied requests must not spawn tabs, resolve
  unauthorized session ids, write registry state, or leak whether a target exists.
- Restored sessions from a previous app run must never be rebound to a live
  surface by matching a persisted surface id. Only an explicit restart may attach
  a restored record to a new live surface.
- When addressing review feedback, do not patch only the exact commented line.
  Identify the violated invariant, audit adjacent methods for the same pattern,
  add focused regression tests for the class, and summarize the sweep in the PR
  response before requesting another review.

## Releases

- Per-issue work goes through the `feature-drive` skill, which stops at PR-open.
  Releases are out of scope for that flow: do not tag, push tags, or publish
  unless explicitly asked, and when you are, follow `RELEASE.md`.
