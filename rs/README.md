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

## This does not decide #341

[#341](https://github.com/free2z/zuu/issues/341) asks whether the *repository*
should have a single Rust workspace. **Nothing here answers that**, and this
file exists partly to say so out loud, because "a second workspace was added
after #341 was filed" is exactly the kind of fact that later gets read as a
decision.

Every argument against consolidation in #341 is wallet-specific:

- Tauri's mobile project layout expects the app crate where it is.
- The wallet's three lockfiles resolve the Zcash and Tauri graphs **differently
  on purpose**, and unifying them would silently change what ships.
- `libsqlite3-sys` declares `links = "sqlite3"`, so Cargo hard-errors on a graph
  containing two versions — which makes `rusqlite 0.37` a repo-wide singleton and
  makes any workspace merge a resolution question, not a layout question.

None of those applies to a fresh tree with no Tauri, no SQLite and no path
dependencies into `z/`. If #341 later chooses one repo-wide workspace, `rs/`
folds into it by moving these members and deleting one `[workspace]` table.

## The toolchain pin is a restatement

`rs/rust-toolchain.toml` repeats `channel = "1.97.1"` because cargo selects a
toolchain from the directory it runs in, and the shared scripts run cargo from
here. It is **not a second source of truth.** The one place the version is
decided is `wallet/rust-toolchain.toml`, and

```
scripts/check-rust-toolchain.sh --toolchain-file rs/rust-toolchain.toml \
                                --manifest rs/crates/f2z-codec/Cargo.toml
```

fails the pull request the moment the two disagree. `.github/workflows/rs.yml`
runs exactly that. Bumping the compiler means editing
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

`f2z-codec` is separate from everything that will sit on top of it for three
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
cargo build --target wasm32-unknown-unknown -p f2z-codec
```

The gates are the repository's shared scripts, pointed here with `--root`:

```bash
scripts/check-rust-toolchain.sh --toolchain-file rs/rust-toolchain.toml \
                                --manifest rs/crates/f2z-codec/Cargo.toml
scripts/check-rust-fmt.sh    --root rs
scripts/check-rust-clippy.sh --root rs
scripts/check-rust-deny.sh   --root rs --config rs/deny.toml
```

All four discover crates rather than listing them, so a new crate under `rs/` is
gated from its first commit. `.github/workflows/rs.yml` runs them, plus
`cargo test` and the WASM build, behind its own `gate`.

### Workspace lints

`rs/Cargo.toml` denies the panicking families — `unwrap_used`, `expect_used`,
`panic`, `indexing_slicing`, `arithmetic_side_effects` — for every member. The
reason is specific to what this tree is: the relay is a public, unauthenticated
network listener, and a panic in its parser is a remote denial of service.
Integration tests relax them, with a note saying why.
