# ADR 0010 — The signing transcript, anti-replay, and ACK semantics

**Status:** Accepted (Phase 1 specification, 2026-08-23) ·
**Refs:** [#545](https://github.com/free2z/zuu/issues/545),
[#131](https://github.com/free2z/zuu/issues/131),
[ADR 0002](./0002-multi-device.md), [ADR 0005](./0005-federation.md) ·
**Specifies:** [`../WIRE.md` §5](../WIRE.md#5-the-signing-transcript),
[§8](../WIRE.md#8-ack-semantics)

> **Invented here.** [`../ARCHITECTURE.md` §6.2](../ARCHITECTURE.md#62-queues)
> said only that *"every relay command is signed with the relevant queue key."*
> There was no transcript, no statement of what the signature covers, no
> anti-replay construction, and no acknowledgement semantics beyond "ACK arrives
> → delete."

## Context

"Signed with the queue key" is not a specification. A signature over the command
body alone is replayable everywhere: to the same relay later, to a different
relay, on a different connection, under a different request id. Two of those are
live attacks in *this* system rather than textbook ones.

**Cross-relay replay is live because of [ADR 0005](./0005-federation.md).** A
device publishes its queue addresses on *k* relays and senders send to all *k*.
If a signed command does not name a relay, relay A can take a frame verbatim and
submit it to relay B, which verifies it happily. For `APPEND` that is a duplicate.
For `ACK` it is worse: **A replays the recipient's cumulative `ACK` to B, and B
deletes ciphertext the recipient never received from B** — silent, permanent
message loss, caused by one relay against another, using only bytes the victim
signed.

**Acknowledgement semantics are load-bearing because of delete-on-ack.** The relay
deletes on ACK, so the ACK rule is the rule that decides whether messages survive.
[`../ARCHITECTURE.md` §6.3](../ARCHITECTURE.md#63-what-delivered-means) defines
four delivery states and warns that conflating them is how delete-on-ack loses
messages; the relay implements exactly one of them and must implement it exactly.

## Decision

**The signing transcript.** Every signed command is an Ed25519 signature over a
fixed-shape `CommandTranscript` covering, in order: a domain-separation label
(`"free2z/relay/v1/cmd"`), the protocol version, **the relay identity binding**,
**the TLS exporter channel binding**, the command code, the request id, the queue
address, the signer key, a timestamp, a 16-byte client nonce, and a hash of the
re-encoded body.

- `relay_id = H("free2z/relay/v1/relay-id", relay_identity_pk)`. The relay proves
  possession of that key in `HELLO`; the client compares it against the value
  carried in the peer's in-band `queue_advert`
  ([ADR 0009](./0009-queue-addressing-and-binding.md)).
- `channel_binding = TLS-Exporter("EXPORTER-free2z-relay-v1", "", 32)`
  ([RFC 8446 §7.5](https://datatracker.ietf.org/doc/html/rfc8446#section-7.5)).

**Anti-replay** is a bounded timestamp window (`±clock_skew_ms`, default 2
minutes) plus a `(signer_key, nonce)` seen-set covering that window. The seen-set
is **fail-closed**: at its bound the relay returns `ERR_BACKPRESSURE` rather than
evicting live entries. It is **in memory and need not survive a restart**.

**ACK is cumulative, monotone, idempotent, and never selective.** Acking beyond
the highest appended index is an error.

## Consequences

- **A signature is valid at exactly one relay, on exactly one TLS session, for
  exactly one request id.** The cross-relay `ACK` replay above fails at signature
  verification; a captured frame replayed on a new connection fails on the channel
  binding; a frame replayed on the same connection fails on the seen-set.
- **The relay MUST prove possession of its identity key**, or `relay_id` is
  decoration that any relay can claim. `HELLO` returns
  `Sign(relay_identity_sk, "free2z/relay/v1/hello" || channel_binding || client_nonce)`
  and the client verifies it before sending any signed command.
- **The channel binding cannot be computed behind a TLS-terminating proxy, and we
  say so.** Such a relay declares `channel_binding_mode: "none"`, uses 32 zero
  bytes, and a client may refuse it. There is no fix at this layer: no
  standardized way for a proxy to forward the exporter exists, and trusting a
  proxy-supplied value would defeat the purpose.
- **In `none` mode the seen-set argument breaks, and the consequence is
  spelled out rather than buried.** The reason the seen-set may be volatile is
  that a restart destroys every TLS session, so every pre-restart signature is
  already invalid against every new session — the binding has invalidated the
  corpus. With the binding zeroed that no longer holds, so such a relay MUST
  either persist its seen-set or declare `antireplay_persistence: "volatile"` and
  accept a replay window of `clock_skew_ms` across a restart. Clients read the
  field and may refuse.
- **The residual is bounded, not zero.** Within the window, on the same session, a
  party that sees the frames can replay them — that party being the operator or
  its proxy, who already controls the relay. `APPEND` replay yields a duplicate
  deduplicated end-to-end by `msg_id`; `ACK`, `READ`, `DELETE_QUEUE` and
  `BIND_SEND` replays are no-ops; `CREATE_QUEUE` replay costs the operator a
  queue. "Duplicate or no-op, at the operator's expense, against an adversary who
  could already refuse service" is acceptable — because of the bound, not because
  it is nothing.
- **The transcript deliberately does not cover relative ordering.** Two `APPEND`s
  can be reordered by anything in the path. Ordering is not a relay property in
  this design; it is the hash-linked DAG of
  [`../ARCHITECTURE.md` §7](../ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering),
  precisely so it survives a hostile relay.
- **Responses are unsigned.** Every response that matters end-to-end is verified
  by other means, and signing responses would buy an audit trail against an
  adversary who can simply refuse to answer.
- **Cumulative ACK keeps relay state to one integer per queue.** Selective
  acknowledgement would need a per-message bitmap — state proportional to the
  queue rather than constant — and would let a reader hold one message
  indefinitely while acknowledging later ones, a shape with no legitimate use.
- **Acking beyond the highest appended index is an error, and this is not
  tidiness.** Without the rule a reader could **pre-ack** to a very large index,
  after which every future `APPEND` is deleted the instant it lands while the
  sender keeps receiving successful (empty) `APPEND` responses — because
  [`../WIRE.md` §6.3](../WIRE.md#63-commands-signed-by-the-send-side-queue-key)
  forbids telling a sender anything about queue state. A device could black-hole
  its own queue silently and indefinitely, and the only symptom anywhere would be
  absent `device-delivered` receipts, indistinguishable from the recipient being
  offline
  ([`../THREAT-MODEL.md` §4.4](../THREAT-MODEL.md#44-tail-truncation-is-not-detectable-by-hash-links)).
  One comparison removes the possibility.
- **Idempotent ACK is what makes [#131](https://github.com/free2z/zuu/issues/131)
  tractable.** A dropped connection tells you nothing about what arrived; a client
  that never saw its ACK response simply sends it again. `APPEND` is *not*
  idempotent at the relay, deliberately — deduplication lives end-to-end at
  `msg_id`. Duplicate-tolerant delivery plus idempotent acknowledgement is the
  combination that survives an unreliable network.
- **The client-side MUST that the wire cannot enforce, restated where an
  implementer will meet it:** a device MUST NOT ACK before its durable local write
  completes ([ADR 0002](./0002-multi-device.md)). The relay has no way to know
  whether a write happened, so this rule lives entirely in the client and is the
  single most safety-critical rule in the delivery layer.

## Alternatives rejected

- **Signing the command body alone.** Rejected: replayable to another relay, on
  another session, at another time. This is the alternative the merged text's
  "signed with the relevant queue key" would most naturally be read as.
- **A server-issued challenge on every signed command.** Rejected: it makes every
  command a two-round-trip operation, which at a mobile client's latency is the
  difference between a responsive messenger and a slow one, to replace a
  timestamp-plus-nonce construction that achieves the same bound.
- **Persisting the seen-set unconditionally.** Rejected for the TLS-exporter
  mode: it adds a durability obligation and a write on the hot path to re-derive a
  property the channel binding already provides. Retained as a requirement for
  `none` mode, where the property is genuinely absent.
- **Evicting seen-set entries under pressure.** Rejected outright. An eviction
  policy that discards unexpired entries reopens the replay window at exactly the
  moment the relay is under load — which is exactly when an attacker would arrange
  to be.
- **Selective acknowledgement.** Rejected on relay state and on abuse shape,
  above.
- **Letting an ACK beyond the head succeed as a no-op.** Rejected: it is
  indistinguishable at the relay from pre-acking, and the failure it enables is
  silent.
- **Server-assigned sequence numbers as the ordering authority.** Rejected
  already by [`../ARCHITECTURE.md` §12](../ARCHITECTURE.md#12-disposition-of-prior-review-feedback)
  in response to #131, and nothing here reopens it: relay indices are per-queue
  bookkeeping for acknowledgement, never message order.
