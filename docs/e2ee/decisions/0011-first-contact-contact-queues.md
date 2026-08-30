# ADR 0011 — First contact: a distinctly-flavoured contact queue

**Status:** Accepted (Phase 1 specification, 2026-08-23) ·
**Refs:** [#545](https://github.com/free2z/zuu/issues/545),
[#133](https://github.com/free2z/zuu/issues/133),
[ADR 0004](./0004-metadata-ambition.md) ·
**Specifies:** [`../WIRE.md` §12](../WIRE.md#12-first-contact)

> **Invented here — and it closes a genuine hole in the merged design**, not a
> detail left for later.

## Context

[`../ARCHITECTURE.md` §6.2](../ARCHITECTURE.md#62-queues) says queue addresses are
established *"inside the MLS group — a member advertises its `QueueSendAddr` set
to peers in an authenticated application message, never via the server."*

That is correct, and it is circular. **There is no path for the `Welcome` that
creates the group in the first place.** Alice cannot advertise a queue to Bob
inside a group that does not exist, and she cannot send Bob the `Welcome` that
would create it, because Bob has no queue Alice is authorized to write to. As
merged, two people who have never spoken can never begin. Every implementation PR
in the Phase 1 wave would hit this on its first end-to-end test.

The shape of the answer is forced: **something has to accept a write from a
stranger.** The only questions are what that something is, how tightly it is
capped, and how honest we are about what it costs.

## Decision

**A contact queue**: a queue that differs from an ordinary queue in exactly four
ways.

1. **Its send side is never bound.** `BIND_SEND` on a contact address returns
   `ERR_NOT_PERMITTED`, always, for everyone. There is no key authorizing writes,
   so there is no key to steal, squat
   ([ADR 0009](./0009-queue-addressing-and-binding.md)) or lose.
2. **It accepts unsigned appends** (`CONTACT_APPEND`) from anyone presenting a
   valid proof-of-work stamp.
3. **Its address is published** in the owner's directory entry, authenticated by
   whatever signature that entry carries, rather than advertised in-band. It is
   the one address in the system meant to be looked up.
4. **It is hard-capped**: a pending-message cap, a byte cap, a per-source token
   bucket, and a required proof-of-work stamp computed over a **relay-issued,
   single-use, expiring challenge** scoped to the target address.

Its receive side is an ordinary queue: read, acknowledge and delete with the
normal recv-side commands, signed by the recv key.

The contact queue carries **one message, in one direction, once per pair**. Both
sides then create ordinary queues and advertise them inside the group, and the
contact queue plays no further part for that pair.

## Consequences

- **First contact works**, and it works without the server ever being trusted:
  the `Welcome` is addressed to a `KeyPackage` Alice obtained from a
  key-transparency-verified directory entry, so a relay that substitutes or
  fabricates content produces something Bob cannot decrypt. The contact endpoint
  is authenticated by the directory entry, which matters — an unauthenticated
  contact address supplied by a server is
  [#133](https://github.com/free2z/zuu/issues/133)'s MITM reintroduced at the one
  moment the user has least context to notice.
- **Unsigned appends are unauthenticated by construction, and the filter is
  cryptographic and client-side.** A payload that is not a `Welcome` addressed to
  one of Bob's published `KeyPackage`s fails to decrypt and is discarded. Junk
  costs Bob bandwidth and costs the attacker a stamp. Well-formed but unwanted
  contact requests are a moderation problem, surfaced to Bob as requests rather
  than as messages.
- **`CONTACT_APPEND` returns nothing**, on the same rule as `APPEND`: a stranger
  must learn neither how full the queue is nor whether Bob has read it.
- **Proof of work taxes phones far more than rented GPUs. This is the central
  weakness and it is not fixable by tuning.** A leading-zero-bit search is
  precisely the workload commodity parallel hardware accelerates best; the ratio
  between a rented GPU-hour and a battery-constrained mid-range phone is orders of
  magnitude. A difficulty high enough to meaningfully cost an attacker is a
  difficulty that makes a cheap Android device heat up before it can say hello. We
  have chosen a difficulty that is a nuisance to attackers and tolerable to
  phones, which means it is *only* a nuisance. **That calibration claim was not
  measured; see the correction below.**

  > **Correction (2026-08-30).** v1 publishes `difficulty_bits = 20` as the
  > concrete interoperability default for both queue creation and contact
  > append, because an unnamed default makes independent implementations
  > diverge. No cheap-Android or attacker-hardware measurement supported the
  > sentence above, so 20 bits is explicitly provisional rather than described
  > as tolerable or effective. The calibration question remains open in
  > [`ARCHITECTURE.md` §13-N](../ARCHITECTURE.md#13-open-questions); changing the
  > default after measurement is an observable policy change, not a retroactive
  > claim that the measurement existed here.
- **Disk exhaustion via mass queue creation is made expensive, not closed.**
  Nothing prevents an adversary with real resources from creating very many
  legitimate-looking queues with valid stamps from many sources. The caps bound
  what one queue costs; they do not bound how many exist. Global backpressure
  ([ADR 0012](./0012-anti-abuse-v1.md)) keeps the relay alive by degrading service
  for everyone, because identifying the attacker would require exactly the
  identity the relay deliberately lacks.
  [`../ARCHITECTURE.md` §13-I](../ARCHITECTURE.md#13-open-questions)'s anonymous
  credentials are the real answer and remain deferred and unspecified.
- **A contact queue can be filled to deny first contact.** An attacker willing to
  pay `contact_max_pending` stamps keeps Bob unreachable to strangers until he
  drains it. Existing conversations are entirely unaffected — they use ordinary
  queues — and Bob's client drains aggressively, but under a sustained flood Bob's
  remedy is to create a new contact queue and republish his directory entry, which
  costs a directory epoch and is therefore slow. This is a real, unmitigated denial
  of service against first contact.
- **The directory lookup reveals interest in a handle**, which is the accepted
  limit of [`../THREAT-MODEL.md` §4.1](../THREAT-MODEL.md#41-directory-lookup-reveals-interest-in-a-handle).
  First contact is exactly the moment that limit applies. This design does not
  worsen it and does not fix it.
- **The relay learns that someone contacted a public address.** It does not learn
  who — the append is unsigned and carries no client identity — but it sees the
  source IP, as it does for everything.
- **A dependency is flagged, not invented.** The flow assumes Bob has published
  MLS `KeyPackage`s Alice can fetch, and that one is available and unexpired.
  KeyPackage publication, last-resort key packages, exhaustion behaviour and fetch
  rate limiting are **directory design**, deferred with `KT.md` and **ADR 0013**,
  which is blocked on [#544](https://github.com/free2z/zuu/issues/544).

## Alternatives rejected

- **Do nothing and require an out-of-band invite** (a QR code, a link, a shared
  secret). Rejected as a product decision: free2z is a public creator platform
  where `@handle` *is* the discovery mechanism
  ([ADR 0004](./0004-metadata-ambition.md)), and a messenger where you cannot
  message a creator you just found is not the product. Retained as an *additional*
  path, not as the only one.
- **Let the free2z application server hold and forward first-contact messages.**
  Rejected outright: it gives the server a `Welcome`-shaped message with a
  recipient it knows, which is the social graph the whole queue design exists to
  withhold, and it puts the server back in the position of choosing what reaches
  whom.
- **Signed appends to the contact queue, authorized by the sender's identity
  key.** Rejected: it would require the recipient's relay to know and check
  identity keys, which reintroduces identity at exactly the layer
  [ADR 0004](./0004-metadata-ambition.md) removed it from, and it would tell the
  relay who contacted whom.
- **A memory-hard proof of work (Argon2id and relatives).** Rejected for v1 with
  regret. It would genuinely narrow the phone-versus-GPU gap. It also multiplies
  the **relay's own verification cost** by the same factor it raises the
  attacker's, which is the wrong trade at the moment of a flood, when the relay is
  the resource under pressure. Verification must stay a single hash. Recorded as
  an open question ([§13-N](../ARCHITECTURE.md#13-open-questions)) rather than
  closed.
- **Payment (shielded ZEC) for first contact.** Not rejected — **deferred**, and
  it is the same deferral as [§13-I](../ARCHITECTURE.md#13-open-questions):
  [ADR 0006](./0006-zcash-coupling.md) already contemplates prepaid quota
  credentials redeemed via blind-issued tokens. That design is unspecified, and
  shipping payment before anonymous credentials would mean shipping an identifier.
- **Reusing an ordinary queue with a well-known send key.** Rejected: a published
  send key is a key everyone holds, i.e. exactly an unbound send side, but with
  the added false suggestion that a signature means something.
- **No caps, relying on PoW alone.** Rejected: PoW bounds the *rate* of writes,
  not the *total*, so an attacker with patience fills any uncapped queue.
