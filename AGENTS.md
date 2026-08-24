# Working in `zuu` — the contribution doctrine

## eXtreme, Lean, Trunk-based development on steroids

We ship a massive amount of work **in parallel, autonomously, with agents** — not
by fiddling with a local worktree. The ONLY loop is:

1. A human (or agent) names something that needs to change.
2. **Subagents** do the work in **isolated worktrees** → **issues/PRs** →
   automated **QA gate + adversarial review** → **squash-merge to `main` on the
   remote**.
3. Local `main` is **fast-forwarded from the remote** — the changes arrive
   already reviewed, gated, and merged. Then repeat.

**Never, ever, do we have a dirty local `main`.** Uncommitted changes sitting on
the primary checkout is a process failure, not a deliverable. Nobody hands the
human stray local edits to "review" — the whole point is that the PR pipeline
already proved the change is good **before** it reaches local `main`.

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
6. After the merge is confirmed, promptly remove the worker worktree and local
   branch, then prune its remote-tracking metadata. First verify
   that the PR merged into this repository's `main`, that its merge commit is
   on `origin/main`, and that the checked-out and local branch match the PR's
   head name and commit. Confirm the worker and its background processes have
   stopped. Audit branch and worktree reflogs, then inspect tracked, untracked,
   and ignored files and reflogs in every initialized submodule; preserve
   anything needed before deleting its last ref or reflog. Never use force
   removal to override dirty or unmerged work.
   Require exactly one credential-free canonical HTTPS fetch URL and push URL
   for `origin`, both targeting the PR's base host and repository. From the
   still-present verified worktree, reject any Git URL-rewrite rule that can
   match the push URL, then delete the remote branch through that literal URL
   with a lease bound to the verified head commit. Treat global worktree
   pruning as a separate audited operation; never let it remove metadata for an
   unavailable worktree.
   Build-heavy merged worktrees (`target/`, `node_modules/`, etc.) must not be
   left behind.

**Why this is absolute:** an un-pushed commit on local `main` is not saved —
`git reset --hard origin/main` or a fresh re-clone silently destroys it, and
nothing is durable until it lands on `origin`. Keeping local `main` a pure
fast-forward mirror of the remote means the human always sits on a clean `main`
that only ever moves forward, and every change carries a reviewable PR trail.

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

## Review governance — required, but never a bottleneck

Branch protection **requires 1 approving review** on `main` — this is real
governance, and **colleagues are always subject to it**; no one merges unreviewed.
The reviewer, though, is almost always an **agent acting on the owner's behalf**,
watching PRs and approving the instant CI is green so nobody is ever blocked.
Skylar is the owner/CEO/CTO and moves at the speed of light: when no
colleague-agent reviewer is around, the owner **overrides via admin** and keeps
going (`enforce_admins=false`; `gh pr merge --squash --admin` **after** the CI
`gate` is confirmed green). The admin path bypasses the *human* check, never the
*QA* check — CI must be verified green first. In ~99.999% of cases the "human
review" is simply an agent standing in for the owner, not a person.

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
- ❌ Add a crate that brings a second `rusqlite`. `libsqlite3-sys` declares
  `links = "sqlite3"`, and Cargo refuses outright to build a graph containing
  two versions of a `links` package — a hard error, not a warning. Everything
  under `wallet/` reaches SQLite through `wallet/plugins/tauri-plugin-zcash`'s
  `rusqlite = { version = "0.37", features = ["bundled", "array"] }`, and
  `wallet/zuuli/src-tauri` links that plugin together with the rest of the app,
  so **rusqlite 0.37 is a repo-wide singleton**: any new crate that needs SQLite
  must resolve to it. All three lockfiles currently agree on `rusqlite 0.37.0` /
  `libsqlite3-sys 0.35.0`. Worked example: `openmls_sqlite_storage` 0.2.0 — the
  latest *release* — requires `rusqlite ^0.32` and is therefore unusable here;
  its `0.3.0-rc` line moved to `^0.37` and would fit. Check the requirement
  before adopting, because the conflict appears only once the app links both: a
  crate that builds fine on its own can still be off-limits.

## Guardrails that keep us honest

- **`.github/workflows/zuuallet.yml`** builds both halves of Zuuallet (frontend
  typecheck+build; Rust `cargo build` of the Tauri backend through the
  librustzcash path deps) on every change to the app, its deps, or the
  `z/zcash/librustzcash` submodule pointer. If a bump breaks us, CI says so.
- The workflow's **weekly `upstream-canary`** job rebuilds against the *latest*
  librustzcash `main` + refreshed crates, so upstream drift surfaces as an early
  warning **before** we bump the submodule in a PR.
- **`scripts/check-rust-toolchain.sh`** proves every Rust toolchain pin still
  agrees with `wallet/rust-toolchain.toml`, and — since #553 — that **every**
  tracked `Cargo.toml` and `rust-toolchain.toml` outside `z/` is registered with
  it, so a crate cannot escape the MSRV check by never being registered. The
  `wallet/zuuli` gate runs it on every pull request, so a half-finished bump
  fails in review instead of in a protected store release. See below.
