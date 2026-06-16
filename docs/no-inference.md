---
layout: doc
title: The No-Inference Rule
description: Maxx's product boundary for mechanical facts and agent-declared facts.
section: explanation
---

# The No-Inference Rule

**Maxx is the visible terminal-native runtime/control plane, not the workflow
brain.**

Maxx makes terminal-native work observable and controllable without pretending
to understand workflow intent. It may display facts it directly owns or
observes, and facts an agent explicitly declares to it. It must never
manufacture workflow truth from incidental signals.

This document is the canonical statement of that rule. It exists because
inference-based shortcuts look useful in the short term but create brittle
behavior, surprising UX, and hidden product semantics. Keep the wording here
consistent with the comments, tests, and fixtures that enforce it so the rule
stays easy to search for (`no-inference`).

## Three kinds of fact

Every value Maxx shows falls into exactly one of three buckets. The first two
are allowed; the third is allowed **only** when it arrives as the second.

1. **Mechanical facts** — things Maxx directly controls or observes as terminal
   runtime infrastructure. These are Maxx-owned and always safe to show as
   themselves:
   - process lifecycle (running / exited), reported by the kernel via
     `ghostty_surface_process_exited`
   - PTY / session / surface identifiers, the foreground pid, exit status
   - command start/stop timestamps
   - window / tab / worktree associations and the working directory
   - explicitly attached URLs and caller-supplied metadata
   - terminal escape sequences the running program emits — the bell (BEL) and
     OSC 9/4 progress — which are mechanical terminal facts, not agent prose

2. **Agent-declared facts** — workflow meaning provided through an explicit
   structured channel: a control-API call, a protocol message, a structured
   hook event, a metadata field, or a deliberate user/agent action. Maxx stores
   and replays these verbatim; it never originates or reinterprets them. The
   declared workflow-state badge (`set-state` / `set-summary`) and the sidebar
   agent-activity indicator (the hook event pipeline) are both of this kind.

3. **Workflow truth** — any semantic claim about the work itself: _task
   complete_, _blocked_, _ready for review_, _PR created for this task_, _tests
   passed for this change_, _implementation done_, _next step known_. Maxx may
   present workflow truth **only** when it is an agent-declared fact. Maxx never
   derives it.

## The rule

- Maxx may show **mechanical facts** as mechanical facts.
- Maxx may show **agent-declared facts** when they arrive through an explicit
  structured declaration.
- Maxx must **not** derive **workflow truth** by any of:
  - scraping or regexing terminal output / PTY scrollback
  - parsing agent prose (free-form text) to infer completion, success,
    blockers, next steps, or workflow state
  - interpreting command names, process names, or argv
  - inspecting branch names, file paths, or worktree locations
  - reading PR URLs as semantic state
  - using idle time as a proxy for completion
- Any semantic status surface must identify its source as **mechanical** or
  **explicitly declared**. If neither applies, the status must not be shown as
  truth.

If an agent has no explicit declaration path for a status you want to surface,
**document the gap** — do not fill it with a heuristic.

## Where the rule lives in the code

The rule is enforced by type boundaries, not just discipline: the surfaces that
display status have no access to terminal output, so inference is impossible by
construction rather than merely prohibited.

| Surface                                        | Kind                        | Source of truth                                                                                                                    | File                                                                                                      |
| ---------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `lifecycle` (running/exited/closed/archived)   | Mechanical                  | Surface existence + kernel-reported process exit                                                                                   | `macos/Sources/Features/Control/ControlSession.swift`, `ControlSessionRegistry.swift`                     |
| Declared workflow-state badge + summary        | Agent-declared              | `sessions.set-state` / `sessions.set-summary` only                                                                                 | `ControlSession.swift` (`WorkflowState`, `ControlDeclaredState`), `SurfaceView.swift` (`AgentStateBadge`) |
| Agent-reported metadata chip                   | Agent-declared              | `sessions.create` (at spawn) / `set-metadata` / `update` / `remove-metadata` / `clear-metadata`                                    | `ControlSession.swift` (`metadata`), `SurfaceView.swift` (`AgentMetadataBadge`)                           |
| Audit log (`wait` / `watch` / `events`)        | Agent-declared + mechanical | Explicit declarations + Maxx-recorded lifecycle actions                                                                            | `ControlEvents.swift`, `ControlSessionRegistry.swift`                                                     |
| Persistent session registry (restored records) | Agent-declared + mechanical | `registry.json` — only stored identity, relationships, declared facts, and timestamps; replayed verbatim on load, never re-derived | `ControlSessionPersistence.swift`, `ControlSessionRegistry.swift` (`rehydrate`)                           |
| Sidebar agent-activity indicator               | Agent-declared + mechanical | Hook events the agent CLI fires (`maxx-agent-hook`) + terminal bell/progress                                                       | `macos/Sources/Features/Terminal/TerminalAgentActivity.swift`, `src/agent_hook/main.zig`                  |

