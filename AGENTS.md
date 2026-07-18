# Working in `zuu` — the contribution doctrine

`zuu` is a **synthetic monorepo**. The `z/` directory vendors Zcash-ecosystem
repos as git submodules (`z/{github-org}/{repo}`) so we can depend on them **in
source** — build, test, and integrate against real upstream code rather than
released crates/packages. Our own apps (e.g. `wallet/zuuallet/`) depend on those
submodules via path dependencies.

This exists to **move the whole ecosystem forward together**, not just to keep
our apps building. Our software (Zuuallet especially) is experimental. When those
two goals conflict, **ecosystem progress wins over our own short-term
stability.**

- **Parallel agents:** see [docs/PARALLEL-AGENTS.md](docs/PARALLEL-AGENTS.md)
  for how multiple agents collaborate through issues/worktrees/PRs.

## The prime directive: stay on the bleeding edge, and contribute the fixes

We track upstream **HEAD** (the tracked branch in `.gitmodules`, usually `main`)
for the repos in `z/`. We do **not** sit on old pins to stay comfortable. When
moving to the latest breaks us, we fix it and push the fix outward.

### When a dependency's HEAD breaks us

First decide **whose bug it is**:

1. **It's our bug** — an API we call changed, a feature we relied on is no
   longer implicitly enabled, we were leaning on something undeclared.
   → **Fix forward in our code.** Port to the new API. Declare the features we
   actually use. Never pin the dependency backward to dodge our own porting
   work. (Example: when `propose_transfer` gained `SpendPolicy`/`TxVersion`
   args and `Payment::new` became `Result`, we updated `send.rs` — we did not
   pin librustzcash back.)

2. **It's a real upstream regression** — HEAD is genuinely broken for a valid
   configuration.
   → **Branch, PR, pin, resume:**
   1. Branch the dependency and fix it there.
   2. Open a PR **against upstream HEAD**.
   3. Add our fork to `z/` (or point the existing submodule's `url`/`branch` at
      our fork) so we can depend on the fix **in source** right now.
   4. Pin our own commit **transiently** — just until the PR merges.
   5. Once it's merged upstream, **move the submodule back to upstream `main`**
      and drop the fork/pin.
   Then repeat as we keep moving forward.

The point of pinning our own commit is never to park there. It's a bridge that
keeps the synthetic monorepo building **while** the fix is in flight upstream.

### Branching a dep is a signal to vendor it

If we need to branch something to make it work, that's a strong candidate to
**add to `z/`** (if it isn't already) so we can depend on it in source, test,
integrate, and move it forward alongside everything else.

## What NOT to do

- ❌ Pin a submodule to an old commit to avoid porting our code.
- ❌ Carry a local patch that only lives in someone's working tree. If a pin
  isn't reachable from the submodule's configured remote, a fresh clone and CI
  **cannot build it**. Push the fix to a fork we control and point `.gitmodules`
  at it. (This repo has been bitten by exactly this — a `buildskin` patch that
  only existed locally, so `git submodule update --init` from a clean checkout
  could never reproduce the build.)
- ❌ Rely on transitive/implicit behavior (e.g. a Cargo feature enabled only by
  another crate's unification). Declare what we use.

## Guardrails that keep us honest

- **`.github/workflows/zuuallet.yml`** builds both halves of Zuuallet (frontend
  typecheck+build; Rust `cargo build` of the Tauri backend through the
  librustzcash path deps) on every change to the app, its deps, or the
  `z/zcash/librustzcash` submodule pointer. If a bump breaks us, CI says so.
- The workflow's **weekly `upstream-canary`** job rebuilds against the *latest*
  librustzcash `main` + refreshed crates, so upstream drift surfaces as an early
  warning **before** we bump the submodule in a PR.

## Verifying before you push

A warm local build is a liar. It reuses artifacts and, worse, resolves Cargo
**features** and npm **optional-dependency trees** differently than a clean
checkout — so a build that's green on your machine can be red in CI for reasons
your machine will never show you. Two specific traps we've hit:

- **Feature unification masking.** Your local dependency graph may turn on a
  Cargo feature (e.g. `rusqlite/array`, `tonic/transport`) that CI's graph does
  not, so code using that feature compiles locally and fails in CI. `cargo build`
  locally will *not* reproduce this; only a clean build does.
- **Toolchain skew.** A newer stable `rustc` can reject code an older one
  accepted (e.g. `Self::Error` becoming an ambiguous associated type). Verify
  with the **same toolchain CI uses** (`rustup toolchain install <ver>` +
  `cargo +<ver>`), not whatever you happen to have.
- **Platform-gated dependencies.** A dependency under
  `[target.'cfg(target_os = "…")'.dependencies]` only exists for that OS. In
  TOML, every `key = …` after a `[table]` header belongs to that table until the
  next header — so deps written below a `cfg(macos)` block are silently
  macOS-only even if you meant them to be universal. Zuuallet's entire zcash stack
  was accidentally macOS-gated this way; it built on every developer's Mac and
  failed on Linux CI with `unresolved import zcash_protocol`. Cross-platform
  deps go in `[dependencies]`. Check placement with
  `cargo tree --target x86_64-unknown-linux-gnu -i <crate>` — if it prints
  "nothing to print" for a dep you use everywhere, it's gated to the wrong
  target.

So: for anything touching Rust deps/features, verify in a **clean Linux build
with CI's toolchain** — a throwaway `ubuntu:24.04` container that installs the
pinned `rustc`, fetches only the needed submodule, and runs the same `cargo
build --locked` — and **let it finish**. That is the only local check that sees
what CI sees. The workflow's `--locked` build and standalone plugin build exist
to catch these too, but catching them before the push is cheaper than a red run.

## Practical notes

- Submodules live at `z/{github-org}/{repo}` and track a branch (see
  `.gitmodules`). Update to latest with `git submodule update --remote`.
- A submodule pin must be **fetchable from its configured `url`**. Verify a
  fresh `git submodule update --init <path>` works before relying on a pin.
- Lockfiles must be **cross-platform**. `package-lock.json` generated on macOS
  can fail `npm ci` on Linux CI (diverging optional-dependency subtrees);
  regenerate so it satisfies both. Cargo features must be declared, not
  inherited by luck.
- Per-project agent docs (`wallet/zuuallet/CLAUDE.md`,
  `wallet/plugins/tauri-plugin-zcash/CLAUDE.md`) carry the concrete build
  commands and API gotchas. This file is the *why*; those are the *how*.
