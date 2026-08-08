# Parallel agents through GitHub

How multiple Claude agents work on `zuu` concurrently without creating a clusterfuck on the local branch. Read this together with [AGENTS.md](../AGENTS.md).

## IRON RULE — local `main` is read-only

This is the one rule that makes everything below work. If you read nothing else, read this.

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

## Roles
- **Orchestrator** (the human + their lead agent) stays on `main`, always. Local `main` only ever fast-forwards to `origin/main` — never committed to, never left dirty. The orchestrator creates issues and dispatches subagents; it does not edit the working tree of `main`.
- **Worker subagents** do all code changes, each in its **own git worktree** (via the Agent tool's `isolation: "worktree"`), so N agents build in parallel with zero working-tree collisions.

## The loop (per unit of work)
1. **Issue first.** Every task becomes a GitHub issue with scope + acceptance criteria before code exists. Issues are the shared coordination surface. Use labels: `agent-ready`, `in-progress`, `blocked`.
2. **One issue → one worktree → one branch → one PR.** Branch name: `type/<issue#>-slug` (e.g. `feat/152-search-page`, `fix/160-onboarding-crash`, `docs/158-x`). PR body includes `Closes #<issue#>`.
3. **Small, focused PRs.** Each PR closes one issue and stays reviewable. This is the antidote to giant mega-branches.
4. **CI is the merge gate.** `.github/workflows/zuuli.yml` (and any other required checks) must be green. Never merge red.
5. **Rebase onto `origin/main` frequently.** Resolve conflicts in the worktree — never on `main`.
6. **Partition file surfaces** across concurrent tasks so parallel PRs don't collide. Sequence dependent work; land shared/foundational changes first.
7. **Clean up immediately after merge.** Before removal, verify all of these:

   - GitHub reports the PR merged and local `HEAD` equals that PR's
     `headRefOid`. A clean worktree alone does not detect unpushed or post-PR
     commits, and squash-merging breaks normal ancestry checks.
   - `git status --short --untracked-files=all --ignore-submodules=none` is
     empty, then inspect the same command with `--ignored=matching`. These
     explicit options prevent user configuration from hiding files without
     expanding every file under large ignored build directories. Delete known
     reproducible output, but preserve local-only data such as `private/`,
     `.env.local`, and `release-artifacts/` when present.
   - Within every initialized submodule, recursively run the same tracked,
     untracked, and ignored-file checks. Verify that its checked-out gitlink
     commit is fetchable from the configured remote; inspect `git stash list`
     and local refs, and push every commit worth keeping. Relocate any
     local-only data before removal: superproject status does not list ignored
     files or per-worktree Git metadata inside submodules.

   Then remove the worktree, use `git branch -D` to delete its local branch
   (squash merges make `-d` reject it), and run `git worktree prune` plus
   `git fetch --prune`. Delete the exact remote worker branch explicitly, then
   fetch with pruning again. `-D` and remote deletion are allowed only after
   the `headRefOid` equality check above. Never run `git submodule deinit`
   during cleanup: submodule
   registrations live in shared repository configuration, so it can disrupt
   other active worktrees. Never leave merged Rust/Tauri worktrees retaining
   `target/`, `node_modules/`, or other reproducible build output. Never use
   force removal to override a dirty or unmerged worktree. Git may require
   `git worktree remove --force` solely because a verified-clean worktree
   contains initialized submodules; use it only after every safety check above
   passes.

   If any check fails, keep the worktree and inspect its diffs, files, commits,
   submodules, and PR state. Commit and push useful work, or get the owner's
   direction before discarding anything. `git worktree prune` removes stale
   metadata; it does not make a worktree safe to delete.

## Branch & PR conventions
- Prefixes: `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `deps/`.
- One logical change per PR. If a PR grows past a few hundred lines of real diff, split it.
- Reference the issue with `Closes #N` (or `Refs #N` if it only partially addresses it).
- Never commit build artifacts (`dist/`, `node_modules/`, `target/`) — they belong in `.gitignore`.

## Repo-specific care
- `z/` are **git submodules** (Zcash ecosystem, in-source deps). A fresh worktree does not automatically have submodules checked out; run `git submodule update --init --recursive` in the worktree before any build that needs them. Doc-only or frontend-only changes usually don't.
- Follow the upstream-contribution doctrine in [AGENTS.md](../AGENTS.md): stay on upstream HEAD, fix forward, PR upstream regressions, pin forks in `z/` only transiently.
- Keep this doc and conventions in-repo so every fresh agent inherits them.

## Recovering from mistakes
- Deleted a branch by accident? `git reflog` holds it for ~90 days; `git branch <name> <sha>`.
- Local `main` diverged? `git switch main && git reset --hard origin/main` (only ever on `main`, since we never commit there).
