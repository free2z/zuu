# ADR 0006 — Zcash coupling: client-side cryptography only, no chain in the critical path

**Status:** Accepted (owner, 2026-08-08) · **Refs:** [#305](https://github.com/free2z/zuu/issues/305) §5, §7.6

## Context

ZUULI ships a Zcash wallet, which offers four things no other messenger has:
seed-derived identity, an immutable public broadcast medium for key-transparency
checkpoints, an authenticated remote out-of-band verification channel (shielded
memos), and anonymous paid anti-abuse. The question is how much belongs in the
critical path, given that a chain dependency brings availability coupling and
exposure to ZEC price volatility.

## Decision

**Client-side cryptography only.**

- **In:** messaging identity derived from the wallet seed via **hardened,
  ZIP-32-style derivation on a dedicated messaging-only branch**. Pure client-side
  key derivation; no chain involved.
- **In (optional, later):** prepaid quota credentials purchased with shielded ZEC
  and redeemed via blind-issued/KVAC tokens — anti-spam without identity.
- **Out of the critical path:** on-chain anchoring of key-transparency
  checkpoints.

**Hard constraint: never reuse Sapling/Orchard spending or viewing keys as
messaging keys.** Different curves (Jubjub/Pallas vs. X25519/Ed25519) and, more
fundamentally, key separation is non-negotiable. Derive a distinct messaging seed
from the master seed, then generate messaging keys from that.

## Consequences

- Restoring the wallet mnemonic restores the messaging identity. There is no
  separate identity backup to lose.
- The messaging tree is rooted at its own BLAKE2b personalization and uses only
  hardened derivation with no extended public key at any level, so it **cannot
  collide with the Sapling or Orchard key trees even at identical indices**, and
  the seed is not recoverable from any messaging key. See
  [`../ARCHITECTURE.md` §4.2](../ARCHITECTURE.md#42-derivation-proposed).
- Cross-protocol key reuse is exactly what an auditor will (correctly) fail us on,
  so the domain-separation table is part of the specification, not an
  implementation detail.
- **No chain dependency means no availability coupling and no ZEC price exposure
  in the messaging path.** Witness cosigning
  ([ADR 0005](./0005-federation.md)) provides the same anti-equivocation property
  for free, and it is the Certificate Transparency model rather than a novel one.
  For the record: at [ZIP 317](https://zips.z.cash/zip-0317)'s 10,000-zatoshi
  minimum shielded fee and ZEC ≈ $517 (Aug 2026), a checkpoint costs ~$0.052 —
  cheap, but cheap was never the argument.
- **Shielded-memo verification is retained as a genuinely unusual capability.**
  Two users who already know each other's payment address have an authenticated,
  private, *remote* out-of-band channel for confirming identity keys — safety
  numbers without an in-person QR scan. ZUULI-only; a complement to key
  transparency, not a replacement.
- Anchoring may exist later as an **opt-in highest-assurance tier**, never a
  requirement. The KVAC/blind-credential design for paid quota is unspecified
  ([`../ARCHITECTURE.md` §13-I](../ARCHITECTURE.md#13-open-questions)).

## Alternatives rejected

- **Reuse Sapling/Orchard keys as messaging keys.** Rejected outright: wrong
  curves, and a bedrock violation of key separation.
- **On-chain KT checkpoints in the critical path.** Rejected: buys nothing that
  witness cosigning does not, and adds a hard external dependency plus price
  exposure.
- **No Zcash coupling at all.** Rejected: seed-derived identity is a cheap
  usability win with no downside once domain separation is done correctly, and the
  shielded-memo verification channel is a genuine differentiator.
- **Requiring payment for messaging.** Rejected: marginal cost per user for text
  is ~$0.002–0.02/month, so pricing should be set by spam resistance and relay
  sustainability, not cost recovery.
