# Parallel agents through GitHub

How multiple Claude agents work on `zuu` concurrently without creating a clusterfuck on the local branch. Read this together with [AGENTS.md](../AGENTS.md).

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
7. **Clean up on merge.** Delete the branch and worktree after merge. Prune stale local branches routinely (`git fetch --prune`, then delete branches whose upstream is `gone`).

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
