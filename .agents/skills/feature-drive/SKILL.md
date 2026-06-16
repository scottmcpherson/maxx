---
name: feature-drive
description: Pick up a Maxx Linear issue (team Maxx, MAX-NNN) and drive it to done — fetch the issue, work in a dedicated git worktree, implement, build and exercise the running app with Peekaboo screenshots, run /code-review, attach evidence, shepherd the Codex PR review to a clean pass, and move the Linear issue through its statuses. Use when the user points at a Linear issue ID or URL ("/feature-drive MAX-123", "drive MAX-12", "pick up the next issue"), asks what to work on next from Linear, or hands off an issue for implementation.
---

# Drive a Linear issue to done

The issue says **what** to build; this skill is the invariant **procedure** for getting it done. "Done" includes the Linear bookkeeping — code merged with a stale issue is not done.

Maxx is a native macOS terminal app (a Ghostty fork, built with Zig). Read `AGENTS.md` for build/test/format commands; this skill assumes it.

## 1. Take the issue

1. **ID given** (e.g. `MAX-123`)? `get_issue` it. **No ID?** `list_issues` (team Maxx, unstarted states, ordered by priority) and propose the highest-priority unblocked issue before starting.
2. Read the description, acceptance criteria, comments, and relations. **If it's blocked by unfinished issues, stop and report the blockers** — never start blocked work.
3. `save_issue` → state **In Progress**. If the issue is unassigned, assign it to yourself (`me`); if it already has an assignee, leave it.
4. Create an isolated worktree from the freshest remote state (parallel-safe) — never work directly on `main`. All drive worktrees live under a single central tree, namespaced by repo, **outside** the checkout — never as siblings in `~/Developer` and never inside the repo (a worktree is a full checkout, so nesting it makes IDEs/Xcode/file watchers recurse into duplicate copies). From the repo root:
   ```
   repo=$(basename "$(git rev-parse --show-toplevel)")
   wt="$HOME/Developer/worktrees/$repo/max-<n>"
   git fetch origin && git worktree add "$wt" -b <branch> origin/main
   cd "$wt"
   ```
   Use the absolute `$wt` path, not a relative `../…` one (relative `..` breaks the moment a command runs from a subdir). The leaf is `max-<n>` — not the full branch, whose `<type>/…` slash would create a stray nesting level. `<branch>` is the issue's `gitBranchName` from `get_issue` (it auto-links the PR to the issue via the GitHub integration); fall back to `<type>/max-<n>-<short-slug>` (e.g. `fix/max-123-tab-title-crash`) if absent. Branch from `origin/main`, never from local HEAD — fetch-then-branch picks up the latest without ever running `git pull` into the main checkout, so it can't disturb a dirty main or sibling worktrees no matter how many drives run in parallel. Do all the work from inside `$wt`.

## 2. Implement

- Build to the acceptance criteria; re-read them as you go, not just at the end.
- Match surrounding code conventions. The shared Zig core is in `src/`, the macOS app in `macos/`, the GTK app in `src/apprt/gtk`; `AGENTS.md` has the stack notes.
- If the issue is underspecified or contradictory, decide sensibly and comment the decision on the issue so it outlives the session.

## 3. Prove it

1. **Tests & formatting** for what you touched — don't run the full suite blindly:
   - `zig build test -Dtest-filter=<name>` for affected Zig tests, plus `zig fmt .` (and `swiftlint lint --strict --fix` / `prettier -w .` if you touched Swift / other files).
