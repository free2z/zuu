# ADR 0015 — `KeyPackage` publication: a consumable key at a mutable store

**Status:** Accepted (2026-08-26) ·
**Refs:** [#133](https://github.com/free2z/zuu/issues/133),
[ADR 0004](./0004-metadata-ambition.md),
[ADR 0011](./0011-first-contact-contact-queues.md),
[ADR 0013](./0013-key-transparency-log.md) ·
**Specifies:** [`../WIRE.md` §12.6](../WIRE.md#126-keypackage-publication--where-a-consumable-key-lives) ·
**Closes:** `KT.md` §1.2 and §12's *"MLS `KeyPackage` publication and
exhaustion"*, `WIRE.md` §1.2 and §16's copy of it

> **Invented here.** The specification deferred this deliberately and in three
> places; none of them chose an answer. This one is chosen, and every alternative
> it beat is written down below with the reason it lost.

## Context

This was the last functional blocker on first contact. `resolve_handle` worked,
`accept_contact_request` worked, and `start_conversation` ran the whole verified
directory lookup — the monotonicity checks, the threshold, the inclusion proof,
the alarms, the pin — and then refused by name, because
[`../WIRE.md` §12.5](../WIRE.md#125-the-full-handshake-end-to-end) step 2 needs a
`Welcome` addressed to a `KeyPackage` the recipient published and nothing
published one. Two people could find each other and neither could open a
conversation.

### The tension that made it a design problem rather than a chore

**A `KeyPackage` is consumable; a key-transparency log is append-only.**

RFC 9420 §10 has a client delete a key package's init secret once it has
processed the `Welcome` addressed to it. A package served twice means two
initiators encrypting to one secret. Meanwhile
[`../KT.md` §4.2](../KT.md#42-versions-and-the-hash-chain)'s version chain and
[§4.3](../KT.md#43-uniqueness-within-an-epoch--a-must-that-comes-from-the-audit)'s
one-entry-per-handle-per-epoch rule exist so that nothing in the log is ever
withdrawn. An append-only structure cannot express consumption. That is why
[§4.1](../KT.md#41-structure) says a `DirectoryEntry` carries *"no
`KeyPackage`"*, and any design that quietly puts them back has to answer it.

So the question is not *how do we get key packages into the directory*. It is:
**what already knows how to address a device, and is allowed to forget things?**

## Decision

**A device's key packages live at the relay that hosts its contact queue,
addressed by the same `contact_addr` its directory entry already publishes.**

Two new commands hang off the addresses one `CREATE_CONTACT_QUEUE` already
produced:

- `PUBLISH_KEY_PACKAGES` (`0x0032`) — signed by the contact queue's **receive
  key**, addressed to its `recv_addr`. Appends to the pool, skips byte-identical
  duplicates so a retry is safe, clamps to a published cap, and replaces the one
  package of last resort.
- `CLAIM_KEY_PACKAGE` (`0x0033`) — **unsigned**, behind a proof-of-work stamp
  with its own challenge purpose, addressed to the published `contact_addr`.
  Serves and deletes the oldest package; serves the last-resort package without
  deleting it when the pool is empty; answers `ERR_UNAVAILABLE` when there is
  neither.

And one non-negotiable obligation on the fetcher: **a claimed package MUST be
authenticated against the `DirectoryEntry` the log proved** — the credential's
signature under the entry's `identity_pk`, its handle, its presence in the
published `devices` set, its absence from `revocations`, and the leaf binding.
[`../WIRE.md` §12.6.5](../WIRE.md#1265-authentication--mandatory-and-structural)
is the full list.

### Why this is the right shape, in four lines

- **No new identifier at the relay.** ADR 0004 gives the relay no accounts, no
  handles and no identity keys, and none is introduced. A `contact_addr` is an
  opaque 32-byte value the relay generated itself and has held ever since; the
  directory does the handle → address binding, covered by the entry's
  authorization signature exactly as it already is for first contact.
- **No new key.** Ownership of the pool is ownership of the contact queue,
  proved with the receive-side key the relay registered at creation. There is no
  key to steal, squat or lose that was not already there.
- **No wire change to a frozen structure.** `DirectoryEntry` is untouched.
  `KT.md` §12 names a wire change to that structure as the price of closing an
  unrelated open item; this one does not spend it.
- **The relay is a cache of self-authenticating objects, not a trusted party.**
  A key package is signed by the device key and carries the `DeviceCredential`
  the identity key signed. A hostile relay can withhold, exhaust, or choose
  among the device's *own* packages. It cannot substitute one, because it does
  not have the device's signing key — which is the whole reason this is safe to
  put at a party the threat model assumes is hostile.

## Alternatives considered, and why each lost

### 1. In the directory, with consumption tracked elsewhere

Resolves addressing with nothing new at all: an entry already carries a device
set, so it could carry a pool.

**Rejected.** It re-opens the exact conflict §4.1 closed, and the damage is not
theoretical:

- Every consumption needs a new `entry_version`, so **one directory epoch per
  conversation started**. §4.3 permits at most one entry per handle per epoch,
  so a popular handle cannot refill faster than the epoch cadence — and §5's
  placeholder cadence is 600 s.
- `entry_version` becomes a **public counter of how many people have started a
  conversation with you**, published forever, to everyone who ever resolves you.
- The log's write volume becomes a function of social activity rather than of
  key changes, which is not the workload
  [ADR 0013](./0013-key-transparency-log.md) sized `akd` for.

A variant — publish only a *commitment* to the pool in the directory and serve
the pool elsewhere — was also rejected. It buys a fetcher a proof that the pool
was chosen by the owner, and the package is **already** self-authenticating
under the `DeviceCredential`, so the commitment adds nothing but a directory
write per refill.

### 2. A new relay endpoint with its own addressing

The relay can consume, so give it a purpose-built key-package store with its own
address space.

**Rejected**, and the reason is the question this alternative has to answer:
what addresses it? Either

- the address is derived from an identity — which is precisely the identifier
  ADR 0004 forbids the relay to hold; or
- it is a fresh opaque address, which must then be **published in the directory**
  so a stranger can find it — a new `DirectoryEntry` field, a wire change to the
  structure two implementations have frozen, and a second published address per
  device that can get out of sync with the first (an entry naming a live contact
  queue and a dead key-package store).

Reusing `contact_addr` is not a shortcut around that. The two are the *same
capability* — "the public address at which strangers may initiate first contact
with this device" — and splitting one capability across two addresses creates
the failure mode rather than avoiding it.

### 3. The free2z platform serves them

The platform has accounts and handles already, and could hand out key packages
keyed by handle with no new addressing at all.

**Rejected**, twice over. It puts an account-bearing service back in the
first-contact path, which is the shape [#133](https://github.com/free2z/zuu/issues/133)
is about — mitigated by §12.6.5's check, but re-introduced as a surface for no
gain. And it breaks federation: a relay-hosted pool federates with the relay
([ADR 0005](./0005-federation.md)), so a user on a third-party relay is
self-sufficient; a platform-hosted one makes free2z a required participant in
every conversation anybody starts, which is the dependency the whole delivery
design exists to remove.

### 4. Synthesize a key package from the directory's `device_kem_pk`

The most tempting alternative, because it needs **no endpoint at all**. A
`DeviceCredential` already publishes `device_kem_pk`, the X-Wing hybrid key
(`KT.md` §4.1). An initiator could build a `KeyPackage` from directory material
alone and address a `Welcome` to it — nothing to publish, nothing to consume,
nothing to exhaust.

**Rejected, and it is worth stating why because the reasoning is what justifies
bounding the last-resort package below.** `device_kem_pk` is a
*directory-lifetime* key: it changes when the credential changes, on the order of
a device's life. Using it as an MLS init key makes **every** first contact use a
permanently reused init key — one long-lived secret that opens every `Welcome`
ever sent to that device. That is strictly worse than the last-resort package,
which is at least explicitly labelled, deliberately short-lived, and reached only
when the pool is empty. This alternative makes the *common* case
forward-secrecy-free rather than the exhausted one.

It is, however, exactly what a last-resort package degenerates into if it is
never rotated — which is why
[`../WIRE.md` §12.6.6](../WIRE.md#1266-exhaustion-and-the-package-of-last-resort)
says a device SHOULD give it a lifetime materially shorter than its credential's,
and why the reference client asks for thirty days against a year.

### 5. Invert the handshake — the responder creates the group

The shape nobody proposed, and the one that came closest to winning. Alice never
needs a package from Bob: she writes to Bob's contact queue with **her own**
freshly generated `KeyPackage` and her queue advert; Bob, on accepting, resolves
`@alice`, verifies her package against the directory, creates the MLS group,
adds her, and sends the `Welcome` back. No pool, no publication, no exhaustion,
no last resort, no relay change, and better forward secrecy than either — the
init key is fresh per request and never sits on a server.

**Rejected**, for one decisive reason and two supporting ones.

The decisive one: **it moves an unbounded-state problem from the relay onto the
initiator.** Alice must keep the private init key of every unanswered request
alive indefinitely, because she cannot know whether Bob will accept in an hour or
in a month. That set grows with every contact attempt, has no cap mechanism, is
invisible to everyone including Alice, and cannot be garbage-collected without
silently abandoning pending requests. The pool at the relay has the same problem
in mirror image — and there it is **capped, refillable, observable, and paid for
by proof of work.** Exchanging a bounded, instrumented store for an unbounded,
invisible one is the wrong direction.

Supporting: a `Welcome` is self-contained and asynchronous, so Alice can start a
conversation with a Bob who is offline for a month and he joins whenever;
inversion needs two round trips with both parties reachable. And it rewrites
§12.5's normative handshake and ADR 0011's design to close an item both of them
deferred, which is a much larger normative change than filling the hole in.

## Consequences

**Accepted, and each is stated where it lands rather than only here.**

- **The last-resort package trades forward secrecy for availability.**
  [`../THREAT-MODEL.md` §4.12](../THREAT-MODEL.md#412-a-last-resort-key-package-is-a-reused-init-key).
  It is the RFC's own answer for exhaustion and it is a real cost: two initiators
  encrypting under one long-lived secret, retroactively openable by whoever
  compromises it. A device MAY publish none and accept unreachability instead.
- **A hostile relay can force that trade.** It can serve the reusable package
  while holding a full pool, and the `last_resort` byte is unsigned.
  [§4.13](../THREAT-MODEL.md#413-a-relay-chooses-which-key-package-you-get-and-can-always-serve-the-reusable-one).
  The recipient can detect it; nothing in v1 requires it to.
- **Draining a pool is cheaper than flooding a contact queue.** A claim consumes
  and a `CONTACT_APPEND` does not, so `max_pool_size` claim stamps push a
  device onto its reusable package until it refills.
  [`../WIRE.md` §12.6.9](../WIRE.md#1269-anti-abuse). Proof of work is the whole
  mitigation, and [§13-I](../ARCHITECTURE.md#13-open-questions)'s anonymous
  credentials remain the real answer.
- **A claim is observable when first contact is abandoned.** One new bit beyond
  [§4.1](../THREAT-MODEL.md#41-directory-lookup-reveals-interest-in-a-handle),
  named in [§4.14](../THREAT-MODEL.md#414-claiming-a-key-package-tells-the-relay-someone-is-about-to-make-contact).
- **A relay must publish whether it does this at all.** The additive
  `GET_KEY_PACKAGE_POLICY` response's `enabled` flag is not implied by the
  frozen v1 capability document's `contact_queues_enabled`, and a client reads
  it: the difference is whether anyone can start a conversation with the
  devices that relay hosts. Keeping it in a new command preserves old/new v1
  interoperability under `WIRE.md` §3.5.
- **`KT.md` §4.1 is unchanged.** The dated note there records that the exclusion
  is affirmed rather than reversed, so a reader arriving from the open-item list
  finds the answer instead of a hole.

## What this does not close

- **The numbers.** The pool target, the low-water mark and the last-resort
  lifetime are policy. The reference client uses 32, 8 and thirty days against a
  cap of 64; all four are placeholders in the sense §12.3's caps are, and none
  has been measured.
- **Multi-relay redundancy.** A directory entry may carry several
  `ContactEndpoint`s, and *k* is [§13-G](../ARCHITECTURE.md#13-open-questions),
  still open. This build claims the first, so a single hostile relay is a single
  point of failure for first contact exactly as it already was for the contact
  queue.
- **Whether a recipient should alarm on a manufactured exhaustion.** The
  evidence exists (§4.13); no mechanism is specified and none is implemented.
