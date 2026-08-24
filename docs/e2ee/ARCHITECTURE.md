# free2z E2EE — Architecture

**Status:** Phase 0 design. Nothing described here is implemented.
**Refs:** [#305](https://github.com/free2z/zuu/issues/305) (epic and decisions),
[#131](https://github.com/free2z/zuu/issues/131),
[#132](https://github.com/free2z/zuu/issues/132),
[#133](https://github.com/free2z/zuu/issues/133),
[#134](https://github.com/free2z/zuu/issues/134).
**Companion:** [`THREAT-MODEL.md`](./THREAT-MODEL.md), [`WIRE.md`](./WIRE.md),
[`KT.md`](./KT.md), [`decisions/`](./decisions/).

This document is written to be read by a third-party security auditor. Where
something is undecided, it is listed in [§13 Open questions](#13-open-questions)
rather than answered by invention. Where a property does not hold, it is stated
as not holding. Constants, labels and wire encodings marked *proposed* are
placeholders to be fixed in the Phase 1 specification; they are written down so
the structure can be reviewed, not so they can be implemented as-is.

---

## 1. Where we are today

Verified against the tree at the time of writing, so the starting point is a
fact rather than a memory:

- `ts/react/free2z/src/lib/p2pe2e/` is **642 lines** across
  `webrtcmanager.ts` (151), `peerconnectionmanager.ts` (256),
  `websocketmanager.ts` (160) and `datachannelmanager.ts` (75). Grepping it for
  `encrypt|crypto|subtle|fingerprint|sodium|nacl` returns **nothing**. There is
  no application-layer cryptography in the p2pe2e client at all.
- `py/dj/apps/efm/consumers.py` is a 210-line Django Channels
  `SignalingConsumer`. It authenticates a participant with an HS256 JWT signed
  by `settings.SECRET_KEY`, tracks presence in the Django cache, and in
  `handle_signaling_message` relays `offer` / `answer` / `ice_candidate`
  messages verbatim from one participant's channel to another's.

The consequence is exactly what [#133](https://github.com/free2z/zuu/issues/133)
says: today's confidentiality is *only* WebRTC's DTLS transport encryption, and
the certificate fingerprints that key it travel through the server inside the
SDP. The server can hand participant A an offer pointing at a machine it
controls, and MITM the session undetectably. **We are not hardening an E2EE
system; we are building one for the first time.** There is no wire format to
preserve, so we are architecturally unconstrained.

## 2. Goals and non-goals

### 2.1 Goals

1. **The server cannot read message content.** Non-negotiable. No server-side
   key escrow, no server-held plaintext, no server-mediated key agreement that
   the server could substitute into.
2. **The server destroys ciphertext on acknowledged delivery.** The relay may
   buffer ciphertext for an offline recipient and must delete it once delivery
   is acknowledged. It is a buffer, not an archive. (Relaxed from the original
   "must be online" requirement, which made the product unusable.)
3. **Forward secrecy and post-compromise security** at group scale, not just
   for 1:1.
4. **The server cannot lie about who you are talking to.** Key changes are
   publicly auditable; a server that equivocates leaves non-repudiable evidence.
5. **A credible, written metadata story** — not just AEAD over the body.
6. **P2P is an optimization, never a security dependency.** It may fail, be
   blocked, or be attacked without weakening confidentiality or authenticity.
7. **Support cryptographic "apps"**, with FROST/DKG
   ([#132](https://github.com/free2z/zuu/issues/132),
   [#134](https://github.com/free2z/zuu/issues/134)) as the first one.
8. **Hybrid post-quantum confidentiality from day one**, not retrofitted.
9. **Federated by construction** — anyone can run a relay, and separately anyone
   can run a witness (§9.3); clients treat both as untrusted, replaceable
   infrastructure.

### 2.2 Non-goals

- **Anonymity against a global passive adversary.** We improve metadata privacy
  substantially and state the limit plainly. We are not building Tor, and we do
  not ship an anonymity network. Users who need network-layer anonymity should
  run the client over one.
- **Cryptographic deniability of conversational messages.** See §5.6 — MLS
  application messages are signed by the sender's leaf key, so we do not get
  deniability and we do not claim it.
- **Post-quantum *authentication*.** X-Wing gives hybrid PQ confidentiality
  (a KEM). Signatures remain Ed25519. See §5.5.
- **Defending a compromised endpoint.** Malware with the user's privileges on
  the user's device reads plaintext. No messenger defends against this and
  neither do we.
- **Compatibility with the current prototype's wire format.** There isn't one.
- **Shipping code from Phase 0.**

## 3. The stack

| Layer | Choice | Standard |
|---|---|---|
| 0. Client integrity | ZUULI native (strong) / web WASM (stated-weaker) | [ADR 0001](./decisions/0001-platform-priority.md) |
| 1. Identity + directory | Seed-derived identity; key-transparency log with independent witness cosigning (§9.3) | CONIKS / SEEMless / Parakeet lineage |
| 2. Session crypto | **MLS**, hybrid PQ (X-Wing) from day one | [RFC 9420](https://datatracker.ietf.org/doc/html/rfc9420), [RFC 9750](https://datatracker.ietf.org/doc/rfc9750/), [draft-ietf-mls-extensions](https://www.ietf.org/archive/id/draft-ietf-mls-extensions-04.html) |
| 3. Delivery | SMP-style opaque pairwise unidirectional queues, delete-on-ack, federated | [SimpleX SMP](https://simplex.chat/docs/simplex.html) design, clean-room implementation |
| 3b. Fallback delivery | Nostr relays, optional, retention consciously accepted | [NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md) is advisory only |
| 4. P2P | WebRTC, DTLS fingerprints authenticated **inside** the MLS group | [RFC 8827](https://datatracker.ietf.org/doc/html/rfc8827) |
| App | FROST/DKG on the MLS exporter, [#134](https://github.com/free2z/zuu/issues/134) payload structure, CertEq echo broadcast | [FROST](https://eprint.iacr.org/2020/852.pdf), [bip-frost-dkg](https://github.com/BlockstreamResearch/bip-frost-dkg) |

Each layer is independently replaceable. The security of layer 2 does not depend
on layers 3 or 4 being honest, which is what lets us push ciphertext through
relays we do not trust as a censorship-resistance measure.

```
   ┌──────────────────────────────────────────────────────────────┐
   │ App: chat UI · FROST/DKG ceremony · future apps              │
   ├──────────────────────────────────────────────────────────────┤
   │ Application framing: hash-linked DAG, retention class,       │
   │ receipts, gap requests            (§7, transport-independent)│
   ├──────────────────────────────────────────────────────────────┤
   │ MLS (RFC 9420): FS, PCS, epochs, membership, exporter  (§5)  │
   ├───────────────────────────┬──────────────────────────────────┤
   │ Delivery service (§6)     │ P2P (§10)                        │
   │ opaque queues, del-on-ack │ WebRTC, fingerprints from MLS    │
   ├───────────────────────────┴──────────────────────────────────┤
   │ Identity + key transparency directory (§4, §9)               │
   └──────────────────────────────────────────────────────────────┘
```

### 3.1 MLS implementation choice

**Recommended: [OpenMLS](https://github.com/openmls/openmls)** (Rust,
permissively licensed, interop-tested against other MLS stacks), with the
X-Wing hybrid ciphersuite built on Cryspen's
[libcrux](https://cryspen.com/post/pq-openmls/) formally verified ML-KEM/X25519.
One Rust crypto core, compiled natively for ZUULI and to WASM for the web
client — no second implementation, therefore no implementation-divergence class
of bug ([ADR 0001](./decisions/0001-platform-priority.md)).

Alternatives considered: **mls-rs** (AWS) — good WASM story and conformance
validation, but per #305 no published third-party security audit;
**ts-mls** — would mean a second implementation, rejected on divergence grounds;
**Marmot MDK** — audited by Least Authority and the closest existing system, but
tightly coupled to Nostr transport, which conflicts with delete-on-ack (§6.7).
We should study MDK closely and reuse its lessons without adopting its transport
coupling.

**Audit status — established, and it is why the version floor exists.** OpenMLS
received an independent security assessment by SRLabs, sponsored by the Sovereign
Tech Agency, published
[2026-05-27](https://blog.openmls.tech/posts/2026-05-27-independent-audit/).
Eight findings, one of them **High severity — "improper authentication of
MACs."** The High finding and all but one of the rest are fixed in **0.8.1** (and
0.7.3 on the previous line).

**Floor: `openmls >= 0.8.1`.** Any earlier version contains a High-severity
authentication defect and MUST NOT be shipped. One Low-severity finding was still
open at publication; **review its status before release** rather than assuming the
audit closed everything. Note also that the version floor interacts with the
crypto provider: `openmls_rust_crypto` does not implement X-Wing, so the PQ
ciphersuite (§5.2) requires the libcrux provider.

This closes §13-A. It does not remove the case for our own review — an audit of
the library is not an audit of how we use it — but it does mean "widely used" has
been replaced by a published assessment with a named auditor and a fixed version.

## 4. Identity and the key hierarchy

### 4.1 Principles

- **Domain separation everywhere.** Every derivation is a keyed hash with a
  distinct, versioned label. No key is ever used for two purposes.
- **Never reuse Zcash spending or viewing keys as messaging keys.**
  Non-negotiable ([ADR 0006](./decisions/0006-zcash-coupling.md)). Different
  curves (Jubjub/Pallas vs. X25519/Ed25519) and, more fundamentally, key
  separation is bedrock. We derive a *distinct* messaging seed from the master
  seed and generate messaging keys from that.
- **Identity is restorable from the mnemonic; device keys are not.** Identity
  keys are seed-derived so that restoring the wallet restores the identity.
  Device keys are generated by the device's CSPRNG, never leave the device, and
  are *not* derivable from the seed — so seed compromise does not retroactively
  yield every device's MLS state.
- **Non-repudiation and deniable-style authentication never share a key.**
  Per [#305 §3.3](https://github.com/free2z/zuu/issues/305), ceremony payloads
  are deliberately signed and attributable; conversational authentication is a
  different key context. (This buys blast-radius separation and clean
  semantics; it does not buy deniability — see §5.6.)

### 4.2 Derivation (proposed)

Written in ZIP 32's idiom — BLAKE2b-512 with a 16-byte personalization,
`(I_L, I_R) = (key, chain code)`, hardened indices only — because ZUULI already
implements that shape and auditors already know it.
See [ZIP 32](https://zips.z.cash/zip-0032).

```
S                     = BIP-39 seed (the wallet mnemonic the user already backs up)

MSK  = (msk, cc_msk)  = BLAKE2b-512(personal = "Free2zMsg_MSTRv1", S)
                        ── one-way. S is not recoverable from MSK.
                        ── rooted in its own personalization, so this tree
                           cannot collide with the Sapling ("ZcashIP32Sapling")
                           or Orchard key trees even at identical indices.

CKDh(node, i)         = BLAKE2b-512(personal = "Free2zMsg_CKDv1_",
                                    cc_node || 0x11 || I2LEOSP32(i))
                        ── hardened only; there is no non-hardened variant and
                           no extended public key at any level of this tree.

account_node          = CKDh(CKDh(CKDh(MSK, 32'), 133'), account')
                           purpose' = 32'   (ZIP 32 idiom)
                           coin'    = 133'  (SLIP-44 Zcash)
```

From `account_node`, every leaf is an HKDF-SHA256 expansion under a distinct
versioned label (`HKDF-Expand(PRK = ik_account, info = label, L)`):

| Key | Label | Type | Lifetime |
|---|---|---|---|
| `IdentitySigningKey` (ISK) | `free2z/msg/v1/identity-sig` | Ed25519 | Long-term. Signs device credentials and directory entries. **Never signs message content.** |
| `CeremonySigningKey` (CSK) | `free2z/msg/v1/ceremony-sig` | Ed25519 | Long-term. Signs **only** FROST/DKG payloads (§11). Deliberately non-repudiable. |
| `DirectoryAuthKey` | `free2z/msg/v1/directory-auth` | Ed25519 | Long-term. Authenticates directory updates and self-audit queries. |
| `BackupWrapKey` | `free2z/msg/v1/backup-wrap` | 32 B | Long-term. Wraps local encrypted history so it survives reinstall on the same seed. |

Per-device, generated on-device from the OS CSPRNG, never seed-derived, never
exported:

| Key | Type | Notes |
|---|---|---|
| `DeviceSignatureKey` (DSK) | Ed25519 | The MLS leaf `signature_key` (RFC 9420 §7.2). |
| `DeviceInitKey` / KeyPackage keys | X-Wing hybrid (X25519 + ML-KEM-768) | HPKE init key and leaf `encryption_key`. |
| `QueueKey_{q}` | Ed25519, one per queue | Authorizes send or receive on one relay queue (§6.2). |

A **device credential** binds the two levels:

```
DeviceCredential = {
  type:        "free2z/device-credential/v1",
  identity_pk: ISK.public,
  handle:      "@alice",
  device_pk:   DSK.public,
  device_kem_pk: DeviceInitKey.public,
  not_before, not_after,
  signature:   Sign(ISK, canonical(everything above))
}
```

This is carried as the MLS `Credential` in the member's `LeafNode`, so **every
MLS peer validates the identity→device binding as part of ordinary MLS
processing.** Revocation is an explicit signed `DeviceRevocation` published to
the key-transparency log and mirrored by an MLS `Remove` proposal in every group
the device is in.

> Adding a device to an account is a wiretap. Device registration and revocation
> are designed now ([ADR 0002](./decisions/0002-multi-device.md)) and shipped
> later, and when they ship they are security-critical: every registration must
> be surfaced to every other device of the account and to the key-transparency
> log, so it cannot happen silently.

### 4.3 What is derived from what — summary

```
mnemonic ──► S ──► Sapling / Orchard trees            (wallet; never touched here)
              └──► MSK ──► account_node ──► ISK, CSK, DirectoryAuthKey, BackupWrapKey
                                              │
                                              └─ signs ─► DeviceCredential
                                                             ▲
                     OS CSPRNG ──► DSK, DeviceInitKey, QueueKeys (per device)
                                                             │
                                                MLS LeafNode ┘
                                                      │
                                     MLS key schedule ▼ (RFC 9420 §8)
                        epoch_secret ──► encryption_secret, sender_data_secret,
                                          exporter_secret, epoch_authenticator, …
                                                      │
                                MLS-Exporter(label, ctx, L) ──► §5.4 app secrets
```

## 5. Session cryptography — MLS

One MLS group per conversation or room, 1:1 included. MLS
([RFC 9420](https://datatracker.ietf.org/doc/html/rfc9420)) is chosen because it
is the only IETF-standard construction that gives forward secrecy **and**
post-compromise security at group scale with O(log N) rekeying, has multiple
interop-tested implementations, and — decisively for us — has a standardized
exporter for handing application protocols epoch-bound key material (§5.4).

### 5.1 Membership and epochs

Membership changes (Add / Remove / Update) are Proposals committed into a new
epoch. Every member independently validates the Commit against the
`GroupContext`, so the delivery service cannot add or remove a member. The
server relays Commits; it cannot author them.

**Forward secrecy:** a member added in epoch *n* cannot derive keys for epoch
*n−1*. A member who joins on Tuesday cannot read Monday's traffic through the
protocol. This is correct and occasionally infuriating, and the product must say
so plainly rather than paper over it; history transfer to a *new device of an
existing member* is a separate, explicitly-designed mechanism (§13-D), not an
accident of the crypto.

**Post-compromise security:** a member who Updates their leaf key heals the
group's secrets against an adversary who previously extracted that member's
state, provided the adversary is passive after the Update. Clients issue an
Update on a schedule and on every app foreground.

### 5.2 Ciphersuite

Baseline hybrid post-quantum from day one: X25519 + ML-KEM-768 via
**X-Wing** ([draft-connolly-cfrg-xwing-kem](https://datatracker.ietf.org/doc/draft-connolly-cfrg-xwing-kem/)),
AES-128-GCM (or ChaCha20-Poly1305 where AES is not hardware-accelerated),
SHA-256, Ed25519 signatures.

We adopt hybrid PQ now rather than retrofitting, because harvest-now-decrypt-
later is a live threat against long-lived conversations and because retrofitting
a ciphersuite across a federation is far harder than starting with one.

> **Open question (§13-B):** the MLS PQ ciphersuite codepoint registration is
> still in flight. We must pin an exact ciphersuite identifier and a migration
> path before Phase 2, and be prepared for the registered value to differ from
> whatever OpenMLS ships today.

### 5.3 Framing

All application payloads travel as MLS `PrivateMessage` (RFC 9420 §6.3), which
encrypts the content, the sender's leaf index and the content type under the
epoch's `encryption_secret` and `sender_data_secret`. The relay sees an opaque
blob and a queue address, nothing more.

### 5.4 Exporter-derived application secrets

Per RFC 9420 §8.5,
`MLS-Exporter(Label, Context, Length)` yields forward-secret, epoch-bound key
material bound to the group state. The Safe Extension API in
[draft-ietf-mls-extensions](https://www.ietf.org/archive/id/draft-ietf-mls-extensions-04.html)
is the mechanism we intend to use for component-scoped exports as it stabilizes.

| Consumer | Label | Context | Use |
|---|---|---|---|
| FROST/DKG (§11) | `free2z/frost/v1` | `ceremony_id` | Session domain separator, transcript binding, outer AEAD for part-2 shares |
| WebRTC binding (§10) | `free2z/webrtc/v1` | `session_id` | Binds DTLS fingerprints to the group |
| Queue rotation (§6.2) | `free2z/queue/v1` | `peer_leaf_index` | Derives the next queue **signing keys** and the rotation schedule — see the correction below |
| Local history wrap | `free2z/history/v1` | `conversation_id` | At-rest key for retained plaintext |

Because these are exporter outputs, they inherit the group's forward secrecy and
are automatically bound to the exact membership of the epoch — which is
precisely the "confidential, authenticated, replay-bound channel between an
agreed participant list" that
[#132](https://github.com/free2z/zuu/issues/132) requires, obtained from a
standard instead of invented.

> **Correction (2026-08-23).** An earlier revision of the table above said the
> queue exporter *"derives the next queue addresses without a round trip."* That
> is no longer accurate and should not be read as though it were.
> [ADR 0009](./decisions/0009-queue-addressing-and-binding.md) has the **relay**
> generate both queue addresses from its own CSPRNG, because client-chosen
> addresses permit squatting and collisions. The exporter therefore derives the
> rotation *schedule* and the next queue *signing keys*; the new address comes
> back from the relay and still has to reach the peer in an in-band advert. **A
> rotation costs one relay round trip and one in-band message** —
> [`WIRE.md` §7.5](./WIRE.md#75-rotation-needs-no-new-command).

### 5.5 What hybrid PQ does and does not buy

- **Does:** confidentiality against an adversary that records ciphertext today
  and gains a cryptographically relevant quantum computer later. The KEM is
  hybrid, so it is no weaker than X25519 alone even if ML-KEM is broken
  classically.
- **Does not:** post-quantum *authentication*. MLS signatures are Ed25519, our
  identity, device and ceremony signatures are Ed25519, and the KT log is signed
  with Ed25519. An adversary with a quantum computer *at the time of the attack*
  could forge them. This is an accepted, stated limitation; migrating signatures
  (e.g. to ML-DSA) is future work and is listed in §13-C.

### 5.6 Deniability — stated, not claimed

MLS `PrivateMessage` carries a signature by the sender's leaf key over the
framed content. **Therefore MLS as specified does not provide cryptographic
deniability for conversational messages, and we do not claim it.** A recipient
who preserves the ciphertext, the epoch secrets and the sender's leaf credential
holds attributable evidence.

What we *do* provide is strict key-context separation
([#305 §3.3](https://github.com/free2z/zuu/issues/305)): `CeremonySigningKey`
signs ceremony payloads and nothing else; `DeviceSignatureKey` signs MLS framing
and nothing else; `IdentitySigningKey` signs credentials and directory entries
and nothing else. A FROST transcript can never be replayed as chat evidence and
vice versa. See also
[Real-World Deniability in Messaging](https://petsymposium.org/popets/2025/popets-2025-0018.pdf)
for why the practical value of deniability is contested; our position is to be
honest about not having it rather than to imply it.

## 6. Delivery service

The delivery service is a **separate, small, efficient Rust process**, not a
Django app ([ADR 0005](./decisions/0005-federation.md)). Concurrent WebSocket
connections, not bandwidth, are the cost driver, and the Django Channels stack
is dramatically less efficient per connection than a Rust service.

Its design follows SimpleX's SMP: pairwise, unidirectional, opaque queues with
no user identifiers anywhere. We adopt the *protocol design*; the implementation
is clean-room.

> **§13-E, closed 2026-08-23.** The licence was verified from published
> repository metadata only, without reading any source file: `simplex-chat/simplexmq`
> — the reference SMP server — is **AGPL-3.0**. The binding rule and the full
> clean-room posture are recorded in
> [`WIRE.md` §15](./WIRE.md#15-clean-room-posture-toward-simplex--blocking-pre-check-resolved):
> **nobody on this project reads `simplexmq` source**; the design derives solely
> from the public protocol description.

The relay's wire protocol — transport, framing, canonical serialization, the
command set, the signing transcript, anti-replay, queue lifecycle, ACK semantics,
TTLs, padding enforcement, error codes, the capability document, first contact and
anti-abuse — is specified in [`WIRE.md`](./WIRE.md). Where that document narrows
or corrects something below, it says so at the point of use.

### 6.1 What the relay is

A relay accepts ciphertext against a queue address, holds it until the reader of
that queue acknowledges it, then deletes it. It has no accounts, no user
identifiers, no contact lists, no group state, and no ability to enumerate who
talks to whom by asking itself. It is a buffer, not an archive.

Steady-state stored ciphertext at 1,000 DAU is on the order of **4 MB** — only
what is currently undelivered. That is the entire point of delete-on-ack, and it
is also the economic precondition for the federation
([ADR 0005](./decisions/0005-federation.md)).

### 6.2 Queues

For every ordered pair (sender device → recipient device) there is a
unidirectional queue with **two distinct addresses**:

```
QueueSendAddr  — presented by the sender; authorizes APPEND only
QueueRecvAddr  — presented by the recipient; authorizes READ, ACK and DELETE
```

Each address is an opaque random identifier bound to an Ed25519 `QueueKey` at
creation. Every relay command is signed with the relevant queue key. The relay
verifies the signature against the key registered for that address and learns
nothing else — no account, no handle, no identity key.

**The two addresses are not unlinkable at the relay, and we do not claim they
are.** An APPEND to `QueueSendAddr` has to be delivered into the message list
read from `QueueRecvAddr`, so the relay necessarily holds that mapping — it is
what makes delivery work. An operator who dumps the queue table pairs the two
ends of every queue it hosts, directly and without any traffic analysis.
SimpleX's SMP does not achieve this property either.

What the split does buy is real, and it is capability separation rather than
unlinkability:

- **A sender cannot read, ACK or delete.** The append capability is strictly
  weaker than the read capability and there is no way to escalate one into the
  other. A sender learns nothing about what is queued or whether it was taken.
- **A compromised sender-side key cannot drain the queue.** Whoever holds a
  `QueueSendAddr` and its key — including someone who seizes the sending device
  — can write, but cannot recover a single undelivered message.
- **An observer of the relay's front door cannot pair addresses from traffic
  alone.** The two addresses are unrelated on the wire, so an attacker who sees
  connections and commands but not the relay's internal state is reduced to
  timing correlation.

Only the third of these survives against a relay operator with database access,
and against that adversary it fails completely. See
[`THREAT-MODEL.md` §3.3](./THREAT-MODEL.md#33-compromised-relay-operator-third-party-or-ours)
and [§4.9](./THREAT-MODEL.md#49-the-relay-knows-which-queue-addresses-are-paired).

Queue addresses are established **inside** the MLS group — a member advertises
its `QueueSendAddr` set to peers in an authenticated application message, never
via the server. Addresses rotate on a schedule using the
`free2z/queue/v1` exporter so a long-lived relationship does not present a
long-lived identifier.

> **This paragraph is circular for a pair that has never spoken**, and the gap is
> real rather than a detail: there is no path for the `Welcome` that creates the
> group in the first place, because the recipient has no queue the sender is
> authorized to write to.
> [ADR 0011](./decisions/0011-first-contact-contact-queues.md) and
> [`WIRE.md` §12](./WIRE.md#12-first-contact) close it with a hard-capped
> **contact queue** whose send side is never bound and whose address is published
> in the owner's directory entry — together with the honest limits on what its
> anti-abuse actually buys.

**Fan-out (D2):** a message to a recipient with *d* registered devices is sent
to *d* queues, one per device, as *d* independently encrypted MLS messages
(each device is its own MLS leaf). Group messages to a group with *m* member
devices go to *m* queues. The relay never learns that *d* queues belong to one
person.

### 6.3 What "delivered" means

Four distinct states, deliberately separated. Conflating them is how
delete-on-ack loses messages.

| State | Who observes it | Meaning |
|---|---|---|
| `accepted` | sender ↔ relay | The relay returned OK for an APPEND to queue *q*. Says nothing about the recipient. |
| `queue-delivered` | reader ↔ relay | The reader of *q* has **durably written the ciphertext to local storage** and then sent a signed ACK for that queue index. The relay deletes the ciphertext at this instant. |
| `device-delivered` | end-to-end | The recipient device emitted an authenticated `DeliveryReceipt` **inside the MLS group**, referencing the message by `msg_id`. |
| `delivered` (the D2 definition) | sender, application layer | A `device-delivered` receipt has been received from **every device in the recipient's device set as of the epoch in which the message was sent**. |

Three properties follow, and each is deliberate:

1. **The relay implements only `queue-delivered`.** Its deletion rule is
   per-queue and unconditional: ACK arrives → delete. It has no cross-queue
   state, because cross-queue state would mean knowing the device set, which
   would mean knowing the recipient. There is no "all devices delivered" concept
   on the server, by design.
2. **A device MUST NOT ACK before its durable write completes.** ACK-on-read
   plus a crash equals permanent loss, because the relay has already deleted the
   only copy. This is a MUST in the client, and it is the single most
   safety-critical rule in the delivery layer.
3. **`delivered` is computed by the sender end-to-end**, from receipts that are
   themselves MLS application messages. The relay cannot forge, suppress
   undetectably (§7), or observe it.

Undelivered ciphertext has a **TTL ceiling** (30 days) after which the relay
drops it and the sender learns only from the continued absence of a receipt.
Quota and TTL are relay policy and are published in the relay's capability
document so clients can choose. The wire-level rules — a per-queue message TTL
clamped to that 30-day ceiling, a **queue idle TTL** that the merged docs did not
have and without which the queue table grows without bound, and the exact ACK
semantics that make delete-on-ack safe — are
[`WIRE.md` §7.7](./WIRE.md#77-ttls) and [§8](./WIRE.md#8-ack-semantics).

### 6.4 Delete-on-ack and lost acknowledgements

[#131](https://github.com/free2z/zuu/issues/131) makes the point precisely: a
dropped connection tells you nothing about what arrived. Delete-on-ack sharpens
it — a lost ACK now means a permanently lost message, because the relay's copy
is gone or was never taken.

This is why §7's hash-linked DAG is not optional. It is the mechanism that turns
"a message vanished" from an undetectable event into a detected gap with a
defined repair path.

### 6.5 Padding

Ciphertext is padded to fixed-size buckets before it reaches the relay
(proposed: 1 KiB / 4 KiB / 16 KiB / 64 KiB, then chunked into 64 KiB units).
The relay **rejects** non-conforming sizes, so a client cannot leak length by
being sloppy and a malicious client cannot use length as a covert channel to a
colluding relay. Real text is ~100 bytes; the padding dominates, which is the
intent.

> **Open question (§13-F):** bucket sizes need a traffic study. The values above
> are placeholders chosen for arithmetic convenience, not measurement. Because of
> that, [`WIRE.md` §9](./WIRE.md#9-padding-enforcement) puts the accepted size set
> in the relay's **capability document** rather than in the protocol, so that
> adopting the measured answer is an operator config change rather than a
> federation-wide flag day — and states plainly that the relay's list is a filter,
> not the source of truth: the property comes from the client padding to its own
> set before the ciphertext leaves the device.

### 6.6 Delivery receipts

Receipt timing is a **published deanonymization vector** against sealed sender
([No safety in numbers](https://arxiv.org/pdf/2305.09799)) — sealed-sender group
membership has been recovered from receipt patterns alone. Our position:

- Receipts are **on by default, batched and jittered** (proposed: flushed on a
  randomized interval rather than immediately on arrival).
- Receipts are **disableable per conversation**, and the UI states the trade-off
  (disabling costs you the ability to know a message landed, which under
  delete-on-ack matters more than in a retaining messenger).
- **Read receipts are separate from delivery receipts** and default off.

### 6.7 Nostr as fallback transport

Nostr relays are useful as a redundant, censorship-resistant path, and MLS's
security does not depend on the relay being honest, so pushing ciphertext
through relays we do not control costs no confidentiality.

But Nostr relays are **retain-by-default**. NIP-40 expiration is advisory; a
relay is free to ignore it, and we cannot verify deletion on infrastructure we
do not run. **Therefore Nostr cannot satisfy goal 2 and is not our primary
transport.** It is an opt-in fallback, per conversation, and the UI must state
that choosing it means accepting that ciphertext may be retained indefinitely by
third parties. Delete-on-ack is a property of relay software we specify.

## 7. Application framing — hash-linked causal ordering

Per [#131](https://github.com/free2z/zuu/issues/131) and
[#134](https://github.com/free2z/zuu/issues/134)'s structural approach, every
application payload carries hashes of its predecessors. This single choice makes
ordering and gap detection **transport-independent**: it works identically
whether a message arrived over the relay, over WebRTC, or over Nostr, so the
transports can interleave freely without a sequencing authority.

```
AppMessage = {
  type:            "chat" | "receipt" | "gap_request" | "gap_response"
                 | "ceremony" | "queue_advert" | "webrtc_offer" | ...,
  msg_id:          BLAKE2b-256("free2z/msg/v1/msgid" || canonical(rest)),
  parents:         [msg_id, ...],   // every message this sender had delivered
                                    // and not yet referenced, at send time
  epoch:           uint64,          // MLS epoch
  sent_at:         uint64,          // sender-claimed; ADVISORY ONLY, never
                                    // used for ordering or security decisions
  retention_class: CHAT | CEREMONY, // §8
  body:            opaque
}
```

Wrapped in an MLS `PrivateMessage`, so it is confidential and authenticated by
the sender's leaf key without any additional signature for `CHAT` payloads.
`CEREMONY` payloads carry their own signature *in addition* (§11) — that is
deliberate belt-and-braces, not redundancy.

- **Causal ordering:** the DAG's partial order. For display, a deterministic
  total order breaks ties by `(epoch, sender_leaf_index, msg_id)`. Wall-clock
  timestamps are never used to order, because a clock is an attacker-controlled
  input.
- **Gap detection:** a receiver that sees a `parents` hash it does not hold
  knows, with certainty and without any server assistance, that it is missing a
  message. It emits `gap_request{hashes}` to the sender over any available
  transport.
- **Repair:** the sender re-encrypts the original plaintext under the *current*
  epoch and replies `gap_response`. It does not replay old ciphertext, so repair
  does not undermine forward secrecy. This requires the sender to hold a
  bounded-window plaintext outbox, which interacts with retention (§8.4).
- **What hash links do NOT detect: tail truncation.** If a relay drops the last
  *k* messages from a sender and no later message arrives, there is no dangling
  parent to notice. Detecting suppression of the tail requires liveness signals
  — periodic authenticated heartbeats carrying the sender's current DAG head —
  and even then, an adversary that partitions a peer entirely is
  indistinguishable from that peer being offline. Stated in
  [`THREAT-MODEL.md`](./THREAT-MODEL.md); no protocol fixes this.

## 8. Retention (D3)

[ADR 0007](./decisions/0007-retention-per-user.md), which supersedes
[ADR 0003](./decisions/0003-history-retention.md). This section governs
**client-side** retention only.

**The one retention property that is a security claim** is the server-side one,
and it is unchanged: in every mode, the relay holds nothing after acknowledged
delivery. That is goal 2, it is not adjustable per conversation, and it is
remotely auditable rather than verifiable
([`THREAT-MODEL.md` §4.5](./THREAT-MODEL.md#45-server-side-deletion-is-auditable-not-verifiable)).
Everything else in §8 is local policy and courtesy signalling, and is labeled as
such.

### 8.1 Retention is a per-user local choice

**Each user decides how long their own device keeps its own copy.** One
participant keeps five minutes; another keeps forever. Both are legitimate, and
neither constrains the other. There is no shared retention state, no group-wide
setting, and nothing in the protocol that makes one member's preference bind
another member's disk.

An earlier revision of this document specified the opposite: retention as a
`GroupContext` retention extension (RFC 9420 §12.4), listed in
`required_capabilities`, changed by a two-phase `RetentionChangeProposal` /
`RetentionChangeAck` unanimity negotiation. **That design was withdrawn because
it does not deliver the property it appears to deliver.** Once a recipient
legitimately holds plaintext, nothing in the protocol constrains what their
device does with it — a modified client advertises whatever capabilities it
likes, joins the group, honors nothing, and retains everything. The machinery
bought group-state complexity and a join-time exclusion rule in exchange for a
guarantee that a recompiled binary defeats. It is client-trust theater and it is
gone.

### 8.2 The ephemeral hint is a courtesy signal, not a control

A conversation may carry an **ephemeral hint**: a requested mode and TTL, sent as
an MLS application message.

```
ephemeral_hint = {
  mode:        EPHEMERAL | RETAINED,   // requested, not imposed
  ttl_seconds: uint32,                 // EPHEMERAL only; from local receipt
  sent_in_epoch: uint64,
}
```

Because it travels inside MLS it is confidential, **authenticated and
attributable**: nobody can forge "Azhr asked for this to be ephemeral," and every
member sees who asked and in which epoch. That much is real cryptography.

What it is not is enforcement. Conforming clients honor a hint by default and
expire local plaintext at the requested TTL. **A non-conforming client simply
ignores it, and no mechanism exists — or can exist — to detect that.** The hint
is a courtesy feature in exactly the class of Signal's and WhatsApp's
disappearing messages: it defends against casual persistence, against a message
lingering on a screen, and against device seizure after the TTL, on devices whose
owners are not adversaries. Those are worth having, and none of them is a defense
against the counterparty.

**Therefore the hint MUST NOT appear in any security claims table** — not here,
and not in
[`THREAT-MODEL.md` §5](./THREAT-MODEL.md#5-summary-what-we-claim-precisely).
UI copy that implies a hint is enforced against a determined counterparty is a
defect.

**The knock-on, stated plainly.** Dropping the retention extension also drops
`required_capabilities`, and with it the only join-time mechanism that excluded a
client which would silently ignore an ephemeral setting. **Nothing replaces it.**
Any client that speaks MLS and our application framing can join a conversation,
and whether it honors hints is unobservable from outside. We accept this because
the exclusion never worked — a client that lies about its capabilities passed the
check anyway — but the change is a real reduction in what the group can assert
about who is in it, and it should be read as one.

### 8.3 Purge requests, and why nothing here is retroactive

Clearly labeled a **request, not a guarantee**, a member may send
`PurgeRequest{before_epoch}`. Conforming clients delete local history before that
epoch and reply `PurgeAck`. The UI must say "asked N participants to delete; M
confirmed," never "deleted."

`PurgeRequest` survives the change to §8.1 **unchanged**, because it was always
correctly labeled: it never claimed to compel anyone, so nothing about it was
theater.

A purge is a request precisely because deletion cannot reach backwards, and the
same asymmetry governs everything else in this section. A user changing their own
local setting, and a hint arriving mid-conversation, both apply **forward only**:

- **Retaining → ephemeral cannot be retroactive**, because retroactive deletion
  is unenforceable across other people's devices. A member may have been offline,
  may have exported, may have screenshotted.
- **Ephemeral → retaining cannot be retroactive**, because the data is already
  gone. There is nothing to retain.

### 8.4 Short local retention and gap repair

A short local TTL shortens the plaintext outbox window used for gap repair (§7),
which means some detected gaps become unrecoverable. That is surfaced to the user
as an explicit "this message could not be recovered" marker rather than a silent
hole. Because retention is now per user, this trade-off is made by the person who
chose the short TTL and lands on their own conversation view.

### 8.5 Ceremony transcripts are retained by default

Messages with `retention_class = CEREMONY` are **retained by default**, and the
reason is not protocol compulsion — it is that the participant wants the
evidence. A DKG transcript is what lets them later prove the ceremony ran
correctly and who said what. Discarding it is discarding your own proof.

Under the per-user model this needs no exemption machinery: a default plus a
clear explanation before the ceremony begins, so consent is informed. A
participant who deletes their own transcript anyway has only reduced what they
themselves can later demonstrate. Transcripts are stored under the
`free2z/history/v1` local wrap key like everything else.

## 9. Identity directory, key transparency, and federation

### 9.1 The problem this solves

[#133](https://github.com/free2z/zuu/issues/133): the server today decides who
you are connected to. Any directory that maps `@handle → identity key` and is
trusted blindly reintroduces exactly that MITM, one level up. Encrypting
perfectly to the wrong key is not security.

### 9.2 The directory

A CONIKS / SEEMless / Parakeet-lineage **append-only log** of
`(handle → IdentitySigningKey.public, epoch, DeviceCredential set)`, with:

- **Inclusion proofs** for a queried handle, so a lookup is verifiable.
- **Privacy-preserving lookups** (SEEMless/Parakeet-style) so a lookup does not
  reveal the rest of the directory and unqueried entries stay private.
- **Consistency proofs** between successive epoch roots
  ([RFC 6962](https://datatracker.ietf.org/doc/html/rfc6962)-style), so a client
  can verify the log is append-only across every root it has ever seen. — **This
  bullet is wrong as written; see the correction below.**
- **Self-audit:** every client monitors its own handle each epoch and raises a
  loud, non-dismissible alarm on any key change it did not initiate. This is
  what makes an attempted MITM *detectable by the victim*, which is the whole
  point.
- **Key rotation rules** —
  [ADR 0014](./decisions/0014-directory-key-rotation.md): a same-key entry is
  self-signed; a key *change* requires both a rotation proof signed by the
  outgoing key and a signature by the new key; a *lost* key requires a
  platform-authority reset that raises a **non-dismissible** peer alarm and
  applies a multi-day cooldown during which clients keep using the old key. That
  reset is a real weakening — platform-assisted recovery is indistinguishable
  from platform-assisted attack — and announcing it loudly is the entire
  mitigation.
- **Manual safety-number verification** remains available and is the strongest
  check; ZUULI additionally offers verification over a shielded Zcash memo
  between two users who already know each other's payment address — an
  authenticated, private, *remote* out-of-band channel, which is genuinely
  unusual (see [ADR 0006](./decisions/0006-zcash-coupling.md)).

> **Correction (2026-08-23) — the consistency-proof bullet above overpromises,
> and a client cannot do what it says.** The claim that a client "can verify the
> log is append-only across every root it has ever seen" is **false**, and it is
> left standing above rather than edited away so that an auditor can see exactly
> what was claimed and what replaced it. It is false for the construction this
> section specifies, and for the implementation
> [ADR 0013](./decisions/0013-key-transparency-log.md) adopts. `akd`'s
> `AppendOnlyProof` carries every node inserted between the two roots plus its
> sibling path, so it is **O(entries added), not O(log n)** as an RFC 6962
> consistency proof would be — measured by
> [#544](https://github.com/free2z/zuu/issues/544) at **3.9 MB and 1–3 seconds
> for five epochs** on a 100,000-entry directory. A phone on cellular data cannot
> verify consistency across every root it has seen, and no amount of engineering
> makes it able to. This is the price of the privacy property in the second
> bullet, not a defect: the tree is a sparse Patricia tree keyed by VRF output
> rather than a chronological Merkle tree, and the cheap consistency proof is
> exactly what is given up to get privacy-preserving lookups.
>
> **The architecture is unaffected.** §9.3 already assigns append-only
> verification to **witnesses**, which are native daemons polling over outbound
> HTTPS and have all day. What each party can actually verify is:
>
> | Party | Can verify |
> |---|---|
> | **Client** | Inclusion for a queried handle (`lookup_verify`, ~1.1 ms in WASM) and its own key history (`key_history_verify`, ~2.6 ms), **against a root it has checked is signed by the log and cosigned by *t* of its own configured witnesses**. Non-membership, so "no such handle" is proved rather than asserted. |
> | **Witness** | Append-only consistency between consecutive roots — **the reason the role exists.** |
>
> **The consequence, stated plainly because the text above under-states it: a
> client cannot substitute its own consistency check for a witness's.** There is
> no cheap check for it to run, so there is no fallback if the witness set is
> absent, unreachable, or not independent. Read that together with §9.3's
> statement that witnesses free2z operates are not independent witnesses, and the
> honest position at launch is that **nothing establishes append-only-ness to a
> client except client gossip and manual safety-number verification.** The
> witness set is more load-bearing than the merged text implies, not less, and
> recruiting independent witnesses is correspondingly more urgent.
>
> [`KT.md` §8.3](./KT.md#83-the-threshold-rule-and-failing-closed) specifies the
> threshold rule and the fail-closed behaviour this forces, and
> [`KT.md` §8.5](./KT.md#85-what-a-client-cannot-verify) restates the limit at
> the point of use.

> **The log construction is now specified.** The `SignedTreeHead` format, the
> epoch cadence and maximum merge delay, the proof encodings, the full
> `DirectoryEntry` structure, the witness poll-verify-cosign protocol and the
> cosignature format are in [`KT.md`](./KT.md), with
> [ADR 0013](./decisions/0013-key-transparency-log.md) recording the choice of
> construction. Both were blocked on spike
> [#544](https://github.com/free2z/zuu/issues/544) and landed on 2026-08-23 when
> it closed.

### 9.3 Anti-equivocation without a blockchain

The residual attack on any KT log is **equivocation**: showing different
directories to different users. The fix is Certificate Transparency's, not a
chain's:

- **Witness cosigning.** A witness observes the KT log root for each epoch,
  **verifies the append-only proof from the previous root it cosigned**, and
  signs what it saw. A client accepts a root only if it carries at least *t*
  cosignatures from its own configured witness set. Two conflicting signed roots
  for the same epoch are **non-repudiable cryptographic evidence of
  misbehavior**, publishable by anyone. The append-only check is not an optional
  extra: a witness that cosigns without performing it attests only that the log
  signed something, which the log's own signature already proves, so such a
  witness is worthless while looking exactly like a working one
  ([`KT.md` §7.4](./KT.md#74-a-witness-that-does-not-verify-the-append-only-proof-is-worthless)).
- **Client gossip.** Clients cross-check roots with each other over the
  messaging channel itself — CONIKS's original design, and free because we
  already have an authenticated channel.

**Witness and relay are separate roles.** An operator MAY run both, and we
expect some will, but the protocol does not couple them and neither should the
volunteer ask. A witness:

- needs **no inbound port** — it polls the log over outbound HTTPS,
- needs **no TLS certificate, no domain and no public IP**, for the same reason,
- needs **no database** — its entire state is the last root it signed, a few
  hundred bytes in a file,
- needs no ciphertext, no queue storage, no uptime commitment beyond "checks in
  often enough," and holds nothing whose loss or seizure harms a user.

A relay, by contrast, is a public network service with storage, an inbound
listener, TLS termination and a durability obligation. Requiring a witness to
also be a relay would multiply the cost, the operational risk and the legal
exposure of volunteering, for no gain in the property being bought — and the
number of independent witnesses is precisely what makes that property real.

The property strengthens as the *witness set* grows, independently of the number
of relays, which is why recruiting witnesses is a cheaper path to
anti-equivocation than recruiting relay operators. The multi-relay design we
want for censorship resistance ([ADR 0005](./decisions/0005-federation.md)) is
complementary: both become genuinely meaningful at the same moment, when the
operators are independent of us.

> **Stated plainly:** witnesses we operate are not independent witnesses. Until
> there are at least two run by parties outside free2z, *t* is effectively 0 and
> client gossip is the only anti-equivocation that exists. The UI must say so
> rather than display a reassuring witness count.

**No blockchain in the critical path** ([ADR 0006](./decisions/0006-zcash-coupling.md)).
On-chain checkpointing buys nothing that witness cosigning does not, and costs a
hard dependency plus exposure to ZEC price volatility. For the record: at
[ZIP 317](https://zips.z.cash/zip-0317)'s 10,000-zatoshi minimum shielded fee and
ZEC ≈ $517 (Aug 2026), a checkpoint costs ~$0.052 — cheap, but cheap is not the
argument. It may exist later as an opt-in highest-assurance tier.

### 9.4 Relay trust model

Clients treat relays as **untrusted, replaceable infrastructure.**

| A relay CAN | A relay CANNOT |
|---|---|
| Refuse service, drop, delay or reorder ciphertext | Read message content |
| Count messages and observe bucketed sizes | Forge or modify a message (MLS auth fails) |
| Observe connection times and source IPs | Add or remove a group member |
| Attempt timing correlation between queues | Learn the handle or identity key behind a queue |
| Retain ciphertext despite claiming not to (unverifiable) | Undetectably suppress a message in the *middle* of a DAG (§7) |
| Suppress the *tail* of a conversation (§7) | Equivocate on the KT log without leaving evidence (§9.3) |

The relay is open source and trivially self-hostable **from the first release**,
not as a later "community edition." A community operator should be able to run
one sustainably on a ~$5/month VPS; that is achievable precisely because
delete-on-ack means there is no archive and pairwise queues mean there is no
public firehose. (~95% of Nostr relays cannot cover their costs, and retain-
everything-serve-a-firehose is why.)

Redundancy: a device may publish queue addresses on *k* relays and senders send
to all *k*; duplicates are deduplicated client-side by `msg_id`. Egress
multiplies by *k*; at *k*=3 this is still trivial. Choosing *k*'s default is
§13-G.

## 10. P2P (WebRTC) — an optimization, not a dependency

Keep WebRTC, invert the trust. Today the signaling server relays SDP containing
DTLS certificate fingerprints, and the client trusts them — which is the MITM in
[#133](https://github.com/free2z/zuu/issues/133).

**New rule: DTLS certificate fingerprints are exchanged and authenticated inside
the MLS group, never trusted from the signaling server.**

1. Each peer generates its DTLS certificate and computes the fingerprint.
2. Each peer sends `webrtc_offer{fingerprint, sdp_digest, session_id}` as an
   MLS application message — confidential and authenticated to the group.
3. SDP may still be relayed by the server for connectivity, but the receiving
   client **verifies that the fingerprint in the received SDP exactly matches
   the one it received inside the MLS group**, and refuses the connection
   otherwise.
4. The session is additionally bound to the group by
   `MLS-Exporter("free2z/webrtc/v1", session_id, 32)`.

A substituted fingerprint now fails authentication rather than going unnoticed.
This makes #133's attack **impossible rather than merely detectable**, and it
demotes P2P to what it should be: a latency and bandwidth optimization that may
fail freely without compromising anything. Application framing (§7) is identical
over P2P and relay, so the two interleave without special cases.

WebRTC still leaks the peer's IP address through ICE candidates. Clients default
to relay-only ICE (TURN) for contacts not explicitly trusted, and the UI states
what enabling direct connections reveals.

## 11. FROST/DKG — the first application

Runs **inside** an MLS group whose membership is exactly the participant list,
using an exporter-derived, epoch-bound secret — while keeping
[#134](https://github.com/free2z/zuu/issues/134)'s signed, session-hash-bound
payload structure as the application payload.

This is deliberate belt-and-braces, and the reasoning matters: MLS provides the
channel, forward secrecy, post-compromise security and ordering; #134's
structure keeps the ceremony **verifiable even if the channel is broken**, which
was the entire point of that proposal. The data structure must remain secure
over "any networking, even unreliable or insecure networking."

### 11.1 Payload structure (from #134, retained)

Including the follow-up refinement in #134's comments: **every signed message
carries the signing participant's public key (`participant_id`) and an explicit
message `type`.** A key signing itself costs nothing and makes ordering and
verification obvious to implement.

```
session = {
  type: "frost/dkg/session/v1",
  participants: [SigningKey, ...],   // CeremonySigningKey publics, ordered
  threshold, max_signers,
  nonce: <32 random bytes>,          // distinguishes runs with same participants
  time,                              // advisory
}
session_hash = H(canonical(session))

part1 = {
  type: "frost/dkg/part1/v1",
  participant_id: <signer's CeremonySigningKey public>,
  session: session_hash,             // identical on every message; anti-replay
  commitment: <FROST round-1 commitment>,
  encryption: <fresh X25519 public key>,   // MUST be fresh per session
  signature: Sign(CSK, canonical(rest)),
}
part1_id = H(all part1 messages, in session participant order)

part2 = {
  type: "frost/dkg/part2/v1",
  participant_id, part1: part1_id,
  shares: [ box(FROST.part2(participants[i]),
                nonce = part1_id,             // deterministic ⇒ unique per pair
                receiver = participants[i].encryption,
                sender   = self.encryption) , ... ],  // session participant order
  signature: Sign(CSK, canonical(whole message including shares)),
}

part3 = {
  type: "frost/dkg/part3/v1",
  participant_id,
  part2: H(all part2 messages, in session participant order),
  shared_public_key: <the FROST group public key>,
  signature: Sign(CSK, canonical(rest)),
}
```

Signatures use `CeremonySigningKey` — a key context that signs ceremony payloads
and nothing else (§4.2, §5.6). Using `part1_id` as the box nonce is
deterministic *and* unique per (session, pair), which is stronger than random
for this purpose because it removes any chance of nonce reuse across a retry.

The MLS exporter secret `MLS-Exporter("free2z/frost/v1", ceremony_id, 32)` is
mixed into the transcript domain separator and used as an outer AEAD context, so
a ceremony transcript from one group can never be replayed into another even if
the participant list and nonce were somehow identical.

### 11.2 Mandatory destruction of the per-session encryption key

#134 requires that each participant **delete their per-session encryption
private key once they have received the part-2 messages.** An attacker who later
obtains that key can decrypt the shares sent to that participant, and an
attacker who obtains enough of them can reconstruct a threshold and forge
signatures. This is a forward-secrecy requirement, and it must be **enforced and
tested, not left to convention**:

- The key lives in a `Zeroizing` wrapper in the Rust core and is owned by the
  ceremony state machine.
- The Part2 → Part3 transition destroys it as part of the transition, not as a
  best-effort cleanup afterwards.
- A test asserts that after the transition, an attempt to decrypt any part-2
  ciphertext fails — i.e. the destruction is observable, not merely intended.
- **Honest limit:** in the WASM/browser client we cannot guarantee zeroization.
  The JavaScript engine's GC may have copied the buffer, and we cannot control
  the heap. This is one of several reasons ceremonies are a ZUULI-first feature
  ([ADR 0001](./decisions/0001-platform-priority.md)).

### 11.3 Participant-list agreement needs a real echo broadcast

#134's first step — the initiator announces the participant list — requires
genuine *agreement*, not just delivery. Pedersen-style DKG without agreement on
the broadcast is vulnerable to a participant **biasing the resulting key by
adaptively complaining after seeing shares**. This is a known, live concern in
the exact FROST implementation we would use:
[ZcashFoundation/frost#577 — "Lack of agreement despite broadcast"](https://github.com/ZcashFoundation/frost/issues/577).

We therefore implement an echo broadcast — Goldwasser–Lindell style, or
concretely the `CertEq` construction from
[BlockstreamResearch/bip-frost-dkg](https://github.com/BlockstreamResearch/bip-frost-dkg):

1. Every participant signs `session_hash` with its `CeremonySigningKey`.
2. Signatures are echoed to all participants and collected into a certificate.
3. A participant outputs success **only** when it holds a certificate containing
   a valid signature from **every** participant in the list.

A participant that never obtains a complete certificate does not proceed and
does not output a key. See also the
[ZF Pedersen DKG DoS remediation](https://zfnd.org/pedersen-dkg-vulnerability-in-frost-distributed-key-generation-successfully-remediated/).

### 11.4 Meeting #132's requirements

| #132 requirement | How it is met |
|---|---|
| Part 1 from every participant to every other (reliable broadcast) | MLS application messages fanned out to per-device queues, plus §7's hash-linked DAG for gap detection and explicit re-request. This is *eventual delivery with retry*, **not** Byzantine reliable broadcast — see the caveat below. |
| Part 2 to each participant confidentially, hidden from server and other participants | #134's per-recipient `box()` to fresh per-session X25519 keys, inside MLS. Two independent layers; either alone suffices for confidentiality against the relay. |
| An agreed participant list before key generation | §11.3 CertEq echo broadcast. |
| Progress on receiving all part-*n* without knowing others have | The state machine advances on local completeness, exactly as #132 specifies. |

**Caveat, stated plainly:** our transport gives eventual delivery with retry, not
Byzantine reliable broadcast. A relay can delay or partition arbitrarily. What
CertEq supplies is the *agreement* property that a lossy broadcast lacks — a
partitioned participant fails to complete rather than completing on a divergent
view. Liveness is not guaranteed against an adversarial relay; **safety is.**

### 11.5 Transcript retention

Every ceremony message carries `retention_class = CEREMONY` and is retained by
default, because the participant wants the evidence (§8.5).

## 12. Disposition of prior review feedback

| Issue | Point | Disposition |
|---|---|---|
| [#131](https://github.com/free2z/zuu/issues/131) | Networks are unreliable; connections drop without telling you what arrived | **Addressed** — §7 hash-linked DAG, explicit acks, §6.4 |
| #131 | N² P2P connections make failure probability quadratic | **Addressed** — §10 demotes P2P to an optimization; the relay is the default path, and its connection count is linear |
| #131 | Timestamps cannot order messages | **Addressed** — §7, `sent_at` is advisory only and never used for ordering |
| #131 | "For FROST, a centralized server with sequence numbers is much simpler" | **Consciously declined in that form.** We keep a server-mediated default path (agreeing with the reliability argument) but reject server-assigned sequence numbers as the ordering authority, because that hands the server censorship and reordering power. The DAG gives the same replay-on-reconnect ergonomics without trusting the sequencer. |
| [#132](https://github.com/free2z/zuu/issues/132) | Reliable broadcast, confidential per-recipient delivery, agreed participant list, local-completeness progression | **Addressed** — §11.4, with the honest caveat that we provide eventual delivery, not Byzantine reliable broadcast |
| [#133](https://github.com/free2z/zuu/issues/133) | The server can MITM the WebRTC handshake | **Addressed** — §10 (fingerprints authenticated in-band) and §9 (key transparency for the identity keys themselves) |
| #133 | Minimize manual checking; prefer many participants checking the same thing | **Addressed** — §9.2 self-audit and gossip mean everyone checks the same log roots automatically; manual safety numbers are a backstop, not the primary mechanism |
| [#134](https://github.com/free2z/zuu/issues/134) | Signed, session-hash-bound, self-securing payload structure | **Adopted essentially verbatim** — §11.1 |
| #134 | Deterministic `part1_id` as box nonce | **Adopted** — §11.1 |
| #134 | Per-session encryption key MUST be deleted after part 2 | **Adopted and made testable** — §11.2 |
| #134 (comment) | Include `participant_id` and a message `type` in every signed message | **Adopted** — §11.1 |
| #134 | Participant-list agreement | **Strengthened** — §11.3 requires a real echo broadcast (CertEq); announcement alone is insufficient |

## 13. Open questions

Genuinely undecided. Listed rather than invented.

**Letters are stable identifiers.** A question that gets answered is moved to
§13.1 and its letter is retired rather than reused, so a citation to "§13-F"
means the same thing a year from now. The gaps in the list below are therefore
deliberate.

- **B. PQ ciphersuite codepoint.** The MLS PQ ciphersuite registration is in
  flight. Pin an exact identifier and a migration path before Phase 2.
- **C. Post-quantum signatures.** X-Wing covers the KEM only. Migrating identity,
  device, ceremony and KT-log signatures (e.g. to ML-DSA) is unscheduled. What
  is the trigger condition?
- **D. History transfer to a new device.** MLS forward secrecy means a newly
  added device cannot decrypt past epochs. Where the user has chosen to retain
  local history (§8.1), do we transfer it device-to-device (requiring a secure
  pairing channel), and what does that do to the forward-secrecy claim?
  Unresolved.
- **F. Padding bucket sizes.** Need a traffic study; current values are
  placeholders. [`WIRE.md` §9](./WIRE.md#9-padding-enforcement) deliberately puts
  the size set in the relay's capability document rather than in the protocol, so
  that adopting the measured answer is a configuration change rather than a
  federation-wide flag day.
- **G. Relay redundancy factor *k*.** Default value, and whether it is per
  conversation or global.
- **H. Push notifications.** APNs/FCM are the standard way to avoid a persistent
  connection per mobile client — which is our dominant cost driver — but they
  leak notification timing to Apple/Google and the push token is an identifier.
  SimpleX uses a separate optional queue address. **We need a deliberate
  position and do not have one.**
- **I. Anonymous credentials for quota.** The zkgroup/KVAC-style design for
  "prove you paid for capacity without revealing who you are"
  ([ADR 0006](./decisions/0006-zcash-coupling.md), optional tier) is unspecified.
  It remains the real answer to the abuse cases that
  [ADR 0012](./decisions/0012-anti-abuse-v1.md) explicitly does **not** close.
  **Not to be confused with `WIRE.md` §13.1's `token` mode**, which was reserved
  on 2026-08-24 because v1's wire has no field a token can go in
  ([#630](https://github.com/free2z/zuu/issues/630)). A token is an identifier
  and an anonymous credential is not; token mode was never this question's
  carrier, and reserving it costs this question nothing. When it is answered it
  arrives as a **new command code** under
  [`WIRE.md` §3.5](./WIRE.md#35-versioning), whose absence on an un-upgraded
  relay is a non-fatal `ERR_UNKNOWN_COMMAND` rather than a federation flag day.
- **K. Handle rename and transfer.** How the KT log represents a handle changing
  owner without creating a MITM window.
  [ADR 0014](./decisions/0014-directory-key-rotation.md) settles directory *key
  rotation* — including the lost-key case — and deliberately does **not** settle
  rename or transfer, which are a change of owner rather than of key and create a
  MITM window of a different shape. Still open.
- **L. Encrypted media attachments.** Out of scope for the first release, but the
  storage decision (zero-egress object storage) should be made before we build,
  not after — retrofitting off S3-style egress pricing is painful.
- **M. Group scale limits.** MLS is O(log N) for rekey but the delivery fan-out
  is O(members × devices). At what size do we need a different fan-out strategy?
- **N. Proof-of-work function and calibration.** Opened 2026-08-23 by
  [`WIRE.md` §12.4](./WIRE.md#124-the-honest-limits). v1 specifies a
  leading-zero-bit search over BLAKE2b, chosen so the relay's verification cost is
  a single hash — the property that matters under flood. That is also the family
  of function commodity parallel hardware accelerates best, so it **taxes phones
  far more than rented GPUs**, and no difficulty setting fixes that. A memory-hard
  function narrows the hardware gap and multiplies the relay's own verification
  cost by the same factor. What difficulty is simultaneously a real cost to an
  attacker and tolerable on a cheap Android device is **unmeasured**, and whether
  a memory-hard function is affordable at relay scale is undecided.
- **O. Messaging-handle eligibility for existing accounts.** Opened 2026-08-23 by
  [`WIRE.md` §14](./WIRE.md#14-handle-charset-for-messaging--blocking-pre-check-resolved).
  Messaging handles are `[a-z0-9_]{1,30}`, ASCII, so that **cross-script**
  homograph and mixed-script impersonation does not exist — same-script ASCII
  lookalikes such as `1`/`l` remain and are a client rendering problem
  ([`THREAT-MODEL.md` §4.10](./THREAT-MODEL.md#410-the-platform-username-space-contains-homographs-messaging-handles-do-not)).
  free2z usernames are broader
  (`^[\w.@+-]+$`, up to 150 characters), so some existing accounts are not
  eligible. **Measured 2026-08-23 — and still open**, because measurement was
  never the whole question. What the measurement settled:
  - **What share, closed.** **Approximately 90% of existing accounts are eligible
    after case-folding and approximately 10% are not** — overwhelmingly because
    the username contains `.` `@` `+` or `-`; non-ASCII characters and
    over-length names account for very few. It is not a set of dead rows:
    **every ineligible account has logged in at least once and all but one is
    still active.** Whether that is a rounding error or a migration project is a
    question about the *absolute* count and not about the share, and absolute
    counts are business data, deliberately not published in this repository; they
    are recorded in the deployment repository. The earlier answer that it was
    "neither" rested on a scale qualifier that the redaction to proportions
    removed, and is withdrawn — see the correction in
    [`WIRE.md` §14.3](./WIRE.md#143-the-decision-and-the-cost-accepted).
  - **Which validator, closed.** `Creator(AbstractUser)` does not override
    `username`; the field is recorded with
    `UnicodeUsernameValidator`. **Non-ASCII usernames are legal on free2z today
    and a small, non-zero number of accounts carry one** — so the platform's
    existing handle space already contains the homograph surface, in the present
    tense, as a property of the shipped product rather than a risk of a future one
    ([`WIRE.md` §14.2](./WIRE.md#142-checked-against-free2zs-real-username-rules--measured),
    [`THREAT-MODEL.md` §4.10](./THREAT-MODEL.md#410-the-platform-username-space-contains-homographs-messaging-handles-do-not)).
  - **Still open — and it is a product decision, not a measurement.** Is that
    ~10% of real users simply excluded from messaging discovery in v1, or are
    they served by a separate opt-in messaging handle? The latter is directory
    design and touches §13-K. Nobody has decided, so this stays open.
  - **Surfaced by the measurement, and blocking.** Case-insensitive username
    uniqueness is enforced only in two serializers, not in the database, and
    **production holds case-variant duplicate accounts today, in more than one
    group**. Those must
    be resolved before the handle mapping ships; the correction and the intended
    end state (a database-level `UniqueConstraint(Lower("username"))`) are in
    [`WIRE.md` §14.3](./WIRE.md#143-the-decision-and-the-cost-accepted). The
    backend work is tracked in the deployment repository.
- **P. KT epoch cadence and maximum merge delay.** Opened 2026-08-23 by
  [`KT.md` §5](./KT.md#5-epochs-and-the-merge-promise). The values there — a
  600-second epoch published whether or not there is work, and a 3,600-second
  maximum merge delay — are **proposed placeholders**, chosen so that silence is
  a detectable fault rather than an ambiguity. What they should actually be
  depends on the submission rate, on how much append-only-proof volume a
  volunteer witness will tolerate per day, and on how long a user should wait to
  see their own device addition land. None of the three is measured, and the
  first cannot be until there are users.
- **Q. Witness-set independence criterion and the default *t*.** Opened
  2026-08-23 by [`KT.md` §8.3](./KT.md#83-the-threshold-rule-and-failing-closed).
  §9.3 states that witnesses free2z operates are not independent witnesses; it
  does not say what *does* make one independent, who decides, or what a client
  ships with on day one when the honest answer is that no independent witness
  exists. The threshold rule is specified and fails closed; the **default** value
  of *t*, the shipped witness list, and the rule by which a witness is counted as
  independent are not decided, and choosing them badly would let a reassuring
  number stand in for a property we do not have.
- **R. Client gossip wire format.** Opened 2026-08-23 by
  [`KT.md` §8.4](./KT.md#84-gossip). §9.3 and
  [#311](https://github.com/free2z/zuu/issues/311) both make client gossip
  load-bearing — it is the *only* anti-equivocation that functions before
  independent witnesses exist — and neither specifies a message. What a client
  gossips, how often, what it does on a mismatch, and how a disagreement becomes
  portable evidence rather than a local error dialog are all unspecified.
  `KT.md` defines the evidence structures but deliberately does not invent the
  protocol that exchanges them.
- **S′. Client verification of a handle's first directory entry.** Opened
  2026-08-24 by [`KT.md` §4.7](./KT.md#47-what-a-compromised-authority-can-and-cannot-do),
  as the narrower remainder of **S** below. §4.5 now says what authorizes a first
  entry, and the log is the only party that checks it: a `HandleAssertion`
  travels in the submission envelope, is not part of `DirectoryEntry`, is not
  inside the value the tree commits to, and is not served with a lookup. Every
  other authorization in §4.4 is the opposite — a `RotationProof` and a
  `ResetAuthorization` sit inside `EntryAuthorization` and are re-verified by
  every client on every lookup. So the first-entry hole is closed against a
  stranger and **not against the log**, `KT.md` §8.1 step 6 still verifies
  nothing at `entry_version == 1`, and §8.5's table still says so. Closing it
  means a fourth `EntryAuthorization` case carrying the assertion and the
  identity countersignature, with the binding committing to
  `H(tls_codec(DirectoryEntryTBS))` rather than to the whole entry digest —
  a wire change to a structure two implementations have already frozen, so it is
  filed rather than made. [#594](https://github.com/free2z/zuu/issues/594).

- **T. Proving that a handle is unregistered.** Opened 2026-08-24 by
  [`KT.md` §8.1](./KT.md#81-lookup) and
  [§9.5](./KT.md#95-error-codes), and unlike most of this list it is not a
  decision we have deferred — it is a **requirement the specification states and
  the adopted library cannot meet.** `KT.md` requires "no such user" to be
  answered with a non-membership proof, deliberately, because a directory that
  may *assert* absence can disappear a user and be indistinguishable from one
  telling the truth. `akd` 0.13 has no API that produces such a proof: `lookup`
  errors for a label with no user state, and the `NonMembershipProof` inside a
  `LookupProof` is about a freshness marker for a label that is present. A v1 log
  therefore serves an assertion, which `KT.md` now requires to be **labelled
  unproved on the wire** so a client cannot mistake it for a proof
  ([`THREAT-MODEL.md` §4.11](./THREAT-MODEL.md#411-an-unregistered-handle-is-asserted-not-proved)).
  Closing it means one of: upstream support
  ([`KT.md` §11.5](./KT.md#115-what-akd-013-cannot-do-and-what-upstream-would-have-to-add)),
  which is the preferred shape and is not a small change; a per-epoch signed
  presence commitment, which bounds the lie to one epoch rather than removing it
  and would need specifying; or accepting the labelled assertion permanently and
  saying so. The knock-on is in
  [`KT.md` §5.3](./KT.md#53-the-submission-receipt): a submission receipt for a
  handle's **first** entry cannot be turned into portable evidence either, which
  is the same handle-with-no-entry case as **§13-S′** above — and as §13-S, which
  closed on 2026-08-24 and moved to §13.1.
  [#634](https://github.com/free2z/zuu/issues/634).
**S** — what authorizes a handle's first directory entry — was opened and closed
on 2026-08-24 and has moved to §13.1.

### 13.1 Closed

Kept here rather than deleted, so that a reader who arrives via an old citation
finds the answer instead of a hole.

- **S. What authorizes a handle's first directory entry — opened and closed
  2026-08-24.** §9.2 above specifies an append-only log of
  `(handle → identity key, …)` and does not say who is entitled to a handle;
  [ADR 0014](./decisions/0014-directory-key-rotation.md) settles authorization
  for a handle that already has an entry — same-key update, key change, lost key
  — and takes no position on the first one.
  [`KT.md` §4.4](./KT.md#44-what-authorizes-an-entry) inherited that silence, and
  as its rules were first enumerated they accepted a first entry for an
  unregistered handle from **whoever submitted one**.
  [#594](https://github.com/free2z/zuu/issues/594) found it while implementing
  against the document.
  **It is answered by [`KT.md` §4.5](./KT.md#45-handleassertion--what-authorizes-a-handles-first-entry)**:
  a short-lived, log-pinned, single-use `HandleAssertion` from a configured
  authority, countersigned by the identity key it names so that a stolen
  assertion is worthless, with the validity cap held by the **log** rather than
  the issuer. §4.6 fixes the no-authority mode a self-hosted log needs under
  [ADR 0005](./decisions/0005-federation.md) and **requires it to be reported**
  in a signed policy document, so a client can see that handles there are
  unvouched. §4.7 states what the trust root costs.
  **It was not decided in the specification**, which is the objection
  [#551](https://github.com/free2z/zuu/issues/551) is open about: the decision is
  the owner decision recorded on
  [#305](https://github.com/free2z/zuu/issues/305), which
  [#554](https://github.com/free2z/zuu/issues/554)'s brief did not name, so the
  documents inherited the gap rather than introducing it, and §4.5 transcribes
  what two independent implementations already agreed on byte-for-byte. What it
  does **not** close is above as **S′**.
- **A. OpenMLS audit status — closed 2026-08-08.** An independent assessment by
  SRLabs, sponsored by the Sovereign Tech Agency, was published
  [2026-05-27](https://blog.openmls.tech/posts/2026-05-27-independent-audit/):
  eight findings, one High ("improper authentication of MACs"), fixed in 0.8.1
  and 0.7.3. **We adopt the floor `openmls >= 0.8.1`.** One Low-severity finding
  was still open at publication and must be re-checked before release. See §3.1.
  This closes the question of whether the library has been audited; it does not
  close the question of auditing *our* use of it, which per #305's economics
  remains the dominant cost of the system.
- **E. SimpleX licensing — closed 2026-08-23.** The check was performed from
  **published repository metadata only** (GitHub's REST repository endpoint and a
  top-level contents listing), by an agent working on
  [#545](https://github.com/free2z/zuu/issues/545). **No source file from that
  project was fetched, opened or read.** Result:
  `simplex-chat/simplexmq` — the reference implementation of SMP, i.e. the
  server — reports **AGPL-3.0**, as does `simplex-chat/simplex-chat`. The
  operative consequence is recorded as a binding rule in
  [`WIRE.md` §15](./WIRE.md#15-clean-room-posture-toward-simplex--blocking-pre-check-resolved):
  **nobody on this project reads `simplexmq` source**, and the design derives
  solely from the public protocol description. Also recorded there, rather than
  glossed: the published protocol document lives in that same AGPL repository, so
  the clean-room posture rests on the distinction between the expression of a
  specification and the protocol it describes. That is our position, stated so it
  can be challenged; it is not legal advice, and anything beyond avoiding the code
  requires actual advice.
- **J. Retention unanimity — closed 2026-08-08, by removing the premise.** The
  negotiated-unanimity retention model was withdrawn (§8.1). With retention a
  per-user local choice there is no group policy to change unanimously or
  otherwise, so the question of what to do about a non-unanimous change no longer
  has a subject. See [ADR 0007](./decisions/0007-retention-per-user.md).

## 14. References

**Standards**
[RFC 9420 — MLS Protocol](https://datatracker.ietf.org/doc/html/rfc9420) ·
[RFC 9750 — MLS Architecture](https://datatracker.ietf.org/doc/rfc9750/) ·
[draft-ietf-mls-extensions — Safe Extension API](https://www.ietf.org/archive/id/draft-ietf-mls-extensions-04.html) ·
[draft-connolly-cfrg-xwing-kem](https://datatracker.ietf.org/doc/draft-connolly-cfrg-xwing-kem/) ·
[RFC 9180 — HPKE](https://datatracker.ietf.org/doc/html/rfc9180) ·
[RFC 6962 — Certificate Transparency](https://datatracker.ietf.org/doc/html/rfc6962) ·
[RFC 8827 — WebRTC Security Architecture](https://datatracker.ietf.org/doc/html/rfc8827) ·
[ZIP 32](https://zips.z.cash/zip-0032) ·
[ZIP 316](https://zips.z.cash/zip-0316) ·
[ZIP 317](https://zips.z.cash/zip-0317) ·
[ZIP 302](https://zips.z.cash/zip-0302) ·
[ZIP 231](https://zips.z.cash/zip-0231)

**Systems**
[Marmot / White Noise](https://github.com/marmot-protocol/marmot) ·
[Least Authority audit — Marmot MDK](https://leastauthority.com/blog/audit-of-white-noise-marmot-development-kit-mdk/) ·
[SimpleX / SMP](https://simplex.chat/docs/simplex.html) ·
[Signal Private Group System (KVAC)](https://signal.org/blog/pdfs/signal_private_group_system.pdf) ·
[Signal Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) ·
[Signal SPQR](https://signal.org/blog/spqr/)

**Key transparency**
[CONIKS](https://eprint.iacr.org/2014/1004.pdf) ·
[Parakeet](https://eprint.iacr.org/2023/081.pdf) ·
[WhatsApp Key Transparency](https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/)

**FROST / DKG**
[FROST paper](https://eprint.iacr.org/2020/852.pdf) ·
[bip-frost-dkg (CertEq)](https://github.com/BlockstreamResearch/bip-frost-dkg) ·
[ZF FROST book — DKG](https://frost.zfnd.org/tutorial/dkg.html) ·
[ZcashFoundation/frost#577](https://github.com/ZcashFoundation/frost/issues/577) ·
[ZF Pedersen DKG remediation](https://zfnd.org/pedersen-dkg-vulnerability-in-frost-distributed-key-generation-successfully-remediated/)

**Implementations**
[OpenMLS](https://github.com/openmls/openmls) ·
[PQ OpenMLS / libcrux](https://cryspen.com/post/pq-openmls/) ·
[mls-rs](https://github.com/awslabs/mls-rs) ·
[ts-mls](https://github.com/LukaJCB/ts-mls)

**Limits and attacks**
[No safety in numbers — sealed-sender traffic analysis](https://arxiv.org/pdf/2305.09799) ·
[Improving Signal's Sealed Sender](https://www.cs.umd.edu/~kaptchuk/publications/ndss21.pdf) ·
[WAIT — Binary-Equivalent Transparency](https://arxiv.org/pdf/2104.06136) ·
[Trustworthy JavaScript for the Open Web](https://hacks.mozilla.org/2026/05/trustworthy-javascript-for-the-open-web/) ·
[Real-World Deniability in Messaging](https://petsymposium.org/popets/2025/popets-2025-0018.pdf)
