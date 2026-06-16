---
layout: doc
title: Install and Build Maxx
description: Download Maxx or build it locally from source.
permalink: /docs/getting-started/install/
section: getting-started
---

# Install and Build Maxx

## Download a Release

Maxx publishes macOS release artifacts from `maxx-v*` tags:

- [Download the latest macOS DMG](https://github.com/scottmcpherson/maxx/releases/latest/download/Maxx.dmg)
- [Download the latest macOS zip](https://github.com/scottmcpherson/maxx/releases/latest/download/Maxx-macOS-universal.zip)
- [View all releases](https://github.com/scottmcpherson/maxx/releases)

Release builds are signed and notarized.

## Build from Source

From the repository root:

```sh
./tools/zig build
```

On macOS, if you are not changing the app bundle and want a faster shared-code
build:

```sh
./tools/zig build -Demit-macos-app=false
```

Run Zig tests with:

```sh
./tools/zig build test
```

Prefer targeted tests while developing:

```sh
./tools/zig build test -Dtest-filter=<test name>
```

Launch a dev build with:

```sh
./tools/zig build run
```

## Related Contributor Docs

- [Root README](https://github.com/scottmcpherson/maxx/blob/main/README.md)
- [Contributing guide](https://github.com/scottmcpherson/maxx/blob/main/CONTRIBUTING.md)
- [Agent instructions](https://github.com/scottmcpherson/maxx/blob/main/AGENTS.md)
