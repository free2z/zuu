# free2z E2EE — Threat model

**Status:** Phase 0 design. Nothing described here is implemented.
**Companion:** [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`decisions/`](./decisions/). **Refs:**
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
  An attempted substitution is visible **to the victim**.
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
non-repudiable evidence against itself.

**Not defended.** Collusion of the directory operator with *t* witnesses defeats
the scheme entirely. The property is only as strong as the independence of the
witness set, and independence is a social fact we cannot verify
cryptographically. Clients should default to a witness set that is not all
free2z-operated, and the UI should make the configured set inspectable.

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

## 5. Summary: what we claim, precisely

| Property | ZUULI (native) | Web (WASM) |
|---|---|---|
| Server cannot read content | **Yes**, unconditionally | **Only if the served bundle is honest** (§3.6) |
| Server cannot forge messages | **Yes** | Same caveat |
| Server cannot MITM the identity | **Yes** — KT + self-audit + witnesses | Same caveat |
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
