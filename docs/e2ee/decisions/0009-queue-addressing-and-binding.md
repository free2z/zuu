# ADR 0009 — Queue addressing: relay-generated addresses, in-band adverts, and once-only send-key binding

**Status:** Accepted (Phase 1 specification, 2026-08-23) ·
**Refs:** [#545](https://github.com/free2z/zuu/issues/545),
[ADR 0004](./0004-metadata-ambition.md), [ADR 0005](./0005-federation.md) ·
**Specifies:** [`../WIRE.md` §7](../WIRE.md#7-queue-lifecycle)

> **Invented here.** [`../ARCHITECTURE.md` §6.2](../ARCHITECTURE.md#62-queues)
> specified that a queue has two addresses, that each is bound to an Ed25519 key
> at creation, and that addresses are advertised inside the MLS group. It
> specified nothing about **who generates an address**, how the send side comes
> to be bound, or what rotation costs.

## Context

Three questions were left open and each has a wrong answer that looks reasonable.

**Who picks the address?** Deriving it client-side from an exporter is the
obvious move and [`../ARCHITECTURE.md` §5.4](../ARCHITECTURE.md#54-exporter-derived-application-secrets)
gestures at it, promising rotation "without a round trip."

**How does the send side become authorized?** The recipient creates the queue and
holds the recv key. The sender is a different device that does not exist, from the
relay's point of view, until it appears.

**What does rotation cost?** [ADR 0004](./0004-metadata-ambition.md) requires
rotation so that a long-lived relationship does not present a long-lived
identifier.

## Decision

1. **The recipient creates the queue**, with `CREATE_QUEUE` signed by the recv
   key it is registering.
2. **The relay generates both addresses from its own CSPRNG** — 32 uniformly
   random bytes each, independent of one another and of any key. Clients do not
   choose addresses.
3. **The send side starts unbound.** No key authorizes `APPEND` until one is
   bound.
4. **The peer learns `send_addr` from an authenticated `queue_advert` inside the
   MLS group, never through the server**, and the advert carries `relay_id`
   alongside the address.
5. **The sender binds once with `BIND_SEND`. Binding is once-only and
   irreversible.** A second bind — with any key, including the same key — is
   `ERR_ALREADY_BOUND`.
6. **Rotation needs no new command:** create a new queue on the
   `free2z/queue/v1` exporter schedule, advertise it in-band, delete the old one
   once drained.

## Consequences

- **Squatting is unaskable.** With client-chosen addresses, an adversary could
  create queues at addresses it predicts a victim will want — derived from
  exporter inputs it can guess, or by sweeping — so that the victim's creation
  fails or, worse, succeeds against an existing attacker-controlled record.
  Relay-generated addresses remove the question.
- **Collisions become the relay's problem, and it can solve them.** Two clients
  independently deriving addresses will eventually collide, and a collision
  between unrelated conversations is a cross-conversation delivery bug with no
  clean recovery. A single CSPRNG can retry, which at 32 bytes it never will.
- **A narrowing of `ARCHITECTURE.md` §5.4 that must be stated.** §5.4's table says
  the `free2z/queue/v1` exporter *"derives the next queue addresses without a
  round trip."* That is no longer accurate. The exporter derives the **rotation
  schedule and the next queue signing keys**; the addresses come from the relay
  and the new `send_addr` still has to reach the peer in an advert. Rotation
  therefore costs one relay round trip and one in-band message. The cost is small
  — one message per rotation period between parties already exchanging messages —
  and it is the price of refusing client-chosen addresses. It is recorded rather
  than left as a contradiction between two documents; see
  [`../WIRE.md` §7.5](../WIRE.md#75-rotation-needs-no-new-command).
- **The relay operator can steal the write capability, and the design makes it
  noisy rather than impossible.** An operator that reads `send_addr` out of its
  own database and calls `BIND_SEND` first wins the race; the legitimate sender
  then receives `ERR_ALREADY_BOUND`. **This does not prevent the theft. It makes
  it loud.** The client MUST treat `ERR_ALREADY_BOUND` on a first bind for a
  freshly advertised address as a **non-dismissible failure**: not a retry, not a
  toast, not a log line — the conversation is marked compromised at the transport
  layer, the queue abandoned, and the user told which relay misbehaved.
- **What the thief gets is bounded.** It cannot read the queue (`send_addr`
  authorizes `APPEND` only). Anything it appends fails MLS authentication at the
  recipient, so it is garbage rather than forgery. What it gains is the ability to
  deny the legitimate sender its queue and to consume the recipient's quota —
  denial of service, which it already had by refusing to serve. The property
  bought is **attributable denial rather than flaky delivery**, which is the same
  detected-versus-undetected trade as
  [`../THREAT-MODEL.md` §4.5](../THREAT-MODEL.md#45-server-side-deletion-is-auditable-not-verifiable).
- **Rebind is deliberately absent.** Allowing the recv key to rebind would give
  the strongest key in the system — the one that can drain the queue — a second
  capability over the send side, to recover from a failure that already has a
  clean, cheap alternative: make a new queue.
- **Rotation overlaps rather than switching atomically.** The old queue stays
  readable until drained; the sender switches at `valid_from_epoch`; a message in
  flight during the switch lands in the old queue and is read from it.
- **`relay_id` travels with the address.** Without it, the sender has no
  authenticated statement of *which relay* the recipient chose, and the relay
  identity binding of [ADR 0010](./0010-signing-transcript-and-ack-semantics.md)
  would have nothing to compare against.

## Alternatives rejected

- **Client-derived addresses from the `free2z/queue/v1` exporter.** Rejected on
  squatting and collisions, above. This is the alternative the merged docs
  implied, and rejecting it is the reason §5.4's "without a round trip" is
  narrowed.
- **Addresses derived from the queue public key** (e.g. `H(pk)`). Rejected: it
  ties the address to the key, so rotating one forces rotating the other, and it
  makes the address a commitment to a key an attacker may later learn.
- **A rebindable send side, controlled by the recv key.** Rejected: it adds a
  capability to the most powerful key in the system to solve a problem that
  creating a new queue already solves.
- **Pre-committing to the sender's key at creation
  (`CREATE_QUEUE{expected_send_key}`).** This would close the operator-binds-first
  race entirely, and it was **rejected for v1 on cost, not on merit**: the
  recipient does not know the sender's fresh queue key at creation time, so
  learning it needs an extra in-band round trip *before* the advert, turning a
  one-message advert into a three-message handshake for every queue and every
  rotation. It is the right answer if the race proves to matter in practice, and
  it is recorded here so the option is on the record rather than rediscovered.
- **A dedicated `ROTATE` command.** Rejected: it would be create-plus-delete with
  extra state and a new failure mode (a half-rotated queue), to save a client
  three lines of sequencing.
- **Server-assigned sequential or structured addresses.** Rejected: any structure
  in an address is information the relay hands to anyone who obtains one, and
  enumerable addresses defeat the opacity that
  [ADR 0004](./0004-metadata-ambition.md) exists to provide.
