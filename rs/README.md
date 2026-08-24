# `rs/` — the free2z Rust workspace

One `[workspace]`, one `rs/Cargo.lock`, alongside the existing `ts/`, `py/`,
`z/` and `wallet/`.

This tree holds the E2EE messaging system of
[#305](https://github.com/free2z/zuu/issues/305): the relay, the directory, and
the crates they share with the clients. It is specified by
[`docs/e2ee/WIRE.md`](../docs/e2ee/WIRE.md) and the ADRs beside it.

## Why it is called `rs/` and not `relay/`

[ADR 0001](../docs/e2ee/decisions/0001-platform-priority.md) requires **one Rust
crypto core**, compiled natively for ZUULI *and* to WASM for the web, so that
there is never a second implementation of the protocol to diverge from the
first. That means this tree will hold **client** crates beside the servers, and
a namespace named for one role would be wrong within a quarter.

`rs/` is the role-neutral name. `f2z-codec` is the first crate in it and is
already both: the relay parses frames with it, and so does the browser.

## #341 is decided, and a root here is inside the decision

[#341](https://github.com/free2z/zuu/issues/341) asked whether the *repository*
should have a single Rust workspace. It is **decided**, and the answer is in
[`docs/architecture/CARGO-WORKSPACE.md`](../docs/architecture/CARGO-WORKSPACE.md)
— accepted 2026-08-23 — not in the issue thread. Read the ADR, not this section,
when the question comes up again.

The ADR keeps the wallet's three Rust package roots independent and rules out a
repository-root workspace outright, because Cargo enrols path dependencies below
a workspace root and `z/` holds upstream Cargo projects that are not ours to
govern as members. Its own words:

> If a wallet-wide workspace is ever adopted, its candidate root is `wallet/`,
> with explicit members and exclusions.

**So the consolidation the ADR leaves open is `wallet/`-scoped, and `rs/` is not
under `wallet/`.** A fourth package root here does not make that consolidation
harder; the two trees were never candidates to merge under it. The ADR's reasons
for the boundary are wallet-specific in exactly the same way:

- The release system runs the Tauri CLI from the app directories and reads
  `src-tauri/Cargo.lock` and `src-tauri/target`; Tauri's generated mobile
  projects expect the app crate where it is.
- The wallet's three lockfiles resolve the Zcash and Tauri graphs **differently
  on purpose** — Tauri 2.11.5 / `aws-lc-rs` 1.17.3 on one side, 2.10.2 / 1.15.4
  on the other — so unifying them starts with a coordinated dependency update,
  not a relocation.
- `libsqlite3-sys` declares `links = "sqlite3"`, so Cargo hard-errors on a graph
  containing two versions — which makes `rusqlite 0.37` a repo-wide singleton and
  makes any workspace merge a resolution question, not a layout question.

None of those engages a tree with no Tauri, no SQLite and no path dependencies
into `z/`. What `rs/` does owe the ADR is its "Adding Rust crates" step 5 — run
the repository's manifest-discovering format, clippy and cargo-deny checks, and
add explicit locked build/test coverage for the context the crate promises. That
is what `.github/workflows/rs.yml` is.

The ADR does not freeze the question; it lists **revisit triggers** — a shared
release cadence, two or more further shared crates, a divergence that escapes
the per-app locked builds, measured CI data, or release tooling made independent
of the app-local lock and target paths — and it accepts consolidation only after
a migration proves the whole list of builds and tests. None of those triggers is
about `rs/`. If one ever fires and this tree is in scope, folding it in is one
reviewed dependency-resolution diff across both lockfiles — not the deletion of
a `[workspace]` table.

## The toolchain pin is a restatement

`rs/rust-toolchain.toml` repeats `channel = "1.97.1"` because cargo selects a
toolchain from the directory it runs in, and the shared scripts run cargo from
here. It is **not a second source of truth.** The one place the version is
decided is `wallet/rust-toolchain.toml`, and

```
scripts/check-rust-toolchain.sh
```

fails the pull request the moment the two disagree. `.github/workflows/rs.yml`
runs exactly that. `rs/rust-toolchain.toml` and every `rs/crates/*/Cargo.toml`
are registered in the script's own `TOOLCHAIN_RESTATEMENTS` and `MANIFESTS`
arrays — not by `--manifest` flags in this workflow, because the bare invocation
the required ZUULI gate runs passes no flags and would be blind to anything
registered only here. Bumping the compiler means editing
`wallet/rust-toolchain.toml` and running `scripts/check-rust-toolchain.sh`,
which names every restatement that still needs updating — this one included.

## Licence boundary: permissive crates, AGPL binaries

Per the owner decision recorded on
[#305](https://github.com/free2z/zuu/issues/305):

- **Shared crates are permissive** (MIT, matching the repository's `LICENSE`), so
  that the ZUULI client, the WASM web client, and third-party relays and clients
  can link them.
- **Server binaries will be AGPL-3.0.**

Every `Cargo.toml` in this tree sets `license` explicitly, from the first commit,
so the boundary is never implicit. `rs/deny.toml` makes it mechanical: it sets
`private = { ignore = false }`, which is what stops cargo-deny from skipping our
own `publish = false` crates, and it allows no copyleft licence at all. An
AGPL-3.0 server binary will therefore fail the gate until it is added to
`[licenses] exceptions` **by name** — a reviewed, one-line act. Putting
`"AGPL-3.0"` in `allow` instead would permit it for every crate in the tree,
including the ones the client links, which is the drift the split exists to
prevent.

## Crates

| Crate | What it is |
|---|---|
| [`crates/f2z-codec`](./crates/f2z-codec) | The canonical encoding layer of `WIRE.md`: `tls_codec` wrappers for every wire structure, the domain-separated signing transcript (§5), the redacting newtypes, and the padding-bucket validator (§9). `no_std` + `alloc`, `#![forbid(unsafe_code)]`, no I/O, no async runtime, and it builds for `wasm32-unknown-unknown`. |
| [`crates/f2z-relay-proto`](./crates/f2z-relay-proto) | The protocol layer above it: signed-command construction and verification in §5.1's exact order, the timestamp window and fail-closed seen-set (§5.5), the queue lifecycle and ACK arithmetic (§7, §8), the capability document (§11), the `HELLO` proof of possession (§5.2), and §4.3's typed in-flight window. Same constraints — `no_std` + `alloc`, no I/O, no clock, no randomness, and it builds for `wasm32-unknown-unknown`. |
| [`crates/f2z-relay-store`](./crates/f2z-relay-store) | The relay's queue storage: a `RelayStore` trait that speaks addresses and bytes and never a wire frame, plus a durable `SqliteStore` (WAL, `synchronous = FULL`, `secure_delete = ON`, group commit) and a volatile `MemoryStore`. **Native only** — it links SQLite and is not on the wasm line. `std`, `#![forbid(unsafe_code)]`, no async runtime. |
| [`crates/f2z-relay-testkit`](./crates/f2z-relay-testkit) | **FakeRelay**: a spec-conforming relay a client can develop against, over an in-process pipe *and* a real `ws://127.0.0.1:0` listener running the same implementation, plus fault injection and the conformance vector suite `f2z-relay` is run against unchanged. Also ships the `f2z-fakerelay` binary and `rs/deploy/docker-compose.dev.yml`. **Native only** — it opens sockets, spawns tasks and reads a clock, and is deliberately absent from the `wasm32` job. |
| [`crates/f2z-relay`](./crates/f2z-relay) | **The relay daemon** — the server that runs in production. `wss://` listener, §4 framing, §5 signed-command verification with the TLS-exporter binding, the full §6 command set over `RelayStore`, a group-commit writer, TTL expiry, §13 anti-abuse, the signed capability document, and a loopback-only `/healthz` + `/metrics` admin listener. **AGPL-3.0**, native only, never on the wasm line. |
| [`crates/f2z-authority`](./crates/f2z-authority) | An **experimental candidate** for the directory's non-cryptographic trust-root layer: the proposed `HandleAssertion`, a partial assertion-layer check, `AuthoritySet`, and `f2z-assert`. `KT.md` does not yet ratify these structures or first-entry/no-authority semantics (#594), and its result is not §4.4 directory authorization. Same portability constraints. |

**The clients link `f2z-codec` and `f2z-relay-proto`; the relay links those two
plus `f2z-relay-store`.** That is the licence boundary in practice: the shared
crates are MIT because a third-party relay, ZUULI and the WASM web client all
compile the same rules, and a rule that two implementations disagree about is how
ciphertext gets deleted before it is read. **`f2z-relay` is the first crate on
the other side of that boundary** — an AGPL-3.0 server binary, named in
`rs/deny.toml`'s `exceptions` so crossing it cannot happen by accident.

The current dependency graph is narrower than that intended architecture:
`f2z-relay-proto` depends on `f2z-codec`, while `f2z-authority` is still a
standalone experimental leaf and no workspace package depends on it. Wiring the
authority candidate into a relay or client is future integration work, not a
property this README claims today.

`f2z-codec` is separate from everything that sits on top of it for three
reasons, and each is enforced by a test rather than by intent:

1. **Re-encode equality** (`WIRE.md` §3.3) is implemented once. Every received
   frame is decoded, re-encoded and byte-compared, and the *re-encoded* bytes are
   what a signature covers. Implementing it in one crate is what removes the
   parse-versus-verify gap from the whole system instead of from one component.
2. **Redacting `Debug`.** Addresses, payloads and keys never render their bytes.
   `--log-level trace` must not turn a relay into a ciphertext archive.
3. **It reaches WASM.** No I/O, no tokio, no `std`. A CI job builds it for
   `wasm32-unknown-unknown` on every change, because "we kept it portable" is a
   claim that stops being true the first week nobody checks.

## Working in this tree

```bash
cd rs
cargo test
cargo build --target wasm32-unknown-unknown --lib \
  -p f2z-codec -p f2z-relay-proto -p f2z-authority

# f2z-relay-store's crash-safety suite is behind a default-off feature, because
# the feature compiles an abort() into the commit path. It kills real child
# processes; `cargo test` alone does not run it.
cargo test -p f2z-relay-store --features crash-injection --test crash_safety

# A relay endpoint for a client developer, in one command.
cargo run -p f2z-relay-testkit --bin f2z-fakerelay

# The real thing, on loopback, with an ephemeral store.
cargo run -p f2z-relay -- --store memory
```

**Not every crate here reaches the browser, and the wasm line is the record of
which do.** `f2z-relay-store` links SQLite through `rusqlite`'s bundled C
amalgamation; `f2z-relay-testkit` opens sockets, spawns tasks and reads a clock,
and a test harness that could reach the browser build could end up in the
shipped bundle; `f2z-relay` is an AGPL server binary that does all three. All
are deliberately absent from `rs.yml`'s `rs_wasm` job. Adding a crate to that
line is a claim that a client links it.

The gates are the repository's shared scripts, pointed here with `--root`:

```bash
scripts/check-rust-toolchain.sh
scripts/check-rust-fmt.sh    --root rs
scripts/check-rust-clippy.sh --root rs
scripts/check-rust-deny.sh   --root rs --config rs/deny.toml
```

**All four now discover crates, by two different mechanisms.**
`check-rust-fmt.sh`, `check-rust-clippy.sh` and `check-rust-deny.sh` find every
`Cargo.toml` under `--root`, so a new crate under `rs/` is formatted, linted and
supply-chain-gated from its first commit.

`check-rust-toolchain.sh` still verifies a *registry* — it has to, because an
MSRV is a value to compare, not a tree to walk — but registration is no longer a
discipline. Its **census** enumerates every `Cargo.toml` and `rust-toolchain.toml`
git tracks outside `z/` and fails on any that declares `[package]` (or restates
the toolchain) and is registered nowhere. Proved by adding a throwaway
`rs/crates/scratch/Cargo.toml` with no `rust-version` and no `license`:

| Script | Sees it? | Verdict |
|---|---|---|
| `check-rust-fmt.sh --root rs` | yes | RED — `4 crate(s) are not formatted: … rs/crates/scratch` |
| `check-rust-clippy.sh --root rs` | yes | RED — `2 crate(s) failed the clippy gate: … rs/crates/scratch` |
| `check-rust-deny.sh --root rs --config rs/deny.toml` | yes | RED — `error[unlicensed]: scratch = 0.0.0 is unlicensed` |
| `check-rust-toolchain.sh` | yes | RED — `rs/crates/scratch/Cargo.toml declares [package] but is registered nowhere` |

Before [#553](https://github.com/free2z/zuu/issues/553) that last row was
**GREEN and blind**, and every new crate in this tree needed a `--manifest` flag
added to `rs.yml` by hand. It now needs a line in `MANIFESTS` instead — and the
check names the file and says so, rather than a reviewer having to notice.
`.github/workflows/rs.yml` runs all four, plus `cargo test` and the WASM build,
behind its own `gate`.

A virtual workspace root like `rs/Cargo.toml` is excused because it declares no
`[package]` and so has no `rust-version` to pin — recognised by that structure,
not by a path exclusion list that could later be widened to excuse a real crate.

### Workspace lints

`rs/Cargo.toml` denies the panicking families — `unwrap_used`, `expect_used`,
`panic`, `indexing_slicing`, `arithmetic_side_effects` — for every member. The
reason is specific to what this tree is: the relay is a public, unauthenticated
network listener, and a panic in its parser is a remote denial of service.
Integration tests relax them, with a note saying why.
