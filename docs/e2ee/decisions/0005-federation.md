# ADR 0005 — Federation: full multi-relay from day one

**Status:** Accepted (owner, 2026-08-08) · **Refs:** [#305](https://github.com/free2z/zuu/issues/305) §7.5 and the economics comment

## Context

A single-operator relay is a single point of censorship, coercion and failure,
and it makes every privacy claim conditional on one company's continued good
behavior. Federation is also much cheaper to decide now than to retrofit — it
touches addressing, trust configuration and the key-transparency design at once.

The counter-argument is economic: decentralized networks re-centralize because
running a node is expensive, so only well-funded operators persist. Roughly **95%
of Nostr relays cannot cover their operating costs**, and the reason is
instructive — they retain every event forever and serve a public firehose.

## Decision

**Full multi-relay.** free2z runs the first relay. The protocol and relay
software are built for anyone to run one, and clients treat relays as
**untrusted, replaceable infrastructure**.

## Consequences

- The relay is a **separate, small, efficient Rust service**, not a Django app.
  Bandwidth is not the constraint; **concurrent WebSocket connections are**, and
  the existing Django Channels stack is dramatically less efficient per connection
  than a Rust service.
- **Open source and trivially self-hostable from the first release**, not as a
  later "community edition." This matters beyond ideology: server-side deletion is
  auditable but not verifiable from outside
  ([`../THREAT-MODEL.md` §4.5](../THREAT-MODEL.md#45-server-side-deletion-is-auditable-not-verifiable)),
  so **anyone who needs a verifiable guarantee must be able to run their own
  relay.**
- **Our economics invert Nostr's.** Delete-on-ack means no archive; pairwise
  opaque queues mean no firehose. Steady-state stored ciphertext is ~4 MB per
  1,000 DAU. A community operator can sustainably run a relay on a ~$5/month VPS.
  **The delete-on-ack requirement is not only a privacy property — it is the
  economic precondition for the federation.**
- **Cross-relay witness cosigning of key-transparency log roots provides
  anti-equivocation**, which is why no blockchain is needed
  ([ADR 0006](./0006-zcash-coupling.md)). The property strengthens as the
  federation grows — but it is only as strong as the *independence* of the witness
  set, which is a social fact we cannot verify cryptographically. Clients should
  default to a witness set that is not all free2z-operated.
- A device may publish queue addresses on *k* relays; senders send to all *k* and
  clients deduplicate by `msg_id`. Egress multiplies by *k*; at *k*=3 this is still
  trivially inside one commodity host's included bandwidth. The default *k* is an
  open question.
- **Nostr is a fallback transport, not the primary one.** Nostr relays retain by
  default and NIP-40 expiration is advisory, so they cannot deliver delete-on-ack.
  Opt-in per conversation, with the retention trade-off stated in the UI.
- If encrypted attachments ship, **zero-egress object storage (R2 or equivalent)
  is the design, not an optimization** — 1M DAU at 2 MB/day is ~60 TB/month, about
  $5,400 on S3-style egress and $0 on R2. Infrastructure is anyway a rounding
  error next to **engineering time and third-party security audit**, which
  dominate the budget. Plan around the audit.

## Alternatives rejected

- **free2z as the only relay.** Rejected: single point of censorship and coercion,
  and it makes every privacy claim conditional on us.
- **Adopt Nostr's relay network as the primary transport.** Rejected: retain-by-
  default is architecturally incompatible with requirement 2 (destroy ciphertext
  on delivery), and we cannot verify deletion on infrastructure we do not run.
- **Relay inside the Django monolith.** Rejected on connection efficiency, which
  is the actual cost driver.
- **Relay as a later community edition.** Rejected: self-hosting is what converts
  "trust us" into "verify it yourself," so it cannot be deferred.
