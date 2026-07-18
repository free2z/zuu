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
- Moving the **whole ecosystem forward** takes priority over ZUULI's own
  short-term stability.

Per-project specifics:

- `wallet/zuuli/CLAUDE.md` — ZUULI desktop app (Tauri v2 + React).
- `wallet/plugins/tauri-plugin-zcash/CLAUDE.md` — Rust plugin, build commands,
  librustzcash API gotchas.
- `.github/workflows/zuuli.yml` — CI that proves dependency bumps still build.