### The control API (declared workflow state)

`sessions.set-state` accepts only a fixed, validated vocabulary (`running`,
`needsInput`, `blocked`, `complete`, `failed`); `sessions.set-summary` carries a
free-form line. Both are agent-declared, recorded with a source and timestamp,
audited, and shown verbatim. They are intentionally separate from the
Maxx-owned `lifecycle` and from the free-form `status`, so the UI presents them
as agent-provided rather than Maxx-derived (the badge popover literally says
"Reported by the agent — not derived by Maxx"). See
[Control API](control-api.html).

### The hook event pipeline (sidebar agent-activity)

The "automatic" Claude Code / Codex status is **not** Maxx watching the
terminal. The agent CLI fires explicit hooks (e.g. Claude Code's
`UserPromptSubmit`, `Stop`, `Notification`; Codex's configured hooks). The
bundled `maxx-agent-hook` helper translates the **explicit hook event name** to
a normalized state and writes a structured JSON line to a per-surface event
file; Maxx reads that file and renders the declared state. The helper and the
reducer recognize only a closed vocabulary of declared event names — an
unrecognized event yields no state rather than a guess. No terminal output is
ever read.

### The idle-time boundary (a mechanical display bound, not inference)

`TerminalAgentActivityReducer` keeps a running indicator lit only while a turn
is in progress, with one safety bound: a `running` indicator that is never
closed out by a further hook event expires after `runningTTL` (6 hours). This is
a display-hygiene bound, **not** idle-time inference of completion: it clears a
stale `running` spinner back to the neutral `idle` baseline (the absence of an
active turn) and can never produce a `complete`, `failed`, or any other workflow
claim. Idle time is never read as "the work finished."

## Tests that lock this down

Negative fixtures feed Maxx the tempting-but-prohibited signals and assert it
infers nothing; positive fixtures prove explicit declarations still render.

- `macos/Tests/Control/NoInferenceGuardrailsTests.swift` — terminal prose
  (`done`, `tests passed`, `blocked`, PR URLs), process/command names, branch
  names, paths/worktree locations, and idle time never produce a workflow state;
  explicit `set-state` / `set-summary` still do.
- `macos/Tests/Terminal/TerminalAgentActivityTests.swift` — unrecognized /
  prose-like hook event fields never yield an activity state; the TTL only ever
  expires to `idle`.
- `src/agent_hook/main.zig` (`agent hook state normalization`) — prose, PR
  URLs, and branch-like strings normalize to no state.
- `src/connector/connector.zig` (`no-inference: adapters surface only explicit
  fields`) — connector payloads stuffed with uncopied bait (branch, head ref,
  labels, plain state strings, assignees, paths) never leak into the event,
  prompt, provenance metadata, caller, group, or the emitted `sessions.create`
  request; only explicitly copied fields and templated group values from
  explicit event fields appear.
- `src/runner/runner.zig` (`no-inference: only explicit fields and reserved
  provenance reach the request`) — the automation trigger runner dispatches a
  payload stuffed with bait and asserts none of it reaches the `sessions.create`
  it sends; the runner's own provenance is limited to reserved, explicit
  `runner.*` keys. A polling trigger fires only on its configured exit-code
  contract and forwards the check's stdout as an opaque payload — it never reads
  the output to decide meaning (`src/runner/poll.zig`).
- `src/webhook/handler.zig` (`no-inference: webhook bait fields never reach the
  launch`) — a webhook payload stuffed with bait reaches the launch only through
  the connector adapter's explicit fields; the listener authenticates and frames
  the request but interprets nothing, and the raw body is handed to the command
  verbatim (a temp file) rather than scraped.
- `macos/Tests/Control/ControlSessionPersistenceTests.swift`
  (`rehydrationNeverInfersUndeclaredSemanticFields`) — a persisted record whose
  mechanical fields (command `git commit -m done …`, cwd `/repo/feature-complete`,
  title `tests passed …`) read like completion signals never rehydrates with a
  guessed `workflow_state`, `summary`, or `agent_type`; only explicitly declared
  facts survive a restart, verbatim.