- **`scripts/check-rust-fmt.sh`**, **`scripts/check-rust-clippy.sh`** and
  **`scripts/check-rust-deny.sh`** hold every Rust crate under `wallet/` to
  rustfmt, `clippy -D warnings`, and the `wallet/deny.toml` supply-chain policy.
  All three **discover** crates by finding `Cargo.toml` under `wallet/` rather
  than listing them, so a new crate is gated from its first commit. All three
  run on the pinned toolchain and refuse to render a verdict on any other —
  rustfmt's output and clippy's lint set both move between compiler versions,
  and a check that ran on whatever was installed would report version skew as a
  code defect. Each has a mirrored job in `zuuallet.yml`, because the required
  `gate` lives in `zuuli.yml` and its change detector does not select
  `wallet/zuuallet/**`. Which tree they judge is `--root`'s to say (default
  `wallet`, so the wallet gate is unchanged), `--config` chooses the policy
  `check-rust-deny.sh` enforces, and clippy's `z/zcash/librustzcash`
  requirement is read out of the manifests rather than assumed — so a second
  top-level Rust namespace is policed by the same three gates without
  inheriting the wallet's path-dependency baggage. All three carry a
  `--self-test` that proves they still fail on the thing they exist to catch.
- **Target-native clippy is part of the required gate.** Linux cannot compile
  macOS- and Windows-only Keychain, Credential Manager, filesystem, and OAuth
  branches. The `rust_native_clippy` matrix in `.github/workflows/zuuli.yml`
  therefore runs the same pinned `scripts/check-rust-clippy.sh` verdict on both
  native hosts, and `gate` explicitly awaits it. Each lane first executes a
  negative control that proves both `-D warnings` and the selected target OS,
  so an inherited cross-target cannot masquerade as a clean native verdict.
- **`wallet/deny.toml`'s `ignore` entries rot, and re-reading them will not tell
  you.** Each carries a human-written reason that was true the day it was
  written and quietly stops being true as the graph moves. A stale justification
  is worse than none: it launders an out-of-date assumption as a reviewed
  decision. Five high-severity `aws-lc-sys` advisories sat behind "aws-lc-rs
  1.15.4 pins the vulnerable line, and `0.38`/`0.39` is a semver-major bump we
  cannot reach" well after `wallet/zuuli/src-tauri` had already resolved
  aws-lc-rs 1.17.3 → aws-lc-sys 0.43.0 and stopped reporting them at all. So
  **re-derive instead of re-reading**: empty `ignore` in a local, uncommitted
  edit, run `scripts/check-rust-deny.sh advisories`, and diff what it actually
  reports against what the file claims. Remediation is tracked in **#351**.

## The Rust toolchain pin

### One source of truth

**`wallet/rust-toolchain.toml` decides the version. Nothing else does.**

Everything else in the repo restates it, because the surrounding tools cannot
read a TOML file at the moment they need the value:

| Restatement | Why it cannot just read the file |
|---|---|
| `rust-version` in every registered `Cargo.toml` manifest | Cargo needs a literal, and it is the **two-component MSRV floor** (`X.Y`) of the three-component channel (`X.Y.Z`) — deliberately a different form, compared as such |
| `ZUULI_RUST_VERSION` in `zuuli-packaging.yml` and `zuuli-release.yml` | A workflow-level `env:` cannot be computed from a file, and the release jobs verify the installed compiler with `rustc --version \| grep -F "rustc $ZUULI_RUST_VERSION "` |
| `dtolnay/rust-toolchain@<sha> # <version>` in packaging/release and target-native Zuuallet jobs | The action's **version branches hardcode the compiler in `action.yml` and do not declare a `toolchain` input at all** — a commit-pinned ref *is* the version pin, and the trailing comment is its only readable record |
| `dtolnay/rust-toolchain@<sha> # stable` in source-derived gate/Zuuallet jobs | `uses:` cannot contain an expression, so the generic action implementation is commit-pinned while its `toolchain:` input still reads the version from `wallet/rust-toolchain.toml`; the upstream canary deliberately omits that input so only its compiler selection follows `stable` |
| MSRV/`cargo +<version>` lines in the wallet READMEs, the plugin `CLAUDE.md`, and `wallet/zuuli/docs/releasing.md` | Prose |

A second top-level Rust tree does not get a decision of its own either. It needs
its own `rust-toolchain.toml`, because Cargo picks the toolchain from the
directory it runs in, and its crates carry their own `rust-version` — both are
restatements. Register them in `scripts/check-rust-toolchain.sh`'s
`TOOLCHAIN_RESTATEMENTS` and `MANIFESTS` arrays and they are held to
`wallet/rust-toolchain.toml` exactly like every row above. (`--toolchain-file`
and `--manifest` still register a path ad hoc for a local run, but a flag in one
workflow is **not** a registration: the bare invocation the required gate runs
passes no flags.)

