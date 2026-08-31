# Fork & pin register

<!-- verified: 2026-08-31 -->

What this repository carries that is **not stock upstream**, and **what event
retires each one**.

This page is an index and an exit-condition tracker. It deliberately does *not*
restate the justifications — those live next to the declaration they justify,
which is where someone editing the declaration will actually read them. Every
row links out to its real home.

`scripts/check-dependency-register.mjs` enforces this page. Its offline half
runs on every pull request that touches the inputs; its network half runs weekly
from `.github/workflows/dependency-register.yml` and opens an issue when an exit
condition has fired, a fork has drifted behind its upstream, or a `.gitmodules`
`branch` names a ref that no longer exists. See
[Why a scheduled issue and not a gate](#why-a-scheduled-issue-and-not-a-gate).

Everything below was verified against the live sources on the date in the
marker above. Re-verify when you edit; a register of unverified restatements is
worse than no register.

---

## 1. `z/zcash/librustzcash` → `free2z/librustzcash`

| | |
|---|---|
| **Kind** | Submodule fork (the *only* one in `z/`) |
| **Points at** | `https://github.com/free2z/librustzcash`, branch `f2z/drop-stale-rustcrypto-rc-pins` |
| **Upstream** | `zcash/librustzcash`, `main` |
| **Delta** | one 4-line deletion (the `block-buffer = "=0.11.0-rc.3"` / `crypto-common = "=0.2.0-rc.1"` workspace pins and the two `zcash_primitives` lines consuming them), plus the lockfile |
| **Exit condition** | **`zcash/librustzcash#3010` merges** → move `.gitmodules` back to `https://github.com/zcash/librustzcash` + `main`, drop the pin |
| **Why** | [`.gitmodules`](../.gitmodules) and the header of [`scripts/check-librustzcash-compat.mjs`](../scripts/check-librustzcash-compat.mjs) |

**State on 2026-08-31:** #3010 open, not merged. Fork branch head
`a2b8c95210`, 1 ahead of and 2 behind `zcash/librustzcash@main` (`aed0fdda`).
Upstream still carries both pins on `main`.

### Two traps this entry exists to remember

**Two branches on the same fork.** #3010's head is
`f2z/upstream-drop-stale-rustcrypto-rc-pins`, a *different* branch from the
`f2z/drop-stale-rustcrypto-rc-pins` that `.gitmodules` tracks. They are both at
`a2b8c95210` today, and nothing but this check keeps them that way: rebasing one
and not the other means the thing we build is not the thing under review
upstream. `--upstream` compares the two heads and fails when they differ.

**Upstream has never run CI on #3010.** `check-runs` for `a2b8c95210` in
`zcash/librustzcash` reports `total_count: 0` — upstream gates fork-PR workflows
behind maintainer approval, so no workflow has ever started. "Wait for green
upstream" is not a signal that exists here; our own `gate` and `rs / gate` are
the only evidence the deletion is safe.

---

## 2. `[patch.crates-io] bip32` → `free2z/crates`

| | |
|---|---|
| **Kind** | Cargo `[patch.crates-io]`, pinned by `rev` |
| **Declared in** | [`wallet/zuuli/src-tauri/Cargo.toml`](../wallet/zuuli/src-tauri/Cargo.toml) |
| **Points at** | `https://github.com/free2z/crates` @ `131d490ef75ccd23111cc7f3df91e4a88fc971ae` (branch `f2z/bip32-secp256k1-0.29`) |
| **Upstream** | `iqlusioninc/crates`, `main` |
| **Delta** | upstream `main` (`eb57d494`) with `bip32`'s `secp256k1-ffi` requirement held at 0.29 — one requirement, nothing else |
| **Exit condition** | a real **`bip32 0.6.0`** release **and** the Zcash stack on **secp256k1 0.31** |
| **Why** | the `[patch.crates-io]` comment block at the foot of `wallet/zuuli/src-tauri/Cargo.toml` |

**Both halves of the exit condition are still unmet on 2026-08-31.**

* crates.io `bip32`: `max_version` is `0.6.0-pre.1` (published 2025-01-27);
  `max_stable_version` is `0.5.3`. No 0.6.0.
* `z/zcash/librustzcash/Cargo.toml` still declares
  `secp256k1 = { version = "0.29", ... }` and
  `bip32 = { version = "=0.6.0-pre.1", ... }`. The stack has not moved to 0.31.
  (crates.io's own `secp256k1` is at 0.33.1 — the constraint is librustzcash's
  requirement, not the registry's ceiling.)

The fork is **not** drifting: `131d490e` is 1 ahead of, 0 behind,
`iqlusioninc/crates@main`. This is the only `[patch.crates-io]` in the
repository, and the check fails if a second appears unregistered, or if any
patch is pinned by `branch` instead of `rev`.

---

## 3. Deliberate version holds that look stale but are not

Every version below is **verified against
[`z/zcash/librustzcash/Cargo.toml`](../z/zcash/librustzcash/Cargo.toml)'s
`[workspace.dependencies]`**, not against a summary. The check re-reads that
file, so upstream bumping any of them turns this table red rather than leaving
it quietly wrong.

| Crate | Held at | Who forces it | Where the reason lives |
|---|---|---|---|
| `rusqlite` | 0.37 | **Upstream librustzcash** *and* a repository-wide singleton: `libsqlite3-sys` declares `links = "sqlite3"` and Cargo hard-errors on two versions of a `links` package | [`rs/Cargo.toml`](../rs/Cargo.toml) (`rusqlite` entry), `wallet/plugins/tauri-plugin-zcash/Cargo.toml`, upstream's own CocoaPods note |
| `secrecy` | 0.8 | **Upstream librustzcash** workspace (`secrecy = "0.8"`). `wallet/zuuli/src-tauri` names it only to match what `tauri-plugin-zcash` already resolves | `wallet/zuuli/src-tauri/Cargo.toml` |
| `secp256k1` | 0.29 | **Upstream librustzcash** workspace. Also the second half of row 2's exit condition | `z/zcash/librustzcash/Cargo.toml`; `wallet/zuuli/src-tauri/Cargo.toml` `[patch.crates-io]` block |
| `rand` | 0.8 | **Upstream librustzcash** workspace (`rand = "0.8"`, `rand_core = "0.6"`). Not a repository-wide hold — `rs/` is on `rand_core 0.10` and the shipping wallet lock legitimately carries 0.8, 0.9 and 0.10 | `z/zcash/librustzcash/Cargo.toml`; `rs/Cargo.toml` (`rand_core` entry) |
| `sha2` | 0.10 | **Upstream librustzcash** workspace (`sha2 = "0.10"`) — see the correction below | [`rs/Cargo.toml`](../rs/Cargo.toml) (`sha2` entry) |
| `hkdf` | 0.12 | **Our own choice.** `hkdf` appears nowhere in librustzcash. 0.12 is the line that pairs with `sha2` 0.10 (both on `digest` 0.10), so it moves only when `sha2` does | [`rs/Cargo.toml`](../rs/Cargo.toml) (`hkdf` entry) |

### Correction: the `sha2` hold's stated reason was wrong

`rs/Cargo.toml` used to justify `sha2 = "0.10"` as resolving "to the copy
`akd_core`'s graph already carries". **`akd_core` 0.13.0 does not depend on
`sha2` at all** — its digest is `blake3`, and it reaches `sha2 0.10.9` only
transitively through `ed25519-dalek 2`. The hold is still right; the reason was
not. The real one, read off the shipping lock:

`f2z-msg-identity` is linked into **`wallet/zuuli/src-tauri`**, and in that
binary `sha2 0.10.9` is what `zcash_primitives`, `zcash_transparent`,
`zcash_script`, `tauri-plugin-zcash`, `bip0039`, `bs58`, `tauri-codegen` and
`wry` all resolve to — because librustzcash's workspace declares `sha2 = "0.10"`.
Moving `f2z-msg-identity` to 0.11 would add a second SHA-256 to the shipped
wallet. That is the constraint, and it is upstream's, not `akd_core`'s.

The comment in `rs/Cargo.toml` has been corrected to say so.

---

## 4. `openmls_memory_storage`

| | |
|---|---|
| **Kind** | Not a fork and not a pin — a **linked-but-unreachable** dependency with an open upstream defect |
| **How it gets here** | a hard, non-optional dependency of `openmls_libcrux_crypto 0.4.0`, whose `Provider` owns a `MemoryStorage` field. Nothing in this tree ever hands it to OpenMLS |
| **Exit condition** | an `openmls_memory_storage` release **newer than 0.6.0** whose `clear_proposal_queue` carries [openmls/openmls#2163](https://github.com/openmls/openmls/pull/2163) |
| **Why, in full** | the `openmls_memory_storage` block in [`rs/deny.toml`](../rs/deny.toml), and the module header of `rs/crates/f2z-msg-store/src/storage_impl.rs` |

Recorded here only because it is an exit condition and exit conditions belong in
one place. Do not duplicate the prose — `rs/deny.toml` explains why it is
deliberately *not* banned, and #850 is the PR that wrote it down.

**State on 2026-08-31:** #2163 merged upstream 2026-08-31; latest
`openmls_memory_storage` release is 0.6.0, published 2026-08-25 — before the
fix. No release carries it. Read the release's source, not its version number.

> Note for whoever follows the trail: PR #850's *title* cites
> "openmls#2188", which does not exist. The body and `rs/deny.toml` both cite
> **#2163**, which is the real PR. Trust the code comment.

---

## 5. `z/` submodule policy

`z/` vendors Zcash-ecosystem repositories so we can depend on them **in source**
and move the ecosystem forward (`AGENTS.md`, "The prime directive"). The build
consequence is narrow:

**Only `z/zcash/librustzcash` is a Cargo path dependency.** It is named by
`wallet/plugins/tauri-plugin-zcash/Cargo.toml` (nine path deps) and reaches
`wallet/zuuli/src-tauri` and `wallet/zuuallet/src-tauri` through that plugin. No
other manifest in the tree points into `z/`. Bumping any other submodule cannot
break a build.

Two nuances that make "nothing else consumes `z/`" not strictly true, and one
piece of housekeeping:

* **`langchain/zcash/store.py` reads two submodules as document corpora.** It
  loads `../../z/ZcashFoundation/zebra/` (`.rs`, `.toml`, `.yaml`, `.md`,
  `.json`, `.proto`) and `../../z/zcash/zips/` (`.rst`) into a Chroma vector
  store. Not a build input, but a consumer: emptying or moving either path
  changes what the retriever indexes.
* **`z/zcash/zcash` is archived upstream** (`archived: true`, last push
  2026-07-19, the zcashd EOL merge). It is a **frozen artifact, not a tracked
  upstream** — "stay on HEAD" does not apply, and `git submodule update
  --remote` will never move it again.
* **`z/hhanh00/warp` is dormant**: last push 2024-12-22, ~20 months ago, not
  archived. Reference-only, and nobody should expect it to move.

One claim worth correcting: **`z/hhanh00/zwallet` is *not* dormant** — last
push 2026-08-23, eight days before this verification. Only `warp` is.

### `.gitmodules` `branch` fields

Every submodule declares a `branch`, and `git submodule update --remote`
resolves it against the remote. A `branch` naming a ref that no longer exists on
the remote makes that submodule un-updatable, silently, forever — which is
exactly what happened to `z/ZcashFoundation/z3` when upstream renamed `dev` to
`main` on 2026-05-30 and nobody noticed for months (fixed in #847). The check's
`--upstream` mode `git ls-remote`s every `branch` in `.gitmodules`; it is the
cheapest of the three rules and the one that would have caught that.

---

## Why a scheduled issue and not a gate

The offline half of `scripts/check-dependency-register.mjs` — this page agreeing
with `.gitmodules`, the `[patch.crates-io]` set, and librustzcash's declared
versions — depends on nothing outside this repository, so it is safe to run on a
pull request and it does.

The network half is deliberately **not** a required check. Every one of its
verdicts is a statement about somebody else's repository: whether `zcash/librustzcash`
merged a PR, how many commits upstream `main` has gained, whether a remote still
publishes a branch. Wiring that into branch protection hands a third party's
merge queue — or an api.github.com outage — the ability to redden `main` for a
contributor who touched none of it. Upstream merging #3010 is *good news*; it
must not be an incident for whoever happens to open a PR that hour.

So it runs weekly and on `workflow_dispatch`, and files (or updates) a single
issue. The action item lands in the tracker where fork retirement belongs,
nobody is blocked, and the thing that failed for months — nobody looking — is
the thing that is now automated.
