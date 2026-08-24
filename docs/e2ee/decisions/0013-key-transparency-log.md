# ADR 0013 — Key-transparency log construction: adopt `akd`, floor `>= 0.13.0`, held by `[bans.deny]` and not by advisory tooling

**Status:** Accepted (owner, 2026-08-23, on the spike outcome) ·
**Refs:** [#544](https://github.com/free2z/zuu/issues/544) (the spike and its full
evidence), [#554](https://github.com/free2z/zuu/issues/554) (this record),
[#305](https://github.com/free2z/zuu/issues/305),
[#311](https://github.com/free2z/zuu/issues/311),
[#133](https://github.com/free2z/zuu/issues/133) ·
**Specifies:** [`../KT.md`](../KT.md) ·
**Relates to:** [ADR 0001](./0001-platform-priority.md) (one crypto core, no second
implementation), [ADR 0014](./0014-directory-key-rotation.md) (what authorizes an
entry — written to sit on whatever construction this ADR selects),
[`../ARCHITECTURE.md` §9.2](../ARCHITECTURE.md#92-the-directory)

> **Decided by a spike, not invented here.** #544 was a timeboxed investigation
> with a published result and an owner decision recorded against it. This ADR
> records that decision and its consequences. The measurements quoted below are
> the spike's; they were taken on an Apple M2 Max under the pinned toolchain
> (`rustc 1.97.1`) and in Node 22's V8, and they are reproduced here so that a
> reader does not have to trust a link. One claim in
> [`../ARCHITECTURE.md` §9.2](../ARCHITECTURE.md#92-the-directory) does not
> survive this decision, and it is corrected there rather than quietly restated
> here.

## Context

[`../ARCHITECTURE.md` §9.2](../ARCHITECTURE.md#92-the-directory) specifies a
CONIKS / SEEMless / Parakeet-lineage append-only directory with
privacy-preserving lookups. That is a construction, not an implementation, and
the open question was never *which* construction — it was whether we adopt a
production implementation of it or write the Merkle machinery ourselves.

The reason that question got a spike rather than a preference is an asymmetry in
the failure modes, and it is worth stating in full because it is the general
rule and will be needed again:

- A bug in a **simple cleartext log** leaks metadata. That is bad, and it is
  **loud**: the leak is present in the published bytes, so it is discoverable by
  inspection, by anyone, at any time after the fact.
- A soundness bug in an **append-only zero-knowledge set** lets the log
  substitute a key **undetectably**. The server swaps Alice's key, serves it to
  Bob, rolls it back, and Alice's self-audit sees nothing. That does not *weaken*
  the guarantee — it **inverts** it. It restores
  [#133](https://github.com/free2z/zuu/issues/133)'s MITM and adds a transparency
  log on top asserting that the MITM cannot happen.

A user who is told "your key changes are auditable" and is wrong is worse off
than a user who was told nothing, because they stop doing the manual check. The
asymmetry therefore argues for a maintained, deployed, reviewed implementation
over a simpler one we own — the same rule
[ADR 0001](./0001-platform-priority.md) already applied when it chose OpenMLS
over writing our own MLS.

[`akd`](https://github.com/facebook/akd) — Meta's Auditable Key Directory, the
SEEMless/Parakeet-lineage append-only zero-knowledge set that backs WhatsApp Key
Transparency — is a Rust implementation of exactly the lineage §9.2 names.

The spike put four questions to it: does it reach `wasm32-unknown-unknown` (the
likeliest hard blocker, because ADR 0001 forbids a second client verifier); has
it been independently audited to the standard we held OpenMLS to; does its
dependency graph fit the repo-wide `rusqlite`/`libsqlite3-sys` `links` singleton
documented at `AGENTS.md`; and what does verification cost in a browser. All four
cleared.

## Decision

**Adopt `akd` / `akd_core` for the key-transparency directory. Do not hand-roll
the Merkle machinery.** `../ARCHITECTURE.md` §9.2's *construction* stands
unamended; this is the construction it already specified, obtained from an
implementation rather than written.

**The version floor is `akd >= 0.13.0`, `akd_core >= 0.13.0`, hard, and it is
enforced by a `cargo-deny` bans entry rather than by a version requirement.**

The reason is specific and it is the part of this ADR most likely to be
forgotten. [facebook/akd#495](https://github.com/facebook/akd/pull/495) — *"Fix
auditor append-only bypass in batch node insertion"*, merged **2026-08-12**,
released in **0.13.0 on 2026-08-13** — fixed a bug in which
`AzksElementSet::partition` silently dropped any node whose label was not
strictly beneath the pivot, so an unchanged **interior** node whose label is a
strict prefix of an inserted leaf had its committed value discarded. Upstream's
own description of the consequence: *a malicious server can exploit this to
rewrite an existing label's value while still producing a valid append-only
proof, defeating the auditor's append-only guarantee.*

**There is no RustSec or OSV advisory for it.** An OSV query for `akd` on
crates.io returns `{}`. So `cargo audit` and `cargo deny advisories` pass on a
stale `0.12.0` pin — silently, and forever, because nothing will ever arrive to
make them stop. A `Cargo.toml` requirement is not a floor either: a
`[patch.crates-io]`, a path dependency, a workspace inheritance change or a
vendored copy all walk under it without comment.

The floor is therefore structural, and lands in `rs/deny.toml` with the code, not
in this documentation change:

```toml
[[bans.deny]]
# akd < 0.13.0 contains an auditor append-only bypass, facebook/akd#495, merged
# 2026-08-12 and released in 0.13.0 on 2026-08-13: a malicious log can rewrite an
# existing label's value while still producing a VALID append-only proof, which
# defeats the witness role entirely (see docs/e2ee/KT.md §7).
# There is no RustSec/OSV advisory — an OSV query for `akd` returns {} — so
# `cargo audit` and `cargo deny advisories` will NOT catch a downgrade. This entry
# is the floor. Do not remove it, and do not assume tooling is holding it.
name = "akd"
version = "<0.13.0"

[[bans.deny]]
name = "akd_core"
version = "<0.13.0"

[[bans.deny]]
# akd_mysql's last release is 0.8.9 (2023-03-15) and it is not maintained.
# The durable Database impl is ours (KT.md §11.2).
name = "akd_mysql"
```

**Audit status, held to the standard §3.1 applied to OpenMLS.** `akd` was
reviewed by **NCC Group Security Services, Cryptography Services practice, August
2023** — 3 consultants, 20 person-days, report v1.0 published 2023-11-14, public,
40 pages, named consultants (Elena Bakos Lang, Gérald Doussot, Kevin Henry,
Thomas Pornin). Scope was release **v0.9.0**, primarily `akd/` and `akd_core/`,
supplemented by what is now RFC 9381, SEEMless and Parakeet.
**1 Medium, 8 Low, 6 Informational; all fixed, all retested in October 2023,
merged as of tagged release v0.11.0.** The Medium was *"multiple key updates
during epoch results in invalid state"* — `publish()` with duplicate labels
leaving a dangling interior node and no valid key for the user; it is why
[`../KT.md` §5.1](../KT.md#51-cadence) makes at-most-one-entry-per-handle-per-epoch
a MUST rather than a convention.

- Landing page:
  <https://www.nccgroup.com/research-blog/public-report-whatsapp-auditable-key-directory-akd-implementation-review/>
- Report:
  <https://www.nccgroup.com/media/phzpm0qv/_ncc_group_metaplatforms_e008327_report_2023-11-14_v10.pdf>

**What `akd` is, precisely: the zero-knowledge set and nothing else.** It ships no
signed tree heads, no cosigning, no witness protocol, no gossip, and only an
in-memory `Database`. Everything in
[`../ARCHITECTURE.md` §9.3](../ARCHITECTURE.md#93-anti-equivocation-without-a-blockchain)
— the STH format and its signing transcript, log-key rotation, the witness
poll-verify-cosign loop, the cosignature format, the threshold rule, submission
receipts, client gossip — plus a durable storage backend, is ours to write. That
is [`../KT.md`](../KT.md).

## Consequences

- **Adopting `akd` shrinks the KT track substantially and does not remove it.**
  It buys the hard cryptographic core — the sparse Patricia tree over VRF-derived
  labels, the commitments, the membership, non-membership and append-only proofs
  — and roughly none of the plumbing. Scope the follow-up issues on that basis,
  not on "we adopted a key transparency library."

- **ADR 0001's one-implementation property holds where it matters.** The *client*
  verifier — `lookup_verify` and `key_history_verify` — lives in `akd_core`,
  builds for `wasm32-unknown-unknown` with no `wasm-bindgen` shim, no `js-sys`,
  no fork and no `getrandom` feature dance, and **runs**: the spike drove real
  proofs through `WebAssembly.instantiate(bytes, {})` with zero imports and got
  valid results against real root hashes. Size, size-optimised `cdylib`:
  **118 KB raw, 40 KB brotli**. Cost in V8, against a 1,000,000-entry directory:
  `lookup_verify` **1.11 ms** (4,042-byte proof), `key_history_verify` over three
  versions **2.63 ms** (9,173-byte proof) — about 1.25× native. There is no
  second verifier to diverge.

- **The consistency-proof claim in §9.2 does not survive, and is corrected
  there.** `akd`'s `AppendOnlyProof` carries every node inserted between two
  roots plus its sibling path, so it is **O(entries added), not O(log n)** as an
  RFC 6962 consistency proof would be — measured at **3.9 MB and 1.1 s native /
  3.4 s in WASM for five epochs** on a 100,000-entry directory. A phone on
  cellular data cannot verify consistency across every root it has seen. This is
  the price of the privacy property, not a defect: the tree is a sparse Patricia
  tree keyed by VRF output rather than a chronological Merkle tree, and the cheap
  O(log n) consistency proof is what you give up to get it. The architecture is
  unaffected, because §9.3 already assigns append-only verification to
  **witnesses**. Only the sentence was wrong.
  See [`../ARCHITECTURE.md` §9.2](../ARCHITECTURE.md#92-the-directory)'s dated
  correction and [`../KT.md` §8.5](../KT.md#85-what-a-client-cannot-verify).

- **It makes the witness set more load-bearing, not less.** A client cannot
  substitute its own consistency check for a witness's — there is no cheap check
  for it to run. Combined with §9.3's existing statement that witnesses free2z
  operates are not independent witnesses, the honest reading is that at launch
  **nothing** establishes append-only-ness to a client except client gossip and
  manual safety-number verification. That is a sharper obligation than the merged
  text implies, and [`../KT.md` §8.3](../KT.md#83-the-threshold-rule-and-failing-closed)
  states it.

- **The dependency graph fits, and does not engage the `links` singleton.**
  `akd` touches no SQLite at all — the verifier tree and the full server tree
  both grep clean for `rusqlite`, `libsqlite3-sys`, `openssl` and `ring` — so the
  repo-wide `rusqlite 0.37` / `libsqlite3-sys 0.35` constraint recorded in
  `AGENTS.md` is simply not engaged. This is the opposite of the
  `openmls_sqlite_storage` 0.2.0 situation. Storage is a `pub trait Database`;
  the durable backend is ours. Licences across the 29-crate verifier tree are all
  permissive (MIT / Apache-2.0 / BSD-3-Clause / CC0), **no GPL or AGPL**. Builds
  clean on the pinned `1.97.1` with no MSRV declared, no nightly features,
  edition 2021. `getrandom` appears only as a host build-dependency through
  `protobuf-codegen`, never in the wasm artifact, and codegen is pure Rust — no
  `protoc` in CI. Version unification against `wallet/zuuli/src-tauri/Cargo.lock`
  is already exact for every shared crate.

- **`akd` is pre-1.0, and every minor bump is a reviewed change.** 0.12.0 →
  0.13.0 took five months and carried breaking changes. Pin `>=0.13, <0.14` and
  read the release notes for soundness fixes on every bump, because — as #495
  proves — they will not arrive as advisories.

- **The audit is three years old and does not cover the code we will run.** NCC
  reviewed v0.9.0 in August 2023 and retested into v0.11.0. `HistoryProofV2`, the
  parallelisation work and the batch-insert rewrite are all later and unreviewed,
  and **#495 lived in exactly that unreviewed region** — NCC had explicitly
  deprioritised "performance optimizations within the library, such as the
  storage caching and parallelization strategy," which is where the bug was. This
  is the same shape as our OpenMLS position and takes the same mitigation: hold
  the floor, read every release, and treat the auditor path as the highest-value
  target for our own review and fuzzing. NCC's own strategic recommendation — more
  negative and fuzz testing of the public API — is cheap for us to actually do.

- **The audit covers `akd`; it does not cover our use of `akd`.** NCC said so
  directly: *"the correct behavior of akd relies on proper integration with an
  external application that authenticates users and publishes updates to the
  directory. This integration must be done properly... Further review of such an
  integration is recommended."* That integration is exactly what
  [`../KT.md`](../KT.md) specifies and what ADR 0014 authorizes. Adopting an
  audited library moves the review burden; it does not discharge it.

- **One upstreamable wart, recorded so it is not rediscovered.**
  `akd::auditor::audit_verify` compiles for `wasm32-unknown-unknown` and then
  **traps at runtime** (`RuntimeError: unreachable`), because
  `verify_append_only_hash` hardcodes `AzksParallelismConfig::default()` —
  `AvailableOr(32)` — which reaches `tokio::task::spawn`, and there is no runtime
  and no threads on that target. It fails on a 33 KB proof as readily as on a
  3.9 MB one, so it is not a size or stack problem. The spike confirmed the
  root cause by vendoring 0.13.0 and changing that one call to
  `AzksParallelismConfig::disabled()`, after which the auditor verifies correctly
  in WASM (12.9 ms for a 33 KB proof, 3.4 s for the 3.9 MB one). It lives in the
  **server** crate, and the auditor is the **witness** role, which is a native
  outbound-polling daemon per §9.3 — so the client verifier is unaffected and
  reaches the browser cleanly. The fix upstream is one line of signature change
  (`audit_verify(..., parallelism: AzksParallelismConfig)`); it is worth a PR
  regardless, and until it lands a WASM or non-tokio auditor needs a
  `[patch.crates-io]` pinned to a reviewed commit rather than a real fork.

- **This ADR constrains construction, not authorization.** What may enter the log
  is [ADR 0014](./0014-directory-key-rotation.md)'s, which was deliberately
  written to be implementable on whatever this ADR selected. The two are
  consistent: nothing in `akd` cares who signed an entry, so 0014's dual-signature
  and reset rules are enforced entirely in our submission path, and a log that
  skips them produces proofs that verify perfectly for entries nobody authorized.
  That is stated in [`../KT.md` §4.4](../KT.md#44-what-authorizes-an-entry).

## Alternatives rejected

- **Hand-rolled RFC 6962 chronological log + VRF-derived leaf index +
  commitment-hidden entry contents.** This was #544's declared fallback, and it
  is not a bad design: it is smaller, we would own all of it, the auditable
  surface would be a few hundred lines instead of a library, and it keeps the
  cheap O(log n) consistency proof that `akd` costs us — which would let clients
  verify append-only-ness themselves and make the witness set less load-bearing.
  Rejected anyway, on the asymmetry above: we would own the **soundness of the
  append-only proof**, and a soundness bug there is the undetectable-substitution
  failure, not a metadata leak. #495 is the concrete argument. That bug survived
  a named third-party audit and a production deployment at WhatsApp's scale for
  years, and was found by an external researcher, not by its authors. We would not
  have found ours either, and nobody would have been looking.

- **A plain cleartext RFC 6962 log.** Rejected outright, and it is worth being
  explicit that this is a *privacy* rejection rather than a security one. A
  cleartext log publishes the whole directory: every user's device count, every
  device-addition timestamp, and — because a directory entry carries contact
  endpoints — the full membership of the messaging system as a downloadable file.
  For a public creator platform that is a permanent, indexable, retroactive leak
  about every user, including the ones who joined before they understood what it
  meant. Note that the leak comes from publishing entries in the clear, not from
  RFC 6962, which is why the fallback above pairs it with a VRF and a commitment.

- **Full hand-rolled SEEMless.** Rejected as the worst of both: it keeps the
  privacy property and therefore keeps the expensive append-only proof, so it
  gives up nothing `akd` costs us, while taking on the entire soundness burden of
  a construction whose published implementation had a soundness bug ten days
  before we looked at it. The only argument for it would be that we understand
  our own code better, and #495 is the counter-argument.

- **A second, simpler verifier for the web client**, with `akd` used only
  natively. Rejected by [ADR 0001](./0001-platform-priority.md), and unnecessary:
  the client verifier reaches the browser at 40 KB brotli and 1.1 ms per lookup.
  There was no cost to pay for the divergence we would have bought.

- **Waiting for `akd` 1.0.** Rejected: pre-1.0 is a versioning statement, not a
  maturity statement, and this pre-1.0 crate has a published audit and a
  production deployment behind it. The real risk it names — breaking minors and
  soundness fixes that never become advisories — is answered by the `[bans.deny]`
  floor and a reviewed bump, not by waiting.

- **Pinning `akd` to a fork we control from the start.** Rejected: it converts a
  maintained dependency into a maintained-by-us dependency, which is
  hand-rolling with extra steps, and it detaches us from exactly the upstream
  release stream that carries fixes like #495. The `[patch.crates-io]` for the
  auditor parallelism wart is deliberately framed as a bridge with an upstream PR
  behind it, per the prime directive in `AGENTS.md`.

- **On-chain anchoring of epoch roots.** Rejected here for the reason
  [ADR 0006](./0006-zcash-coupling.md) already gave: it buys nothing that witness
  cosigning does not, and costs a hard external dependency in the critical path.
  Unchanged by this decision.
