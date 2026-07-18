# CLAUDE.md

Read **[AGENTS.md](./AGENTS.md)** first — it is the contribution doctrine for
this repo:

- `zuu` is a **synthetic monorepo**; `z/` vendors Zcash-ecosystem repos as
  submodules so we depend on them **in source**.
- We **stay on upstream HEAD** and **contribute fixes** rather than pinning to
  old commits.
- When HEAD breaks us: if it's our bug, **fix forward**; if it's a real upstream
  regression, **branch → PR upstream → add the fork to `z/` → pin our commit
  transiently → resume `main` once merged**.
- Moving the **whole ecosystem forward** takes priority over Zuuallet's own
  short-term stability.

Per-project specifics:

- `wallet/zuuallet/CLAUDE.md` — Zuuallet desktop app (Tauri v2 + React).
- `wallet/plugins/tauri-plugin-zcash/CLAUDE.md` — Rust plugin, build commands,
  librustzcash API gotchas.
- `.github/workflows/zuuallet.yml` — CI that proves dependency bumps still build.
- `docs/PARALLEL-AGENTS.md` — how parallel agents collaborate through GitHub
  (worktrees/issues/PRs).
