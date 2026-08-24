# free2z E2EE — Threat model

**Status:** Phase 0 design. Nothing described here is implemented.
**Companion:** [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`WIRE.md`](./WIRE.md),
[`KT.md`](./KT.md), [`decisions/`](./decisions/). **Refs:**
[#305](https://github.com/free2z/zuu/issues/305).

This document names the adversaries and, for each, states the defense — or
states plainly that there is none. It is written for a third-party auditor, so
the failures are as prominent as the successes. **Every security property
claimed here is one the design in `ARCHITECTURE.md` actually delivers.** Where a
property does not hold, it is listed as not holding rather than softened.

---

## 1. Assets

| Asset | Why it matters |
|---|---|
| Message plaintext | The obvious one. |
| Long-term identity keys (`ISK`, `CSK`) | Compromise means impersonation, and for `CSK`, forged ceremony transcripts. Seed-derived, so seed compromise implies these. |
| Per-device MLS state (leaf key, epoch secrets) | Compromise means reading current traffic until PCS heals. |
| FROST secret shares and the per-session encryption key | Enough shares reach threshold and forge spending authority over real funds. |
| Social graph (who talks to whom) | Often more sensitive than content. |
| Conversation existence and timing | Traffic analysis input. |
| Group membership | Signal-sealed-sender research shows this is recoverable from receipt patterns if you are careless. |
| Handle → identity key mapping | If the server can lie about it, all of the above is moot. |
| Retained local history | Device seizure surface. |

## 2. Trust assumptions

We assume, without which nothing works:

- The user's device is not compromised at the time of key generation.
- The mnemonic is backed up by the user and not disclosed.
- The cryptographic primitives hold: X25519, ML-KEM-768, Ed25519, SHA-256,
  BLAKE2b, AES-GCM / ChaCha20-Poly1305 — with the quantum caveat in §3.8.
- The Rust crypto core, once audited, is a correct implementation.
- For ZUULI: the OS, the code-signing chain, and the update channel are honest.
- For the web client: **we assume much more, and that is the point of §3.6.**

We do **not** assume the free2z server is honest, the relay is honest, the
network is honest, or that other participants are honest.

## 3. Adversaries

### 3.1 Malicious or compromised free2z server

**Capability.** Runs the application server, the key-transparency directory, and
the first relay. Serves the web client's JavaScript. Sees every connection, every
queue operation, every directory lookup, and every source IP. Can modify any
data it stores or relays.

**Defended.**

- **Cannot read message content.** All payloads are MLS `PrivateMessage`; the
  server holds no key material and participates in no key agreement. This is
  goal 1 and it holds unconditionally for the ZUULI client.
- **Cannot forge or modify messages.** MLS authenticates every message with the
  sender's leaf key, bound to a device credential signed by the sender's
  identity key. Modification fails authentication at the recipient.
- **Cannot add or remove group members.** Membership changes are MLS Commits
  validated independently by every member against the `GroupContext`. The server
  relays Commits; it cannot author them.
- **Cannot MITM the WebRTC handshake** — the attack in
  [#133](https://github.com/free2z/zuu/issues/133). DTLS fingerprints are
  exchanged inside the MLS group and the client refuses any SDP whose
  fingerprint does not match
  ([`ARCHITECTURE.md` §10](./ARCHITECTURE.md#10-p2p-webrtc--an-optimization-not-a-dependency)).
  A substituted fingerprint fails authentication rather than going unnoticed.
- **Cannot substitute an identity key undetectably.** The KT directory is an
  append-only log with inclusion and consistency proofs; every client self-audits
  its own handle every epoch and alarms on any key change it did not initiate.
  An attempted substitution is visible **to the victim**. — **Three corrections
  below narrow this bullet; read them with it.**
- **Cannot equivocate on the directory without leaving evidence**, once an
  independent witness set exists. Witness cosigning plus client gossip means two
  conflicting signed roots for one epoch are non-repudiable, publishable proof of
  misbehavior. Witnesses free2z operates provide none of this, so until outside
  operators exist, client gossip is the whole of the defense
  ([`ARCHITECTURE.md` §9.3](./ARCHITECTURE.md#93-anti-equivocation-without-a-blockchain)).
- **Cannot forge or alter an ephemeral hint.** Hints are MLS application
  messages, so the server can neither invent one nor change its TTL nor misattribute
  it. Note carefully what this is *not*: honoring a hint is a client courtesy, not
  something any party can enforce
  ([`ARCHITECTURE.md` §8.2](./ARCHITECTURE.md#82-the-ephemeral-hint-is-a-courtesy-signal-not-a-control)),
  and retention itself is a per-user local choice the server never sees.
- **Cannot silently drop a message in the middle of a conversation.** Hash-linked
  parents produce a detectable gap.
- **Cannot retain ciphertext it has deleted.** For its *own* relay we control the
  code; see the honest limit below.

> **Correction (2026-08-23) — who verifies what, in "inclusion and consistency
> proofs."** The identity-substitution bullet above reads as though a client
> checks both. It does not, and cannot. Per
> [ADR 0013](./decisions/0013-key-transparency-log.md), the log is `akd`, whose
> append-only proof is **O(entries added), not O(log n)** — 3.9 MB and 1–3
> seconds for five epochs. A client verifies **inclusion**, **non-membership**
> — of a *stale version* for a handle that is in the tree, and **not** of an
> unregistered handle, which cannot be proved at all (§4.11) — and **its own key
> history**, cheaply, against a root it has checked is signed
> by the log and cosigned by *t* of its own configured witnesses. **Append-only
> consistency is verified by witnesses only**, which is what the role is for
> ([`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory), corrected;
> [`KT.md` §8.5](./KT.md#85-what-a-client-cannot-verify)).
>
> The bullet's conclusion survives — a substitution is still visible to the
> victim, because self-audit over its own key history is exactly the check that
> catches it, and that check is the cheap one. What does **not** survive is any
> reading in which a client independently establishes that the log never rewrote
> anything. Against a log that equivocates rather than appends, the client has
> only the cosignatures, gossip, and manual safety-number verification — and
> §3.9 plus [§9.3](./ARCHITECTURE.md#93-anti-equivocation-without-a-blockchain)
> say what those are worth before independent witnesses exist, which is: at
> launch, nothing but gossip and manual verification.

> **Correction (2026-08-23) — the platform reset path is a stated exception.**
> [ADR 0014](./decisions/0014-directory-key-rotation.md) introduced a platform-authority
> reset for a user who has lost the key that would authorize a key change, and
> flagged that this bullet would need annotating when the KT documents landed.
> A reset **does** substitute an identity key on the platform's authority alone.
> It is not undetectable — it is published in the log, counted per epoch in the
> tree head, raises a non-dismissible alarm on every peer holding the old key,
> and is delayed by a multi-day cooldown during which conforming clients keep
> using the old key. But "cannot substitute an identity key undetectably" is
> doing precise work here and should be read precisely: the reset converts an
> undetectable substitution into a **loud, delayed, permanently recorded** one.
> It does not prevent it. A user who ignores the alarm is MITM'd, and a user who
> set `no_reset` has foreclosed the path entirely at the cost of permanent handle
> loss on a lost seed.

> **Correction (2026-08-24) — the bullet is scoped to a handle that already has
> a directory entry, and that qualifier was never written down.** "Substitute an
> identity key" presupposes a key already published for the handle; self-audit,
> the alarm and the key-change rules all hang off the entry that key lives in.
> For a handle with **no** entry yet, none of that machinery has anything to act
> on, and
> [`KT.md` §4.4](./KT.md#44-what-authorizes-an-entry) does not say what authorizes
> a handle's **first** entry — as its rules are enumerated, a first entry is
> accepted from whoever submits one, including the log itself
> ([#594](https://github.com/free2z/zuu/issues/594),
> [§13-S](./ARCHITECTURE.md#13-open-questions)). A server that publishes a first
> entry for a handle whose owner never enrolled is not *substituting* a key, so
> the bullet above stays literally true — and a peer who resolves that handle is
> MITM'd anyway, with no self-audit anywhere to fire, because the person who
> would audit is not a user of the system. **The bullet is therefore not a claim
> about unregistered handles and must not be restated as one**, which is exactly
> the failure the scoping convention in
> [`README.md`](./README.md) exists to catch; the summary row in §5 has been
> narrowed to match. What closes the gap is a decision that has not been taken —
> `KT.md` §4.4 states the option space and answers none of it — so this
> correction records a limit rather than a fix.

**Not defended.**

- **Denial of service.** The server can refuse to serve, drop every message, or
  delete a user's account. There is no defense within the protocol. The mitigation
  is structural, not cryptographic: federation
  ([ADR 0005](./decisions/0005-federation.md)) means a user can move to another
  relay, and the KT log's witnesses are not all ours.
- **Retention despite claiming deletion.** Delete-on-ack is a property of relay
  *software*, and no client can verify that a remote process actually called
  `unlink`. We can make it auditable (open source, reproducible builds,
  self-hosting) but not verifiable. **Anyone who needs a verifiable guarantee
  must run their own relay.** Stated plainly, and it is why self-hosting from the
  first release is a decision rather than a nicety.
- **Tail truncation.** Dropping the last *k* messages from a sender, when no later
  message arrives to dangle a parent hash, is not detectable by the hash-link
  mechanism. Heartbeats carrying the sender's DAG head narrow the window; a full
  partition remains indistinguishable from the peer being offline.
- **Denying that a handle exists.** The log can answer a lookup for a registered
  handle with "not registered", and no client can check it: `akd` 0.13 produces
  no proof of absence, so the answer is an assertion labelled as one
  ([`KT.md` §8.1](./KT.md#81-lookup)'s correction). The label is what a client
  gets instead of a defense. See §4.11.
- **Directory lookup metadata.** See §4.1.
- **Serving malicious JavaScript to the web client.** See §3.6. This is the big
  one, and it is not fixable at the protocol layer.

### 3.2 Network observer

**Capability.** Passive or active on-path: the user's ISP, a national backbone,
a hostile Wi-Fi, a CDN in the path. Sees TLS-wrapped traffic to the relay and,
if direct P2P is used, the peer's IP.

**Defended.**

- Content is encrypted twice over (MLS inside TLS). A network observer learns
  nothing about content that the relay does not already learn — which is nothing.
- Message sizes are padded to fixed buckets before leaving the client, so length
  does not leak content
  ([`ARCHITECTURE.md` §6.5](./ARCHITECTURE.md#65-padding)).
- Active tampering with the transport causes MLS authentication failures, not
  silent corruption.
- Queue identifiers are opaque and rotate, so a long-lived relationship does not
  present a long-lived on-wire identifier.

**Not defended.**

- **The user is using free2z, and when.** Connection timing, volume and cadence
  are visible. We do not ship an anonymity network; a user who needs to hide
  *that they are using the system* must run the client over Tor or a VPN. This
  is a stated non-goal.
- **Coarse activity correlation.** An observer with vantage on both endpoints can
  correlate send and receive timing. See §3.7.
- **Peer IP address on direct P2P.** ICE candidates reveal it. Clients default to
  relay-only ICE for contacts not explicitly trusted, and the UI states what
  enabling direct connections reveals — but if the user enables it, the IP is
  exposed to the peer and to anyone observing.

### 3.3 Compromised relay operator (third-party or ours)

**Capability.** Full control of a relay: reads its storage, logs everything,
drops, delays, reorders, replays, and lies about deletion. May be a relay the
user chose, or ours.

**Defended.**

- Reads only opaque ciphertext against opaque queue addresses. No accounts, no
  handles, no identity keys, no group state, no contact lists.
- Cannot forge messages (MLS authentication) or modify them undetectably.
- Cannot enumerate group membership by asking itself, because it has no notion of
  a group — only independent unidirectional queues.
- Cannot map a queue address to a person from its own records: addresses are
  established inside the MLS group, never through the server, and carry no
  handle, account or identity key. The relay learns that address *X* feeds
  address *Y*; it does not learn who they are.
- Cannot read, ACK or delete using a send-side credential. `QueueSendAddr`
  authorizes APPEND only, so a compromised sender-side key — or a seized sending
  device — cannot drain a single undelivered message out of the queue
  ([`ARCHITECTURE.md` §6.2](./ARCHITECTURE.md#62-queues)).
- Replay is rejected: MLS generation counters and the message DAG make a replayed
  ciphertext a duplicate `msg_id` at worst.
- Cannot single-handedly equivocate on the KT log — a client requires *t*
  witness cosignatures from its own configured set.

**Not defended.**

- **The send/receive address pair, for every queue it hosts.** Delivery requires
  it: an APPEND to `QueueSendAddr` must land in the list read from
  `QueueRecvAddr`, so the mapping is in the relay's database by construction. An
  operator who dumps that table pairs the two ends of every queue it hosts
  **directly**, with no traffic analysis at all. The two-address split buys
  capability separation and resistance to a *front-door* observer; it does not
  buy unlinkability against the operator, and this document does not claim it
  does. See §4.9 and
  [`ARCHITECTURE.md` §6.2](./ARCHITECTURE.md#62-queues).
- **Traffic correlation across queues.** Even where a relay hosts only one
  direction, an append on one queue closely followed by a fetch on another is a
  usable signal. Padding and jitter raise the cost; they do not eliminate it.
  Using different relays for send and receive directions helps against the
  point above and is supported, but is a user choice we cannot enforce.
- **Delivery-receipt timing.** See §4.2 — this is the strongest practical attack
  available to a relay operator.
- **Denial of service and censorship.** Same as §3.1. Federation is the answer:
  clients treat relays as replaceable, and a device may publish queue addresses
  on *k* relays.
- **Claimed deletion.** Same limit as §3.1: unverifiable from outside.
- **Source IP.** The relay sees it unless the client uses Tor or a VPN.

### 3.4 Compromised participant (a legitimate member turned adversary)

**Capability.** A real member of the group with valid keys. Sees all plaintext
addressed to the group by construction.

**Defended.**

- **Cannot read history from before they joined.** MLS forward secrecy: a member
  added in epoch *n* cannot derive epoch *n−1* keys.
- **Cannot read after removal.** A Remove commits a new epoch with fresh secrets.
- **Cannot impersonate another member.** Every message is signed by the sender's
  leaf key under a device credential chained to that member's identity key.
- **Cannot bias a FROST/DKG result by adaptively complaining after seeing
  shares.** This is the concrete attack behind
  [ZcashFoundation/frost#577](https://github.com/ZcashFoundation/frost/issues/577);
  the CertEq echo broadcast
  ([`ARCHITECTURE.md` §11.3](./ARCHITECTURE.md#113-participant-list-agreement-needs-a-real-echo-broadcast))
  is the defense. A participant that cannot obtain a complete certificate does
  not output a key.
- **Cannot deny having sent a ceremony message.** Ceremony payloads are signed
  with `CeremonySigningKey` and bound to `session_hash`. Non-repudiation is the
  intended property here.
- **Cannot forge an ephemeral hint in someone else's name.** Hints are
  authenticated and attributable inside MLS, so "Azhr asked for this to be
  ephemeral" cannot be fabricated by another member.

**Not defended.**

- **Leaking plaintext they legitimately received.** Screenshots, copy-paste,
  forwarding, a modified client that ignores an ephemeral hint. No E2EE system
  defends against an authorized reader, and this is the reason retention is a
  per-user local choice rather than a negotiated group property
  ([`ARCHITECTURE.md` §8.1](./ARCHITECTURE.md#81-retention-is-a-per-user-local-choice)):
  a rule that only conforming clients follow is not a defense against a member
  who has already decided not to conform.
- **Keeping their own copy forever.** Every participant chooses their own local
  retention. A counterparty retaining everything is not a protocol violation and
  is not detectable; it is the expected case for anyone who wants it.
- **Refusing to participate.** A ceremony participant can stall a DKG
  indefinitely. Availability is not a property we provide against a member who
  will not play; the failure is safe (no key is output) rather than silent.
- **Ignoring an ephemeral hint.** The hint is a courtesy signal
  ([`ARCHITECTURE.md` §8.2](./ARCHITECTURE.md#82-the-ephemeral-hint-is-a-courtesy-signal-not-a-control));
  a client that disregards it is indistinguishable from one that honors it, and
  no join-time capability check excludes it — see the knock-on recorded in that
  section.

### 3.5 Compromised device

**Capability.** Malware or a forensic tool with the user's privileges on the
user's machine, or physical access to an unlocked device.

**Defended.**

- **Past traffic is partially protected.** MLS forward secrecy means epoch
  secrets already deleted cannot be recovered — subject to this user's own local
  retention setting, since retained local plaintext is right there on disk.
- **Future traffic heals, eventually.** Post-compromise security: once the
  compromised member issues an Update and the adversary is passive thereafter, the
  group's secrets recover.
- **Local storage is encrypted at rest** under a key wrapped by `BackupWrapKey`
  and the OS keystore where available.
- **The FROST per-session encryption key is destroyed after part 2**
  ([`ARCHITECTURE.md` §11.2](./ARCHITECTURE.md#112-mandatory-destruction-of-the-per-session-encryption-key)),
  enforced in the state machine and asserted by test — so a device compromised
  after the ceremony does not yield the shares that were sent to it.
- **Device revocation exists**: a signed `DeviceRevocation` in the KT log plus an
  MLS `Remove` in every group.

**Not defended.**

- **Anything at all, while the compromise is active.** The adversary reads
  plaintext as the user reads it, exfiltrates keys, and sends as the user. This is
  total and unavoidable; no messenger defends against it, and we should never
  imply we do.
- **The seed.** If the mnemonic is on the compromised device, the adversary gains
  `ISK`, `CSK` and the ability to enroll new devices — i.e. a permanent wiretap
  that survives revocation of the compromised device, until the user rotates
  identity. Identity rotation is a KT event and is loud, but the window is real.
- **Retained history**, in full, for whatever this user chose to keep.
- **Zeroization in the browser.** In WASM we cannot guarantee that key material
  is erased from memory: the JS engine's GC may have copied the buffer and we do
  not control the heap. This is one reason ceremonies are ZUULI-first.

### 3.6 A coerced server serving targeted JavaScript to web clients

**This is the most important entry in this document.**

**Capability.** A legal order, an insider, or an attacker with deployment access
causes the free2z server to serve modified JavaScript/WASM **to one targeted
user** while serving honest code to everyone else. The modified bundle
exfiltrates keys or plaintext.

**Defense: there is none.**

Not "weak," not "mitigated" — **none**. This is a fundamental property of
browser-delivered E2EE, not a bug in our code. The user fetches the program that
performs the encryption from the same party the encryption is meant to protect
against, on every page load, and has no way to know what they received. Subresource
integrity, CSP and code review do not help, because the attacker controls the
document that declares them. It leaves no trace on the client.

**What we actually do about it:**

1. **ZUULI is the trust anchor** ([ADR 0001](./decisions/0001-platform-priority.md)).
   A signed native binary with a Rust crypto core is fetched once, from a signed
   update channel, and can be verified out of band. Strong claims are made there.
2. **The web UI must state its weaker guarantee in the interface**, not merely in
   documentation. A user making a decision about a sensitive conversation in a
   browser must be told, in the product, that the browser client's guarantee
   depends on the server being honest at page-load time.
3. **High-value operations are ZUULI-only.** FROST/DKG ceremonies, which create
   spending authority over real funds, are not offered in the browser.
4. **Web code transparency is a research track, never a release blocker.**
   See [WAIT](https://arxiv.org/pdf/2104.06136) and
   [Trustworthy JavaScript for the Open Web](https://hacks.mozilla.org/2026/05/trustworthy-javascript-for-the-open-web/).
   Binary-equivalent transparency for web bundles would reduce this to
   "detectable after the fact," which is a real improvement and still not a fix.

Any marketing copy that describes the web client's guarantee as equivalent to
ZUULI's is false. This is a hard constraint on the product, not a documentation
preference.

### 3.7 Global passive adversary — explicitly out of scope

**Capability.** Observes traffic at enough vantage points to correlate senders
and recipients by timing and volume across the whole network.

**Defense: none, and this is a stated non-goal.**

Padding and receipt jitter raise the cost of correlation but do not defeat an
adversary with global vantage. Defeating one requires mixnet-grade cover traffic
and latency budgets that are incompatible with an interactive messenger. We are
not building Tor. We say so here rather than implying otherwise by silence.

### 3.8 Future quantum adversary

**Capability.** Records ciphertext today; obtains a cryptographically relevant
quantum computer later ("harvest now, decrypt later"). Or, in the further future,
possesses one at the time of attack.

**Defended.**

- **Confidentiality against harvest-now-decrypt-later.** The MLS ciphersuite is
  hybrid X25519 + ML-KEM-768 (X-Wing) **from day one**, not retrofitted. Recorded
  ciphertext is not decryptable by a future quantum adversary unless *both*
  components fall.

**Not defended.**

- **Authentication.** Every signature in the system — MLS leaf signatures, device
  credentials, ceremony payloads, KT log roots and witness cosignatures — is
  Ed25519. An adversary with a quantum computer *at the time of the attack* could
  forge them and impersonate any party. Migrating signatures (e.g. to ML-DSA) is
  unscheduled future work
  ([`ARCHITECTURE.md` §13-C](./ARCHITECTURE.md#13-open-questions)). This is an
  accepted, stated limitation, not an oversight.

### 3.9 Malicious directory witness

**Capability.** Operates one of the witnesses whose cosignature clients rely on
for KT anti-equivocation; may refuse to sign, sign a false root, or collude with
the directory operator. A witness is a distinct role from a relay
([`ARCHITECTURE.md` §9.3](./ARCHITECTURE.md#93-anti-equivocation-without-a-blockchain))
— one operator may run both, but a witness holds no ciphertext and compromising
one yields no message data.

**Defended.** A client requires *t* cosignatures from **its own configured**
witness set, so a single malicious witness cannot validate a forged root. A
witness that signs a root conflicting with another root it signed produces
non-repudiable evidence against itself — which is why a cosignature signs the
*contents* of a tree head (log id, epoch, tree size, root hash) rather than the
log's signature over them: the contradiction is then checkable by anyone, without
the log's public key and without ever having seen the log's own signature
([`KT.md` §7.2](./KT.md#72-witnesscosignature)). A client that requires *t*
cosignatures also **fails closed** when it cannot get them
([`KT.md` §8.3](./KT.md#83-the-threshold-rule-and-failing-closed)).

**Not defended.** Collusion of the directory operator with *t* witnesses defeats
the scheme entirely. The property is only as strong as the independence of the
witness set, and independence is a social fact we cannot verify
cryptographically. Clients should default to a witness set that is not all
free2z-operated, and the UI should make the configured set inspectable.

**Not defended, and added 2026-08-23: a lazy witness is indistinguishable from a
working one.** A witness's whole job is to verify the **append-only proof**
between consecutive roots — the check
[`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory) establishes that no
client can perform for itself. A witness that skips it and cosigns anyway is
attesting only that the log signed something, which the log's own signature
already proved. Such a witness produces cosignatures that are valid, timely,
countable, and **worth nothing**, and no client can tell the difference by
inspecting them. Nothing in the protocol detects this; the mitigations are that
the witness daemon and the log link the same verification code so that "cosign
without verifying" is not a state a conforming implementation can be in, that
witnesses publish their own cosignature history so a third party can re-derive
the proofs they claim to have checked, and that the operator set is small enough
to be known. A malicious witness that *wants* to be useless simply patches the
check out, and we would not know
([`KT.md` §7.4](./KT.md#74-a-witness-that-does-not-verify-the-append-only-proof-is-worthless)).

### 3.10 Lost or stolen device (no active malware)

**Defended.** Local storage is encrypted at rest; conversations this user set to
expire have already discarded plaintext past their TTL; the device can be revoked
via the KT log and Removed from every group, after which it decrypts nothing new.

**Not defended.** Anything the device still holds at seizure time under this
user's own retention setting, if the attacker also has the unlock credential.
Revocation is not retroactive.

## 4. Known limits, stated up front

These are not open questions. They are decided trade-offs we accept, and each
must appear in user-facing documentation, not only here.

### 4.1 Directory lookup reveals interest in a handle

Resolving `@alice` to an identity key tells the directory operator that someone
is interested in `@alice` at that moment. This is an **unavoidable consequence of
free2z being a public creator platform** where handles are the discovery
mechanism — you cannot look someone up by name without revealing that you looked.

The limit is bounded: it applies at **connection time**, not to ongoing
communication. Once the conversation exists, traffic flows over opaque pairwise
queues and the directory is not consulted again
([ADR 0004](./decisions/0004-metadata-ambition.md)). Privacy-preserving lookup
proofs (SEEMless/Parakeet-style) prevent the *rest* of the directory leaking, and
future work could add private information retrieval, but the fact of the lookup
remains. We document this honestly rather than paper over it.

### 4.2 Delivery-receipt timing is a published deanonymization vector

Sealed sender is not a defense against traffic analysis of receipt patterns.
Researchers have recovered **sealed-sender group membership from receipt timing
alone** ([No safety in numbers](https://arxiv.org/pdf/2305.09799);
see also [Improving Signal's Sealed Sender](https://www.cs.umd.edu/~kaptchuk/publications/ndss21.pdf)).

Our position: receipts are batched and jittered by default, disableable per
conversation, with read receipts separate and off by default. **This raises the
cost of the attack; it does not eliminate it.** A relay that hosts both ends and
observes receipt cadence over time retains a real statistical advantage. Users
with a strong anonymity requirement should disable delivery receipts and accept
the resulting loss of certainty about delivery — which, under delete-on-ack,
costs more than it would in a retaining messenger.

### 4.3 Ephemeral hints are a courtesy signal, not a control

Retention is a **per-user local choice**: each participant decides what their own
device keeps, and nothing in the protocol lets one participant's preference bind
another's disk
([`ARCHITECTURE.md` §8.1](./ARCHITECTURE.md#81-retention-is-a-per-user-local-choice)).

A conversation may carry an ephemeral **hint** — authenticated and attributable
inside MLS, so it cannot be forged or misattributed. Conforming clients honor it.
A recipient can screenshot, photograph the screen, or run a client that ignores
the hint entirely, and **that is undetectable.** An earlier revision of these
documents specified a negotiated group retention policy with a
`required_capabilities` join check; it was withdrawn, because a modified client
lies about its capabilities and the check bought nothing.

The hint defends against casual persistence and against device seizure after the
TTL. It does not defend against a determined counterparty, **it is not a security
property, and it is deliberately absent from the claims table in §5.** Any UI copy
implying enforcement is a defect.

### 4.4 Tail truncation is not detectable by hash links

Hash-linked parents detect gaps in the *middle* of a message DAG with certainty.
They do not detect suppression of the *most recent* messages, because there is no
later message to dangle a reference. Heartbeats narrow the window; a total
partition remains indistinguishable from the peer being offline.

### 4.5 Server-side deletion is auditable, not verifiable

No client can prove a remote process deleted anything. Open source, reproducible
builds and self-hosting make the claim auditable; only running your own relay
makes it verifiable.

### 4.6 No deniability for conversational messages

MLS signs application messages with the sender's leaf key, so a recipient who
retains the ciphertext, the epoch secrets and the sender's credential holds
attributable evidence. **We do not claim deniability.** Key-context separation
([`ARCHITECTURE.md` §5.6](./ARCHITECTURE.md#56-deniability--stated-not-claimed))
gives clean semantics and blast-radius containment, not deniability.

### 4.7 Push notifications are an unresolved metadata leak

Mobile push (APNs/FCM) is the standard way to avoid holding a persistent
connection per client, which is our dominant cost driver. It also gives Apple and
Google notification timing, and the push token is a stable identifier. **We do
not yet have a position**
([`ARCHITECTURE.md` §13-H](./ARCHITECTURE.md#13-open-questions)). Until we do,
this is an unquantified leak and must not be described as solved.

### 4.8 Nostr fallback means accepting retention

Nostr relays retain by default and NIP-40 expiration is advisory. Choosing the
Nostr fallback transport trades the delete-on-ack property for reach and
censorship resistance. It is per conversation, opt-in, and the UI must state that
ciphertext may be retained indefinitely by third parties.

### 4.9 The relay knows which queue addresses are paired

A queue's send address and its receive address are **linked in the relay's own
database**, because that link is how a message gets from one to the other. A
relay operator therefore holds a pairing table for every queue it hosts, and can
read the pseudonymous communication graph over queue addresses off disk without
any timing analysis.

What limits the damage is what the addresses are *not*: they are opaque, they
carry no handle or identity key, they are per device pair and per direction, and
they rotate on the `free2z/queue/v1` exporter schedule, so the graph is over
short-lived pseudonyms rather than over people. Deanonymizing it requires
attaching a queue address to a person by some other means — source IP, timing
against a known event, or correlation with the platform's own logs when free2z
runs both. Publishing queue addresses on *k* relays, and using different relays
for the two directions, splits the table so no single operator holds all of it.

The two-address split is still worth having, for the reasons in
[`ARCHITECTURE.md` §6.2](./ARCHITECTURE.md#62-queues) — a sender that cannot
read, ACK or delete, and a sender-side key that cannot drain the queue. It is
simply not unlinkability, and the earlier text in this document that said
otherwise was wrong.

### 4.10 The platform username space contains homographs; messaging handles do not

Stated in the present tense because it is a property of the product as it ships
today, not a risk of a future one. free2z usernames are validated by Django's
`UnicodeUsernameValidator`, confirmed against the model's migration history, so
non-ASCII usernames are legal and — measured on production 2026-08-23 — **a
small, non-zero number of accounts carry one today**
([`WIRE.md` §14.2](./WIRE.md#142-checked-against-free2zs-real-username-rules--measured)).
For a threat model the count is beside the point; that it is not zero is the
point.
`@аlice` with a Cyrillic а and `@alice` with a Latin a are two different,
equally valid, equally registerable free2z accounts right now. **The homograph
attack surface in the platform's handle space is present, not hypothetical.**

Messaging handles are `[a-z0-9_]{1,30}` compared as bytes
([`WIRE.md` §14](./WIRE.md#14-handle-charset-for-messaging--blocking-pre-check-resolved)),
so the KT directory's label space contains no confusable pairs and homograph
impersonation **does not exist inside the messenger** — that is why the charset
was restricted, and it is what makes the log's labels not homograph-attackable
([`KT.md` §1.3](./KT.md#13-conventions)). **That sentence over-claims; see the
correction below.**

> **Correction (2026-08-23) — the charset removes the cross-script class of
> confusables, not every confusable.** The paragraph above is left standing
> rather than edited away, so an auditor can see exactly what was claimed and
> what replaced it. `[a-z0-9_]` **does** contain confusable pairs: `1`/`l` and
> `0`/`o` are the canonical ASCII homoglyphs and are indistinguishable in most UI
> sans-serif faces, so `@a1ice` and `@alice`, or `@b0b` and `@bob`, are two
> handles a reader cannot separate by eye. "No confusable pairs" is false as
> written, and "homograph impersonation does not exist inside the messenger" is
> true only of the cross-script kind.
>
> The scoped claim is the one that survives, and it is the one
> [`WIRE.md` §14.1](./WIRE.md#141-proposed-rule) already states — *"an entire
> class of homograph and mixed-script impersonation"*: an entire class, not every
> class. With one script and no case there is no `а`-for-`a` substitution to
> make, so a mixed-script impersonation of a messaging handle cannot be encoded
> at all and never reaches the directory. That is real and it is why the charset
> was restricted. Same-script ASCII lookalikes are **out of scope for this
> mechanism**: nothing in the protocol defends against them, and the defense is
> whatever the client does at render time and at verification time
> ([`CLIENT-CONTRACT.md` §11.3](./CLIENT-CONTRACT.md#113-the-handle-charset-and-accounts-that-cannot-have-a-handle)),
> which this document does not specify.

What that does **not** do is fix the platform. A profile page, a comment byline
or a link on free2z can still carry a homograph username, and a user who copies
a handle from one of those surfaces into a contact search is relying on the
platform's charset, not on ours. The mitigation is narrow and worth stating
exactly: such a string does not match the messaging charset, so the directory
refuses to resolve it at all, which turns a silent impersonation into a lookup
failure. Making free2z's own username space safe is backend and product work,
out of scope for this design.

The distinction that matters, since this document is read for what it claims:
this section states two *factual* properties of the platform username space —
that `UnicodeUsernameValidator` is the validator in use, and that accounts with a
non-ASCII username exist today — because both are facts an adversary can act
on, and both were measured. What it claims is **no safety property** of that
space. Nothing here should be read as asserting that free2z's username space
resists homograph or mixed-script impersonation. It does not, that is the
finding, and no part of this design changes it.

**The same mapping carries a second directory-integrity failure, and it involves
no confusable at all.** Eligibility is evaluated on the *lowercased* username,
platform case-insensitive uniqueness turns out to be an application convention in
two serializers rather than a database constraint, and production holds
case-variant duplicate accounts today. Within each colliding group, two distinct
real accounts map to one messaging handle and the directory would have to pick a
winner — the same outcome a successful homograph produces, reached without one.
It is **blocking**: those accounts must be resolved before the mapping ships. The
correction, the evidence and the intended end state (a database-level
`UniqueConstraint(Lower("username"))`) are in
[`WIRE.md` §14.3](./WIRE.md#143-the-decision-and-the-cost-accepted), and the
open question is
[`ARCHITECTURE.md` §13-O](./ARCHITECTURE.md#13-open-questions).

### 4.11 An unregistered handle is asserted, not proved

**Added 2026-08-24.** [`KT.md` §8.1](./KT.md#81-lookup) and
[§9.5](./KT.md#95-error-codes) require the directory to *prove* that a handle is
unregistered — *"'No such user' is a claim the log must prove"* — and deliberately
give the log no unknown-handle error code so it cannot dodge the requirement with
a status line. **`akd` 0.13 cannot produce that proof.** `Directory::lookup`
errors for a label with no user state, and the `NonMembershipProof` inside a
`LookupProof` proves that a returned version is the current one for a label that
*is* in the tree — a different statement. So a v1 log answers "not registered"
with an **assertion**, which `KT.md` now requires to be **labelled unproved on
the wire** ([#634](https://github.com/free2z/zuu/issues/634)).

**What the adversary gets.** A log that can assert absence without proving it can
deny that a user exists, and be indistinguishable from a log that is telling the
truth. That is the withholding attack the rest of the construction exists to
bound, arriving at the one point where the bound is missing. Concretely, a
coerced or compromised log can make `@alice` unreachable to everyone who has not
already resolved her — silently, per-victim, and with no artifact anyone can
publish afterwards, because the log signs tree heads and not lookup responses.
The absent answer is **not even non-repudiable**: a victim cannot prove they were
told it.

**What bounds it.** Three things, and none of them is the proof:

- **The label.** A client is told, in the answer, that it received an assertion
  rather than a proof, so a downgrade is *visible in the response* instead of
  inferred from its absence. That is the whole of what §8.1's correction buys,
  and it is worth having: the alternative is a client that believes it verified
  something.
- **Scope.** It is an attack on **discovery**, not on an established
  conversation. A handle a client has already resolved and pinned is unaffected —
  the pin holds, and §8.1 forbids an absent answer from weakening it. A client
  told that a handle it holds a pin for does not exist MUST fail closed and
  alarm.
- **It is loud if used broadly.** Denying a handle to many clients is a
  reputational and observable event as soon as two users compare notes out of
  band; it is quiet only against a target who never compares.

**What does not bound it: gossip and witnesses.** Both operate over tree heads
and roots. An absent answer contradicts no root — the log is not equivocating
about what is in the tree, it is declining to say — so §7's fault reports and
§8.4's gossip have nothing to exchange.

**The knock-on, because it is not obvious.** A `SubmissionReceipt` for a handle's
**first** entry cannot be turned into portable evidence of a missed merge
deadline either, for the same reason: the second half of that demonstration is a
proof that the entry is absent
([`KT.md` §5.3](./KT.md#53-the-submission-receipt)'s correction). For
`entry_version >= 2` a complete key-history proof supplies it and the evidence is
self-contained.

**Whether this is permanent.** It is a limit of the adopted library, not of the
construction — a sparse Patricia tree over VRF-derived labels *can* prove a label
absent; `akd` has no API that asks. The upstream capability that would close it
is named in [`KT.md` §11.5](./KT.md#115-what-akd-013-cannot-do-and-what-upstream-would-have-to-add),
and the question is open as
[`ARCHITECTURE.md` §13-T](./ARCHITECTURE.md#13-open-questions). Until it closes,
this is a **No** row in §5 and must appear in user-facing documentation like every
other entry in this section.

## 5. Summary: what we claim, precisely

**Every entry below is scoped by the section it cites, and the scope is part of
the claim.** A **Yes** means yes under the conditions that section states, and
nothing wider. Every correction this document carries has the same cause — a
property that holds under stated conditions, later restated without them (§3.1,
three times; §4.10, once) — so where a summary line and a section disagree, the
section's narrower reading is the one intended.

| Property | ZUULI (native) | Web (WASM) |
|---|---|---|
| Server cannot read content | **Yes**, unconditionally | **Only if the served bundle is honest** (§3.6) |
| Server cannot forge messages | **Yes** | Same caveat |
| Server cannot MITM the identity **of a handle that already has a directory entry** | **Yes, and read §3.1's three corrections** — KT inclusion + self-audit catch a substitution; append-only-ness is a *witness* property, not a client one, and it is not real until independent witnesses exist. The ADR 0014 reset path is a loud, delayed, recorded exception. For a handle with **no** entry yet, what authorizes the first one is undecided ([`KT.md` §4.4](./KT.md#44-what-authorizes-an-entry)) and this row claims nothing. | Same caveat |
| Server cannot deny that a handle exists | **No** (§4.11) — `akd` 0.13 cannot prove non-membership for an unregistered label, so absence is an assertion the log makes and the client is told is unproved. It cannot weaken a pin a client already holds. | Same |
| Server cannot MITM WebRTC | **Yes** — in-band fingerprints | Same caveat |
| Forward secrecy | **Yes** — MLS epochs | Yes, same caveat |
| Post-compromise security | **Yes** — MLS Updates | Yes, same caveat |
| PQ confidentiality (harvest-now) | **Yes** — X-Wing hybrid | Yes, same caveat |
| PQ authentication | **No** (§3.8) | No |
| Relay learns no handles or identity keys | **Yes** (§3.3) | Same |
| Relay learns no social graph | **No** — it holds the pairing table for its own queues, over opaque rotating addresses (§3.3, §4.9), and receipt timing adds to it (§4.2) | Same |
| Server retains nothing after ack | **Auditable, not verifiable** (§4.5) | Same |
| Deniability | **No** (§4.6) | No |
| Anonymity vs. global passive adversary | **No** (§3.7) | No |
| Defense against endpoint compromise | **No** (§3.5) | No |
| Defense against targeted malicious code delivery | **Yes** — signed binary, verifiable out of band | **No** (§3.6) |

The last row is the whole reason ZUULI is the trust anchor.

**Deliberately absent from this table: ephemeral hints.** A hint is a courtesy
signal that conforming clients honor and any other client ignores
([`ARCHITECTURE.md` §8.2](./ARCHITECTURE.md#82-the-ephemeral-hint-is-a-courtesy-signal-not-a-control),
§4.3). It is not a security property, so it is not listed as one — not even as a
"No" row, because a reader scanning this table for what the system does should
not encounter it here at all.
