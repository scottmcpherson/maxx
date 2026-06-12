<!-- LOGO -->
<h1 align="center">
  <img src="images/icons/icon_1024.png" alt="MadMaxx logo" width="128">
  <br>
  MadMaxx
</h1>

<p align="center">
  An unofficial Ghostty fork focused on sidebar-first sessions and parallel coding agents.
  <br>
  Built for agent-driven engineering workflows on macOS.
</p>

<p align="center">
  <a href="#download">Download</a>
  ·
  <a href="#whats-different">What's Different</a>
  ·
  <a href="#project-scope">Scope</a>
  ·
  <a href="#platform-and-agent-status">Status</a>
  ·
  <a href="https://github.com/ghostty-org/ghostty">Ghostty</a>
  ·
  <a href="NOTICE">Notice</a>
</p>

<p align="center">
  <img
    src="images/mosttly-agent-sessions.png"
    alt="MadMaxx preview showing sidebar sessions running multiple coding agents"
    width="920"
  >
</p>

<p align="center">
  <a href="https://github.com/scottmcpherson/mosttly-ghostty/releases/latest/download/MadMaxx.dmg">
    <img alt="Download macOS DMG" src="https://img.shields.io/badge/Download-macOS%20DMG-111111?style=for-the-badge&logo=apple&logoColor=white">
  </a>
  <a href="https://github.com/scottmcpherson/mosttly-ghostty/releases">
    <img alt="View releases" src="https://img.shields.io/badge/View-Releases-346beb?style=for-the-badge&logo=github&logoColor=white">
  </a>
</p>

## Fork Notice

MadMaxx is an unofficial fork of
[Ghostty](https://github.com/ghostty-org/ghostty). It is not affiliated with,
endorsed by, or maintained by the Ghostty project.

The original Ghostty source is licensed under the MIT License. See
[LICENSE](LICENSE) and [NOTICE](NOTICE). Upstream documentation at
[ghostty.org/docs](https://ghostty.org/docs) generally applies, but this fork
may differ where sidebar tabs, sessions, agent statuses, and local distribution
behavior have changed.

## What's Different

MadMaxx keeps Ghostty's fast native terminal core and adds a workflow
layer for people running multiple coding agents in parallel.

- Sidebar-first tab and session organization.
- Sidebar agent status indicators for supported CLIs.
- A macOS-first distribution path for the fork.
- Fork-specific release artifacts published from `mosttly-v*` tags.

## Project Scope

MadMaxx's north star is to stay a lightweight, high-performance Ghostty
terminal for running multiple coding agents in parallel.

In practice, this fork should remain close to "Ghostty with a sidebar and agent
statuses." Changes should preserve Ghostty's terminal feel, keep resource
overhead low, and avoid turning the app into a separate agent-management
product. That matters because agent workflows already consume meaningful CPU,
memory, and battery, and because staying close to upstream Ghostty keeps
long-term cherry-picks and maintenance feasible.

Good fit:

- Agent status integrations for additional terminal-first CLIs, such as Grok,
  Gemini, or other coding agents.
- Sidebar and session polish that improves switching between parallel agent
  terminals.
- Terminal correctness, performance, rename, copy/paste, and macOS integration
  bug fixes.
- Small release, packaging, or distribution improvements for this fork.

Out of scope:

- Built-in browser panels, dashboards, task boards, or other heavyweight app
  surfaces.
- Agent orchestration or management UI beyond exposing terminal session status.
- Features that significantly increase idle resource usage or make upstream
  Ghostty updates difficult.
- General-purpose workflow features better handled by agent CLIs or external
  tools.

When in doubt, prefer terminal-native, lightweight, and upstream-friendly.

## Download

MadMaxx currently publishes macOS builds through GitHub Releases:

- [Download the latest macOS DMG](https://github.com/scottmcpherson/mosttly-ghostty/releases/latest/download/MadMaxx.dmg)
- [Download the latest macOS zip](https://github.com/scottmcpherson/mosttly-ghostty/releases/latest/download/MadMaxx-macOS-universal.zip)
- [View all releases](https://github.com/scottmcpherson/mosttly-ghostty/releases)

These builds are produced from `mosttly-v*` release tags and are signed + notarized.

## Platform and Agent Status

| Area | Status |
| --- | --- |
| macOS sidebar tabs/sessions | Supported |
| macOS sidebar agent statuses | Supported |
| Linux/GTK sidebar agent statuses | Not exposed in the UI yet |
| Claude Code status integration | Supported automatically |
| Codex status integration | Supported automatically |
| X.ai CLI status integration | In progress |
| Gemini CLI status integration | In progress |

The underlying hook event pipeline is shared infrastructure. Other CLIs can use
that pipeline, but only Claude Code and Codex currently have built-in status
integration.

## Documentation

Most general terminal behavior, configuration, and platform documentation comes
from upstream Ghostty:

- [Ghostty documentation](https://ghostty.org/docs)
- [Upstream Ghostty repository](https://github.com/ghostty-org/ghostty)
- [About Ghostty](https://ghostty.org/docs/about)

Fork-specific behavior is documented in this repository as it diverges from
upstream.

## Building from Source

MadMaxx follows the upstream Ghostty build system:

```shell
zig build
```

On macOS, if you do not need to build the app bundle while working on shared
code, this is faster:

```shell
zig build -Demit-macos-app=false
```

Run Zig tests with:

```shell
zig build test
```

Prefer targeted tests while developing:

```shell
zig build test -Dtest-filter=<test name>
```

See [HACKING.md](HACKING.md) for upstream development details and
[AGENTS.md](AGENTS.md) for local agent workflow notes.

## Contributing

For changes specific to MadMaxx, open issues or pull requests against
this fork. For behavior that also affects upstream Ghostty, check the upstream
[Contributing to Ghostty](CONTRIBUTING.md) guidance and consider whether the
change belongs upstream first.

## Upstream Ghostty

Ghostty is a fast, feature-rich, native terminal emulator and embeddable
`libghostty` library. MadMaxx builds on that foundation and keeps
upstream licensing and attribution intact.

For broader Ghostty project status, roadmap, terminal compliance details,
`libghostty`, and crash report documentation, use the upstream documentation:

- [ghostty.org/docs](https://ghostty.org/docs)
- [github.com/ghostty-org/ghostty](https://github.com/ghostty-org/ghostty)