2. **Build and drive the app.** From the worktree, build with `zig build`, then launch the dev build on its **own** control socket — namespaced per issue so parallel drives never fight each other (or an installed Maxx) over a shared per-user socket:
   ```
   open -n --env MAXX_CONTROL_DIR=/tmp/maxx-control-max-<n> zig-out/Maxx.app
   ```
   Pass that same `MAXX_CONTROL_DIR` to every `ghostty +control …` call (the control API is the headless way to drive and observe a change end to end). Take **screenshots with Peekaboo** — the `peekaboo` CLI runs from Bash with no per-call approval and captures a window by pid/bundle id even when it isn't frontmost (so no Spaces juggling, and no computer-use MCP). Target the dev build by pid or `--app com.scottmcpherson.maxx.debug` (plain `Maxx` collides with an installed build):
   ```
   peekaboo image --pid <dev pid> --mode window --path shot.png
   ```
   Use `peekaboo click` / `peekaboo type` for any UI a human would drive. Then `Read` the PNG. Every acceptance criterion must be observably met in the screenshots; a criterion with no supporting screenshot gets called out in the report, never assumed.
3. Run **/code-review** (default `high`). Address findings; re-test if the fixes were non-trivial.

## 4. Close the loop

1. Tick the acceptance-criteria checkboxes in the issue description (`save_issue`); any box left unticked gets a written reason.
2. Attach each screenshot (or clip) to the issue: `prepare_attachment_upload` (contentType `image/png` or `video/mp4`, exact byte `size`) → PUT the raw bytes to the returned signed URL with its headers verbatim → `create_attachment_from_upload`. One file at a time — signed URLs expire fast, so prepare/PUT/finalize each before starting the next. Screenshots can also embed inline in the completion comment.
3. Completion comment: what changed (areas/files), how it was verified (what you ran, what you watched in the app), and anything deferred and why.
4. Commit on the branch following the repo's commit convention (the `writing-commit-messages` skill — `<subsystem>: <summary>`, e.g. `terminal: fix tab title crash`), then push and open a PR (`gh pr create`) with `Fixes MAX-<n>` in the body so Linear links and closes it on merge. Move the issue to **In Review** (`save_issue`).
5. **Shepherd the Codex review.** Codex reviews the PR automatically — it usually starts ~5 minutes after the PR opens (it reacts 👀, then posts inline comments: `P1` = must-fix, `P2` = should-fix; a clean pass is an explicit LGTM/approval or no `P1`/`P2` findings). Wait for it, re-checking every minute or so (`gh pr view <n> --comments` plus the PR's review threads); if nothing has landed ~10 minutes after the PR opened or after a push, nudge it with a `@codex review` PR comment. Then loop, **at most 3 rounds**:
   - **Clean pass** → review is done; go to step 6.
   - **Valid changes requested** → fix them in the worktree. Don't patch only the commented line: identify the violated invariant, audit sibling paths for the same pattern, add focused regression tests, and summarize the sweep in a PR reply (this is AGENTS.md's review-feedback rule). Re-run the narrow tests/build from step 3, commit (same convention) and push, then re-request with a `@codex review` comment and wait for the next pass.
   - **A finding you believe is wrong** → don't silently ignore it; reply on the thread with your reasoning, and treat it as settled only if Codex doesn't re-raise it. Never change code just to appease a finding you can't justify.
   After 3 rounds without a clean pass, **stop** — leave the issue **In Review**, comment on the issue (and PR) with exactly which findings remain contested and the next concrete step, and report. Never loop past 3 rounds or merge over an unresolved `P1`.
6. **Land the status.** Require green CI and a clean Codex pass before any merge — never merge red. Merged or user-confirmed → state **Done**; clean review but still awaiting a human merge → leave **In Review** and say so in your report.
7. **Worktree removal is intentionally not done here** — the drive session ends at PR-open / review sign-off, well before the merge/close that makes a worktree safe to remove, so a reap step here could never run. Reap a merged drive's worktree separately: `git worktree remove "$wt"` once the PR has landed, then `/commit-commands:clean_gone` after the remote branch is deleted.

## Failure honesty

If the build won't run, verification can't pass, or the issue turns out to be mis-scoped: leave it **In Progress** with a comment stating exactly where things stand, what's blocking, and the next concrete step. Never move an issue to Done on hope; never close with failing checks.
