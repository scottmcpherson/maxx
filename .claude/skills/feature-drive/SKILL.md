---
name: feature-drive
description: Pick up a Maxx Linear issue (team Maxx, MAX-NNN) and drive it to done — fetch the issue, work on a branch, implement, build and exercise the running app with computer use + screenshots, run /code-review, attach evidence, and move the Linear issue through its statuses. Use when the user points at a Linear issue ID or URL ("/feature-drive MAX-123", "drive MAX-12", "pick up the next issue"), asks what to work on next from Linear, or hands off an issue for implementation.
---

# Drive a Linear issue to done

The issue says **what** to build; this skill is the invariant **procedure** for getting it done. "Done" includes the Linear bookkeeping — code merged with a stale issue is not done.

Maxx is a native macOS terminal app (a Ghostty fork, built with Zig). Read `AGENTS.md` for build/test/format commands and `WORKFLOW.md` for the branch-and-PR rules; this skill assumes both.

## 1. Take the issue

1. **ID given** (e.g. `MAX-123`)? `get_issue` it. **No ID?** `list_issues` (team Maxx, unstarted states, ordered by priority) and propose the highest-priority unblocked issue before starting.
2. Read the description, acceptance criteria, comments, and relations. **If it's blocked by unfinished issues, stop and report the blockers** — never start blocked work.
3. `save_issue` → state **In Progress**. If the issue is unassigned, assign it to yourself (`me`); if it already has an assignee, leave it.
4. Branch from an up-to-date `main` (per `WORKFLOW.md`) — never work directly on `main`:
   ```
   git switch main && git pull --ff-only
   git switch -c <branch>
   ```
   Use the issue's `gitBranchName` from `get_issue` (it auto-links the PR to the issue via the GitHub integration); otherwise `<type>/max-<n>-<short-slug>`, e.g. `fix/max-123-tab-title-crash`.

## 2. Implement

- Build to the acceptance criteria; re-read them as you go, not just at the end.
- Match surrounding code conventions. The shared Zig core is in `src/`, the macOS app in `macos/`, the GTK app in `src/apprt/gtk`; `AGENTS.md` has the stack notes.
- If the issue is underspecified or contradictory, decide sensibly and comment the decision on the issue so it outlives the session.

## 3. Prove it

1. **Tests & formatting** for what you touched — don't run the full suite blindly:
   - `zig build test -Dtest-filter=<name>` for affected Zig tests, plus `zig fmt .` (and `swiftlint lint --strict --fix` / `prettier -w .` if you touched Swift / other files).
2. **Build and drive the app.** Create a dev build and launch it with `zig build run`, then use **computer use** to exercise the change in the running app — click/type through the relevant flow and take **screenshots** along the way. Every acceptance criterion must be observably met in the screenshots; a criterion with no supporting screenshot gets called out in the report, never assumed.
3. Run **/code-review** (default `high`). Address findings; re-test if the fixes were non-trivial.

## 4. Close the loop

1. Tick the acceptance-criteria checkboxes in the issue description (`save_issue`); any box left unticked gets a written reason.
2. Attach each screenshot (or clip) to the issue: `prepare_attachment_upload` (contentType `image/png` or `video/mp4`, exact byte `size`) → PUT the raw bytes to the returned signed URL with its headers verbatim → `create_attachment_from_upload`. One file at a time — signed URLs expire fast, so prepare/PUT/finalize each before starting the next. Screenshots can also embed inline in the completion comment.
3. Completion comment: what changed (areas/files), how it was verified (what you ran, what you watched in the app), and anything deferred and why.
4. Commit on the branch following the repo's commit convention (the `writing-commit-messages` skill — `<subsystem>: <summary>`, e.g. `terminal: fix tab title crash`), then push and open a PR (`gh pr create`) with `Fixes MAX-<n>` in the body so Linear links and closes it on merge. Merged or user-confirmed → state **Done**; awaiting review → state **In Review** and say so in your report.

## Failure honesty

If the build won't run, verification can't pass, or the issue turns out to be mis-scoped: leave it **In Progress** with a comment stating exactly where things stand, what's blocking, and the next concrete step. Never move an issue to Done on hope; never close with failing checks.
