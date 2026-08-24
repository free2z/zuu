# free2z E2EE — design and specification

This directory holds the design of free2z's end-to-end encrypted messaging
system, from [issue #305](https://github.com/free2z/zuu/issues/305).
**No code ships from these documents.** They are specifications and decision
records written before implementation so that the architecture is chosen
deliberately and can be reviewed by a third party.

- **Phase 0** ([#318](https://github.com/free2z/zuu/issues/318),
  [#346](https://github.com/free2z/zuu/issues/346)) is the design:
  `ARCHITECTURE.md`, `THREAT-MODEL.md`, ADRs `0001`–`0007`. It deliberately
  marked every constant, label and wire encoding a *proposed placeholder*.
- **Phase 1** ([#545](https://github.com/free2z/zuu/issues/545)) fixes the relay
  wire protocol: `WIRE.md` and ADRs `0008`–`0012`, `0014`. Nothing could be
  implemented against placeholders, so this closes those gaps **on the record**,
  before code exists.
- **Phase 1, directory** ([#554](https://github.com/free2z/zuu/issues/554)) fixes
  the key-transparency protocol: `KT.md` and ADR `0013`, unblocked by spike
  [#544](https://github.com/free2z/zuu/issues/544). It also **corrects**
  `ARCHITECTURE.md` §9.2, which claimed clients could verify consistency across
  every root they had seen — they cannot, and the correction says so with a date
  rather than editing the sentence away.
- **Phase 2, client interface** is `CLIENT-CONTRACT.md`: the interface the
  native engine will present to a client, published **ahead of** the
  implementation so frontend work can start in parallel. It decides nothing
  about the protocol — every property in it is a restatement of the documents
  above, cited at the point of use — and it marks every unsettled shape
  *provisional* rather than inventing false precision.

## Contents

| Document | What it is |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | The design. Layers, key hierarchy and derivation, delivery-service semantics, retention model, metadata model, federation and relay trust, FROST/DKG application design, open questions. |
| [`THREAT-MODEL.md`](./THREAT-MODEL.md) | Adversaries, what each can do, and for each one the defense — or a plain statement that there is none. Includes the known, accepted limits. |
| [`WIRE.md`](./WIRE.md) | The relay protocol, specified for a second implementer: transport, framing, canonical serialization, the command set with request/response shapes and stable error codes, the signing transcript, anti-replay, queue lifecycle, ACK semantics, TTLs, padding enforcement, the capability document, first contact, and anti-abuse. Also carries the two resolved pre-checks — the messaging handle charset (§14) and the SimpleX clean-room posture (§15). |
| [`CLIENT-CONTRACT.md`](./CLIENT-CONTRACT.md) | The client interface, specified for a frontend developer who will not read any Rust: the Tauri command surface (`plugin:f2zmsg\|<cmd>`), why enrollment lives in the app crate rather than the plugin, the `types.ts` / `bridge.ts` / `mock.ts` / `events.ts` boundary and the mechanical mock-covers-bridge parity test, the event set and its ordering guarantees, the engine and four-delivery-state machines, the ordering rule, the closed `ErrorCode` union, the rules that must not be broken, what is deliberately not in v1, and the browser client's durability and handle-eligibility obligations. Field shapes are marked provisional; the backend is being implemented now. |
| [`KT.md`](./KT.md) | The key-transparency protocol — `WIRE.md`'s analogue for the directory, specified for a second implementer: the `DirectoryEntry` structure and what authorizes it — **after the first entry**; what authorizes a handle's first one is named as an open, blocking gap rather than invented — `SignedTreeHead` and its signing transcript, log-key rotation, epoch cadence and maximum merge delay, the submission receipt, the witness poll-verify-cosign protocol and its fault evidence, the `WitnessCosignature` format, the client threshold rule and fail-closed behaviour, the proof-serving API, and where `akd`'s types sit underneath ours. |
| [`decisions/`](./decisions/) | One ADR per decision, `0001`–`0014`. |

## The binding decisions

Recorded by the owner on 2026-08-08 in
[#305](https://github.com/free2z/zuu/issues/305). They are inputs to this
design, not conclusions of it. An implementation PR that contradicts one of
these should be rejected, or should first change the decision on the record —
which is what ADR 0007 does to ADR 0003.

| ADR | Decision |
|---|---|
| [0001](./decisions/0001-platform-priority.md) | **Platform** — ZUULI-first; the web client speaks the same protocol via WASM with an explicitly weaker, UI-stated trust model. |
| [0002](./decisions/0002-multi-device.md) | **Multi-device** — design the protocol, queues and key hierarchy for per-device fan-out from day one; ship single-device in the UI. |
| ~~[0003](./decisions/0003-history-retention.md)~~ | **History** — per-conversation retention negotiated inside the MLS group. **Superseded by 0007**; do not implement. |
| [0004](./decisions/0004-metadata-ambition.md) | **Metadata** — key-transparency directory for `@handle` discovery, then sealed sender over opaque pairwise unidirectional queues. |
| [0005](./decisions/0005-federation.md) | **Federation** — full multi-relay. The relay is a separate small Rust service, open source and self-hostable from the first release. |
| [0006](./decisions/0006-zcash-coupling.md) | **Zcash** — client-side cryptography only. Seed-derived messaging identity; no blockchain in the critical path. |
| [0007](./decisions/0007-retention-per-user.md) | **History (supersedes 0003)** — retention is a per-user local choice, plus a non-binding, authenticated ephemeral hint that conforming clients honor. FROST transcripts retained by default because the participant wants the evidence. |

## The Phase 1 wire decisions

Not owner policy decisions — these are **invented in the specification**, each
recording what the merged docs left open, the answer chosen, and the alternatives
rejected. An implementation PR that contradicts one should be rejected, or should
first change the decision on the record. **0013 is the exception**: it was not
invented but decided by a timeboxed spike with published measurements
([#544](https://github.com/free2z/zuu/issues/544)) and accepted by the owner, and
it is the one ADR here whose consequences include *correcting* a merged claim.

| ADR | Decision |
|---|---|
| [0008](./decisions/0008-transport-and-serialization.md) | **Transport + serialization** — WebSocket over TLS 1.3 only; `tls_codec` (TLS presentation language); one binary frame per message; **mandatory re-encode equality**, signing over the re-encoded bytes, so there is no parse-versus-verify gap. |
| [0009](./decisions/0009-queue-addressing-and-binding.md) | **Queue addressing** — the recipient creates the queue and the **relay** generates both addresses from its own CSPRNG; `send_addr` is advertised in-band inside MLS; `BIND_SEND` is **once-only and irreversible**. An operator that binds first steals the write capability — the design makes that **noisy, not impossible**. Narrows `ARCHITECTURE.md` §5.4. |
| [0010](./decisions/0010-signing-transcript-and-ack-semantics.md) | **Transcript, anti-replay, ACK** — a fixed transcript including a **relay identity binding** (closing a live cross-relay `ACK` replay that deletes messages) and a **TLS exporter channel binding** (absent behind a terminating proxy, and the consequences stated); a bounded timestamp window plus a fail-closed `(key, nonce)` seen-set; ACK cumulative, monotone, idempotent, never selective, never beyond the head. |
| [0011](./decisions/0011-first-contact-contact-queues.md) | **First contact** — a hard-capped **contact queue** whose send side is never bound, published in the owner's directory entry, accepting unsigned proof-of-work-stamped appends. Closes a genuine hole: there was no path for the `Welcome` that creates the group. PoW taxes phones far more than rented GPUs, and disk exhaustion is made expensive, not closed. |
| [0012](./decisions/0012-anti-abuse-v1.md) | **Anti-abuse v1** — connection limits, per-queue quotas, PoW-gated queue creation, global backpressure. **Never delete un-acked messages to make room**; refusing new writes is the correct failure mode. States what is not closed. |
| [0013](./decisions/0013-key-transparency-log.md) | **Key-transparency log construction** — adopt [`akd`](https://github.com/facebook/akd), the SEEMless/Parakeet-lineage zero-knowledge set behind WhatsApp Key Transparency, rather than hand-rolling the Merkle machinery. Hard floor `>= 0.13.0`, held by a `cargo-deny` `[[bans.deny]]` entry because **no advisory exists** for the append-only bypass that sets it, so `cargo audit` passes on a stale pin forever. Not an owner *policy* decision but an owner-accepted *spike* outcome ([#544](https://github.com/free2z/zuu/issues/544)) — the one entry in these tables with measurements behind it. |
| [0014](./decisions/0014-directory-key-rotation.md) | **Directory key rotation** — same-key entries self-signed; a key *change* needs both a rotation proof by the outgoing key and a signature by the new key; a *lost* key needs a platform-authority reset that raises a **non-dismissible** alarm and applies a multi-day cooldown. A real weakening, announced loudly, which is the whole mitigation. |

## Prior art in this repo

These four issues are the best prior analysis we have, contributed by a
cryptographer, and the design is written to honor them rather than replace them.

- [#131](https://github.com/free2z/zuu/issues/131) — the network is unreliable;
  ordering and gap detection must be transport-independent.
- [#132](https://github.com/free2z/zuu/issues/132) — FROST/DKG needs reliable
  broadcast *plus* confidential per-recipient delivery *plus* an agreed
  participant list.
- [#133](https://github.com/free2z/zuu/issues/133) — the server can MITM the
  WebRTC handshake today; key transparency plus in-band fingerprint
  authentication is the fix.
- [#134](https://github.com/free2z/zuu/issues/134) — the signed,
  session-hash-bound ceremony payload structure, and the mandatory destruction
  of per-session encryption keys after part 2.

Where each of those is addressed is tabulated in
[`ARCHITECTURE.md` §12](./ARCHITECTURE.md#12-disposition-of-prior-review-feedback).

## Status

Specification only. **Nothing here is implemented.** In particular
`CLIENT-CONTRACT.md` describes an interface that does not exist yet: there is no
`tauri-plugin-f2zmsg` and no frontend messaging module, and nothing should be
read as though there were. The phasing plan lives in
[#305 §8](https://github.com/free2z/zuu/issues/305); child issues are filed
against it.

Phase 0's caveat still governs everything it wrote: constants and encodings it
marked *proposed* were placeholders. `WIRE.md` and ADRs `0008`–`0012`, `0014`
replace those placeholders for the relay protocol, and `KT.md` with ADR `0013`
does the same for the directory — each saying so where it narrows or corrects a
Phase 0 statement. Two Phase 0 claims have now been corrected rather than
rewritten, with dates: `ARCHITECTURE.md` §5.4 (queue addresses are not
exporter-derived) and §9.2 (**clients cannot verify append-only consistency; only
witnesses can**), with the consequences carried into
[`THREAT-MODEL.md` §3.1](./THREAT-MODEL.md#31-malicious-or-compromised-free2z-server)
and [§3.9](./THREAT-MODEL.md#39-malicious-directory-witness).

A Phase 1 constant has since been corrected the same way:
[`KT.md` §6.1](./KT.md#61-structure) (2026-08-24) **renames the tree-head digest
label to `free2z/kt/v1/tree-head-hash`**, because the name it shipped with was a
proper extension of `free2z/kt/v1/sth` and `H` has no separator, so the two
domains were not separated at all. `WIRE.md` §1.3 now states prefix-freeness as a
normative requirement on the **union** of every document's labels, and
`scripts/check-hash-domain-labels.mjs` enforces it on every pull request
([#602](https://github.com/free2z/zuu/issues/602)).

Two further corrections landed on 2026-08-24, both against
[`KT.md` §4.4](./KT.md#44-what-authorizes-an-entry)'s authorization rules and
both found by implementing against them
([#594](https://github.com/free2z/zuu/issues/594)). The first is **closed**: the
numbered rules never required a `same_key` entry to leave `identity_pk`
unchanged, so as enumerated they admitted an identity-key change on **one**
signature, and that is now rule 6. The second is **open, blocking, and
deliberately not answered here**: nothing in §4.4 says what authorizes a handle's
**first** entry, so the rules as written accept a first entry for an unregistered
handle from whoever submits one. Who may vouch for handle ownership is a
product-and-trust decision of the same weight as ADR 0014's reset authority —
which is what [#551](https://github.com/free2z/zuu/issues/551) is open about — so
§4.4 states the option space, names the unratified candidate *as* a candidate,
and settles none of it.
[`THREAT-MODEL.md` §3.1](./THREAT-MODEL.md#31-malicious-or-compromised-free2z-server)
carries the scoping consequence, and it is
[`ARCHITECTURE.md` §13-S](./ARCHITECTURE.md#13-open-questions).

Still open above the relay: **what authorizes a handle's first directory entry**,
`KeyPackage` publication, push notifications, padding
bucket sizes, the redundancy factor *k*, the client gossip protocol, the witness
independence criterion and the default *t*, and the KT epoch cadence. All are
listed in [`ARCHITECTURE.md` §13](./ARCHITECTURE.md#13-open-questions) and in
[`KT.md` §12](./KT.md#12-what-this-document-leaves-open) rather than answered by
invention.

**Dating convention.** Corrections, closures and measurements in these documents
are stamped with the **author's local date** — the local date of the commit
that introduces them, not the UTC date. The dating is the whole reason a
correction is worth anything to an auditor, so a stamp that runs ahead of its own
commit is a defect: correct it, and say in the change that you corrected it
rather than adjusting it quietly. One such fix is recorded in
[`WIRE.md` §14.2](./WIRE.md#142-checked-against-free2zs-real-username-rules--measured).

**Scoping convention.** A claim in these documents is scoped by the section that
states it, and the scope is part of the claim. Three corrections in
[`THREAT-MODEL.md`](./THREAT-MODEL.md) exist because a property that holds under
stated conditions was later restated without them; when restating a claim
somewhere else, carry its qualifiers with it or do not carry the claim.
