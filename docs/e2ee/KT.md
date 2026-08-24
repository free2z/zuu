# free2z E2EE — Key transparency protocol, version 1

**Status:** Phase 1 specification. Nothing described here is implemented.
**Refs:** [#305](https://github.com/free2z/zuu/issues/305) (epic),
[#311](https://github.com/free2z/zuu/issues/311) (the directory),
[#544](https://github.com/free2z/zuu/issues/544) (the spike that chose `akd`),
[#554](https://github.com/free2z/zuu/issues/554) (this document),
[#133](https://github.com/free2z/zuu/issues/133) (the attack it exists to close).
**Companion:** [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`THREAT-MODEL.md`](./THREAT-MODEL.md), [`WIRE.md`](./WIRE.md),
[`decisions/`](./decisions/).
**Decides:** [ADR 0013](./decisions/0013-key-transparency-log.md).
**Implements:** [ADR 0014](./decisions/0014-directory-key-rotation.md).

This document is written to be read by a third-party security auditor and by an
independent implementer. It is [`WIRE.md`](./WIRE.md)'s analogue for the
directory: `WIRE.md` fixes the relay protocol, this fixes the key-transparency
protocol. Where a property does not hold it is stated as not holding. Where
something remains undecided it is listed in §12 and in
[`ARCHITECTURE.md` §13](./ARCHITECTURE.md#13-open-questions), not answered by
invention.

**Most of this document is invented here.**
[`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory) named the
construction and the properties in prose and specified no structure, no
signature, no cadence and no protocol; §9.3 named the witness role and specified
no message. [ADR 0013](./decisions/0013-key-transparency-log.md) settled the
construction — adopt [`akd`](https://github.com/facebook/akd) — and
[ADR 0014](./decisions/0014-directory-key-rotation.md) settled what authorizes an
entry. **Everything between those two decisions and an implementation is
invented below**, and where a choice was invented rather than inherited it says
so at the point of use. Nothing here should be read as "the merged docs already
said this."

---

## 1. Scope

### 1.1 What this document fixes

The `DirectoryEntry` structure and its authorization; the `SignedTreeHead` format
and its signing transcript; log-key rotation; epoch cadence and the maximum merge
delay; the submission receipt; the witness poll-verify-cosign protocol, its
state-update ordering and its fault evidence; the `WitnessCosignature` format;
the client verification rules and the threshold rule; the proof-serving API
surface and its stable error codes; and where `akd`'s types sit underneath ours.

### 1.2 What it deliberately does not fix

- **The client gossip protocol.** §9.3 and
  [#311](https://github.com/free2z/zuu/issues/311) make gossip load-bearing — it
  is the only anti-equivocation that functions before independent witnesses
  exist — and neither specifies a message. §8.4 defines the *evidence* a client
  would exchange and deliberately does not invent the protocol that exchanges
  it. [§13-R](./ARCHITECTURE.md#13-open-questions).
- **MLS `KeyPackage` publication and exhaustion.** Deferred out of `WIRE.md`
  §12.5 as "directory design," and still open. A `KeyPackage` is per-device,
  consumed on use, and republished — a different lifecycle from a directory entry
  and the wrong thing to put in an append-only log one entry at a time. §12.
- **Handle rename and transfer.**
  [§13-K](./ARCHITECTURE.md#13-open-questions), unchanged by this document.
- **The reset authority key's distribution and its own rotation.**
  [ADR 0014](./decisions/0014-directory-key-rotation.md) requires it to be
  published and pinned in clients. How it is pinned, and what happens when *it*
  must rotate, is not specified anywhere and is a real gap. §12.
- **The exact values of the epoch cadence and the maximum merge delay.** §5 gives
  proposed placeholders and the reasoning; the values need measurement.
  [§13-P](./ARCHITECTURE.md#13-open-questions).
- **The default threshold *t* and the shipped witness list.** §8.3 specifies the
  rule and the failure behaviour; the numbers are
  [§13-Q](./ARCHITECTURE.md#13-open-questions).

### 1.3 Conventions

- **MUST / MUST NOT / SHOULD / MAY** are used in the RFC 2119 sense.
- All integers are unsigned and **big-endian**.
- `H(label, x)` means `BLAKE2b-256(label || x)` where `label` is the exact ASCII
  bytes shown, with no separator and no terminator — the idiom
  [`WIRE.md` §1.3](./WIRE.md#13-conventions) already fixes. Note that this is
  *our* hash, used for our envelope; the hash **inside** the tree is `akd`'s and
  is fixed by the configuration in §3.2.
- Structures are written in the **TLS presentation language** and encoded with
  `tls_codec`, under all of [`WIRE.md` §3](./WIRE.md#3-serialization)'s rules —
  including **re-encode equality** ([ADR 0008](./decisions/0008-transport-and-serialization.md)).
  One codec for the whole system. The single exception is `akd`'s own proof
  bytes; see §9.4, which states the exception and why it is safe.
- **"The log"** is the directory server. **"A witness"** is an independent daemon
  per §9.3. **"A client"** is a ZUULI or WASM device
  ([ADR 0001](./decisions/0001-platform-priority.md)).
- A **handle** is `[a-z0-9_]{1,30}`, ASCII, per
  [`WIRE.md` §14](./WIRE.md#14-handle-charset-for-messaging--blocking-pre-check-resolved).
  It is the log's label, and it is why a label cannot carry a **cross-script**
  homograph: with one script and no case there is no `а`-for-`a` substitution to
  encode. Same-script ASCII lookalikes (`1`/`l`, `0`/`o`) are in the label space
  and are out of scope for the directory — see
  [`THREAT-MODEL.md` §4.10](./THREAT-MODEL.md#410-the-platform-username-space-contains-homographs-messaging-handles-do-not).

---

## 2. Roles

| Role | Holds | Reachability | Fails how |
|---|---|---|---|
| **Log** | The tree, every entry, the log signing key, the VRF key | Public HTTPS listener | Can equivocate, can withhold, can refuse. Cannot forge an entry (§4.4) or forge a cosignature. |
| **Witness** | Its own signing key, and its last accepted tree head — a few hundred bytes | **Outbound only.** No inbound port, no TLS certificate, no domain, no database | Can refuse to sign, can sign falsely, can cosign without checking (§7.4). Cannot make a client accept a root alone unless *t* = 1. |
| **Client** | Its own keys, its pinned view of handles it has resolved, its witness policy | Outbound only | Can be lied to if the witness set is not independent. |
| **Reset authority** | An offline key, per [ADR 0014](./decisions/0014-directory-key-rotation.md) | Not networked | Compromise is compromise of every handle without `no_reset`. |

The log and the platform are the same party in practice at launch, and this
document does not pretend otherwise. Everything below is written on the
assumption that the log is the adversary
([`THREAT-MODEL.md` §3.1](./THREAT-MODEL.md#31-malicious-or-compromised-free2z-server)),
because that is the only assumption that makes the machinery worth building.

---

## 3. What `akd` provides, and what we add

### 3.1 The zero-knowledge set

[ADR 0013](./decisions/0013-key-transparency-log.md) adopts `akd` for the
append-only zero-knowledge set: a sparse Patricia tree over **VRF-derived**
labels holding **commitments** to values, with membership, non-membership and
append-only proofs. That is the entire cryptographic core of §9.2's construction,
and it is the part we do not write.

It is also **all** we get. `akd` ships no signed tree heads, no cosigning, no
gossip, no receipts and only an in-memory `Database`. The table:

| Layer | Whose |
|---|---|
| Sparse tree, VRF labels, commitments | `akd_core` / `akd` |
| Membership / non-membership proof + verifier | `akd_core::verify::lookup` |
| Key-history proof + verifier | `akd_core::verify::history` |
| Append-only proof + verifier | `akd::auditor::audit_verify` (server crate — §11.3) |
| Root hash at an epoch | `akd` (`Azks`) |
| **`DirectoryEntry` and its authorization (§4)** | **ours** |
| **`SignedTreeHead`, its transcript, log-key rotation (§6)** | **ours** |
| **Epoch cadence, maximum merge delay, receipts (§5)** | **ours** |
| **Witness protocol, `WitnessCosignature`, fault evidence (§7)** | **ours** |
| **Threshold rule, fail-closed behaviour, gossip (§8)** | **ours** |
| **Proof-serving API (§9)** | **ours** |
| **Durable storage backend (§11.2)** | **ours** |

### 3.2 Configuration, and why the choice is permanent

`akd` is generic over a `Configuration` that fixes the hash function, the label
derivation and the commitment scheme. **We use `WhatsAppV1Configuration`**, not
`ExperimentalConfiguration`.

Two reasons, and the second is the real one. It is the configuration with a
production deployment behind it, and it is the configuration the NCC Group review
of the VRF and commitment construction most closely tracks
([ADR 0013](./decisions/0013-key-transparency-log.md)). An experimental
configuration in a directory that is meant to outlive the product's first
rewrite is a bad trade for whatever it improves.

**The choice is not changeable later.** The configuration determines every label
and every commitment in the tree, so changing it invalidates every proof ever
issued and every root ever cosigned. Migrating configurations means standing up a
**new log with a new `log_id`** and having clients re-pin, which is a
distinguishable event and not a silent upgrade. Treat it as permanent.

### 3.3 Label and value

```
AkdLabel = "free2z/kt/v1/handle:" || handle        (ASCII, handle per §1.3)
AkdValue = H("free2z/kt/v1/value", tls_codec(DirectoryEntry))     (32 bytes)
```

> **Invented here.** `akd` does not care what bytes a label or value contains.
> Both shapes are ours.

The label prefix is domain separation against the same log ever being asked to
hold a second kind of record. It is inside the VRF input, so it is not visible in
the tree and costs nothing in privacy.

**The tree commits to a 32-byte hash of the entry, not to the entry.** The full
`DirectoryEntry` is served alongside the proof (§9.2) and the client recomputes
the hash and compares. This is the standard CONIKS shape and it buys three
things: the tree stays small regardless of how many device credentials a user
accumulates; the value the log commits to covers the entry's **authorization**
as well as its contents, so an entry cannot be re-authorized after publication;
and an entry can be served, cached and gossiped as an ordinary blob without
touching the tree.

What it does **not** buy is confidentiality of the entry. A `DirectoryEntry` is
public by design — it is how `@alice` is discoverable — and the zero-knowledge
property protects the entries you did *not* ask for, not the one you did. See
[`THREAT-MODEL.md` §4.1](./THREAT-MODEL.md#41-directory-lookup-reveals-interest-in-a-handle).

---

## 4. `DirectoryEntry`

### 4.1 Structure

```
struct {
    opaque label<0..255>;              /* exactly "free2z/device-credential/v1" */
    opaque identity_pk[32];            /* ISK.public — ARCHITECTURE.md §4.2      */
    opaque handle<1..30>;
    opaque device_pk[32];              /* DSK.public, the MLS leaf signature_key */
    opaque device_kem_pk<1..2^16-1>;   /* X-Wing hybrid (X25519 + ML-KEM-768)    */
    uint64 not_before_ms;
    uint64 not_after_ms;
} DeviceCredentialTBS;

struct {
    DeviceCredentialTBS credential;
    opaque              signature[64];  /* Ed25519 by identity_pk */
} DeviceCredential;
```

`DeviceCredential` is **self-contained on purpose**, repeating `identity_pk` and
`handle` that the enclosing entry also carries. It is carried as the MLS
`Credential` in a member's `LeafNode`
([`ARCHITECTURE.md` §4.2](./ARCHITECTURE.md#42-derivation-proposed)), where it is
validated by peers who have no directory access at all, so it cannot depend on
its envelope for meaning.

```
struct {
    opaque device_pk[32];
    uint64 revoked_at_ms;
    opaque reason<0..255>;    /* human-readable, advisory, never parsed */
} DeviceRevocation;

struct {
    opaque relay_url<1..255>;   /* wss://…/relay/v1 */
    opaque relay_id[32];        /* WIRE.md §5.2     */
    opaque contact_addr[32];    /* WIRE.md §12.2    */
} ContactEndpoint;

enum { same_key(1), key_change(2), platform_reset(3), (255) } EntryKind;

struct {
    opaque            label<0..255>;      /* exactly "free2z/kt/v1/entry" */
    uint16            kt_version;         /* 0x0001 */
    opaque            log_id[32];         /* §6.1 */
    opaque            handle<1..30>;
    uint32            entry_version;      /* §4.2 */
    EntryKind         kind;
    opaque            identity_pk[32];         /* ISK.public in force from here on   */
    opaque            directory_auth_pk[32];   /* DirectoryAuthKey.public — §4.4     */
    DeviceCredential  devices<0..2^16-1>;
    DeviceRevocation  revocations<0..2^16-1>;
    ContactEndpoint   contact_endpoints<0..2^16-1>;
    opaque            prev_entry_hash[32];     /* §4.2; all-zero at entry_version 1  */
    uint8             no_reset;                /* ADR 0014 */
    uint64            created_at_ms;
} DirectoryEntryTBS;

struct {
    DirectoryEntryTBS  entry;
    EntryAuthorization authorization;     /* §4.4 */
} DirectoryEntry;
```

Note what is **not** in it: no display name, no avatar, no profile field, no
relay list beyond contact endpoints, and no `KeyPackage`. A directory entry is
an append-only public record that every peer of the user will fetch; every field
added to it is a field published forever about everyone. Mutable profile data
belongs on the platform, where it can be changed and deleted.

### 4.2 Versions and the hash chain

`entry_version` is the `akd` version for this label. It **MUST** start at 1 and
increase by exactly 1. The log MUST reject a gap or a repeat.

`prev_entry_hash = H("free2z/kt/v1/prev", tls_codec(previous DirectoryEntry))` —
over the previous entry **including its authorization** — and all-zero at version
1.

The chain is redundant with the tree, which is the point. It means a client
holding a sequence of entries can check their order and completeness **without
the log**, from the bytes alone, and can therefore gossip a chain segment as
self-contained evidence (§8.4). It also means a log that serves a client a
truncated history has to break a hash rather than merely omit a proof.

`created_at_ms` is the **submitter's** clock. It is signed by the submitter, so
it is authenticated, and it is not trustworthy — a submitter can lie about it.
Ordering is established by `entry_version` and by the epoch the entry appears in,
never by this field. It exists so that a user's own client can display when it
made a change.

### 4.3 Uniqueness within an epoch — a MUST that comes from the audit

**The log MUST accept at most one entry per handle per epoch.** A second
submission for a handle whose previous entry is not yet published MUST be
rejected with `ERR_VERSION_CONFLICT` (§9.5); it is the submitter's job to retry
against the published state.

This is not a convenience rule. NCC Group's Medium-severity finding against
`akd` was *"multiple key updates during epoch results in invalid state"* —
`publish()` with duplicate labels in one batch left a dangling interior node and
**no valid key for the user**
([ADR 0013](./decisions/0013-key-transparency-log.md)). The library defect is
fixed; the property that a caller must not hand `publish()` duplicate labels is
a property of the *integration*, which is precisely the region NCC said its
review did not cover. Enforce it in our submission path and assert it in a test.

### 4.4 What authorizes an entry

[ADR 0014](./decisions/0014-directory-key-rotation.md) decides this; the
encoding is here.

```
struct {
    opaque label<0..255>;      /* exactly "free2z/kt/v1/rotation" */
    opaque log_id[32];
    opaque handle<1..30>;
    uint32 entry_version;      /* the version this proof authorizes */
    opaque old_identity_pk[32];
    opaque new_identity_pk[32];
    opaque prev_entry_hash[32];
    uint64 created_at_ms;
} RotationProofTBS;

struct {
    RotationProofTBS proof;
    opaque           signature[64];   /* Ed25519 by old_identity_pk */
} RotationProof;

struct {
    opaque label<0..255>;      /* exactly "free2z/kt/v1/reset" */
    opaque log_id[32];
    opaque handle<1..30>;
    uint32 entry_version;
    opaque old_identity_pk[32];
    opaque new_identity_pk[32];
    uint64 created_at_ms;
    uint64 effective_at_ms;    /* >= created_at_ms + cooldown; ADR 0014 */
} ResetAuthorizationTBS;

struct {
    ResetAuthorizationTBS reset;
    opaque                signature[64];   /* Ed25519 by the pinned reset authority key */
} ResetAuthorization;

struct {
    EntryKind kind;                        /* MUST equal entry.kind */
    select (EntryAuthorization.kind) {
        case same_key:
            struct { opaque auth_signature[64]; };
        case key_change:
            struct { RotationProof rotation; opaque auth_signature[64]; };
        case platform_reset:
            struct { ResetAuthorization reset; opaque auth_signature[64]; };
    } body;
} EntryAuthorization;
```

`auth_signature` is Ed25519 over `tls_codec(DirectoryEntryTBS)`, by:

| `kind` | `auth_signature` by | Plus |
|---|---|---|
| `same_key` | the `directory_auth_pk` **published in the previous entry** | — |
| `key_change` | the `directory_auth_pk` **in this entry** (the new key) | a `RotationProof` signed by the **outgoing `identity_pk`** |
| `platform_reset` | the `directory_auth_pk` **in this entry** | a `ResetAuthorization` signed by the pinned reset authority key |

> **Invented here — a narrowing of `ARCHITECTURE.md` §4.2 that a reader should
> notice.** §4.2's key table says the `IdentitySigningKey` "signs device
> credentials and directory entries" and that the `DirectoryAuthKey`
> "authenticates directory updates." Those overlap, and an implementer would have
> to guess. We split them: **ISK signs `DeviceCredential`s and `RotationProof`s;
> `DirectoryAuthKey` signs the entry envelope and self-audit queries.** The
> reason is blast radius — a routine update (adding a device, rotating a contact
> endpoint) then never touches the key peers pin and display as a safety number,
> while the two operations that *change what a peer trusts* — issuing a device
> credential and rotating the identity — both require ISK. Both keys are derived
> from the same `account_node`, so this is a use-separation, not an independence
> claim: compromise of the seed yields both.

Verification rules the log MUST apply, in order, before an entry enters a batch:

1. Re-encode equality on the submitted bytes
   ([`WIRE.md` §3.3](./WIRE.md#33-the-re-encode-equality-rule--mandatory)).
2. `label`, `kt_version` and `log_id` are exactly this log's.
3. `handle` matches the charset rule and `entry_version` is `previous + 1` (or 1).
4. `prev_entry_hash` matches the published previous entry.
5. `authorization.kind == entry.kind`, and the table above holds.
6. For `key_change`: the `RotationProof`'s `old_identity_pk` equals the previous
   entry's `identity_pk`, its `new_identity_pk` equals this entry's, its
   `entry_version` and `prev_entry_hash` match, and its signature verifies.
   **A key change carrying only one of the two signatures MUST be rejected.**
7. For `platform_reset`: the reset signature verifies under the pinned reset
   authority key, `effective_at_ms - created_at_ms` is at least the published
   cooldown, and the log MUST NOT publish the entry before `effective_at_ms`.
8. Every `DeviceCredential` signature verifies under this entry's `identity_pk`,
   and no two credentials share a `device_pk`.
9. §4.3's uniqueness rule.

**And the thing an implementer must understand about all of that: `akd` enforces
none of it.** The library will happily commit any bytes to any label. Every rule
above lives in our submission path, and a log that skips them produces
inclusion, history and append-only proofs that verify **perfectly** for entries
nobody authorized. The transparency machinery proves that the log did not
*change its mind*; §4.4 is the only thing that proves the log did not *make it
up*. This is the integration NCC declined to review, and it is the highest-value
target in the system for our own testing.

**What the log cannot do, and it is worth saying:** it cannot forge
`auth_signature` or a `RotationProof`, so it cannot rotate a live key. What it
*can* do is refuse a legitimate submission, or publish a
`platform_reset` — which by [ADR 0014](./decisions/0014-directory-key-rotation.md)
is loud, delayed and permanently counted, and is a real weakening announced
rather than hidden.

---

## 5. Epochs and the merge promise

### 5.1 Cadence

> **Invented here, and the values are proposed placeholders.**
> [§13-P](./ARCHITECTURE.md#13-open-questions). The *structure* of the rule
> matters more than the numbers, and is what §5.3 depends on.

- **The log publishes an epoch every `epoch_interval` seconds — proposed 600 —
  whether or not there is anything to publish.** An epoch with no submissions is
  a valid epoch: same monotonicity, same signature, same cosignatures, an
  append-only proof over zero insertions.
- Each published epoch increments `epoch` by exactly 1.
- Within an epoch, at most one entry per handle (§4.3).
- `epoch_interval` and `max_merge_delay_seconds` are published in the log
  descriptor (§9.1) and in every `SignedTreeHead` (§6.1).

**Publishing empty epochs is the load-bearing part.** A log that publishes only
when it has work makes silence ambiguous: a witness that sees nothing for six
hours cannot distinguish "nobody changed a key" from "the log has stopped" from
"the log is serving me a stale branch while it serves someone else a fresh one."
A heartbeat epoch costs a signature and a near-empty proof, and converts that
ambiguity into a **detectable fault** with a timestamp attached. Empty epochs
also cost the witness almost nothing, because the append-only proof is
O(entries added) (§10) and an empty epoch adds none.

### 5.2 Maximum merge delay

**`max_merge_delay_seconds` — proposed 3600, six epochs — is the log's published
promise that an accepted submission will appear in a published, signed tree head
within that window.**

This is Certificate Transparency's MMD, and it is here for CT's reason: without
it, "the log accepted my entry and then never published it" is a complaint, not
a fault. With it, the same situation is a **breach of a signed promise with a
deadline**, and the evidence is two documents anyone can check.

### 5.3 The submission receipt

> **Invented here.** The RFC 6962 SCT analogue. Nothing in §9.2 or `akd` has one.

```
struct {
    opaque label<0..255>;      /* exactly "free2z/kt/v1/receipt" */
    uint16 kt_version;
    opaque log_id[32];
    opaque handle<1..30>;
    uint32 entry_version;
    opaque entry_hash[32];     /* == AkdValue, §3.3 */
    uint64 received_at_ms;
    uint64 merge_by_ms;        /* received_at_ms + max_merge_delay_seconds*1000 */
} SubmissionReceiptTBS;

struct {
    SubmissionReceiptTBS receipt;
    opaque               signature[64];   /* Ed25519 by the log signing key */
} SubmissionReceipt;
```

The log MUST return a receipt on every accepted submission, and MUST NOT return
one for a submission it rejects. A client MUST store the receipt until it has
seen the entry included under a cosigned tree head.

**What the receipt proves.** A `SubmissionReceipt` with `merge_by_ms` in the
past, together with the cosigned `SignedTreeHead` chain covering that instant
and a non-membership proof for `(handle, entry_version)` at the latest of those
roots, is a self-contained, self-authenticating demonstration that the log broke
a signed promise. It needs no trust in the complainant. Publish it.

**What it does not prove, stated because a receipt looks stronger than it is.**

- It does not prove the log *will* publish. It converts a silent failure into a
  provable one. That is the whole of its value.
- It does not prove anyone else saw the promise. A log can hand a receipt to one
  user and to nobody else; the receipt is evidence only once it is published,
  which the victim must actually do.
- It does not defend against a log that includes the entry in a **fork**. The
  entry appears, the receipt is honoured, and the root it appears under is one
  only this user is shown. That is equivocation, and §7 is what addresses it.
- A log that refuses to issue receipts at all is refusing service — visible,
  and not something a receipt can fix.

---

## 6. `SignedTreeHead`

### 6.1 Structure

```
struct {
    opaque label<0..255>;         /* exactly "free2z/kt/v1/sth" */
    uint16 kt_version;            /* 0x0001 */
    opaque log_id[32];            /* H("free2z/kt/v1/log-id", genesis_log_pk) */
    uint64 epoch;
    uint64 tree_size;             /* total (label, version) insertions committed */
    opaque root_hash[32];         /* the akd Azks root at this epoch */
    opaque prev_sth_hash[32];     /* H("free2z/kt/v1/tree-head-hash", tls_codec(prev SignedTreeHeadTBS)) */
    opaque vrf_public_key[32];    /* the ECVRF key labels are derived under */
    uint64 published_at_ms;
    uint32 reset_count;           /* platform resets in this epoch — ADR 0014 */
    uint32 epoch_interval_seconds;
    uint32 max_merge_delay_seconds;
    opaque successor_log_pk[32];  /* all-zero = none; §6.4 */
} SignedTreeHeadTBS;

struct {
    SignedTreeHeadTBS sth;
    opaque            signature[64];   /* Ed25519 over tls_codec(sth) */
} SignedTreeHead;
```

`log_id` is derived from the log's **genesis** signing key and **never changes**,
including across a signing-key rotation (§6.4). If it changed, every rotation
would present as a new log and every client's pinned history would be discarded
— which is exactly the state an attacker wants a client in.

`reset_count` is [ADR 0014](./decisions/0014-directory-key-rotation.md)'s
requirement that platform resets be "counted per epoch, with the count published
alongside the tree head." It is in the signed contents, so an abnormal rate is
visible to anyone tracking tree heads without a single per-handle lookup.

`vrf_public_key` is carried in every tree head so that a client can detect a
change. It **MUST NOT** change within a `log_id`: it determines every label in
the tree, so changing it silently invalidates every prior proof while producing
proofs that still verify under the new key. A client or witness that observes a
`vrf_public_key` change MUST treat it as a fork (§7.3), not as an update.

> **Correction (2026-08-24) — the tree-head digest label was renamed, and the
> old one must not be used.** As first published, this document computed
> `prev_sth_hash` and `announce_sth_hash` (§6.4) under the label formed by
> appending `-hash` to `free2z/kt/v1/sth`. That label was a **proper prefix
> violation**: `free2z/kt/v1/sth` — the signing-transcript constant of
> `SignedTreeHeadTBS` two paragraphs below — is a proper prefix of it, and
> [`WIRE.md` §1.3](./WIRE.md#13-conventions) defines `H(label, x)` as
> `BLAKE2b-256(label || x)` with **no separator and no terminator**. A digest
> taken in the `free2z/kt/v1/sth` domain over any message whose first five bytes
> were `-hash` was therefore bit-identical to a digest taken in the old
> tree-head-digest domain over the remainder: between those two domains,
> separation was absent rather than weakened, over exactly the structure the
> anti-equivocation argument in §7 rests on.
>
> The label is now **`free2z/kt/v1/tree-head-hash`**, which no other label in the
> namespace prefixes and which prefixes no other. **Any digest computed under the
> old label is invalid and MUST be recomputed**; no shipped code held the old
> value — the crates that will use these labels are not written — but an
> implementer working from the first revision of this document must change it.
> `WIRE.md` §1.3 now states prefix-freeness as a normative requirement on the
> union of every document's labels rather than leaving it an unwritten
> assumption, and `scripts/check-hash-domain-labels.mjs` enforces it on every
> pull request. [#602](https://github.com/free2z/zuu/issues/602); predicted in
> [#552](https://github.com/free2z/zuu/issues/552).

### 6.2 The signing transcript, and domain separation

The signature is Ed25519 over `tls_codec(SignedTreeHeadTBS)` — **signed
directly, not prehashed**; the structure is small and fixed-shape, the same
reasoning [`WIRE.md` §5.1](./WIRE.md#51-construction) uses for the command
transcript.

Domain separation is the `label` field, first, inside the signed bytes: every
structure this document signs carries a distinct, versioned constant in its first
field, and a verifier MUST check it before anything else. The set is closed:

| Constant | Structure | Signer |
|---|---|---|
| `free2z/kt/v1/sth` | `SignedTreeHeadTBS` | log |
| `free2z/kt/v1/cosig` | `WitnessCosignatureTBS` | witness |
| `free2z/kt/v1/receipt` | `SubmissionReceiptTBS` | log |
| `free2z/kt/v1/entry` | `DirectoryEntryTBS` | user's `DirectoryAuthKey` |
| `free2z/kt/v1/rotation` | `RotationProofTBS` | user's outgoing ISK |
| `free2z/kt/v1/reset` | `ResetAuthorizationTBS` | reset authority |
| `free2z/kt/v1/log-key-transition` | `LogKeyTransitionTBS` | log, both keys |
| `free2z/kt/v1/fault` | `FaultReportTBS` | witness |
| `free2z/device-credential/v1` | `DeviceCredentialTBS` | user's ISK |

The reason to be strict about it: the log's signing key signs tree heads,
receipts and key transitions. Without an in-band, checked type constant, a
verifier that accepts a signature "from the log" over bytes it did not
type-check is one field-alignment coincidence away from accepting a receipt as a
tree head. The label makes the structures non-interchangeable by construction and
costs a few bytes an epoch.

### 6.3 Monotonicity

A `SignedTreeHead` is acceptable to a client or witness **only if all of the
following hold** against the last one it accepted for this `log_id`:

1. `signature` verifies under the log key currently accepted for `log_id` (§6.4).
2. `label`, `kt_version`, `log_id` are exact.
3. `epoch > last.epoch`.
4. `tree_size >= last.tree_size`.
5. `published_at_ms > last.published_at_ms`.
6. `vrf_public_key == last.vrf_public_key`.
7. **The `prev_sth_hash` chain connects.** If `epoch == last.epoch + 1`, then
   `prev_sth_hash == H("free2z/kt/v1/tree-head-hash", tls_codec(last.sth))` directly.
   If `epoch > last.epoch + 1`, the verifier MUST fetch every intervening tree
   head and check the chain link by link. **It MUST NOT skip.** A gap accepted on
   trust is a branch accepted on trust.
8. If `epoch == last.epoch`: `root_hash`, `tree_size` and `published_at_ms` must
   all be **identical**. Anything else is a fork and is fatal (§7.3).

Rules 3 and 8 together are the rollback and fork tests. A client MUST apply them
too, not only a witness — they are cheap, they need no proof, and they are the
only part of the log's honesty a client can check unaided.

### 6.4 Log signing-key rotation

> **Invented here.** Nothing in the merged docs contemplates the log's own key
> changing, and it will: keys get rotated, HSMs get replaced, operators change.
> A design with no rotation path gets an ad-hoc one at the worst moment.

A tree head MAY announce a successor by setting `successor_log_pk` to a non-zero
value. The transition then requires:

```
struct {
    opaque label<0..255>;        /* exactly "free2z/kt/v1/log-key-transition" */
    opaque log_id[32];
    uint64 announce_epoch;       /* the epoch of the announcing STH */
    opaque announce_sth_hash[32];/* H("free2z/kt/v1/tree-head-hash", tls_codec(announcing sth)) */
    opaque outgoing_log_pk[32];
    opaque successor_log_pk[32];
    uint64 effective_epoch;      /* first epoch signed by the successor */
} LogKeyTransitionTBS;

struct {
    LogKeyTransitionTBS transition;
    opaque              outgoing_signature[64];
    opaque              successor_signature[64];
} LogKeyTransition;
```

**A client or witness accepts `successor_log_pk` only if all of these hold:**

1. It observed the **announcing** tree head itself, signed by the outgoing key
   and carrying **≥ *t* valid witness cosignatures** from its own configured
   witness set (§8.3) — the same threshold it applies to any root.
2. `effective_epoch > announce_epoch`, with at least one full epoch of separation,
   so the announcement is visible before it takes effect.
3. It holds a `LogKeyTransition` whose `announce_sth_hash` matches that tree head,
   with **both** signatures valid — outgoing and successor.
4. The first tree head signed by the successor chains by `prev_sth_hash` to the
   last one signed by the outgoing key, and satisfies §6.3 in full.

**Why the cosignature requirement is not optional, stated plainly: without it, a
key change is indistinguishable from a fork.** A party that accepts a new signing
key on the strength of a signature by that same new key accepts any key from any
attacker. A party that accepts it on the outgoing key's signature alone is safe
only until the outgoing key is the thing that was compromised — which is the most
likely reason to be rotating. Requiring that the *announcement* was itself
witnessed means an attacker must have already defeated the threshold to install
their key, at which point they did not need the rotation path. The structure is
deliberately the same shape as
[ADR 0014](./decisions/0014-directory-key-rotation.md)'s user key change: dual
signature, plus published evidence, plus a delay.

**A witness that cannot satisfy these conditions MUST halt and report
`FaultKind.bad_signature`, not fall back to trusting the new key.** Failing to
follow a log is the correct behaviour; following it into an unverifiable key
change is not.

**Honest limit:** if the outgoing key is lost outright rather than rotated, there
is no path here. The log stands up a new `log_id` and every client re-pins, which
is exactly as disruptive as it sounds and exactly as visible. That is the right
trade — there is no way to make "the log lost its key" both recoverable and
distinguishable from "someone stole the log."

---

## 7. The witness protocol

### 7.1 The loop

A witness holds one piece of durable state — `(log_id, epoch, tree_size,
root_hash, sth_hash, accepted_log_pk)`, a few hundred bytes — and runs:

1. **Poll.** `GET /kt/v1/sth` over outbound HTTPS (§9.2). No inbound port.
2. **Verify the tree-head signature** under `accepted_log_pk`, and the `label` /
   `kt_version` / `log_id` constants. Fail → §7.3.
3. **Check §6.3's monotonicity and chain**, fetching every intervening tree head
   if the poll skipped epochs. Rollback, fork, chain break, or a changed
   `vrf_public_key` → **halt and report (§7.3). Do not advance.**
4. **Fetch the append-only proof** for `(last.epoch, new.epoch]` and **verify it**
   with `akd::auditor::audit_verify` against the two root hashes. Fail → §7.3.
5. **Persist** the new state, durably — `fsync` and atomic rename — **before**
   emitting anything.
6. **Emit** the `WitnessCosignature` (§7.2): `POST /kt/v1/cosign` to the log, and
   append it to the witness's own published cosignature history (§7.5).

**Step 5 precedes step 6, and the order is a correctness requirement, not
hygiene.** A witness that emits first and crashes before persisting comes back
believing it is still at the old epoch. It will then happily cosign whatever it
is served for that epoch next — and if the log serves it a *different* root, the
witness has now signed two contradictory statements for one epoch. That is
exactly the non-repudiable evidence §7.2 is designed to produce, and the witness
manufactured it against itself for a fault that was its own crash. Persist first
and the worst case is a missed cosignature, which is invisible and harmless.

A witness MUST NOT "catch up" past a fault. Once halted it stays halted until a
human looks at the evidence. An automatic resync is an automatic way to erase the
only record of the thing the witness exists to find.

### 7.2 `WitnessCosignature`

```
struct {
    opaque label<0..255>;    /* exactly "free2z/kt/v1/cosig" */
    uint16 kt_version;
    opaque log_id[32];
    uint64 epoch;
    uint64 tree_size;
    opaque root_hash[32];
    opaque witness_pk[32];
    uint64 observed_at_ms;
} WitnessCosignatureTBS;

struct {
    WitnessCosignatureTBS statement;
    opaque                signature[64];   /* Ed25519 by witness_pk */
} WitnessCosignature;
```

**It signs the contents — `log_id`, `epoch`, `tree_size`, `root_hash` — and not
the log's signature over them.** Three consequences, and the design is chosen for
all three:

1. **The statement is verifiable by someone who never saw the log's signature**,
   and who does not have or trust the log's public key. "Witness W says the log
   with id L had root R at epoch E with size S" is a complete, checkable claim
   from the cosignature bytes and W's public key alone. A cosignature over the
   log's signature bytes would be meaningless without first obtaining the log's
   signature *and* its key, from the very party under suspicion.
2. **Two conflicting statements are directly non-repudiable against the
   witness.** Two `WitnessCosignature`s with the same `(log_id, epoch)` and
   differing `(tree_size, root_hash)`, both verifying under `witness_pk`, are a
   contradiction on their face. No third document is needed to establish it. That
   is what makes a witness accountable rather than merely helpful.
3. **`witness_pk` is inside the signed bytes**, so a cosignature cannot be
   re-attributed to another witness, and a witness cannot later claim a
   cosignature was someone else's.

`observed_at_ms` is deliberately **excluded from the contradiction test**: two
cosignatures over the same root at different times are not a conflict, they are
normal. The test is exactly `(log_id, epoch)` equal and `(tree_size, root_hash)`
differing.

**What a cosignature does not say.** It does not say the witness verified the
append-only proof — §7.4. It does not say the root is *correct*, only that this
witness saw it and that its own history is consistent with it. And a witness that
never cosigns at all is indistinguishable from one that is offline; absence is
not evidence.

### 7.3 Refuse, and record

On any fault the witness **refuses to cosign, halts on that log, and writes
evidence**.

```
enum {
    rollback(1),               /* epoch or root moved backwards           */
    fork(2),                   /* same epoch, different root or size      */
    chain_break(3),            /* prev_sth_hash does not connect          */
    bad_signature(4),          /* STH or key-transition signature invalid */
    append_only_failure(5),    /* audit_verify rejected                   */
    vrf_key_change(6),         /* vrf_public_key changed within a log_id  */
    merge_delay_exceeded(7),   /* a receipt's merge_by_ms passed unmet    */
    (255)
} FaultKind;

struct {
    opaque         label<0..255>;   /* exactly "free2z/kt/v1/fault" */
    uint16         kt_version;
    opaque         log_id[32];
    FaultKind      kind;
    opaque         witness_pk[32];
    SignedTreeHead a<0..2^24-1>;    /* the tree heads the witness holds, in order */
    SignedTreeHead b<0..2^24-1>;    /* the conflicting ones, empty where n/a      */
    opaque         detail<0..2^24-1>; /* proof bytes, or a SubmissionReceipt      */
    uint64         observed_at_ms;
} FaultReportTBS;

struct {
    FaultReportTBS report;
    opaque         signature[64];   /* Ed25519 by witness_pk */
} FaultReport;
```

**Which of these are self-authenticating, and which are only an accusation — say
it, because the difference decides what a report is worth.**

| `kind` | Self-authenticating? |
|---|---|
| `rollback`, `fork`, `chain_break`, `bad_signature`, `vrf_key_change` | **Yes.** The evidence is two or more tree heads signed by the log's own key. Anyone with the log's public key checks it in milliseconds and needs to trust nobody. |
| `merge_delay_exceeded` | **Yes**, given the `SubmissionReceipt` in `detail` plus a non-membership proof at the covering root — all log-signed. |
| `append_only_failure` | **No.** The claim is "this proof does not verify," and a third party must re-run `audit_verify` on the bytes in `detail` to see it. A witness could report this falsely, and a log could serve a bad proof to one witness only. It is a **prompt to check**, not a verdict. |

The witness's own signature on a `FaultReport` binds it to the accusation, which
is the point: a witness that cries wolf is on the record too.

Where fault reports are published, and who is expected to act on one, is not
specified here — it is a social and operational question, and inventing a
notification protocol would be pretending we have an answer. What the format
guarantees is that the evidence is portable.

### 7.4 A witness that does not verify the append-only proof is worthless

Step 4 of §7.1 is the entire reason the role exists. Restated so it cannot be
skipped by an implementer optimising a poll loop:

- A witness that verifies the **signature** and cosigns is attesting that the log
  signed something. **The log's own signature already proved that.** Such a
  cosignature adds exactly zero information.
- A witness that verifies **monotonicity** and cosigns detects a log that
  contradicts itself *in the stream that witness was shown*. Useful, and much
  weaker than it sounds: a log that maintains two internally-consistent branches
  and shows each witness only one passes every monotonicity check every time.
- Only the **append-only proof** establishes that the new root extends the old
  one rather than replacing part of it. It is the only check that catches the
  attack in
  [ADR 0013](./decisions/0013-key-transparency-log.md) — a value rewritten under
  a proof that still verifies — and it is the check
  [`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory) establishes that
  **no client can run for itself**, because the proof is O(entries added):
  3.9 MB and 1–3 seconds for five epochs (§10).

There is no way for a client to tell a lazy witness from a diligent one by
inspecting cosignatures. That is stated as an undefended weakness in
[`THREAT-MODEL.md` §3.9](./THREAT-MODEL.md#39-malicious-directory-witness). What
this specification does about it is structural rather than cryptographic:

- **The log and the witness MUST link the same verifier.** `audit_verify` is
  `akd`'s, used by both, at the same pinned version
  ([ADR 0013](./decisions/0013-key-transparency-log.md)'s floor). "Cosign without
  verifying" is then not a state a conforming implementation can drift into by
  omission — it takes deleting a call, not forgetting one — and a divergence
  between what the log believes it published and what a witness accepts cannot
  come from two implementations disagreeing, because there are not two.
- **Witnesses publish their cosignature history** (§7.5), so a third party can
  fetch the proofs for the epochs a witness claims to have cosigned and re-derive
  the verification independently. This does not prove the witness *did* check; it
  makes it possible for anyone to check that the thing the witness attested to is
  actually true.

A witness that is actively malicious simply removes the check, and we will not
know. The mitigation for that is the independence of the witness set, not code.

### 7.5 Witness state and publication

Durable state is `(log_id, accepted_log_pk, epoch, tree_size, root_hash,
sth_hash)` — a few hundred bytes in a file, per §9.3's promise that a witness
needs no database. Updates are `fsync` plus atomic rename (§7.1 step 5).

A witness SHOULD publish, at a stable URL of its own choosing:

- every `WitnessCosignature` it has emitted, appendable and complete;
- every `FaultReport` it has written;
- its public key and a human contact.

This matters more than it looks. If the **log** is the only distributor of
cosignatures — which is the convenient design, and is why §9.2 has the log serve
them — then the party under audit controls the distribution of the evidence used
to audit it. It can withhold a cosignature it does not like and simply appear to
have fewer witnesses that epoch. A client SHOULD therefore fetch cosignatures
directly from at least one witness it configured, not exclusively from the log.
This is stated as a SHOULD rather than a MUST because a client that can only
reach the log is still better off applying the threshold to what the log serves
than applying nothing; but a client that *only ever* asks the log has a weaker
guarantee than the threshold rule appears to give it.

---

## 8. The client

### 8.1 Lookup

To resolve `@alice`:

1. `POST /kt/v1/lookup` (§9.2). The response carries the latest
   `SignedTreeHead`, its cosignatures, `akd`'s `LookupProof`, and the full
   `DirectoryEntry` bytes.
2. Apply §6.3's monotonicity checks against the client's pinned view of this
   `log_id`. **Any failure is fatal and is fork evidence** — a client can and
   MUST make these checks itself.
3. Apply §8.3's threshold rule to the cosignatures.
4. Recompute `AkdValue = H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` from
   the returned entry bytes, under re-encode equality, and use **that** as the
   value in `lookup_verify` — never a value the log asserts.
5. `akd_core::verify::lookup::lookup_verify` against `root_hash` and
   `vrf_public_key` from the verified tree head.
6. Verify the entry's own authorization (§4.4) — the log's proof says the entry
   is *in the tree*, not that it was *authorized*.
7. Pin `(handle, identity_pk, entry_version, prev_entry_hash, epoch)`.

**A handle that is not registered returns a proof of non-membership, not an
error.** This is worth contrasting with
[`WIRE.md` §10](./WIRE.md#10-error-codes)'s existence-oracle rule, which
collapses "no such queue" and "not yours" into one code precisely so the relay
cannot be probed. The opposite conclusion here is correct for the opposite
reason: queue addresses are meant to be unguessable, and **handles are meant to
be public** — discovery is the directory's entire job. So "there is no such user"
is something the log should be made to *prove* rather than allowed to *assert*,
and the zero-knowledge set is exactly what makes that provable without revealing
the rest of the directory.

### 8.2 Self-audit

Every client monitors its own handle every epoch — the check
[`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory) makes the point of
the whole system.

1. `POST /kt/v1/history` for its own handle.
2. Steps 2–4 of §8.1 on the tree head and cosignatures.
3. `akd_core::verify::history::key_history_verify` — ~2.6 ms in WASM for three
   versions (§10).
4. Check that the returned versions form an unbroken `entry_version` sequence
   **and** an unbroken `prev_entry_hash` chain (§4.2) from the client's last
   pinned entry.
5. **Any entry the user's device did not itself submit raises a non-dismissible
   alarm**, naming both key fingerprints and — where `kind` is `platform_reset` —
   stating explicitly that the change was made by the platform without the user's
   old key, per [ADR 0014](./decisions/0014-directory-key-rotation.md).

Step 4 is not redundant with step 3. `key_history_verify` proves the versions are
in the tree; the hash chain proves the client was shown **all** of them. A log
that omits a version from a history response is otherwise serving a truthful
subset.

### 8.3 The threshold rule, and failing closed

**A client accepts a `SignedTreeHead` only if it carries ≥ *t* valid
`WitnessCosignature`s, from **distinct witnesses in its own configured witness
set**, over exactly this `(log_id, epoch, tree_size, root_hash)`.** Cosignatures
from witnesses the client did not configure are ignored — not weighed, not
counted, not displayed as reassurance. A witness list supplied by the log is a
list chosen by the party the witnesses exist to audit.

**When the threshold is not met, the client fails closed.** Per the owner
decision on [#311](https://github.com/free2z/zuu/issues/311): *"Proceeding
silently would overclaim and must not be the default."*

Failing closed is precise, and precision here is the difference between a
security property and an unusable product:

| Operation | Threshold unmet |
|---|---|
| Resolving a **new** handle, creating a group with it, accepting a first-contact `Welcome` from it | **Refused.** This is the [#133](https://github.com/free2z/zuu/issues/133) moment; an unverified key here is the MITM. |
| Accepting a **key change** or a new device credential for a handle already pinned | **Refused**, and surfaced. The old pin stays in force. |
| Sending and receiving in a conversation already established over pinned keys | **Continues.** The keys were verified when they were pinned; nothing about a witness outage retroactively unverifies them. |
| Self-audit (§8.2) | **Continues, and reports.** A client must keep looking at its own history even when it cannot establish the root, because a substitution it can see is worth more than one it cannot. |
| Manual safety-number verification | **Always available**, and is the strongest check in the system regardless of the directory's state. |

**And the bootstrap statement, which is the honest part.** At launch free2z
operates the log and every witness. §9.3 already says that witnesses free2z
operates are not independent witnesses; the consequence for this section is that
**whatever *t* is configured, the cryptographic value of meeting it is zero**
until at least two witnesses are run by parties outside free2z. A client that
displays "3 of 3 witnesses" in that state is displaying a reassuring number for a
property it does not have, which is worse than displaying nothing.

Therefore: **the UI MUST display the number of *independent* witnesses, not the
number of configured witnesses**, and MUST state plainly when that number is
zero. What makes a witness independent, and what *t* defaults to on day one, are
[§13-Q](./ARCHITECTURE.md#13-open-questions) and are not decided here. What is
decided is that the client must not paper over the answer.

### 8.4 Gossip

Before independent witnesses exist, gossip is the only anti-equivocation the
system has ([#311](https://github.com/free2z/zuu/issues/311)), and it is free
because clients already share an authenticated channel.

What a client would exchange is defined: a `SignedTreeHead` (self-authenticating
under the log's key), and a `DirectoryEntry` chain segment (self-authenticating
under §4.2's `prev_entry_hash` chain and §4.4's authorization signatures). Two
clients holding tree heads that fail §6.3's rules **against each other** have
detected equivocation, and the two tree heads are the complete evidence.

**The protocol that exchanges them is not specified here.** When to gossip, with
whom, how much history, what a client does on mismatch, and how the resulting
evidence gets out of the two devices that found it are all real questions with no
answers in the merged docs, and inventing them would be worse than listing them.
[§13-R](./ARCHITECTURE.md#13-open-questions).

### 8.5 What a client cannot verify

Stated at the point of use, and it is the correction
[`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory) now carries.

| Client can verify | Client cannot verify |
|---|---|
| Inclusion of a handle at a root (~1.1 ms) | **Append-only consistency between roots** — the proof is O(entries added), 3.9 MB / 1–3 s for five epochs (§10) |
| Non-membership of a handle at a root | That a witness actually ran the append-only check (§7.4) |
| Its own key history, unbroken by version and by hash chain (~2.6 ms) | That the witness set is independent — a social fact ([`THREAT-MODEL.md` §3.9](./THREAT-MODEL.md#39-malicious-directory-witness)) |
| Monotonicity and the tree-head chain across roots **it has seen** (§6.3) | That the roots it has seen are the roots everyone else was shown |
| That an entry was authorized under §4.4 | That the log did not refuse someone else's submission |
| That a `SubmissionReceipt`'s deadline was met, for its own submissions | That a log which met the deadline did so on the branch everyone else sees |

**A client cannot substitute its own consistency check for a witness's.** There
is no cheap check available to it, so there is no fallback when the witness set
is absent, unreachable, or not independent. This makes the witness set more
load-bearing than §9.3's prose implies, not less.

---

## 9. The served API

### 9.1 The log descriptor

The KT analogue of [`WIRE.md` §11.1](./WIRE.md#111-what-an-operator-publishes),
and for the same reason: a log's entire externally-relevant policy in one signed
document that a human can read before trusting it.

```
struct {
    uint16 kt_versions<1..255>;
    opaque log_id[32];
    opaque log_signing_pk[32];        /* current; §6.4 for succession */
    opaque genesis_log_pk[32];        /* the key log_id is derived from */
    opaque vrf_public_key[32];
    uint8  configuration;             /* 1 = WhatsAppV1; §3.2 */
    uint32 epoch_interval_seconds;
    uint32 max_merge_delay_seconds;
    uint32 reset_cooldown_seconds;    /* ADR 0014 */
    opaque reset_authority_pk[32];
    opaque operator_name<0..255>;
    opaque operator_contact<0..255>;
    opaque operator_jurisdiction<0..255>;
    opaque operator_policy_url<0..255>;
    opaque source_repo_url<0..255>;
    opaque source_commit<0..255>;
    opaque build_digest<0..255>;      /* reproducible-build digest */
    uint64 published_at_ms;
} LogDescriptor;

struct {
    LogDescriptor descriptor;
    opaque        signature[64];
} SignedLogDescriptor;
```

Served at `GET /.well-known/free2z-kt/v1/log`, as `tls_codec` bytes and as JSON
with the same values and the same signature, on
[`WIRE.md` §11.2](./WIRE.md#112-served-two-ways-on-purpose)'s reasoning and with
the same honest caveat: nothing forces the two representations to agree except
the operator, and what makes divergence costly is that both are signed by the
same key.

`reset_authority_pk` being published here does **not** discharge
[ADR 0014](./decisions/0014-directory-key-rotation.md)'s requirement that it be
**pinned in clients**. A reset authority key a client learns from the log is a
key the log chooses, which is no authority at all. The published copy exists so a
human can compare it against the pinned one. How the pinned copy is distributed
and rotated is §12's open gap.

### 9.2 Endpoints

Plain HTTPS, not the relay's WebSocket protocol. A witness should need no
protocol library, a researcher should be able to fetch a tree head with `curl`,
and the directory is a different service from a relay with a different lifecycle.

| Method | Path | Body / response | Who |
|---|---|---|---|
| `GET` | `/.well-known/free2z-kt/v1/log` | `SignedLogDescriptor` | anyone |
| `GET` | `/kt/v1/sth` | latest `SignedTreeHead` + `WitnessCosignature<>` | anyone |
| `GET` | `/kt/v1/sth/{epoch}` | that epoch's `SignedTreeHead` + cosignatures | anyone |
| `GET` | `/kt/v1/audit?from={e0}&to={e1}` | `AppendOnlyProof` (akd protobuf, §9.4) + both tree heads | witnesses in practice (§10) |
| `POST` | `/kt/v1/lookup` | `{handle}` → `DirectoryEntry` + `LookupProof` + tree head + cosignatures | anyone |
| `POST` | `/kt/v1/history` | `{handle, params}` → `DirectoryEntry<>` + `HistoryProofV2` + tree head + cosignatures | anyone |
| `POST` | `/kt/v1/submit` | `DirectoryEntry` → `SubmissionReceipt` | the handle's owner |
| `POST` | `/kt/v1/cosign` | `WitnessCosignature` → empty | witnesses |

Request and response bodies are `tls_codec`, `Content-Type:
application/octet-stream`, under [`WIRE.md` §3](./WIRE.md#3-serialization)'s
rules including re-encode equality — with the §9.4 exception.

`/kt/v1/cosign` is an inbound endpoint on the **log**, not on the witness: the
witness pushes outbound, keeping §9.3's promise that a witness needs no inbound
port, no certificate and no domain. The log then serves the cosignatures it
collected. §7.5 states the conflict of interest that creates and what a client
should do about it.

`/kt/v1/lookup` and `/kt/v1/history` are `POST` with a body rather than `GET`
with the handle in the path, so that the queried handle does not land in the
log's access logs, any intermediary's logs, or a `Referer` header by default.
This is a small thing and it does not change
[`THREAT-MODEL.md` §4.1](./THREAT-MODEL.md#41-directory-lookup-reveals-interest-in-a-handle)
at all: the log still learns the handle, because it has to answer. It removes the
accidental copies, not the intentional one.

### 9.3 Sizes are a rate-limit input, not a footnote

`/kt/v1/audit` can return megabytes (§10). It MUST be rate-limited separately
from every other endpoint, and a log MAY require a range no wider than a
published maximum. A log MAY prune audit ranges older than a published horizon
and MUST then answer `ERR_EPOCH_UNAVAILABLE` rather than a partial proof — but
note what pruning costs: a witness that was offline across the horizon can never
catch up honestly, and its only correct move is §7.3's halt. Pruning horizon
versus witness downtime tolerance is a real operational trade and the values are
part of [§13-P](./ARCHITECTURE.md#13-open-questions).

### 9.4 `akd`'s proof bytes are carried opaquely, and that is safe

`akd` serializes its proofs as **protobuf**, natively, via `akd_core::proto`. We
do not re-encode them into `tls_codec`. They travel as `opaque proof<0..2^24-1>`
inside our structures.

This means [`WIRE.md` §3.3](./WIRE.md#33-the-re-encode-equality-rule--mandatory)'s
re-encode-equality rule **does not apply inside those bytes**, and protobuf is
not canonical. State that plainly rather than let a reader assume the rule covers
everything.

**It is safe, and the reason is precise: nothing we sign is derived from a
proof's encoding.** A proof is an *input to verification*, never a signed object
and never a committed value. The value the client compares against is
`H("free2z/kt/v1/value", tls_codec(DirectoryEntry))`, computed by the client from
entry bytes that **are** under re-encode equality (§8.1 step 4). The root is from
a `tls_codec` tree head signed under §6.2. The only thing a malleable proof
encoding can produce is a different verification *outcome*, and both outcomes are
handled: verify, or reject. There is no third state and no signature that a
re-encoded proof would invalidate.

What we do **not** get from this is a canonical proof for hashing or comparison
purposes, so no part of this specification hashes a proof or compares two proofs
for equality — including `FaultReport.detail` (§7.3), which is why
`append_only_failure` is explicitly not self-authenticating.

### 9.5 Error codes

`uint16`. **Stable forever: a code's meaning is never changed and a retired code
is never reused** — [`WIRE.md` §10](./WIRE.md#10-error-codes)'s rule, for
[`WIRE.md` §10](./WIRE.md#10-error-codes)'s reason.

| Code | Name | Meaning |
|---:|---|---|
| 0 | — | Success. Reserved; never an error. |
| 1 | `ERR_MALFORMED` | Decode failure, re-encode mismatch, oversize body. |
| 2 | `ERR_UNSUPPORTED_VERSION` | Unknown `kt_version`, or a `log_id` this server does not serve. |
| 3 | `ERR_BAD_SIGNATURE` | An `auth_signature`, `RotationProof`, reset or cosignature failed verification. |
| 4 | `ERR_BAD_AUTHORIZATION` | Structurally valid but §4.4's rules unmet — e.g. a key change with one signature. |
| 5 | `ERR_VERSION_CONFLICT` | `entry_version` not `previous + 1`, `prev_entry_hash` mismatch, or a second entry for this handle in this epoch (§4.3). |
| 6 | `ERR_COOLDOWN` | A `platform_reset` whose `effective_at_ms` has not arrived. |
| 7 | `ERR_EPOCH_UNAVAILABLE` | The requested epoch or audit range is outside the served horizon (§9.3). |
| 8 | `ERR_RANGE_TOO_WIDE` | An audit range above the published maximum. |
| 9 | `ERR_RATE_LIMITED` | Retry later. |
| 10 | `ERR_NOT_A_WITNESS` | `/kt/v1/cosign` from a key the log does not recognise. Advisory only — the log's opinion of who is a witness has **no bearing** on a client's configured set (§8.3). |
| 11 | `ERR_INTERNAL` | Log fault. Carries no detail, ever. |

**There is no "unknown handle" code**, deliberately: an unregistered handle is
answered with a non-membership proof (§8.1). "No such user" is a claim the log
must prove.

---

## 10. Measured costs

From [#544](https://github.com/free2z/zuu/issues/544), on an Apple M2 Max under
the pinned `rustc 1.97.1`, WASM figures from Node 22's V8 (the engine Chrome
ships), min-of-N. Reproduced here so a reader does not have to follow a link to
size the system.

**Client verifier, 1,000,000-entry directory, 100 epochs:**

| Operation | Proof | Native | WASM (V8) |
|---|---|---|---|
| `lookup_verify` (incl. protobuf decode) | 4,042 B | 887 µs | **1.11 ms** |
| `key_history_verify`, 3 versions | 9,173 B | 2.09 ms | **2.63 ms** |
| `key_history_verify`, 20 versions | 45,746 B | — | 19.8 ms |

Scaling from 10,000 to 1,000,000 entries costs 1.3 KB of proof and no measurable
time — the cost is dominated by three constant-cost ECVRF verifications.

**Client verifier bundle**, size-optimised `cdylib`, `akd_core` +
`vrf,whatsapp_v1,protobuf`: 118 KB raw, 47.9 KB gzip, **39.6 KB brotli**. At
`opt-level=3`: 183 KB raw, 48.1 KB brotli — take `opt-level=3`.

**Append-only proof, 100,000-entry directory, 5 epoch transitions, ~1,000 new
entries per epoch:**

| | |
|---|---|
| Proof size | **3,896,008 B** (3.9 MB) |
| `audit_verify` native | **1.10 s** |
| `audit_verify` WASM | 3.41 s (requires §11.3's patch) |

This asymmetry is the whole architectural point of this document. A 4 KB / 1 ms
client check and a 3.9 MB / 1 s witness check are not the same kind of operation,
and pretending a phone can do the second is what
[`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory)'s correction exists
to stop.

---

## 11. Implementation notes

### 11.1 Version floor

`akd >= 0.13.0`, `akd_core >= 0.13.0`, hard, enforced by a `[[bans.deny]]` entry
rather than by a manifest requirement, because **no advisory exists** for the
append-only bypass that sets the floor and none ever will. The full reasoning and
the exact entry are in
[ADR 0013](./decisions/0013-key-transparency-log.md). A reviewer who removes that
entry has removed the floor; there is no second line of defence.

### 11.2 Storage is ours

`akd` takes storage through a `pub trait Database` and ships only
`AsyncInMemoryDatabase`. The durable backend is ours to write.
`akd_mysql` is stale — last release 0.8.9, March 2023 — and MUST NOT be used.

`akd` touches no SQLite anywhere in its tree, so the repo-wide `rusqlite 0.37` /
`libsqlite3-sys` `links` singleton recorded in `AGENTS.md` is not engaged by this
dependency.

Treat the `Database` implementation as security-critical rather than as
plumbing. NCC Group explicitly deprioritised "storage caching and parallelization
strategy" in its review, and facebook/akd#495 — the append-only bypass that sets
our floor — was in exactly that unreviewed region. Our storage layer is in the
same neighbourhood and has had no review at all.

### 11.3 The `audit_verify` wasm wart

`akd::auditor::audit_verify` compiles for `wasm32-unknown-unknown` and then traps
at runtime (`RuntimeError: unreachable`), because `verify_append_only_hash`
hardcodes `AzksParallelismConfig::default()` — `AvailableOr(32)` — reaching
`tokio::task::spawn`, and that target has no runtime and no threads. It fails on
a 33 KB proof as readily as on a 3.9 MB one, so it is not a size or stack
problem. Changing that one call to `AzksParallelismConfig::disabled()` makes it
verify correctly in WASM.

**This does not affect us where it matters.** It is in the **server** crate, and
the auditor is the **witness** role, which §9.3 specifies as a native
outbound-polling daemon. The *client* verifier is `akd_core` and reaches the
browser cleanly. The wart is recorded here so it is not rediscovered, and because
the upstream fix is one line — threading `AzksParallelismConfig` through
`audit_verify`'s signature — and is worth a PR per `AGENTS.md`'s prime directive.
Until it lands, a WASM or non-tokio auditor needs a `[patch.crates-io]` pinned to
a reviewed commit, not a fork.

### 11.4 One crate, three consumers

`f2z-kt-core` is linked by the log, the witness and the client, native and WASM,
per [ADR 0001](./decisions/0001-platform-priority.md). The verification code the
witness runs and the verification code the log's tests run are the same code —
which is §7.4's structural mitigation and is not merely tidy.

---

## 12. What this document leaves open

Deliberately, and listed rather than invented.

- **Epoch cadence and maximum merge delay values** —
  [§13-P](./ARCHITECTURE.md#13-open-questions). §5's 600 s / 3,600 s are
  placeholders chosen to make silence detectable, not measured answers.
- **The default *t*, the shipped witness list, and what makes a witness
  independent** — [§13-Q](./ARCHITECTURE.md#13-open-questions). §8.3 fixes the
  rule and the failure mode; the numbers would be an invention.
- **The client gossip protocol** —
  [§13-R](./ARCHITECTURE.md#13-open-questions). §8.4 defines the evidence and
  stops there.
- **Reset authority key pinning and its own rotation.**
  [ADR 0014](./decisions/0014-directory-key-rotation.md) requires the key to be
  pinned in clients and does not say how; nothing anywhere says what happens when
  that key must itself be replaced. A gap, named.
- **MLS `KeyPackage` publication and exhaustion** — deferred out of
  [`WIRE.md` §12.5](./WIRE.md#125-the-full-handshake-end-to-end) as directory
  design, and still not answered. A `KeyPackage` is consumed on use and
  republished constantly, which is the wrong lifecycle for an append-only log
  entry, and last-resort key package behaviour is a separate decision.
- **Handle rename and transfer** —
  [§13-K](./ARCHITECTURE.md#13-open-questions), unchanged.
- **Where `FaultReport`s are published and who acts on one.** The format is
  specified; the social process is not, and inventing one would misrepresent how
  much of this is solved.
- **Whether we carry the `[patch.crates-io]` for §11.3 or wait for upstream.**
  Not needed for a native witness; a decision only if a browser auditor is ever
  wanted.
- **Private information retrieval for lookups.** Would remove
  [`THREAT-MODEL.md` §4.1](./THREAT-MODEL.md#41-directory-lookup-reveals-interest-in-a-handle)'s
  limit rather than bound it. Out of scope and not scheduled.

---

## 13. References

**Construction**
[CONIKS](https://www.usenix.org/conference/usenixsecurity15/technical-sessions/presentation/melara) ·
[SEEMless](https://eprint.iacr.org/2018/607) ·
[Parakeet](https://eprint.iacr.org/2023/081) ·
[RFC 6962 — Certificate Transparency](https://datatracker.ietf.org/doc/html/rfc6962)
(the SCT and MMD analogues in §5) ·
[RFC 9381 — ECVRF](https://datatracker.ietf.org/doc/html/rfc9381)

**Implementation**
[facebook/akd](https://github.com/facebook/akd) ·
[facebook/akd#495 — auditor append-only bypass](https://github.com/facebook/akd/pull/495) ·
[NCC Group public report — WhatsApp Auditable Key Directory implementation review](https://www.nccgroup.com/research-blog/public-report-whatsapp-auditable-key-directory-akd-implementation-review/)

**In this repository**
[`ARCHITECTURE.md` §9](./ARCHITECTURE.md#9-identity-directory-key-transparency-and-federation) ·
[`THREAT-MODEL.md` §3.1](./THREAT-MODEL.md#31-malicious-or-compromised-free2z-server),
[§3.9](./THREAT-MODEL.md#39-malicious-directory-witness),
[§4.1](./THREAT-MODEL.md#41-directory-lookup-reveals-interest-in-a-handle) ·
[`WIRE.md`](./WIRE.md) ·
[ADR 0013](./decisions/0013-key-transparency-log.md),
[ADR 0014](./decisions/0014-directory-key-rotation.md),
[ADR 0001](./decisions/0001-platform-priority.md),
[ADR 0008](./decisions/0008-transport-and-serialization.md)
