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

There is exactly one **required** check, `gate`, and it lives in
[`.github/workflows/zuuli.yml`](../.github/workflows/zuuli.yml). Everything that
must be true before a merge is decided inside it or awaited by it.

| Workflow | Publishes a gate? | Covers |
| --- | --- | --- |
| `zuuli.yml` | **yes — the required `gate`** | ZUULI frontend + Playwright, Rust fmt/clippy/deny across every crate under `wallet/`, target-native clippy on macOS and Windows, and the repository policy scripts |
| `wallet-surfaces.yml` | no | build coverage for free2z and e2e2z — typecheck, tests, bundle, `cargo build` per backend |
| `zuuallet.yml` | no | Zuuallet frontend + backend, and the weekly `upstream-canary` against latest librustzcash `main` |

Two consequences worth internalising:

- **The delegated surfaces are gated by `zuuli.yml`, not by their own
  workflow.** Its change detector selects `wallet/free2z/**` and
  `wallet/e2e2z/**`, so the capability and boundary checks in
  [`docs/architecture.md` §4](./architecture.md#4-what-enforces-the-boundary)
  run on every pull request that touches either tree. `wallet-surfaces.yml`
  publishes no gate and is registered in `check-workflow-gates.mjs`'s
  `UNGATED_WORKFLOWS`.
- **`rust_fmt` / `rust_clippy` / `rust_deny` discover crates** by finding
  `Cargo.toml` under `wallet/` rather than listing them, so a new crate is gated
  from its first commit and cannot escape the MSRV check by never being
  registered.

A green gate is necessary and not sufficient — see
[`docs/PARALLEL-AGENTS.md`](./PARALLEL-AGENTS.md) for the merge mechanics.

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
