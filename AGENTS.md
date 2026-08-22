After making changes, rebuild the app and verify the changes are correct

Development loop: run `pnpm dev` in a persistent user-owned terminal (`pnpm dev --no-mobile` for desktop-only work). The primary checkout keeps the familiar defaults; linked worktrees automatically receive isolated ports, data, desktop previews, and mobile app identities. Use `pnpm dev:status` for the current checkout and `pnpm dev:list` for all worktrees. During iteration, use focused tests and rendered UI checks. Run the full relevant tests, build, and packaged smoke once at final handoff rather than after every edit.

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
