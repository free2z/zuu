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
- **Phase 2, first contact** ([ADR 0015](./decisions/0015-key-package-publication.md))
  closes the last item the wire and directory documents both deferred: **MLS
  `KeyPackage` publication and exhaustion**. It is the first ADR here written
  *alongside* its implementation rather than ahead of it, because the question
  was not answerable on paper — the resolution turned on which component is
  allowed to forget things, and it is proved by a cold-start test against a real
  log, a real witness and a real relay.
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
| [`KT.md`](./KT.md) | The key-transparency protocol — `WIRE.md`'s analogue for the directory, specified for a second implementer: the `DirectoryEntry` structure and what authorizes it, **including a handle's first entry** — the `HandleAssertion`, its two signing transcripts and its seventeen validity rules (§4.5), the no-authority mode a self-hosted log needs and the signed policy document that must report it (§4.6), and what a compromised authority can and cannot do (§4.7) — plus `SignedTreeHead` and its signing transcript, log-key rotation, epoch cadence and maximum merge delay, the submission envelope and receipt, the witness poll-verify-cosign protocol and its fault evidence, the `WitnessCosignature` format, the client threshold rule and fail-closed behaviour, the proof-serving API, and where `akd`'s types sit underneath ours. |
| [`decisions/`](./decisions/) | One ADR per decision, `0001`–`0015`. |

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
| [0015](./decisions/0015-key-package-publication.md) | **`KeyPackage` publication** — a key package is *consumed on use* and an append-only log cannot express consumption, so the pool lives at the **relay**, keyed by the `contact_addr` the directory entry already publishes and authorized by the contact queue's own receive key. `DirectoryEntry` is unchanged. A fetcher **MUST** authenticate a claimed package against the entry the log proved, or the relay chooses whose init key the `Welcome` encrypts to. Exhaustion falls back to RFC 9420's reusable **last-resort** package — a real forward-secrecy trade, stated in `THREAT-MODEL.md` §4.12, that a hostile relay can force (§4.13). Five alternatives rejected on the record, including inverting the handshake. |

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

Specification only. **Nothing here is implemented.** That second sentence stopped
being true, and is corrected rather than deleted: as of **2026-08-24** the relay
and the directory log are being built against these documents in `rs/crates/` —
`f2z-relay`, `f2z-kt`, `f2z-kt-core` and their neighbours — and the three
corrections listed below were found by that work. What it still describes
correctly is the **client**: in particular
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
signature, and that is now rule 6. The second was **open and blocking**: nothing
in §4.4 said what authorizes a handle's **first** entry, so the rules as written
accepted a first entry for an unregistered handle from whoever submitted one.

