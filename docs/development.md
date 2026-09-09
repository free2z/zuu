# Development

Getting the apps built and tested, and how CI decides whether a change may
merge. This page orients; [AGENTS.md](../AGENTS.md) is the authority on
doctrine, guardrails, and the traps that make a warm local build lie to you.

---

## Prerequisites

Install only what the project you picked needs.

| For | You need |
| --- | --- |
| Anything | Git, and the GitHub CLI (`gh`) for the issue/PR workflow |
| Any frontend | Node.js **24**, matching CI, and `npm` |
| Any native build | `rustup`; [`wallet/rust-toolchain.toml`](../wallet/rust-toolchain.toml) selects the exact compiler for every wallet crate |
| A Tauri bundle | Platform [system dependencies](https://v2.tauri.app/start/prerequisites/); iOS and Android also need Xcode or the Android SDK/NDK |

[`.devcontainer/`](../.devcontainer/) is an optional general-purpose container.
Project READMEs and CI remain authoritative for current commands and versions.

## Submodules

Submodules are intentionally **not** initialized in a fresh clone; initializing
the whole ecosystem is expensive. Take what your project needs. ZUULI and
Zuuallet need `librustzcash`:

```bash
git submodule update --init --recursive z/zcash/librustzcash
```

The delegated surfaces — free2z and e2e2z — need **no** submodule, because
neither links a Zcash crate.

## Running an app

Each app is an independent npm project under `wallet/`.

```bash
cd wallet/zuuli && npm ci && VITE_MOCK=1 npm run dev   # fixture-backed, no Rust
cd wallet/free2z && npm ci && npm run dev
cd wallet/e2e2z  && npm ci && npm run dev
```

Mock mode is UI evidence, not an end-to-end wallet or a production proof. For
the real staging API, native wallet, and mobile commands, continue with
[`wallet/zuuli/README.md`](../wallet/zuuli/README.md).

Native builds run through the app-local Tauri CLI, e.g.:

```bash
cargo build --locked --manifest-path wallet/zuuli/src-tauri/Cargo.toml
```

## Testing

`npm run verify` in any app is typecheck + typecheck of tests + `npm test`.
That is the command to run before pushing.

**`wallet/zuuli` has two independent JS suites and only one is easy to reach
for.** Vitest is separate from Playwright (`tests/*.pw.ts`, `npm run test:e2e`),
and the `zuuli / frontend` CI job requires both. Vitest green is **not** evidence
Playwright is green — the `.pw.ts` specs assert rendered copy, so any change
touching user-visible text, navigation, or component structure needs
`npm run test:e2e` (or `npm run verify`) before push. #822 and #803 both learned
this the expensive way.

Repository-wide policy checks live in [`scripts/`](../scripts/) and each carries
a `--self-test` that proves it still fails on the thing it exists to catch. Run
the check *and* its self-test; a check that has quietly become vacuous reports
green.

**Documentation links are checked too.**
[`check-markdown-links.mjs`](../scripts/check-markdown-links.mjs) resolves every
relative link in tracked Markdown *and the heading anchor after it*, so renaming
a heading in one file reddens the required `rs / gate` if another file links to
it — which is the common rot, since headings get reworded constantly while
filenames rarely move. It never fetches an external URL, by design. Run
`node scripts/check-markdown-links.mjs` after editing docs.

## Verify at the real conditions

A warm local build reuses artifacts and resolves Cargo **features** and npm
**optional-dependency trees** differently from a clean checkout, so a green
local build can be red in CI for reasons your machine will never show you.
Development is macOS-heavy; CI is Linux.

[AGENTS.md § *Verifying before you push*](../AGENTS.md#verifying-before-you-push)
documents the specific traps we have actually been bitten by — feature
unification masking, toolchain skew, platform-gated dependencies silently
landing inside a `cfg(target_os = "macos")` table, and integer widths that
differ per target while clippy sees only one. Read it before bumping a Rust
dependency. The short version: for anything touching Rust deps or features,
verify in a clean Linux container on CI's pinned toolchain and **let it
finish**.

## The CI gate model

Branch protection requires exactly two checks — `gate` and `rs / gate` — and
`check-workflow-gates.mjs` holds that set as a digest-pinned contract. Everything
that must be true before a merge is decided inside one of them or awaited by one
of them.

| Workflow | Publishes a gate? | Covers |
| --- | --- | --- |
| `zuuli.yml` | **yes — the required `gate`** | ZUULI frontend + Playwright, Rust fmt/clippy/deny across every crate under `wallet/`, target-native clippy on macOS and Windows, and the repository policy scripts |
| `rs.yml` | **yes — the required `rs / gate`** | the `rs/` Rust workspace, plus the tree-wide policy checks its `changes` job runs unconditionally: action pins, gate wiring, hash-domain labels, server images, the toolchain pin, and Markdown link resolution |
| `wallet-surfaces.yml` | no | `cargo build --all-targets` and `cargo test` of the free2z and e2e2z backends. Their frontend suites moved into `zuuli.yml`'s gated `surfaces` job in #915 |
| `zuuallet.yml` | no | Zuuallet frontend + backend, and the weekly `upstream-canary` against latest librustzcash `main` |

The [rs policy runtime record](ci/RS-POLICY-RUNTIME.md) contains per-step
measurements, the five-minute budget decision, and the read-only refresh command.

Two consequences worth internalising:

- **The delegated surfaces are gated by `zuuli.yml`, not by their own
  workflow.** Its change detector selects `wallet/free2z/**` and
  `wallet/e2e2z/**`, so the capability and boundary checks in
  [`docs/architecture.md` §4](./architecture.md#4-what-enforces-the-boundary)
  run on every pull request that touches either tree — and since #915 so do both
  surfaces' own suites, in the gated `surfaces` job. `wallet-surfaces.yml`
  publishes no gate and is registered in `check-workflow-gates.mjs`'s
  `UNGATED_WORKFLOWS`.
- **A change touching only a surface's frontend tests skips the native matrix.**
  `wallet/{free2z,e2e2z}/tests/**` and their `src/**/*.test.ts?(x)` are carved
  out of the `zuuli` selector and select `surfaces` instead (#949). Anything
  under `src-tauri/` — including a Rust integration test — is not, and still
  selects everything.
- **`rust_fmt` / `rust_clippy` / `rust_deny` discover crates** by finding
  `Cargo.toml` under `wallet/` rather than listing them, so a new crate is gated
  from its first commit and cannot escape the MSRV check by never being
  registered.

A green gate is necessary and not sufficient — see
[`docs/PARALLEL-AGENTS.md`](./PARALLEL-AGENTS.md) for the merge mechanics.

## Merge-queue readiness

**Decision for the current drain: retain the existing reviewed, gated merge
path.** Queue adoption remains open in [#947](https://github.com/free2z/zuu/issues/947).
The read-only settings audit on 2026-09-09 found `strict: true`, required contexts
`gate` and `rs / gate` from GitHub Actions (app ID `15368`), and no queue for
`main`. No settings changed as part of this audit.

Both [zuuli.yml](../.github/workflows/zuuli.yml) and
[rs.yml](../.github/workflows/rs.yml) already run on `merge_group` without path
filters. Their change jobs fetch full history and diff the event's
`merge_group.base_sha` against `GITHUB_SHA`; checkout uses that group commit,
not a PR head. This includes changes from earlier entries in the group.
Unavailable bases and failed diffs select the full suites. Concurrency keys
include the group head SHA, so distinct groups do not cancel each other. Both
final gates run with `always()` and verify every selected dependency.

A local audit executed both exact selector bodies against real temporary Git
histories: docs-only, frontend-only, combined frontend/protocol commits, missing
base, unavailable base, and failed diff. All six scenarios selected the expected
jobs. This proves selector behavior, **not** hosted event delivery or native
build results on a queue ref.

### Prerequisites for a separately authorized trial

1. Establish an eligible approving identity. Current protection requires one
   approval, code-owner approval, and approval after the last push. An approval
   comment is not an approving review. The present owner/admin merge path does
   not establish that an ordinary enqueue will satisfy those requirements.
2. If proof must precede enabling a queue on `main`, use a disposable protected
   pilot branch with the same required checks and a separately authorized queue.
   GitHub creates real `gh-readonly-queue/**` refs after enqueue; a branch merely
   named that way, a manual workflow run, or a simulated payload is not equivalent.
   See GitHub's [merge-group event contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group).
3. Begin conservatively: squash merging, build concurrency one, minimum and
   maximum merge size one, and only non-failing PRs. Choose the check timeout
   above measured cold-run wall time including runner waits. Enqueue an approved
   throwaway PR and record both exact required check names, Actions app identity,
   event, ref, head SHA, and successful conclusions. Include representative native
   and protocol inputs if claiming those jobs ran; docs-only legitimate skips
   prove context delivery, not native coverage. A real trial on `main` is an
   alternative, but necessarily happens after its queue is enabled.
4. For the trial, use ordinary `gh pr merge <number> --match-head-commit <sha>`
   after review/check requirements are met. The [CLI manual](https://cli.github.com/manual/gh_pr_merge)
   explains that this enqueues on a queue-required branch; `--admin` bypasses
   the queue. Do not make bypass the queue's routine merge path.
5. Record the trial evidence and owner decision in #947 before broader adoption.
   Keep all required checks and native coverage intact. Include removal of the
   pilot queue rules and branch in the separately authorized trial plan.

A queue removes manual branch-refresh work; it does not promise one CI build
for a batch. GitHub documents that **merge limits do not combine merge-group
builds**. Failed entries can be removed and later groups rebuilt without them;
this is not a promised binary-search isolation algorithm. See
[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

## Rust package layout

Six shipping Cargo package roots under `wallet/`, each the root of its own
resolution, lockfile, profiles and target directory:

```
wallet/plugins/tauri-plugin-zcash/    wallet/zuuli/src-tauri/     wallet/free2z/src-tauri/
wallet/plugins/tauri-plugin-f2zmsg/   wallet/zuuallet/src-tauri/  wallet/e2e2z/src-tauri/
```

(`wallet/zuuli/wasm-spike/` and `wallet/zuuli/crypto-target-spike/` are
investigation roots, not shipped.) Plus the protocol crates under
[`rs/crates/`](../rs/README.md). The reasoning,
and the conditions under which consolidating into a workspace would be
revisited, is [`architecture/CARGO-WORKSPACE.md`](./architecture/CARGO-WORKSPACE.md).
Read it before adding a crate.

## Contributing

The full loop — issue, worktree, branch, PR, review, merge, cleanup — is
[`docs/PARALLEL-AGENTS.md`](./PARALLEL-AGENTS.md). The rule that admits no
exception:

> **Local `main` is read-only.** Branch from `origin/main` in an isolated
> worktree, never from local `main`; squash-merge on the remote; move local
> `main` only with `git pull --ff-only origin main`.

```bash
git fetch origin
git worktree add -b <type>/<issue>-<slug> <worktree-path> origin/main
```

Contributors without push access follow the same shape from a fork.
