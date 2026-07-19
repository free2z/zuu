# CLAUDE.md

Read **[AGENTS.md](./AGENTS.md)** first — it is the contribution doctrine for
this repo:

## IRON RULE — local `main` is read-only

**LOCAL `main` NEVER CHANGES EXCEPT BY FAST-FORWARD PULL FROM THE REMOTE.**
No agent — and no human — ever commits or merges to local `main`. Not once, not
for a "trivial" one-liner. Every change, without exception, flows through this
exact cycle:

1. `git fetch origin`, then create a **worktree branched from `origin/main`**
   (never from local `main`):
   `git worktree add -b <type>/<slug> <path> origin/main`.
2. Make the changes in the worktree; verify.
3. Push the branch to `origin` and open a **PR** against `main`.
4. **Squash-merge the PR onto the REMOTE** `origin/main` (`gh pr merge --squash`,
   honoring the repo's merge queue / required checks).
5. Local `main` is updated **only** by `git pull --ff-only origin main` in the
   primary working tree. It must ALWAYS equal `origin/main` and must NEVER be
   ahead of the remote.

**Why this is absolute:** an un-pushed commit on local `main` is not saved —
`git reset --hard origin/main` or a fresh re-clone silently destroys it, and
nothing is durable until it lands on `origin`. Keeping local `main` a pure
fast-forward mirror of the remote means the human always sits on a clean `main`
that only ever moves forward, and every change carries a reviewable PR trail.

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