**That second gap was closed later the same day** by
[`KT.md` §4.5–§4.7](./KT.md#45-handleassertion--what-authorizes-a-handles-first-entry),
and it is worth saying how, because the reason it was left open was that naming a
vouching authority in a specification is exactly
[#551](https://github.com/free2z/zuu/issues/551)'s complaint. It was not named in
a specification: the decision is the **owner decision recorded on
[#305](https://github.com/free2z/zuu/issues/305)** — a short-lived signed
handle-ownership assertion from the party that runs the user directory —
which [#554](https://github.com/free2z/zuu/issues/554)'s brief did not mention,
so `KT.md` inherited the gap rather than creating it. §4.5 transcribes the
encoding, the two signing transcripts and the seventeen rules that **two
independent implementations already agreed on byte-for-byte**; §4.6 fixes the
no-authority mode and requires a log running without an authority to say so in a
signed document; §4.7 states what the trust root costs.

**What §4.5 does not close is stated as not closed.** The assertion is checked by
the log and is *not* committed to the tree and *not* served, so unlike every
other authorization in §4.4 a client cannot verify it. The first-entry hole is
therefore closed against a stranger and **not against the log**, which is
[`ARCHITECTURE.md` §13-S′](./ARCHITECTURE.md#13-open-questions);
[`THREAT-MODEL.md` §3.1](./THREAT-MODEL.md#31-malicious-or-compromised-free2z-server)
carries the scoping consequence in a fourth correction, and the original §13-S has
moved to [§13.1 Closed](./ARCHITECTURE.md#131-closed).

**Three more corrections landed on 2026-08-24, and they are the first that
reconcile a merged document against a shipped implementation rather than against
another document.** Each was found by building the thing the specification
describes, and each moved in the direction the evidence pointed rather than the
direction that would have been tidier
([#630](https://github.com/free2z/zuu/issues/630),
[#633](https://github.com/free2z/zuu/issues/633),
[#634](https://github.com/free2z/zuu/issues/634)):

- [`WIRE.md` §13.1](./WIRE.md#131-the-layers) — **the spec moved.**
  `queue_creation_mode: token` had no wire representation: `CREATE_QUEUE` carries
  a `PowStamp` and a reserved `flags` field, so no conforming client could
  present a token. The mode is now **reserved and unpublishable**, a relay
  configured for it MUST refuse to start, and a client MUST refuse a relay
  advertising it. §13-I's anonymous credentials were never carried by this mode —
  a token is an identifier and an anonymous credential is not — and land as a new
  command code under §3.5, whose absence on an old relay is a non-fatal
  `ERR_UNKNOWN_COMMAND` rather than a federation flag day.
- [`KT.md` §5.1](./KT.md#51-cadence) — **the spec moved, and the property did
  not.** "An append-only proof over zero insertions" is not producible with
  `akd`, whose `publish` does not advance the epoch on an empty batch, and an
  epoch numbering decoupled from `akd`'s would make `/kt/v1/audit` unverifiable.
  A log publishes a **heartbeat insertion** per epoch instead; the correction
  specifies its label, its value and its effect on `tree_size`, and shows that
  what the empty epoch existed for — silence as a detectable fault with a
  timestamp — is delivered rather than resembled, and that the heartbeat leaks
  nothing an observer could not already compute.
- [`KT.md` §8.1 / §9.5](./KT.md#81-lookup) — **the spec's promise was withdrawn,
  and the requirement kept as unmet.** *"'No such user' is a claim the log must
  prove"* is a property `akd` 0.13 cannot deliver: it produces no non-membership
  proof for an unregistered label. A v1 log serves an **assertion**, which is now
  required to be labelled unproved on the wire, and the consequence — a log can
  deny that a user exists undetectably — is a stated limit in
  [`THREAT-MODEL.md` §4.11](./THREAT-MODEL.md#411-an-unregistered-handle-is-asserted-not-proved),
  a **No** row in its §5 table, and
  [`ARCHITECTURE.md` §13-T](./ARCHITECTURE.md#13-open-questions). It also removes
  the second half of §5.3's receipt evidence for a handle's *first* entry.
  `CLIENT-CONTRACT.md` §3.10 carries the client-facing half, because a UI that
  renders an unproved absence as a verified one is the downgrade in its final
  form.

**Two more corrections landed on 2026-08-25, and they are the first against the
*client* half of these documents.** Both were found by
[#732](https://github.com/free2z/zuu/issues/732) implementing
[`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)
in Rust and comparing it against the TypeScript that already existed — the
two-implementations check doing exactly what
[ADR 0001](./decisions/0001-platform-priority.md) says two implementations do:

- [`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)
  — **a wire change, made before anything shipped.** `msg_id` did not commit to
  `sender_leaf_index`, which is the second component of §7's own sort key, while
  §7's repair path delivers a message *outside* its original framing. It was
  sound only because §7 says the original sender repairs — an unstated
  dependency that third-party repair, the obvious optimisation past two members,
  would have broken silently: two receivers who learned one message by different
  routes would have rendered different transcripts while agreeing on every
  message. The field is now hashed and authoritative, the framing value is a
  cross-check, and the still-open half — whether third-party repair is
  *permitted* — is [§13-U](./ARCHITECTURE.md#13-open-questions) rather than an
  assumption. [#734](https://github.com/free2z/zuu/issues/734).
- [`CLIENT-CONTRACT.md` §7](./CLIENT-CONTRACT.md#7-ordering) and
  [§5.2](./CLIENT-CONTRACT.md#52-ordering-guarantees--read-this-before-writing-a-reducer)
  — **this document caused a shipped defect, and the sentence is withdrawn.**
  §5.2 said display order is *"recomputed by the UI, always"*, which mandated a
  second implementation of a normative protocol rule in a second language. The
  implementation that resulted sorted by the tie-break alone, never read
  `parents`, and rendered replies above the messages they answered in about half
  of all one-to-one conversations. The correction is not a better comparator —
  a `.sort()` comparator cannot express a topological order — but the removal of
  the second implementation: the engine returns messages already ordered, the UI
  renders what it is given, and `compareMessages` is deleted rather than fixed.
  §9 gains rule 10. [#733](https://github.com/free2z/zuu/issues/733).

The two `akd` limits are limits of the **adopted library**, not of the
construction, and the upstream capabilities that would lift them are named in
[`KT.md` §11.5](./KT.md#115-what-akd-013-cannot-do-and-what-upstream-would-have-to-add)
so a future reader on a newer `akd` knows what to re-check.

Still open above the relay: **client verification of a handle's first directory
entry**, `KeyPackage` publication, push notifications, padding
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
