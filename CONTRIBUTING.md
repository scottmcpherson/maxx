# Contributing to Maxx

Maxx is an unofficial Ghostty fork. Changes specific to Maxx should keep the
terminal lightweight, preserve upstream Ghostty behavior where possible, and
avoid turning the app into a workflow brain.

For behavior that should also apply to upstream Ghostty, check the upstream
[Ghostty contributing guide](https://github.com/ghostty-org/ghostty/blob/main/CONTRIBUTING.md)
and consider whether the change belongs upstream first.

## Build

From the repository root:

```sh
./tools/zig build
```

On macOS, if you do not need the app bundle while working on shared code:

```sh
./tools/zig build -Demit-macos-app=false
```

Launch a dev build with:

```sh
./tools/zig build run
```

## Test

Run targeted Zig tests whenever possible:

```sh
./tools/zig build test -Dtest-filter=<test name>
```

Run the full Zig test suite when the change touches broad shared behavior:

```sh
./tools/zig build test
```

For `libghostty-vt` changes, prefer:

```sh
./tools/zig build test-lib-vt -Dtest-filter=<filter>
```

## Format

Use the formatter that matches the files you changed:

```sh
./tools/zig fmt .
swiftlint lint --strict --fix
./tools/prettier -w .
```

## Pull Requests

- Keep PRs focused on one behavior or documentation change.
- Link the issue being fixed when there is one.
- Include the commands you ran and any manual verification evidence.
- For UI or docs-site changes, include a screenshot or local preview note.
- Do not make external docs, wikis, or notes the canonical source of truth for
  Maxx behavior; update Markdown in this repository instead.

## Architecture Notes

Maxx may display mechanical terminal facts and agent-declared facts. It must not
infer workflow truth by scraping terminal output, parsing agent prose, guessing
from branch names, or using idle time. Read the
[no-inference rule](https://maxx.sh/no-inference.html)
before changing control, runner, webhook, or status surfaces.

Agent-specific workflow instructions live in [AGENTS.md](AGENTS.md).