**Registration is enforced, not remembered.** The same script's **census**
enumerates every `Cargo.toml` and `rust-toolchain.toml` git tracks outside `z/`
and fails, naming the file, on any that declares `[package]` — or restates the
toolchain — and is registered nowhere. Before that existed, an unregistered
crate was simply invisible to the check and shipped with a wrong MSRV, or none,
behind a green check identical to a registered crate's; it held only because
people remembered (#553). A virtual workspace root is excused because it
declares no `[package]`, recognised structurally rather than by a path list.

The `wallet/zuuli` gate reads the channel out of the file (`--print-channel`) and
feeds it to the toolchain action, so the required CI jobs hold **no literal at
all**. Every remaining restatement is verified against the file by
`scripts/check-rust-toolchain.sh`.

### How to bump

1. Change `channel` in `wallet/rust-toolchain.toml`. **That is the only decision.**
2. Run `scripts/check-rust-toolchain.sh`. It names every restatement that has
   not followed, with file and line.
3. Update exactly what it names — including moving each commit-pinned
   `dtolnay/rust-toolchain` SHA to the new version branch **and** its `# <version>`
   comment, plus the checker’s re-derived generic/version expected commits.
4. Re-run until it passes. `scripts/check-rust-toolchain.sh --self-test` proves
   the check can still fail; CI runs both.

A bump that touches the source of truth and nothing else **cannot merge** — the
gate fails. That is the point: the version is one edit plus a mechanical
follow-through, not an eleven-place archaeology exercise.

A bump is also the one moment new clippy lints can appear, since
`scripts/check-rust-clippy.sh` judges only on the pinned compiler. Expect the
bump's own pull request to carry the fixes for whatever the new lint set found —
that is where they belong, not leaking into the next unrelated change.

### Cadence

The pin is currently `1.97.1`, the current stable at the time of writing. It
moved here from `1.88.0` — a nine-version, fourteen-month jump — because the
owner wants the release trains building on a modern compiler and the mechanical
follow-through is now one script instead of an archaeology exercise.

A bump moves every mobile and desktop release target at once, so it stays an
**owner-gated decision**, reviewed **quarterly**, targeting **stable or stable
minus one**. The MSRV consequence is deliberate: the three `rust-version` fields
are defined as the two-component form of the channel, so bumping the channel
raises them too. None of these crates is published to crates.io, so the MSRV is
a statement of what we build with, not a compatibility promise to downstream
consumers.

## Verifying before you push

A warm local build is a liar. It reuses artifacts and, worse, resolves Cargo
**features** and npm **optional-dependency trees** differently than a clean
checkout — so a build that's green on your machine can be red in CI for reasons
your machine will never show you. The specific traps we've hit:

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
- **Platform integer widths, and a clippy that sees one target at a time.**
  libc type widths differ across the targets we ship, but `rustc` and clippy
  each look at exactly one. A conversion that is the reflexive identity on
  whichever target the tool happens to run on is load-bearing on the others —
  and `cargo clippy --fix` will delete it as useless. This half-shipped a
  release: build `0.1.0+7` went to TestFlight on iOS while Android never
  produced an AAB, because `stat.st_mode` is `c_uint` on every Android ABI while
  `mode_t` — the type of `S_IFMT`/`S_IFDIR` — is `u16` on the 32-bit Android
  ABIs, so the shared plugin died with
  `error[E0277]: no implementation for u32 & u16`. `st_dev`/`st_ino` diverge the
  same way between Apple and Linux/Android. The live examples are the
  `#[allow(clippy::useless_conversion)]` and `#[allow(clippy::unnecessary_cast)]`
  sites in `wallet/plugins/tauri-plugin-zcash/src/app_data_migration.rs`, each
  scoped to one statement and each carrying a comment saying not to simplify it.
  **Never accept a clippy auto-fix inside a `#[cfg]`-gated block without reading
  it against every target that block compiles for** — the required `gate`
  compiles for the CI host only and cannot catch this class at all, which is
  open issue **#321**.

So: for anything touching Rust deps/features, verify in a **clean Linux build
with CI's toolchain** — a throwaway `ubuntu:24.04` container that installs the
pinned `rustc`, fetches only the needed submodule, and runs the same `cargo
build --locked` — and **let it finish**. That is the only local check that sees
what CI sees. The workflow's `--locked` build and standalone plugin build exist
to catch these too, but catching them before the push is cheaper than a red run.

## Practical notes

- The three first-party Cargo roots and lockfiles are deliberately independent.
  The release-train boundary, new-crate rules, and explicit triggers for
  reconsidering a wallet-wide workspace are recorded in
  [docs/architecture/CARGO-WORKSPACE.md](docs/architecture/CARGO-WORKSPACE.md).
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
