# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues.

Use GitHub's private vulnerability reporting for this repository when available.
If that is unavailable, contact the maintainer out of band and include enough
detail to reproduce the issue safely:

- affected Maxx version or commit
- platform and build type
- affected surface, such as Control API, webhook ingestion, runner, packaging,
  or update/distribution flow
- impact, prerequisites, and a minimal reproduction

For non-sensitive hardening work, public issues and pull requests are fine.

## Scope

Security-sensitive Maxx areas include:

- local Control API socket and token handling
- capability-policy enforcement
- webhook authentication and payload handling
- persistent control/session registry data
- packaging, signing, notarization, and release artifacts
- any code path that could write secrets, environment variables, or terminal
  output to disk

Maxx is an unofficial Ghostty fork. Issues that reproduce in upstream Ghostty
should also be evaluated against the upstream project's security process.
