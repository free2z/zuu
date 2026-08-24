# ADR 0014 — Directory key rotation: dual-signed changes, and a loud, delayed platform reset

**Status:** Accepted (Phase 1 specification, 2026-08-23) ·
**Refs:** [#545](https://github.com/free2z/zuu/issues/545),
[#133](https://github.com/free2z/zuu/issues/133),
[ADR 0006](./0006-zcash-coupling.md) ·
**Relates to:** [`../ARCHITECTURE.md` §13-K](../ARCHITECTURE.md#13-open-questions)
(handle rename and transfer — still open) ·
**Depends on:** the key-transparency log construction, **ADR 0013**, which was
**deliberately not in this change** — it was blocked on
[#544](https://github.com/free2z/zuu/issues/544), and landed on 2026-08-23 as
[ADR 0013](./0013-key-transparency-log.md) with
[`../KT.md`](../KT.md). The encodings that carry the rules below are
[`../KT.md` §4.4](../KT.md#44-what-authorizes-an-entry); nothing in this ADR
changed to accommodate them.

> **Invented here.** [`../ARCHITECTURE.md` §9.2](../ARCHITECTURE.md#92-the-directory)
> specifies an append-only log of `(handle → IdentitySigningKey.public, epoch,
> DeviceCredential set)` with inclusion proofs, consistency proofs and per-handle
> self-audit. It does **not** specify what authorizes a new entry, and in
> particular says nothing about what happens when the key that would authorize one
> is gone.

## Context

The directory is the foundation: [#133](https://github.com/free2z/zuu/issues/133)
is that the server today decides who you are connected to, and §9 exists so that a
substituted identity key is at least *detectable by the victim*. Self-audit gives
detection. It does not give a rule for **authorization** — which entries the log
should accept in the first place.

Three cases have to be distinguished and they have different answers.

1. **A same-key update.** Adding or revoking a device credential, updating contact
   endpoints ([ADR 0011](./0011-first-contact-contact-queues.md)). The identity key
   is unchanged and available.
2. **A key change.** The user is rotating to a new identity key and still holds
   the old one.
3. **A lost key.** The user cannot sign with the outgoing key at all.

Case 3 is where every system of this kind either introduces a weakness or tells a
population of users that they have permanently lost their handle. Under
[ADR 0006](./0006-zcash-coupling.md) the identity key is **seed-derived**, so
"lost key" means "lost mnemonic" — which also means the user has lost their
wallet. That narrows the population needing recovery to people who have already
suffered a worse loss, but it does not empty it, and free2z is a public creator
platform where a handle is an audience.

## Decision

**Case 1 — a same-key entry is self-signed.** One signature, by the current
`DirectoryAuthKey`, over the canonical encoding of the new entry, the handle, the
epoch, and the hash of the previous entry. The log accepts it iff the signature
verifies under the key already published for that handle.

**Case 2 — a key change requires two signatures, and neither alone is
sufficient.**

- A **`RotationProof` signed by the outgoing key**, binding the old key, the new
  key, the handle, the epoch, and the hash of the previous entry.
- **A signature by the new key** over the new entry, which includes the
  `RotationProof`.

The log MUST reject a key change carrying only one. The outgoing signature stops
the log operator from swapping a key; the incoming signature stops a stolen or
mis-transcribed new key from being installed without proof of possession.

**Case 3 — a lost key requires a platform-authority reset**, which:

- is an entry signed by a dedicated **reset authority key**, held offline, whose
  public key is published and pinned in clients;
- **raises a non-dismissible alarm on every peer** that holds the old key, naming
  the handle, both key fingerprints, and — explicitly — the fact that the change
  was **platform-assisted rather than user-authorized**;
- applies a **cooldown** (proposed: 7 days) during which conforming clients
  **keep using the old key** and refuse to encrypt to the new one, so that a user
  who still holds the old key can cancel the reset with a `RotationProof`;
- is published in the log like every other entry, so it is permanently visible
  and countable;
- is counted per epoch, with the count published alongside the tree head, so an
  abnormal rate of resets is visible to anyone without a single per-handle lookup.

**An entry MAY additionally carry a `no_reset` flag.** A user who sets it is
declaring that the reset path does not apply to their handle: losing the key means
losing the handle, permanently, with no recovery. This is the strongest available
posture and it costs nothing to offer.

## Consequences

- **Neither the log operator nor the platform can change a live key silently.**
  Case 2 needs a signature the platform does not have; case 3 is loud by
  construction.
- **This is a real weakening, and announcing it loudly is the entire
  mitigation.** A platform-assisted recovery is **cryptographically
  indistinguishable from a platform-assisted attack.** There is no signature that
  separates "Alice lost her seed and asked us" from "someone compelled us to hand
  Alice's handle to a different key" — in both cases the only authority is the
  platform's. What separates them is that both are announced, both land in an
  append-only log that anyone can audit and count, and both are delayed. This is
  the standard delay-and-notify recovery pattern, with the standard property: it
  converts an undetectable substitution into a detectable one, and it does not
  prevent anything.
- **A user who ignores the alarm gets MITM'd, and so does one whose client
  dismisses it.** "Non-dismissible" is therefore a hard product requirement, not a
  UX preference: a peer must be unable to continue the conversation without
  acknowledging that the key changed by platform action. Copy that reads "Alice's
  security code changed" is a defect; it must say that the change was made by the
  platform without Alice's old key.
- **The cooldown is the part that gives the victim something to do.** Notification
  without a window tells a user they have been attacked after the attacker already
  has their traffic. During the cooldown, conforming clients keep encrypting to
  the old key, so an attacker who obtained a reset gets nothing readable until the
  window elapses, and the legitimate holder of the old key can cancel.
- **The reset authority key is a high-value target and must be treated as one.**
  Offline, split if practicable, its use rare and publicly counted. A compromise
  of that key is a compromise of every handle that has not set `no_reset`. This is
  the concentrated risk the decision creates, and it should be read as such.
- **`no_reset` is not free for the user.** It is the correct choice for a
  high-risk user and the wrong default for a creator whose handle is their
  livelihood. It must be presented with a plain statement of what it forecloses,
  and it MUST NOT be silently defaulted either way.
- **This does not answer handle rename or transfer.** A rename is not a key
  change; a transfer is a change of *owner* rather than of key, and it creates a
  MITM window of a different shape. That remains
  [§13-K](../ARCHITECTURE.md#13-open-questions), open.
- **It is written to be implementable on whatever log #544 selects.** The decision
  constrains what authorizes an entry, not how entries are stored, proved or
  cosigned. Those are ADR 0013's, and their absence here is deliberate rather than
  an oversight — see [`../WIRE.md` §1.2](../WIRE.md#12-what-it-deliberately-does-not-fix).
- **The threat-model claim that must be updated when this ships.**
  [`../THREAT-MODEL.md` §3.1](../THREAT-MODEL.md#31-malicious-or-compromised-free2z-server)
  currently states that the server "cannot substitute an identity key
  undetectably." That remains true with this decision — the reset is maximally
  detectable — but the sentence is doing more work than it looks like it is, and
  the reset path is the reason. It should be annotated when the KT documents land,
  not left to be discovered. **Done 2026-08-23**: §3.1 now carries a dated
  correction stating that the reset converts an undetectable substitution into a
  loud, delayed, permanently recorded one, and does not prevent it.

## Alternatives rejected

- **No recovery at all: lose the seed, lose the handle.** This is the strongest
  security answer and it was rejected as a *default*, not on its merits. free2z is
  a creator platform where a handle is an audience and a livelihood, and a
  messenger that permanently destroys both on a lost backup will not be adopted by
  the people it is for. It survives as the opt-in `no_reset` flag, because users
  who want it should have it.
- **Instant reset with notification but no cooldown.** Rejected: notification
  without a window gives the victim nothing to do in time. The attacker has the
  traffic before the alarm is read.
- **Reset without a peer alarm.** Rejected outright. That is an undetectable
  server-mediated identity substitution — precisely the attack
  [#133](https://github.com/free2z/zuu/issues/133) and
  [`../ARCHITECTURE.md` §9](../ARCHITECTURE.md#9-identity-directory-key-transparency-and-federation)
  exist to prevent — with a support ticket as its authorization.
- **A dismissible alarm.** Rejected: an alarm a user can clear with one tap is an
  alarm that will be cleared with one tap, most reliably by the users under the
  most pressure.
- **Social recovery (M-of-N contacts attest to the new key).** Not rejected —
  **deferred.** It genuinely removes the platform from the trust path, and it
  needs a contact-attestation format, a threshold policy, a rule for what happens
  when contacts are unreachable or collude, and UI for all of it. That is more
  machinery than v1 warrants, and it moves trust rather than removing it. Worth
  revisiting once the log construction exists.
- **A single signature by the new key alone for a key change.** Rejected: it lets
  anyone who can get an entry into the log take over a handle, which is the log
  operator's capability by definition.
- **A single signature by the outgoing key alone.** Rejected: it installs a new
  key with no proof that anyone possesses it, so a typo, a truncated transfer or a
  malicious substitution of the new key material by the log operator all produce a
  handle nobody controls.
- **On-chain anchoring of key changes.** Rejected here for the same reason
  [ADR 0006](./0006-zcash-coupling.md) rejected it for checkpoints: it buys
  nothing that witness cosigning does not, and adds a hard external dependency to
  the recovery path — the worst possible place for one.
