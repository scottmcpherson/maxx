# Releasing Maxx

Day-to-day work goes through the `feature-drive` skill, which carries each Linear
issue to a merged PR and deliberately stops there. Cutting a release is a
separate, rarely-run ceremony: its actions are outward-facing and hard to
reverse (tags, pushed tags, published releases), so it lives here and always
requires an explicit request and human confirmation.

## Remote-state guardrail

- Do not push, tag, publish, or otherwise change remote repository state unless
  explicitly requested. A `feature-drive` push + PR-open is the requested action
  for that drive; a release is **not** — it must be asked for on its own.

## Before a release

- `main` is the only release source. Require a clean, up-to-date `main`.
- Check for local and remote branches that have not landed on `main`; for each,
  decide merge / defer / abandon before cutting.
- Confirm required CI is green on the release source.

## Cut a release

- Require an explicit version or tag — never infer it.
- Show the release plan before running any remote-changing command.
- Ask for explicit confirmation before tagging, pushing, or publishing.
- Do not create tags, push branches, or publish releases unless explicitly
  requested and confirmed.
