# ADR 0004 — Metadata: sealed sender over opaque pairwise queues

**Status:** Accepted (owner, 2026-08-08) · **Refs:** [#305](https://github.com/free2z/zuu/issues/305) §3.6, §7.4

## Context

Encrypting content is the easy half. A system that hides message bodies but
exposes who talks to whom, how often, and when has not delivered much to a user
whose risk comes from association rather than content. The available ambition
levels are: hide content only; additionally hide the sender (sealed sender);
additionally hide the social graph (SimpleX-style, no user identifiers anywhere).
Each step costs real performance and complexity.

free2z is also a **public creator platform** where `@handle` is the discovery
mechanism, which constrains what is achievable at connection time.

## Decision

**A key-transparency directory resolves `@handle` → identity key for discovery.
After connection, traffic flows over pairwise, unidirectional, opaque queues, so
ongoing communication does not expose the social graph.**

## Consequences

- The relay has **no accounts, no handles, no identity keys, no contact lists and
  no group state.** It sees opaque queue addresses and opaque ciphertext. Each
  queue has **two distinct addresses** — one authorizing append, one authorizing
  read/ack/delete. That is **capability separation**: a sender can never read,
  ACK or delete, and a compromised sender-side key cannot drain the queue. It is
  **not** unlinkability against the relay operator — delivery requires the relay
  to know which receive address a send address feeds, so the operator holds that
  pairing table by construction
  ([`../THREAT-MODEL.md` §4.9](../THREAT-MODEL.md#49-the-relay-knows-which-queue-addresses-are-paired)).
- Queue addresses are established **inside the MLS group**, never via the server,
  and rotate on a schedule using an MLS exporter, so a long-lived relationship
  does not present a long-lived identifier.
- **Accepted limit: the directory lookup reveals interest in a handle at
  connection time.** This is an unavoidable consequence of handle-based discovery
  on a public platform — you cannot look someone up by name without revealing that
  you looked. The limit is bounded to *connection time*; the directory is not
  consulted again for ongoing traffic. It is documented honestly in
  [`../THREAT-MODEL.md` §4.1](../THREAT-MODEL.md#41-directory-lookup-reveals-interest-in-a-handle)
  rather than papered over.
- **Fixed-size padding buckets are mandatory**, enforced by the relay rejecting
  non-conforming sizes — so a sloppy client cannot leak length and a malicious one
  cannot use length as a covert channel to a colluding relay.
- **Delivery-receipt policy is a deliberate decision, not an accident.** Receipt
  timing is a *published* deanonymization vector against sealed sender — group
  membership has been recovered from receipt patterns alone
  ([No safety in numbers](https://arxiv.org/pdf/2305.09799)). Receipts are batched
  and jittered by default, disableable per conversation; read receipts are
  separate and default off. **This raises the cost of the attack; it does not
  eliminate it**, and we say so.
- Push notifications remain an **unresolved** metadata leak
  ([`../ARCHITECTURE.md` §13-H](../ARCHITECTURE.md#13-open-questions)) and must not
  be described as solved until we take a position.

## Alternatives rejected

- **Hide content only.** Rejected: insufficient for any credible claim of being
  world-class, and the social graph is frequently the more sensitive asset.
- **Full SimpleX-style no-identifiers-anywhere, including discovery.** Rejected as
  incompatible with free2z's product: handle-based discovery is the point of a
  creator platform. We take the SimpleX queue model for everything *after*
  connection, which is where it matters most and costs least.
- **Private information retrieval for directory lookups.** Not rejected — deferred.
  It would genuinely close the §4.1 limit, and remains future work rather than a
  v1 requirement.
