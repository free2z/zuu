# ADR 0012 — Anti-abuse v1: layered limits, and refusing writes rather than dropping messages

**Status:** Accepted (Phase 1 specification, 2026-08-23) ·
**Refs:** [#545](https://github.com/free2z/zuu/issues/545),
[ADR 0004](./0004-metadata-ambition.md), [ADR 0005](./0005-federation.md),
[ADR 0006](./0006-zcash-coupling.md) ·
**Specifies:** [`../WIRE.md` §13](../WIRE.md#13-anti-abuse-v1)

> **Invented here.** The merged documents contain **no** quota or rate-limit
> mechanism at all. [`../ARCHITECTURE.md` §13-I](../ARCHITECTURE.md#13-open-questions)
> defers the anonymous-credential design explicitly and specifies nothing in its
> place, and §6.3 mentions only that "quota and TTL are relay policy."

## Context

A relay is an anonymous, unauthenticated service that allocates durable storage on
request. It has no accounts, no identities and no contact lists, by design
([ADR 0004](./0004-metadata-ambition.md)) — which means it also has none of the
levers a normal service uses against abuse. It must nonetheless survive on a
volunteer's ~$5/month VPS ([ADR 0005](./0005-federation.md)), because the economics
of self-hosting are what make the federation real rather than nominal.

The genuinely dangerous failure is not "the relay falls over." It is **the relay
staying up by quietly discarding messages it already accepted**, which would break
the other half of delete-on-ack and would do so through the one blind spot the
architecture has ([`../THREAT-MODEL.md` §4.4](../THREAT-MODEL.md#44-tail-truncation-is-not-detectable-by-hash-links)).

## Decision

**Four layers**, each cheaper than the one below it and applied first:

1. **Connection limits** — concurrent connections and new-connection rate per
   source, handshake timeout, maximum frame size, bounded in-flight window,
   per-connection command rate. All applied before any signature verification.
2. **Per-queue quotas** — maximum messages, maximum bytes, append rate. Send-side
   refusals collapse to a single code so the sender learns nothing about queue
   state.
3. **Queue-creation control** — `open`, `pow`, or `token`, **defaulting to
   `pow`**: a proof-of-work stamp over a relay-issued, single-use, expiring
   challenge, verifiable in one hash. **`token` is reserved and unusable; see
   the amendment below.**
4. **Global backpressure** — on crossing published high-water marks the relay
   refuses, in order: queue creation, then appends, then new connections.
   `READ`, `ACK` and `DELETE_QUEUE` are **never** refused for backpressure.

**And the rule that outranks all of them: a relay MUST NOT delete an
unacknowledged message to make room. When it runs out of space it refuses new
writes.**

## Consequences

- **Refusal is the correct failure mode, and the reasoning is the delete-on-ack
  contract itself.** The contract is: the relay holds ciphertext until the reader
  durably writes it and acknowledges, then deletes. A sender that received
  `accepted` has been told the relay took custody. If the relay may later discard
  that message for space, `accepted` means nothing and the recipient's ACK is no
  longer the only thing that removes data. The system would then lose messages
  through a mechanism the hash-linked DAG detects only when a *later* message
  arrives to dangle a parent — i.e. through the tail-truncation blind spot,
  reached by ordinary operation rather than by attack. Refusing a write is loud,
  immediate, and lands on the party that can do something about it; silently
  dropping an accepted message is quiet, delayed, and lands on someone who cannot.
- **A persistently refusing relay is a signal, not a bug.** It needs a bigger disk
  or fewer users, and that is exactly what an operator should be told.
- **`READ`, `ACK` and `DELETE_QUEUE` are exempt from backpressure** because they
  are the operations that make the relay smaller. Refusing them under load is a
  deadlock.
- **PoW is the default gate on creation** because creation is the only command
  that allocates durable state out of nothing. Verification is one hash, which is
  the property that matters: the relay's own cost under flood must stay near zero.
  The consequences for phones are argued in
  [ADR 0011](./0011-first-contact-contact-queues.md) and are not restated as
  though they were solved.
- **`token` mode is supported and is honestly labelled: a token is an
  identifier.** It lets the operator link every queue created with it, which
  reintroduces precisely the linkability that opaque per-pair addresses exist to
  remove. It is offered because a closed or invitational deployment may
  legitimately want it, it MUST be declared in the capability document, and
  clients SHOULD prefer `pow` relays and SHOULD say in the UI what a token-gated
  relay can correlate. **Withdrawn — see the amendment below.**
- **Everything is published.** Limits, TTLs, creation mode, PoW parameters,
  whether per-source limits are on, and the durability mode all live in the signed
  capability document, so a client can choose a relay on policy rather than
  discovering it by failing.

### What is not closed — stated plainly

- **Distributed queue-creation flooding with valid stamps.** Many sources, real
  compute, well-formed queues, valid stamps. The relay has no basis on which to
  distinguish that from users, because the basis would be identity. Backpressure
  keeps it alive by degrading service for everyone. Not solved.
  [§13-I](../ARCHITECTURE.md#13-open-questions)'s anonymous credentials — prove you
  paid for capacity without revealing who you are, per
  [ADR 0006](./0006-zcash-coupling.md)'s optional tier — are the intended answer
  and remain deferred.
- **An abusive but legitimately bound sender.** Once `BIND_SEND` has succeeded the
  relay cannot tell wanted traffic from unwanted: the payload is opaque ciphertext
  and that is the point. The remedy is entirely client-side and in-band — stop
  acknowledging, delete the queue, do not advertise a replacement to that peer.
  That is correct, and it is slower and clumsier than a block button on a server
  that could see who was talking. We chose the metadata property; this is part of
  its price.
- **Per-source limits harm exactly the users who most need the system.** A Tor
  exit, a CGNAT block, a university NAT and a shared VPN egress each present as one
  source carrying many legitimate users, and per-source limits will throttle them.
  **There is no good answer** without an identity the relay deliberately lacks:
  allowlisting Tor exits removes the limit for the population most able to rotate
  addresses, and anything more granular than an address requires knowing something
  about the client. The whole of the mitigation is that operators publish whether
  per-source limits are on, so a user behind shared egress can choose a relay that
  does not use them.

## Amendment (2026-08-24) — `token` mode is reserved, because it was never speakable

Found by `f2z-relay` while implementing layer 3
([#630](https://github.com/free2z/zuu/issues/630)). This ADR named three
queue-creation modes and `WIRE.md` §13.1 specified them, but **v1's wire has no
field a token can go in**: `CREATE_QUEUE` carries a `PowStamp` and a `flags`
field that MUST be 0, and `CREATE_CONTACT_QUEUE` carries a `PowStamp`. A relay in
`token` mode could not be satisfied by any conforming client.

**The decision above is amended, not reinterpreted:** `queue_creation_mode`
value 2 is **reserved and MUST NOT be published**, and the value is never reused;
a relay configured for `token` **MUST refuse to start**; a client that reads
mode 2 **MUST treat the relay as unusable and MUST NOT offer an override.**
`pow` and `open` are the modes v1 has. The full reasoning — including why a
placeholder credential field was rejected in favour of §3.5's new-command-code
path, whose failure mode on an un-upgraded relay is a **non-fatal**
`ERR_UNKNOWN_COMMAND` rather than a federation flag day — is in
[`../WIRE.md` §13.1](../WIRE.md#131-the-layers)'s correction.

**§13-I is unaffected, and that is the point.** The consequence bullet above says
it: a token *is* an identifier. §13-I's anonymous quota credentials are unlinkable
by construction, which is why this ADR already rejects clear payment for queue
creation and defers blind issuance. Token mode was never §13-I's carrier, so
reserving it removes an unusable mode and costs the anti-abuse story nothing.
What is not closed is unchanged, and now reads without a third mode standing in
front of it.

## Alternatives rejected

- **Deleting the oldest un-acked messages to make room.** Rejected — the central
  decision of this ADR, for the reasons above.
- **Accounts, API keys, or registration.** Rejected: it is the identity that
  [ADR 0004](./0004-metadata-ambition.md) exists to remove, and it would let the
  relay build the social graph directly.
- **CAPTCHA on queue creation.** Rejected: it requires a human at the moment of
  creation (queues are created and rotated automatically, often while the user is
  not looking), it usually means a third-party service in the path of an anonymity
  system, and it is defeated by paid solving services more cheaply than PoW is
  defeated by GPUs.
- **Payment for queue creation, in the clear.** Rejected: a payment is an
  identifier unless it is blind-issued, and the blind-issuance design is exactly
  what §13-I defers.
- **Reputation or behavioural scoring.** Rejected: it requires longitudinal state
  about clients, which is the state the relay is designed not to keep.
- **No limits at all, relying on federation to route around abuse.** Rejected: the
  first relay to fall over is the free relay run by a volunteer, and losing those
  is losing the federation.
- **Per-queue limits only, without global backpressure.** Rejected: per-queue
  limits bound the cost of a queue, not the number of queues, so they do not bound
  the relay.
