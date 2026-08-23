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

## Contents

| Document | What it is |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | The design. Layers, key hierarchy and derivation, delivery-service semantics, retention model, metadata model, federation and relay trust, FROST/DKG application design, open questions. |
| [`THREAT-MODEL.md`](./THREAT-MODEL.md) | Adversaries, what each can do, and for each one the defense — or a plain statement that there is none. Includes the known, accepted limits. |
| [`WIRE.md`](./WIRE.md) | The relay protocol, specified for a second implementer: transport, framing, canonical serialization, the command set with request/response shapes and stable error codes, the signing transcript, anti-replay, queue lifecycle, ACK semantics, TTLs, padding enforcement, the capability document, first contact, and anti-abuse. Also carries the two resolved pre-checks — the messaging handle charset (§14) and the SimpleX clean-room posture (§15). |
| [`decisions/`](./decisions/) | One ADR per decision, `0001`–`0012` and `0014`. |

**Not here yet, deliberately:** `KT.md` and **ADR 0013** — the key-transparency
log construction (`SignedTreeHead`, epoch cadence, proof encodings, the full
`DirectoryEntry`, witness-cosignature format). They are blocked on spike
[#544](https://github.com/free2z/zuu/issues/544). The gap in the ADR numbering is
intentional so that the absence is visible rather than silent.

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

Not owner decisions — these are **invented in the specification**, each recording
what the merged docs left open, the answer chosen, and the alternatives rejected.
An implementation PR that contradicts one should be rejected, or should first
change the decision on the record.

| ADR | Decision |
|---|---|
| [0008](./decisions/0008-transport-and-serialization.md) | **Transport + serialization** — WebSocket over TLS 1.3 only; `tls_codec` (TLS presentation language); one binary frame per message; **mandatory re-encode equality**, signing over the re-encoded bytes, so there is no parse-versus-verify gap. |
| [0009](./decisions/0009-queue-addressing-and-binding.md) | **Queue addressing** — the recipient creates the queue and the **relay** generates both addresses from its own CSPRNG; `send_addr` is advertised in-band inside MLS; `BIND_SEND` is **once-only and irreversible**. An operator that binds first steals the write capability — the design makes that **noisy, not impossible**. Narrows `ARCHITECTURE.md` §5.4. |
| [0010](./decisions/0010-signing-transcript-and-ack-semantics.md) | **Transcript, anti-replay, ACK** — a fixed transcript including a **relay identity binding** (closing a live cross-relay `ACK` replay that deletes messages) and a **TLS exporter channel binding** (absent behind a terminating proxy, and the consequences stated); a bounded timestamp window plus a fail-closed `(key, nonce)` seen-set; ACK cumulative, monotone, idempotent, never selective, never beyond the head. |
| [0011](./decisions/0011-first-contact-contact-queues.md) | **First contact** — a hard-capped **contact queue** whose send side is never bound, published in the owner's directory entry, accepting unsigned proof-of-work-stamped appends. Closes a genuine hole: there was no path for the `Welcome` that creates the group. PoW taxes phones far more than rented GPUs, and disk exhaustion is made expensive, not closed. |
| [0012](./decisions/0012-anti-abuse-v1.md) | **Anti-abuse v1** — connection limits, per-queue quotas, PoW-gated queue creation, global backpressure. **Never delete un-acked messages to make room**; refusing new writes is the correct failure mode. States what is not closed. |
| — | **0013 is deliberately absent** — the key-transparency log construction, blocked on [#544](https://github.com/free2z/zuu/issues/544). |
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

Specification only. **Nothing here is implemented.** The phasing plan lives in
[#305 §8](https://github.com/free2z/zuu/issues/305); child issues are filed
against it.

Phase 0's caveat still governs everything it wrote: constants and encodings it
marked *proposed* were placeholders. `WIRE.md` and ADRs `0008`–`0012`, `0014`
replace those placeholders for the relay protocol, and say so where they narrow or
correct a Phase 0 statement. Everything above the relay — the KT log
construction, `KeyPackage` publication, push notifications, padding bucket sizes,
the redundancy factor *k* — remains open and is listed in
[`ARCHITECTURE.md` §13](./ARCHITECTURE.md#13-open-questions) rather than answered
by invention.
