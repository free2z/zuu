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
6. **Rotation needs no new command:** create a new queue, advertise it in-band,
   and delete the old one once drained. `free2z/queue/v1` is reserved for a
   future synchronized schedule; that schedule is not shipping in v1.

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
- **A deliberate correction to `ARCHITECTURE.md` §5.4.** Queue capability
  signing keys belong to different endpoints and are independently generated or
  derived; they are not shared exporter outputs. The authenticated advert carries
  relay/address/rotation intent, never either private key. `free2z/queue/v1` is
  reserved rather than shipping: no durable counter or advert field synchronizes
  such an exporter schedule in v1, and the runtime has no exporter call for this
  path. A genuinely distinct advert makes the sender generate a fresh CSPRNG
  signing seed; an identical replay preserves the current seed. The shipping engine consumes
  such an authenticated replacement advert, but does not automate the full
  create/advertise/overlap/drain rotation flow. The relay still generates the
  addresses, so a complete rotation costs one relay round trip and one in-band
  message. See
  [`../WIRE.md` §7.5](../WIRE.md#75-rotation-needs-no-new-command).
- **Any holder of `send_addr` can take the write capability, and the design
  makes it noisy rather than impossible.** A malicious relay operator can read
  the address from its database, but a leaked, observed, or decommissioned
  address gives any holder the same race. The legitimate sender then receives
  `ERR_ALREADY_BOUND`. **This does not prevent the theft. It makes it loud.** The
  client MUST treat `ERR_ALREADY_BOUND` on a first bind for a freshly advertised
  address as a **non-dismissible failure**: not a retry, not a toast, not a log
  line — the conversation is marked compromised at the transport layer, the
  queue abandoned, and the user shown which relay returned the refusal. That
  result does not identify who bound the address.
- **What the winning key holder gets is bounded.** It cannot read the queue (`send_addr`
  authorizes `APPEND` only). Anything it appends fails MLS authentication at the
  recipient, so it is garbage rather than forgery. What it gains is the ability to
  deny the legitimate sender its queue and to consume the recipient's quota —
  denial of service, which a malicious relay already had by refusing to serve.
  The property bought is **a refusal attributable to a relay rather than flaky
  delivery**, not attribution of the actor, which is the same
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
