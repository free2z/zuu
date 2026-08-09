# free2z E2EE — Phase 0 design documentation

This directory holds the Phase 0 deliverable of
[issue #305](https://github.com/free2z/zuu/issues/305) — the design of free2z's
end-to-end encrypted messaging system. **No code ships from Phase 0.** These are
specifications and decision records written before implementation so that the
architecture is chosen deliberately and can be reviewed by a third party.

## Contents

| Document | What it is |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | The design. Layers, key hierarchy and derivation, delivery-service semantics, retention model, metadata model, federation and relay trust, FROST/DKG application design, open questions. |
| [`THREAT-MODEL.md`](./THREAT-MODEL.md) | Adversaries, what each can do, and for each one the defense — or a plain statement that there is none. Includes the known, accepted limits. |
| [`decisions/`](./decisions/) | One ADR per owner decision, `0001`–`0007`. |

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

Phase 0 documentation. Nothing here is implemented. The phasing plan lives in
[#305 §8](https://github.com/free2z/zuu/issues/305); child issues are filed
against it.
