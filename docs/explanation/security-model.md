---
layout: doc
title: Security Model
description: Maxx local control, token, policy, and webhook security boundaries.
permalink: /docs/explanation/security-model/
section: explanation
---

# Security Model

Maxx exposes local control surfaces so trusted tools can open and manage visible
terminal tabs. Those surfaces are intentionally local, token-gated, and checked
against explicit capabilities before side effects run.

## Local Control Surface

The Control API listens on a Unix domain socket in a per-user control directory.
The directory and token file are created with restrictive permissions, and there
is no network-facing Control API listener.

Every request must present the capability token and is evaluated against the
active policy before object lookup or side effects. Denied requests must not
reveal whether a target exists, spawn tabs, or write registry state.

## Capability Policy

Policy decisions are based on explicit caller identity, requested capability,
and request target. Unknown sources are denied by default. External and webhook
callers receive only the capabilities an operator grants.

## Webhook Boundary

Webhook ingestion validates transport concerns such as route, method, content
type, body size, and HMAC signature. The payload is then parsed by a connector
adapter that copies explicit fields into a launch request. The route config owns
which command runs.

## Persistence Boundary

Persistent control/session state stores identifiers, relationships, declared
facts, timestamps, and audit data. It must not store terminal output, secrets, or
derived workflow conclusions.

## Related References

- [Control API]({{ '/control-api.html' | relative_url }})
- [Webhook ingestion]({{ '/webhook-ingestion.html' | relative_url }})
- [No-inference rule]({{ '/no-inference.html' | relative_url }})
