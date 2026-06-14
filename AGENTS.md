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

## Git Workflow

- Follow `WORKFLOW.md` for branch, feature, and release workflow.
