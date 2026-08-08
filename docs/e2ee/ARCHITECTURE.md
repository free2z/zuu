# free2z E2EE — Architecture

**Status:** Phase 0 design. Nothing described here is implemented.
**Refs:** [#305](https://github.com/free2z/zuu/issues/305) (epic and decisions),
[#131](https://github.com/free2z/zuu/issues/131),
[#132](https://github.com/free2z/zuu/issues/132),
[#133](https://github.com/free2z/zuu/issues/133),
[#134](https://github.com/free2z/zuu/issues/134).
**Companion:** [`THREAT-MODEL.md`](./THREAT-MODEL.md),
[`decisions/`](./decisions/).

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
9. **Federated by construction** — anyone can run a relay, and clients treat
   relays as untrusted, replaceable infrastructure.

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
| 1. Identity + directory | Seed-derived identity; key-transparency log with cross-relay witness cosigning | CONIKS / SEEMless / Parakeet lineage |
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

> **Open question (§13-A):** OpenMLS's third-party audit status must be
> established in writing before release. Do not treat "widely used" as audited.

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
| Queue rotation (§6.2) | `free2z/queue/v1` | `peer_leaf_index` | Derives the next queue addresses without a round trip |
| Local history wrap | `free2z/history/v1` | `conversation_id` | At-rest key for retained plaintext |

Because these are exporter outputs, they inherit the group's forward secrecy and
are automatically bound to the exact membership of the epoch — which is
precisely the "confidential, authenticated, replay-bound channel between an
agreed participant list" that
[#132](https://github.com/free2z/zuu/issues/132) requires, obtained from a
standard instead of invented.

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

> **Action item (§13-E):** verify SimpleX's server licensing **before** anyone
> reads their server source. Parts of that project are copyleft and we need a
> clean-room posture.

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

The two addresses are unlinkable to each other at the relay, so a relay
observing traffic on a send address cannot trivially identify the corresponding
receive address, and therefore cannot trivially pair correspondents. It can
still attempt timing correlation; see [`THREAT-MODEL.md`](./THREAT-MODEL.md).

Queue addresses are established **inside** the MLS group — a member advertises
its `QueueSendAddr` set to peers in an authenticated application message, never
via the server. Addresses rotate on a schedule using the
`free2z/queue/v1` exporter so a long-lived relationship does not present a
long-lived identifier.

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

Undelivered ciphertext has a **TTL ceiling** (proposed: 30 days) after which the
relay drops it and the sender learns only from the continued absence of a
receipt. Quota and TTL are relay policy and are published in the relay's
capability document so clients can choose.

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
> are placeholders chosen for arithmetic convenience, not measurement.

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

[ADR 0003](./decisions/0003-history-retention.md). This governs **client-side**
retention only. In every mode, the server holds nothing after acknowledged
delivery — that is goal 2 and it is not adjustable per conversation.

### 8.1 Retention is group state, not a preference

Retention is carried as a `GroupContext` extension (RFC 9420 §12.4), so it is
part of the authenticated group state that every member validates on every
Commit. **The server cannot tamper with it, cannot observe it, and cannot
suppress a change to it undetectably.**

```
retention_policy_extension = {
  mode:        EPHEMERAL | RETAINED,
  ttl_seconds: uint32,      // EPHEMERAL only; time-to-live after local receipt
  set_in_epoch: uint64,
}
```

The extension is listed in `required_capabilities`, so a client that does not
understand it cannot join the group at all. That is the correct failure mode: a
client that would silently ignore an ephemeral setting must be excluded rather
than tolerated.

### 8.2 Changing it — negotiated, and what "agreed" actually means

Changing retention is a two-phase application-layer negotiation followed by an
MLS Commit:

1. A member sends `RetentionChangeProposal{new_policy}` as an application
   message.
2. Every other member's client responds `RetentionChangeAck{accept | reject}`.
3. Only on unanimous accept does the proposer issue a Commit carrying a
   `GroupContextExtensions` proposal with the new policy.

**Honest limit.** MLS cannot *enforce* unanimity — any member may commit a
`GroupContextExtensions` proposal unilaterally, and MLS will accept it. What the
protocol guarantees is that such a change is **authenticated, attributable and
visible**: every member sees exactly who changed the policy and in which epoch,
and can leave. So the property we deliver is **"no silent change,"** not "no
unilateral change." The UI must present an out-of-band policy change as a
prominent, attributed security event, not a toast.

### 8.3 Mid-conversation changes apply forward only

**A retention change takes effect from the epoch in which its Commit lands, and
applies only to messages received in that epoch or later.** Messages already
stored are governed by the policy that was in force when they were received.

Rationale, both directions:

- **RETAINED → EPHEMERAL cannot be retroactive**, because retroactive deletion
  is unenforceable. A member may have been offline, may have exported, may have
  screenshotted. Claiming retroactive deletion would be claiming a property we
  cannot deliver.
- **EPHEMERAL → RETAINED cannot be retroactive**, because the data is already
  gone. There is nothing to retain.

Separately, and clearly labeled as a **request, not a guarantee**, a member may
send `PurgeRequest{before_epoch}`. Conforming clients delete local history
before that epoch and reply `PurgeAck`. The UI must say "asked N participants to
delete; M confirmed," never "deleted."

### 8.4 Ephemeral mode is best-effort, and the UI must say so

A recipient can always screenshot, photograph the screen, or run a modified
client. Ephemeral mode defends against *casual* persistence and device seizure
after the TTL. It does not defend against a determined counterparty, and any UI
copy implying otherwise is a defect.

Ephemeral mode also shortens the plaintext outbox window used for gap repair
(§7), which means some gaps become unrecoverable. That is surfaced to the user
as an explicit "this message could not be recovered" marker rather than a silent
hole.

### 8.5 Ceremony transcripts are exempt

Messages with `retention_class = CEREMONY` are **always retained**, regardless of
the conversation's retention policy. A DKG transcript is evidence: it is what
lets a participant later prove the ceremony ran correctly and who said what.
Clients MUST NOT delete them under any retention setting, and the UI MUST state
this before the ceremony begins, so consent is informed. Transcripts are stored
under the `free2z/history/v1` local wrap key like everything else.

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
  can verify the log is append-only across every root it has ever seen.
- **Self-audit:** every client monitors its own handle each epoch and raises a
  loud, non-dismissible alarm on any key change it did not initiate. This is
  what makes an attempted MITM *detectable by the victim*, which is the whole
  point.
- **Manual safety-number verification** remains available and is the strongest
  check; ZUULI additionally offers verification over a shielded Zcash memo
  between two users who already know each other's payment address — an
  authenticated, private, *remote* out-of-band channel, which is genuinely
  unusual (see [ADR 0006](./decisions/0006-zcash-coupling.md)).

### 9.3 Anti-equivocation without a blockchain

The residual attack on any KT log is **equivocation**: showing different
directories to different users. The fix is Certificate Transparency's, not a
chain's:

- **Cross-relay witness cosigning.** Each relay in the federation observes and
  signs the KT log root for each epoch. A client accepts a root only if it
  carries at least *t* cosignatures from its own configured witness set. Two
  conflicting signed roots for the same epoch are **non-repudiable
  cryptographic evidence of misbehavior**, publishable by anyone.
- **Client gossip.** Clients cross-check roots with each other over the
  messaging channel itself — CONIKS's original design, and free because we
  already have an authenticated channel.

The property strengthens as the federation grows, so the multi-relay design we
want for censorship resistance ([ADR 0005](./decisions/0005-federation.md))
delivers anti-equivocation as a side effect.

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

Every ceremony message carries `retention_class = CEREMONY` and is retained
regardless of the conversation's retention policy (§8.5).

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

- **A. OpenMLS audit status.** Must be established in writing before release.
  "Widely used" is not "audited." If no adequate audit exists, budget one; per
  #305's economics, audit dominates the cost of this system and infrastructure
  is a rounding error.
- **B. PQ ciphersuite codepoint.** The MLS PQ ciphersuite registration is in
  flight. Pin an exact identifier and a migration path before Phase 2.
- **C. Post-quantum signatures.** X-Wing covers the KEM only. Migrating identity,
  device, ceremony and KT-log signatures (e.g. to ML-DSA) is unscheduled. What
  is the trigger condition?
- **D. History transfer to a new device.** MLS forward secrecy means a newly
  added device cannot decrypt past epochs. Under `RETAINED`, do we transfer
  local history device-to-device (requiring a secure pairing channel), and what
  does that do to the forward-secrecy claim? Unresolved.
- **E. SimpleX licensing.** Verify the server licence **before** anyone reads
  their source; adopt the SMP protocol design with a clean-room implementation.
- **F. Padding bucket sizes.** Need a traffic study; current values are
  placeholders.
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
- **J. Retention unanimity.** §8.2 delivers "no silent change," not "no
  unilateral change." Is that acceptable, or do we want an application-layer
  policy that treats a non-unanimous change as grounds for automatic exit?
- **K. Handle rename and transfer.** How the KT log represents a handle changing
  owner without creating a MITM window.
- **L. Encrypted media attachments.** Out of scope for the first release, but the
  storage decision (zero-egress object storage) should be made before we build,
  not after — retrofitting off S3-style egress pricing is painful.
- **M. Group scale limits.** MLS is O(log N) for rekey but the delivery fan-out
  is O(members × devices). At what size do we need a different fan-out strategy?

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
