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

**And "verified" has to mean re-read, not read once.** Two claims on this page
had already rotted by the time anyone looked: §3's `rand` row still said the
shipping lock carried "0.8, 0.9 and 0.10" after #855 collapsed the 0.9 island,
and the `sha2` correction still said moving off 0.10 "would add a second
SHA-256" long after the MLS half of the graph brought 0.11 in. The check passed
both times, because it was re-reading librustzcash's manifest — the right source
for *who forces a hold*, and no source at all for *what the graph contains*.
Every row in §3 now names the file that verifies it and every number in it is an
`evidence` entry the check re-reads; see
[How each row is re-read](#how-each-row-is-re-read).

---

## 1. `z/zcash/librustzcash` → `free2z/librustzcash`

| | |
|---|---|
| **Kind** | Submodule fork — the only one in `z/` pointing at a repository **we control**. (`z/QED-it/librustzcash` is also a librustzcash fork, but a third party's, vendored reference-only like the rest of `z/`.) |
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

**Every row names the file that verifies it, and
`scripts/check-dependency-register.mjs` re-reads exactly that file.** Most are
[`z/zcash/librustzcash/Cargo.toml`](../z/zcash/librustzcash/Cargo.toml)'s
`[workspace.dependencies]`; two are not, and that difference is the point —
see [How each row is re-read](#how-each-row-is-re-read) below.

The check requires this table and its registry to agree row for row in both
directions. A hold cannot be dropped from the page while the version is still
pinned in the tree, and a row cannot be **added** to the page unless something
re-reads it: a row nobody re-reads is worse than no row, because it wears the
same badge as the ones that are checked.

| Crate | Held at | Who forces it | Where the reason lives |
|---|---|---|---|
| `rusqlite` | 0.37 | **Upstream librustzcash** (`z/zcash/librustzcash/Cargo.toml:161`) *and* a repository-wide singleton: `libsqlite3-sys` declares `links = "sqlite3"` and Cargo hard-errors on two versions of a `links` package | [`rs/Cargo.toml`](../rs/Cargo.toml) (`rusqlite` entry), `wallet/plugins/tauri-plugin-zcash/Cargo.toml`, upstream's own CocoaPods note |
| `secrecy` | 0.8 | **Upstream librustzcash** workspace, `z/zcash/librustzcash/Cargo.toml:154` (`secrecy = "0.8"`). `wallet/zuuli/src-tauri` names it only to match what `tauri-plugin-zcash` already resolves | `wallet/zuuli/src-tauri/Cargo.toml` |
| `secp256k1` | 0.29 | **Upstream librustzcash** workspace, `z/zcash/librustzcash/Cargo.toml:86`. Also the second half of row 2's exit condition | `z/zcash/librustzcash/Cargo.toml`; `wallet/zuuli/src-tauri/Cargo.toml` `[patch.crates-io]` block |
| `rand` | 0.8 | **Upstream librustzcash** workspace, `z/zcash/librustzcash/Cargo.toml:98-99` (`rand = "0.8"`, `rand_core = "0.6"`). Not a repository-wide hold — `rs/` is on `rand_core 0.10`, and since #855 collapsed the `rand 0.9` island the shipping wallet lock carries **0.8.7 and 0.10.2 only** (`rand_core` 0.6.4 and 0.10.1) | `z/zcash/librustzcash/Cargo.toml`; `rs/Cargo.toml` (`rand_core` entry) |
| `sha2` | 0.10 | **Upstream librustzcash** workspace, `z/zcash/librustzcash/Cargo.toml:107` (`sha2 = "0.10"`) — see the correction below | [`rs/Cargo.toml`](../rs/Cargo.toml) (`sha2` entry) |
| `ripemd` | 0.1 | **Upstream librustzcash** workspace, `z/zcash/librustzcash/Cargo.toml:85`. `zcash_transparent` and `zcash_script` resolve to `ripemd 0.1.3`, and so does ours. Bumping to 0.2 adds no copy — `bip32` already carries 0.2.0 — but 0.2 is on `digest 0.11`, so `hash160`'s `Ripemd160` and its `Sha256` would be on **two different `digest` traits in the same six-line function** | `wallet/plugins/tauri-plugin-zcash/Cargo.toml` (`ripemd` entry) and `src/wallet/keys.rs`'s `hash160` |
| `nonempty` | 0.11 | **Upstream librustzcash** workspace, `z/zcash/librustzcash/Cargo.toml:94`. This one crosses an API boundary rather than merely duplicating: `send/native.rs` returns `nonempty::NonEmpty<TxId>` straight out of a librustzcash call, so a second `nonempty` is a type mismatch, not a bigger binary. Single copy (0.11.0), shared by 9 packages in the wallet lock | `wallet/plugins/tauri-plugin-zcash/Cargo.toml` (`nonempty` entry) |
| `base64` | 0.22 | **Upstream librustzcash** workspace, `z/zcash/librustzcash/Cargo.toml:113`. 0.22.1 is the **shared** copy — 11 packages, including `zcash_client_backend`, `zip321`, `reqwest`, `tonic`, `wry` and `tauri-codegen`. Bumping ours would not retire it; it would move our one crate onto `ureq`'s 0.23 island and lose the alignment for nothing | `wallet/plugins/tauri-plugin-zcash/Cargo.toml` (`base64` entry) |
| `bip0039` | 0.12 | **Upstream librustzcash** workspace, `z/zcash/librustzcash/Cargo.toml:192`. Weaker than the rows above, deliberately: upstream declares it only `optional`, behind `zcash_keys`'s `zcashd-compat` and a `zcash_client_sqlite` feature, and neither is on — so today exactly 1 package resolves `bip0039` in the wallet lock, and it is ours (`tauri-plugin-zcash`). Matching 0.12 is what keeps turning either feature on from adding a second BIP-39 | `wallet/plugins/tauri-plugin-zcash/Cargo.toml` (`bip0039` entry) |
| `chacha20poly1305` | 0.10 | **A different upstream.** Not librustzcash's — `z/zcash/zcash_note_encryption/Cargo.toml:24` declares it, under plain `[dependencies]`, because `zcash_note_encryption` is a standalone crate. Every wallet lock carries exactly **one** copy (0.10.1), shared by 5 packages: ours (`tauri-plugin-zcash`, `tauri-plugin-f2zmsg`), `zcash_note_encryption`, `hpke-rs-rust-crypto` and `openmls_rust_crypto`. Bumping ours to 0.11 strands the other three on 0.10 and adds a second AEAD to **all four** wallet locks | `wallet/plugins/tauri-plugin-zcash/Cargo.toml` and `wallet/plugins/tauri-plugin-f2zmsg/Cargo.toml` (`chacha20poly1305` entries) |
| `getrandom` | 0.3 | **A registry crate, not a vendored one.** `tauri 2.11.5` declares `getrandom = "0.3"` unconditionally in its own published manifest, so 0.3 is in the shipping graph whatever we choose; `wallet/zuuli/src-tauri/Cargo.lock` records the edge as `tauri 2.11.5 → getrandom 0.3.4`. Our single call site is `oauth.rs`'s PKCE randomness. Bumping to 0.4 would not retire tauri's copy — the lock already carries 0.2.17, 0.3.4 and 0.4.3 — it would only move us off the copy the framework links. This hold retires when **tauri** moves, not when we decide to | `wallet/zuuli/src-tauri/Cargo.toml` (`getrandom` entry); the edge in `wallet/zuuli/src-tauri/Cargo.lock` |
| `hkdf` | 0.12 | **Our own choice.** `hkdf` appears in neither constraint source. 0.12 is the line that pairs with `sha2` 0.10 (both on `digest` 0.10), so it moves only when `sha2` does | [`rs/Cargo.toml`](../rs/Cargo.toml) (`hkdf` entry) |

### How each row is re-read

The first version of this check re-read one file, librustzcash's
`[workspace.dependencies]`. That is why it caught `sha2`'s justification being
wrong — and it is also why the two rows above that are **not** librustzcash's
were, until now, exactly the thing that rotted before: a claim wearing a
checked-looking badge that nothing re-read.

Each hold now names its own constraint source, and the checker reads whichever
is named:

| Kind | Rows | What is re-read | Strength |
|---|---|---|---|
| Manifest | `rusqlite`, `secrecy`, `secp256k1`, `rand`, `sha2`, `ripemd`, `nonempty`, `base64`, `bip0039` (and `bip32`, section 2's) | `z/zcash/librustzcash/Cargo.toml`'s `[workspace.dependencies]` | Strongest — it reads the *requirement* the upstream author wrote, so a bump is caught the moment the submodule moves |
| Manifest | `chacha20poly1305` | `z/zcash/zcash_note_encryption/Cargo.toml`'s `[dependencies]` | Same, against a different upstream |
| Lockfile | `getrandom` | `wallet/zuuli/src-tauri/Cargo.lock`: `tauri` must still resolve to **2.11.5**, and that package must still pull `getrandom` on the 0.3 line | Weaker, and labelled so. A lockfile is a resolution, not a requirement |
| Negative | `hkdf` | Both manifests above, asserting `hkdf` appears in **neither** | "Our own choice" stops being true the moment an upstream takes a position |

And separately from *who forces a hold*, every **number** this page states —
"0.8.7 and 0.10.2", "11 packages", "5 packages", "0.2.17, 0.3.4 and 0.4.3" — is
an `evidence` entry re-read from the resolved lockfile it was measured in, and
the check requires the **sentence** to carry the number it measured. Both halves
matter. Verifying the lock while letting the prose say something else is exactly
how the `rand` row and the `sha2` correction stayed wrong through a green check:
the measurement had no reader, and then the sentence had no link to it. A stale
number now fails the pull request that carries it.

The `getrandom` row is the honest edge case. `tauri` is a registry crate with
no manifest in this tree, so there is nothing here to re-read for its
*requirement* — only its resolution. The requirement (`[dependencies.getrandom]
version = "0.3"` in tauri 2.11.5's published manifest) was read by hand on the
date in the marker. Pinning the check to that exact version is what makes the
staleness visible: **the next tauri bump turns this row red**, which is not the
check crying wolf but the check saying nobody has re-read tauri's requirement
since. Re-read it, and move the version in the registry.

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
That is the constraint, and it is upstream's, not `akd_core`'s.

The comment in `rs/Cargo.toml` has been corrected to say so.

**Second correction, 2026-08-31 — and it is the same failure again.** This
section used to finish "Moving `f2z-msg-identity` to 0.11 would add a second
SHA-256 to the shipped wallet." It would not. The wallet lock already carries
**0.10.9 and 0.11.0**: the MLS half of the graph brought 0.11 in through
`bip32`, `ed25519-dalek`, `hpke-rs-rust-crypto` and `openmls_rust_crypto`, and
nothing re-read the sentence that said otherwise. 14 packages resolve `sha2`
on 0.10 and 4 packages on 0.11. So the real cost of moving `f2z-msg-identity` is
*defection* — it would leave the copy every Zcash crate in the binary shares —
not a new copy. Both numbers, and both edges, are now `evidence` entries in
`scripts/check-dependency-register.mjs`, so the next time this drifts the check
says so rather than a reader eventually noticing.

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

**State on 2026-08-31:** #2163 merged upstream 2026-08-31T07:18:26Z; latest
`openmls_memory_storage` release is 0.6.0, published 2026-08-25 — before the
fix. No release carries it. Read the release's source, not its version number.

> Two upstream numbers, and they are not alternatives:
> [openmls/openmls#2188](https://github.com/openmls/openmls/issues/2188) is the
> **issue** — ours, "`clear_proposal_queue` removes a key nothing was stored
> under, leaking every proposal body", closed as completed 2026-08-31 with
> "Fixed by #2163" — and
> [openmls/openmls#2163](https://github.com/openmls/openmls/pull/2163) is the
> **pull request** that fixed it. PR #850's title cites the issue and
> `rs/deny.toml` cites the PR; both are correct. The exit condition is keyed to
> **#2163**, because a release either contains that commit or does not, whereas
> a closed issue says nothing about what was published.

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
* **`z/hhanh00/zwallet` is recently touched, but the touch was a deprecation
  notice.** Its last commit is 2026-08-23, `Update README to reflect Zcash
  deprecation (#274)`; the one before it is 2026-06-04, a release chore. So
  neither "dormant" nor "actively maintained" is the useful word — the fact a
  reader needs when deciding whether to keep vendoring it is that its most
  recent act upstream was to announce it is winding down.

Both are reference-only, so neither can break a build; the distinction matters
only to whether we keep carrying them.

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
with `.gitmodules`, the `[patch.crates-io]` set, every constraint source §3's
holds name, and the four wallet lockfiles its measured numbers came from —
depends on nothing outside this repository, so it is safe to run on a pull
request and it does.

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
