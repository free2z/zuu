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
entry **once a handle already has one** — it distinguishes a same-key update, a
key change and a lost key, and takes no position on a handle's *first* entry. A
third owner decision, recorded on
[#305](https://github.com/free2z/zuu/issues/305) and not named in this document's
brief, settled the first entry: a short-lived signed handle-ownership assertion
from the party that runs the user directory. It went unspecified until 2026-08-24
and is now §4.5, §4.6 and §4.7 ([#594](https://github.com/free2z/zuu/issues/594)).
**Everything between those decisions and an implementation is
invented below**, and where a choice was invented rather than inherited it says
so at the point of use. Nothing here should be read as "the merged docs already
said this."

---

## 1. Scope

### 1.1 What this document fixes

The `DirectoryEntry` structure and its authorization — including, since
2026-08-24, a handle's **first** entry: the `HandleAssertion` and its binding
signature (§4.5), the no-authority mode and its mandatory reporting (§4.6), and
an accounting of what trusting an authority costs (§4.7). An earlier revision
said this document fixed authorization "from the second entry onward" and
deferred the first to §1.2; §4.4's **closing** correction — the last of the four
that section carries — records the closure and what
an implementer working from that revision must add. The `SignedTreeHead` format
and its signing transcript; log-key rotation; epoch cadence and the maximum merge
delay; the submission receipt; the witness poll-verify-cosign protocol, its
state-update ordering and its fault evidence; the `WitnessCosignature` format;
the client verification rules and the threshold rule; the proof-serving API
surface and its stable error codes; and where `akd`'s types sit underneath ours.

### 1.2 What it deliberately does not fix

- **A proof that a handle is *unregistered*.** §8.1 and §9.5 require one — *"'No
  such user' is a claim the log must prove"* — and `akd` 0.13 has no API that
  produces it, so a v1 log serves an assertion it MUST label unproved. Listed
  here because it is a requirement this document states and does not deliver,
  which is worse than a gap and is written down as such: §8.1's correction,
  §9.5's correction, §11.5, §12,
  [§13-T](./ARCHITECTURE.md#13-open-questions),
  [`THREAT-MODEL.md` §4.11](./THREAT-MODEL.md#411-an-unregistered-handle-is-asserted-not-proved).
  [#634](https://github.com/free2z/zuu/issues/634).
- **~~What authorizes a handle's *first* directory entry.~~ Closed 2026-08-24 by
  §4.5.** Kept here rather than deleted so a reader arriving from an older
  citation finds the answer instead of a hole. This bullet used to say the
  question was blocking and that inventing an answer here would repeat
  [#551](https://github.com/free2z/zuu/issues/551)'s mistake. The answer was not
  invented: it was the owner decision recorded on
  [#305](https://github.com/free2z/zuu/issues/305), which
  [#554](https://github.com/free2z/zuu/issues/554)'s brief did not name, so this
  document inherited the gap rather than introducing it. §4.5 writes down what
  two interoperating implementations agreed on, §4.6 fixes the no-authority mode
  and requires it to be reported, and §4.7 states what the trust root costs —
  including the part §4.5 does **not** close, which is the log itself.
  [#594](https://github.com/free2z/zuu/issues/594).
- **Client verification of a first entry's authorization.** §4.5 is checked by
  the log and is not committed to the tree, so a client cannot verify it. §4.7's
  last paragraph states the property as not holding and names the wire change
  that would close it. This is a narrower gap than the one above and it is real.
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
| **Log** | The tree, every entry, the log signing key, the VRF key | Public HTTPS listener | Can equivocate, can withhold, can refuse. Cannot forge an entry for a handle that **already has one** (§4.4), and cannot forge a cosignature. **Can still publish a handle's first entry unchecked** — §4.5 authorizes a first entry against a third party, but it is a rule the log applies to itself and is not committed to the tree (§4.7). |
| **Authority** | An assertion signing key, and the record of who owns which handle | Issues to authenticated users; not part of the log | Compromise claims **unregistered** handles. Cannot swap a live key, cannot reset alone, cannot use a stolen assertion (§4.7). A log MAY run with none, and MUST report it (§4.6). |
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
| `same_key`, `entry_version == 1` — a handle's **first** entry | the `directory_auth_pk` **in this entry** | a `HandleAssertion` and an `AssertionBinding` signature (§4.5). On a log that declares itself no-authority (§4.6), the `AssertionBinding` signature alone. |
| `same_key`, `entry_version >= 2` | the `directory_auth_pk` **published in the previous entry** | — |
| `key_change` | the `directory_auth_pk` **in this entry** (the new key) | a `RotationProof` signed by the **outgoing `identity_pk`** |
| `platform_reset` | the `directory_auth_pk` **in this entry** | a `ResetAuthorization` signed by the pinned reset authority key, **and** a `HandleAssertion` with `intent = reset` (§4.5) |

**The first row's middle column authorizes nothing on its own and must not be
read as though it did.** A version-1 entry signed by the `directory_auth_pk` it
itself publishes proves that whoever wrote the entry also wrote the entry. It
authenticates the submitter's *key*; it says nothing about the submitter's claim
to the handle. What authorizes a first entry is the third column, and it is
§4.5.

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

> **Correction (2026-08-24) — the blast-radius sentence above is now narrower
> than it reads, and the example it gives is no longer an example.** §4.5's
> `AssertionBinding` signature is by the **`identity_pk`**, and it is required on
> **every** submission — including `same_key` and `key_change`, where the
> assertion itself is absent and `assertion_digest` is 32 zero bytes (§4.5.2,
> rule 11). So "a routine update then never touches the key peers pin and display
> as a safety number" is no longer true of a routine update: rotating a contact
> endpoint now requires ISK, exactly as adding a device always did.
>
> **The stricter behaviour is specified rather than relaxed, and the trade is
> worth stating.** What is lost is the cold-key property for one operation. What
> is bought is that there is **no submission path that omits the identity
> self-signature** — not on a vouched log, not on an unvouched one, not on a
> routine update. A rule with an exemption is a rule an implementation can be
> talked into taking, and A16 is the rule that makes a stolen assertion
> worthless; the alternative design has a branch where a verifier holds a
> checked assertion and no binding, which is the primitive §4.5.2 exists to
> forbid. The use-separation above still holds for what each key *authorizes* —
> `DirectoryAuthKey` alone still cannot install a new `identity_pk` (rules 6 and
> 7) — but it no longer holds for what each key *is asked to sign*.

Verification rules the log MUST apply, in order, before an entry enters a batch:

1. Re-encode equality on the submitted bytes
   ([`WIRE.md` §3.3](./WIRE.md#33-the-re-encode-equality-rule--mandatory)).
2. `label`, `kt_version` and `log_id` are exactly this log's.
3. `handle` matches the charset rule and `entry_version` is `previous + 1` (or 1).
   **The `(or 1)` case is not an authorization rule and MUST NOT be read as one**
   — it fixes the version number and nothing else. What authorizes a handle's
   *first* entry is **rule 11** and §4.5. (Until 2026-08-24 this document said
   the question was open and blocking; the correction that said so, and the
   closing correction that supersedes it, are the last two at the end of this
   section.)
4. `prev_entry_hash` matches the published previous entry, or is all-zero when
   `entry_version` is 1 (§4.2).
5. `authorization.kind == entry.kind`, and the table above holds.
6. For `same_key`: `identity_pk` **MUST equal the previous entry's
   `identity_pk`.** A `same_key` entry that carries a different one is an
   identity-key change installed on a single signature — by a key that
   [ADR 0014](./decisions/0014-directory-key-rotation.md) does not make
   sufficient to install a new identity — and the log MUST reject it with
   `ERR_BAD_AUTHORIZATION` (§9.5) rather than treat it as a rotation. This rule
   constrains `identity_pk` only.
7. For `key_change`: the `RotationProof`'s `old_identity_pk` equals the previous
   entry's `identity_pk`, its `new_identity_pk` equals this entry's, its
   `entry_version` and `prev_entry_hash` match, and its signature verifies.
   **A key change carrying only one of the two signatures MUST be rejected.**
8. For `platform_reset`: the reset signature verifies under the pinned reset
   authority key, `effective_at_ms - created_at_ms` is at least the published
   cooldown, and the log MUST NOT publish the entry before `effective_at_ms`.
9. Every `DeviceCredential` signature verifies under this entry's `identity_pk`,
   and no two credentials share a `device_pk`.
10. §4.3's uniqueness rule.
11. **§4.5 applies, in full, and the entry MUST NOT be published unless it
    passes.** Three cases, and an implementer applies all three:
    - **`entry_version == 1`.** This is the rule that authorizes a handle's first
      entry. Rules 1–10 above establish only that the entry is well-formed,
      self-consistent and signed by the key it publishes — never that the
      submitter is entitled to the handle. §4.5's assertion carries `intent =
      bind`.
    - **`platform_reset`.** §4.5's assertion carries `intent = reset`, **in
      addition to** rule 8's `ResetAuthorization` and never instead of it. A log
      with no configured authority (§4.6) therefore cannot admit a
      `platform_reset` at all.
    - **`same_key` at `entry_version >= 2`, and `key_change`.** These carry **no**
      assertion, and a log MUST refuse one rather than ignore it (§4.5.3). Rule
      A16 — the identity self-signature over the binding — still applies.

    On a log that declares itself no-authority under §4.6, A16 is the whole of
    §4.5 that runs at `entry_version == 1`, and the rest does not.
12. **`entry_version == 1` MUST carry `kind == same_key`.** `key_change` needs an
    outgoing `identity_pk` and `platform_reset` needs a key to displace; a handle
    with no previous entry has neither, so rules 7 and 8 cannot be satisfied at
    version 1 and both cases MUST be rejected with `ERR_BAD_AUTHORIZATION`
    rather than left to fail obscurely inside a rule that dereferences a
    predecessor that does not exist.

**Rule 11 runs last, and the order is deliberate rather than a numbering
accident.** §4.5's checks are the most expensive in the list — two signature
verifications and the one write in the whole submission path — and A17 mutates
the log's replay ledger. Running rules 1–10 first means a submission that fails
any cheaper rule never reaches the ledger and therefore cannot consume a nonce
that belongs to somebody else. It also means §4.5 is checked against an
`entry_version`, an `identity_pk` and a predecessor that this section has already
agreed to, rather than against values the submitter merely asserted.

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
rather than hidden. **Read "a live key" strictly**: everything in this paragraph
is scoped to a handle that already has an entry in the log, and the second
correction below is why that scope is doing work. §4.5 now says what authorizes
a first entry, and it does **not** widen this paragraph: §4.5 is a rule the log
applies to submissions it receives, not a signature a client can check on an
entry it is served, so the log remains able to publish a first entry for a
handle nobody enrolled. §4.7 states that residual plainly rather than letting
this paragraph be restated without its scope.

> **Correction (2026-08-24) — rule 6 is new, and the list above was incomplete
> without it.** As first published, this section's numbered rules never required
> a `same_key` entry to keep `identity_pk` unchanged. The constraint was implied
> by the case's *name*, and by
> [ADR 0014](./decisions/0014-directory-key-rotation.md)'s case 1 — "the identity
> key is unchanged and available" — but it was absent from the list an
> implementer is told to apply **in order**, and an implementer applies the list.
> A conforming implementation of the first revision therefore accepted a
> `same_key` entry carrying a brand-new `identity_pk` from a party holding only
> the previous entry's `directory_auth_pk`: an identity change installed on
> **one** signature, which ADR 0014 requires the log to reject and which rule 7's
> `RotationProof` exists to prevent. **An implementer working from the first
> revision must add the check**; two independent implementations
> ([#584](https://github.com/free2z/zuu/issues/584),
> [#593](https://github.com/free2z/zuu/issues/593)) inferred the stricter reading
> and recorded it as an addition, which is how the omission was found
> ([#594](https://github.com/free2z/zuu/issues/594)).
>
> Rule 6 is deliberately narrow. Whether a `same_key` entry may rotate
> `directory_auth_pk` is **not** stated by this document in either direction, and
> the new rule does not settle it.

> **Correction (2026-08-24) — nothing in this section authorizes a handle's
> *first* entry, and the section read as though the table above were
> exhaustive.** It is not, and the gap is **open and blocking** (§12).
>
> Every row of the `auth_signature` table authorizes an entry by reference to a
> key that some *earlier* state already established: the `directory_auth_pk`
> published in the previous entry, the outgoing `identity_pk` a previous entry
> named, or the pinned reset authority acting on a handle someone already holds.
> At `entry_version == 1` **there is no previous entry and no earlier state.**
> Rule 3 admits that case explicitly. So the rules above, applied exactly as
> enumerated, accept a first `DirectoryEntry` for any unregistered handle **from
> whoever submits one** — first-come-first-served handle claiming, in the
> document whose entire purpose is that the log cannot lie about who you are
> talking to ([#133](https://github.com/free2z/zuu/issues/133)).
>
> **What an implementer must not do.** Do not read the silence as permission. Do
> not invent a rule and ship it as though this document specified it. In
> particular, do not treat a version-1 entry's own `directory_auth_pk` as
> self-authorizing: a self-signed first entry authenticates **the submitter's
> key**, never **the submitter's claim to the handle**, and conflating those two
> statements is the whole of the defect. Until this is decided, any
> implementation of §4.4 is incomplete by construction and should say so where
> its users can see it.
>
> **What a decision has to settle.** Stated as questions, because this is not a
> question the specification gets to answer for the project:
>
> - **Who may vouch that a handle belongs to a submitter, and against what
>   record.** On free2z the obvious answer is the platform account system, which
>   makes the platform the voucher — a trust concentration of the same kind as
>   [ADR 0014](./decisions/0014-directory-key-rotation.md)'s reset authority, and
>   one that should be weighed as such rather than adopted because it is
>   convenient. [#551](https://github.com/free2z/zuu/issues/551) is open because
>   that comparable authority was created in a specification rather than decided
>   on the record; this one must not repeat it.
> - **Whether a log may run with no such authority at all** — which a
>   self-hosted log must be able to do under
>   [ADR 0005](./decisions/0005-federation.md) — and, if so, whether a client is
>   entitled to be *told* that the handles in that log are unvouched. A client
>   that cannot distinguish a vouched handle from an unvouched one is being shown
>   a reassuring name for a property it does not have, which is the failure §8.3
>   refuses for witness counts.
> - **What binds the vouching to the key being installed**, so that an
>   intercepted, replayed or reordered vouching artifact cannot install a key
>   other than the one it was issued for.
> - **What the log-side bounds are** — validity window, replay scope, rotation of
>   the vouching key, and what a compromise of it costs. Those bounds are the
>   terms on which the concentration above is or is not acceptable, so they are
>   part of the decision and not an implementation detail of it.
>
> **A candidate exists and it is unratified.** The owner decision recorded on
> [#305](https://github.com/free2z/zuu/issues/305) named a signed-assertion
> submission authority and was never turned into a specification;
> [#554](https://github.com/free2z/zuu/issues/554)'s brief did not name it, so
> this document inherited the gap rather than introducing it.
> [#593](https://github.com/free2z/zuu/issues/593) (branch `feature/kt-authority`)
> implements a proposed `HandleAssertion` — a short-lived, domain-separated
> assertion issued by a configured authority, verified alongside a signature by
> the identity key the assertion is about, with an authority set that supports
> rotation and an explicitly reported no-authority mode — and offers it as a
> proposal for this document to catch up with. **Nothing about it is specified
> here, and no part of it is ratified**: not its fields, not its encoding, not
> its signing transcript, not its validity rules, and not the semantics of a
> no-authority mode. Deciding those is a product-and-trust decision, and it is
> deliberately not taken in this document.
> [#594](https://github.com/free2z/zuu/issues/594).

> **Correction (2026-08-24, later the same day) — the correction directly above
> is superseded: the first-entry gap is closed, and §4.5 closes it.** The text
> above is kept verbatim rather than deleted, because it is the record of what
> the rules admitted between the first revision of this document and this one,
> and an implementer working from that revision must add rules 11 and 12.
>
> **What changed, and what did not.** The correction above declined to answer its
> four questions on the ground that naming a vouching authority is a
> product-and-trust decision the specification does not get to take. That
> remains true, and this revision does not take it. The decision was **already
> on the record**: the owner decision recorded on
> [#305](https://github.com/free2z/zuu/issues/305) is that KT submission
> authority is a short-lived signed handle-ownership assertion issued by the
> party that runs the user directory, with the log verifying a signature against
> a configured authority key and a self-hoster plugging in their own.
> [#554](https://github.com/free2z/zuu/issues/554)'s brief did not name that
> artifact, so this document inherited the gap rather than introducing it, and
> what §4.5 does is **write down a decision that was taken and never
> specified** — not mint a new trust root in a specification, which is the
> failure [#551](https://github.com/free2z/zuu/issues/551) is open about. The
> distinction is the whole reason §4.5 exists as encoding-and-rules and §4.7
> exists as an honest accounting of what the decision costs.
>
> **The candidate is now ratified, and it is ratified as-implemented.** The
> structures, transcripts and rules in §4.5 are not an invention of this
> revision. They are what two independent implementations already agreed on
> byte-for-byte — the Rust verification crate offered against
> [#593](https://github.com/free2z/zuu/issues/593)/[#626](https://github.com/free2z/zuu/pull/626)
> and the issuing endpoint operated by the party that runs the user directory —
> and this section's job is to write down what they agreed on so a third
> implementer is not left to infer it. Where the two disagreed on a *default*
> rather than on a rule, §4.5 fixes the rule and says the default is not one.
>
> **Rules 11 and 12 are new, and the `auth_signature` table's first row is a
> split.** As first published the table had one `same_key` row, authorized by
> "the `directory_auth_pk` published in the previous entry", which at
> `entry_version == 1` names nothing. It is now two rows, and the version-1 row
> states in the table itself that its middle column authorizes nothing on its
> own. Rule 12 — that a first entry must be `same_key` — was never written down
> and both implementations inferred it.
> [#594](https://github.com/free2z/zuu/issues/594).

---

### 4.5 `HandleAssertion` — what authorizes a handle's first entry

> **Invented in the sense §4.4's closing correction describes: the *decision* is
> the owner decision on [#305](https://github.com/free2z/zuu/issues/305), and
> the *encoding* is written down here for the first time.** Every structure,
> transcript and rule below is transcribed from two implementations that already
> interoperate, not proposed fresh. **Two requirements here are stricter than
> what a shipped implementation does**, and both are stated at the point of use
> rather than softened to match: §4.5.4's rule that `account_epoch` must be a
> durable counter and never a clock, and §4.5.5's rule that A17's replay ledger
> must survive a restart. Each is a case where the weaker behaviour leaves a
> field or a rule in place that looks like it is doing work it is not.

> **Correction (2026-08-24) — neither of those two is still a gap between this
> document and the Rust log, and the `account_epoch` rule has grown a rule a
> verifier can actually apply.**
> [#650](https://github.com/free2z/zuu/issues/650),
> [#651](https://github.com/free2z/zuu/issues/651).
>
> - **A17's ledger durability was a code defect, not a specification one**, and
>   is fixed: the log rebuilt an empty ledger on startup, so every restart
>   reopened the replay window for every assertion still inside its validity cap,
>   while the trait it wrote through said in its own documentation that a restart
>   must not do that. It now restores each admitted
>   `(authority_id, nonce, expires_ms)` into the live ledger during journal
>   replay. §4.5.5's sentence is unchanged because it was right.
> - **`account_epoch`'s rule is now checkable, within a stated limit.** §4.5.4
>   carries **A18** and says exactly which clocks it still cannot see and what the
>   issuer must therefore guarantee. The issuing endpoint operated by the party
>   that runs the user directory still derives the value from Unix seconds where
>   no counter is supplied and remains **non-conforming**; that is tracked on
>   their side, and A18 means a log now refuses those assertions rather than
>   publishing entries authorized by a rule that could not fail.

An assertion is a short-lived, single-use, log-pinned statement by a configured
authority that a named handle belongs to a named identity key. It is **not** part
of the `DirectoryEntry`; it accompanies one, in the submission envelope of §9.2,
and §4.7 states what that costs.

#### 4.5.1 Structures

```
struct {
    opaque label<0..255>;      /* exactly "free2z/kt/v1/handle-assertion" */
    opaque authority_id[32];   /* H("free2z/kt/v1/authority-id", authority_pk) */
    opaque log_id[32];         /* §6.1 — the log this assertion is for        */
    opaque handle<1..30>;
    opaque handle_id[32];      /* H("free2z/kt/v1/handle-id", handle)         */
    opaque identity_pk[32];    /* ISK.public — the key being vouched for      */
    uint8  intent;             /* bind(1), reset(2) — §4.5.3                  */
    uint32 account_epoch;      /* §4.5.4                                      */
    uint64 issued_ms;
    uint64 expires_ms;
    opaque nonce[16];          /* issuer CSPRNG, fresh per assertion          */
} HandleAssertionTBS;

struct {
    HandleAssertionTBS assertion;
    opaque             signature[64];   /* Ed25519 by authority_id's key */
} HandleAssertion;

struct {
    opaque label<0..255>;         /* exactly "free2z/kt/v1/assertion-binding" */
    opaque log_id[32];
    opaque handle<1..30>;
    opaque identity_pk[32];
    opaque assertion_digest[32];  /* H("free2z/kt/v1/assertion-digest",
                                       tls_codec(HandleAssertion));
                                     all-zero when no assertion accompanies
                                     this submission — §4.6 */
    opaque entry_digest[32];      /* == AkdValue, §3.3 */
} AssertionBindingTBS;
```

`AssertionBinding` has no structure of its own: the signature over
`tls_codec(AssertionBindingTBS)` travels as the submission envelope's
`identity_signature` field (§9.2). It is Ed25519 **by the entry's own
`identity_pk`**.

`authority_id` and `handle_id` are **derived, never accepted as input**, on both
the issuing and the verifying side. The same shape as
[`WIRE.md` §5.2](./WIRE.md#52-relay-identity-binding--the-attack-it-closes)'s `relay_id`, for the
same reason: a key id derived from the key cannot disagree with it, so an
assertion cannot name one authority while being signed by another, or name one
handle while being indexed under another. `handle_id` is redundant with `handle`
in exactly the way §4.2's hash chain is redundant with the tree, and rule A5
below is what makes the redundancy load-bearing rather than decorative.

Encoding is `tls_codec` under [`WIRE.md` §3](./WIRE.md#3-serialization)'s rules,
including re-encode equality: fixed-width `opaque` carries no length prefix, the
two variable-width fields carry a single `uint8` length byte, integers are
unsigned big-endian, and `HandleAssertion` is the TBS bytes immediately followed
by 64 signature bytes with no separator, no outer length and no trailing slack.
`HandleAssertionTBS` is therefore `196 + len(handle)` bytes and a signed
`HandleAssertion` is `260 + len(handle)`.

#### 4.5.2 The signing transcripts

Two signatures, over two structures, and **both are required**:

| Signature | Over | By | Carried in |
|---|---|---|---|
| `HandleAssertion.signature` | `tls_codec(HandleAssertionTBS)`, in full and nothing else | the configured authority key whose digest is `authority_id` | the assertion |
| the `AssertionBinding` signature | `tls_codec(AssertionBindingTBS)` | the submission's own `identity_pk` | the submission envelope, §9.2 |

Both are Ed25519 over the structure **signed directly, not prehashed**, and both
are verified over the **re-encoded** bytes rather than the bytes that arrived —
§6.2's reasoning and [ADR 0008](./decisions/0008-transport-and-serialization.md)'s
rule, unchanged. Domain separation is the `label` field, first, inside the signed
bytes, as it is for every other structure this document signs; §6.2's table is
extended accordingly.

**The identity self-signature is normative, required on every submission, and
there is no path without it** — including `same_key` and `key_change`, which
carry no assertion and set `assertion_digest` to 32 zero bytes so that the
submitter still answers for this exact entry. §4.4's key-separation note carries
a dated correction because that is stricter than the rationale it gave.
An assertion is a **bearer document**: it is bytes an authority signed, sent over
a network, sitting in a submission queue and in whatever archive an operator
kept. Anyone who obtains a copy holds everything the authority said. If holding
one were sufficient to submit under the handle it names, then intercepting one —
from a terminating proxy, from an access log, from a stolen backup — would be a
handle takeover, and the authority would have no way to tell the thief from the
subject. The `AssertionBinding` signature closes that, because producing it
requires the very identity private key the assertion vouches for, which is the
key the thief was trying to replace. A log that verifies the authority's
signature without also verifying the binding has implemented a takeover
primitive, and **MUST NOT** be described as conforming.

Two field choices in `AssertionBindingTBS` are doing specific work and a reader
should notice both:

- **`entry_digest`** is what stops the subject's *own* binding from being
  reusable. A binding signed for one submission does not authorize a second, so
  a log that saw one cannot resubmit it against different entry bytes.
- **`assertion_digest` is over the `HandleAssertion` including its signature**,
  on §4.2's reasoning for `prev_entry_hash`: committing to the authorization as
  well as the contents means an assertion cannot be re-signed after the subject
  has bound itself to it.

#### 4.5.3 `intent`, and where each value is legal

```
enum { bind(1), reset(2), (255) } AssertionIntent;
```

An unknown `intent` byte is a **decode failure, never a default**.
[`WIRE.md` §3.3](./WIRE.md#33-the-re-encode-equality-rule--mandatory) names
"unknown variant bytes silently mapped to a default" as one of the four things
re-encode equality exists to make loud, and here the worst available default is
the one that creates a handle.

| `intent` | Legal at | Paired with |
|---|---|---|
| `bind` | `entry_version == 1` **only** | §4.4's first table row |
| `reset` | `entry_version >= 2` **only**, and only for `kind == platform_reset` | §4.4's `ResetAuthorization`, in addition — never instead |

Splitting the two is what stops an assertion issued to hand somebody a fresh
handle from being re-presented to take over an established one.

**`same_key` and `key_change` MUST NOT carry an assertion, and a log MUST refuse
one rather than ignore it.** Those two cases are authorized under §4.4 by the
previous entry's `directory_auth_pk` and, for a rotation, by the outgoing
`identity_pk`. Admitting an assertion there would give the authority a second
way to authorize a change to a live handle — precisely the power
[ADR 0014](./decisions/0014-directory-key-rotation.md) spends a cooldown, a
non-dismissible alarm and a per-epoch counter to constrain. Refusing rather than
ignoring matters because an ignored field is one an implementation can start
honouring later without anyone noticing.

#### 4.5.4 `account_epoch`

`account_epoch` is the authority's counter for the **account** behind the
handle. It increments when the account changes hands or is recovered, which is
the only thing that justifies a `reset`. The log retains the value from the last
admitted assertion for the handle and requires the next one to be **strictly
greater** (A15), so a `reset` assertion cannot be spent twice on one
account-ownership event. At a **first** entry there is no retained value and A15
has nothing to compare against; the value in a `bind` assertion is simply the
baseline the handle's first `reset` must exceed.

> **One of the two places this document is stricter than a shipped
> implementation, and it is deliberate** — the other is A17's ledger durability
> (§4.5.5). `account_epoch` **MUST** be a durable per-account counter
> held by the authority, and **MUST NOT** be derived from a clock. A monotonic
> wall clock satisfies "strictly greater than the last one" unconditionally and
> forever, which does not merely weaken A15 — it deletes it, while leaving a
> field in place that looks like it is doing the work. One reference issuer
> currently derives the value from Unix time in whole seconds where no counter
> is supplied, and by this rule it is non-conforming; the rule is stated here
> rather than softened to match, because A15's entire purpose is to make a reset
> a distinct event and a clock-derived epoch makes every instant a distinct
> event. A `u32` seconds counter also exhausts the field in 2106, which is a
> second reason not to put a clock in it.

> **Correction (2026-08-24) — the MUST above is now a rule a log applies, and
> the honest limit of that rule is stated with it.**
> [#651](https://github.com/free2z/zuu/issues/651). As first published this
> section stated the issuer's obligation and stopped there, which left A15 in the
> position the paragraph above describes: a rule that **cannot fail** against a
> clock-derived value, in a document that says so. A requirement no verifier
> checks is a requirement, not a rule, and this one had already been disregarded
> by a shipped issuer.
>
> A log therefore now applies **A18** (§4.5.5), and it has two halves because one
> is not enough:
>
> - **A18a — a ceiling.** `account_epoch` **MUST** be less than `2^20`
>   (1,048,576). This is what a count of account-ownership events can plausibly
>   reach: an account that changed hands or was recovered a million times is not
>   an account. Unix time in whole seconds has exceeded it since 1970-01-13, and
>   Unix milliseconds do not fit `uint32` at all, so the exact non-conformance
>   named above is refused **on the value's face** — including at a first `bind`,
>   where there is no retained value and A15 has nothing to compare against at
>   all.
> - **A18b — a step bound.** Where a value is retained for the handle,
>   `account_epoch` **MUST NOT** exceed it by more than **16**. A counter
>   increments once per ownership event, and only events whose assertion never
>   reached the log accumulate slack, so the gap between two admitted assertions
>   is a handful. A clock's gap is however much time passed. This is what catches
>   a clock too coarse to trip the ceiling — days since the epoch is about
>   20,700.
>
> Both are **fixed constants, not published policy numbers**, unlike A9's
> validity cap: the same bound on every log is one a client can apply without
> first fetching §4.6's document, and there is no operational reason for two logs
> to disagree about a counter's shape.
>
> **What A18 cannot do, said plainly.** No check on a single `uint32` can prove
> the value came from durable storage. A clock fine enough to tick between two
> issuances but coarse enough to tick at most sixteen times, and small enough in
> absolute terms to stay under the ceiling, is indistinguishable from a counter
> in the value alone. A18 is therefore **necessary and not sufficient**, and the
> MUST above is not weakened to match what a verifier can see. What the issuer
> must guarantee instead, and what this document requires of it:
>
> - `account_epoch` is read from and written to a **per-account column that
>   survives a process restart**;
> - it is incremented **only** on the events that justify invalidating
>   outstanding assertions — account recovery and account transfer — and once per
>   such event, not once per assertion issued;
> - an issuer that cannot read that column **MUST refuse to issue**
>   `intent = reset` rather than substitute a clock, a timestamp, or any other
>   value that happens to be increasing.

#### 4.5.5 The rules, in the order a log applies them

These are §4.4 rule 11, expanded. They run **after** §4.4's rules 1–10, for the
reason stated there. `A` numbering keeps them distinguishable from §4.4's list;
a log MUST apply all of them.

1. **A1 — presence, in both directions.** An assertion is present **iff** this is
   a first entry or a `platform_reset` on a log with a configured authority
   (§4.6). A missing one where it is required is a refusal; a present one where
   it cannot be judged is also a refusal.
2. **A2 — re-encode equality** on the assertion bytes
   ([`WIRE.md` §3.3](./WIRE.md#33-the-re-encode-equality-rule--mandatory)). The
   re-encoded bytes, never the received ones, are what the signature is checked
   over.
3. **A3 — `label`** is exactly `free2z/kt/v1/handle-assertion`.
4. **A4 — `log_id` is this log's.** Refused, not ignored. An authority that
   vouched for `@alice` on one log has said nothing about `@alice` on another,
   and a `log_id` treated as advisory makes every log in existence a replay
   target for every other log's assertions.
5. **A5 — `handle_id == H("free2z/kt/v1/handle-id", handle)`.** The assertion
   agrees with itself.
6. **A6 — `handle` is the submission's handle**, compared as bytes. Charset
   conformance is not a separate check: bytes outside `[a-z0-9_]{1,30}` do not
   decode into a handle at all (§1.3), so a non-conforming handle cannot reach
   this rule as bytes-that-decoded. **No normalization is performed**, per
   [`WIRE.md` §14.1](./WIRE.md#14-handle-charset-for-messaging--blocking-pre-check-resolved);
   comparing by any rule other than byte equality would reintroduce exactly what
   the charset removed.
7. **A7 — `identity_pk` is the submission's `identity_pk`.** An assertion about
   one key cannot authorize another.
8. **A8 — `expires_ms > issued_ms`.**
9. **A9 — `expires_ms - issued_ms <= max_validity_ms`, and `max_validity_ms` is
   the log's, not the issuer's.** This is the log-side cap and it is the single
   most load-bearing bound in this section. An issuer that could choose its own
   validity would, once compromised, mint one assertion good for a decade, and
   every later rotation of the authority set would leave that assertion working.
   The cap is what bounds a captured or post-compromise assertion to the cap.
   **The value is not fixed by this document** — it is published in §4.6's
   policy document so that a bound nobody can see is not a bound nobody can
   check. A short window is the point: long enough for a user to complete a
   submission after the authority issued for them, short enough that a captured
   assertion is stale before it can be carried anywhere. The implementations
   this section transcribes use 15 minutes as a cap and disagree on the default
   validity an issuer picks within it, which is why the default is not specified
   here and the cap is.
10. **A10 — `issued_ms` is not further ahead of the log's clock than
    `clock_skew_ms`**, also published in §4.6.
11. **A11 — `now_ms < expires_ms`.** The skew allowance is deliberately **not**
    applied to expiry: an assertion is refused the moment the log's clock reaches
    it. The asymmetry is fail-closed — a verifier whose clock runs fast refuses a
    little early rather than accepting a little late — and it keeps the widest
    window any assertion can be accepted in at exactly
    `max_validity_ms + clock_skew_ms`, which is a number an operator can state.
12. **A12 — `authority_id` is in the log's configured authority set** (§4.6).
13. **A13 — the authority's signature verifies**, strictly, over the re-encoded
    body.
14. **A14 — `intent` matches the position**, per §4.5.3's table, and the entry
    kind matches its sequence position: a first entry has no predecessor, a
    `platform_reset` has one and must replace its `identity_pk`.
15. **A15 — `account_epoch` is strictly greater** than the value retained for
    this handle. §4.5.4 governs what the value must be.
16. **A16 — the `AssertionBinding` signature verifies under the submission's
    `identity_pk`.** §4.5.2. **This rule applies on every path**, including
    §4.6's no-authority path, where it is the whole of the check.
17. **A17 — `(authority_id, nonce)` has not been admitted before.** Single-use,
    and it is the only rule here that writes. Keying on the pair rather than on
    the assertion digest is deliberate: a digest catches only a byte-identical
    replay, while the pair also catches an issuer that reused a nonce across two
    *different* assertions — an issuer bug, or a compromised issuer trying to
    make two claims look like one, which is the case worth failing on.
18. **A18 — `account_epoch` moved like a counter, not like a clock.** It is
    below `2^20`, and where a value is retained for this handle it exceeds that
    value by at most 16. §4.5.4 states both bounds, why they are fixed rather
    than published, and exactly what they cannot prove. Applied **with A15**
    rather than after A17: it costs nothing, and a submission that fails it must
    not burn a nonce. Numbered last because it was added last
    ([#651](https://github.com/free2z/zuu/issues/651)); it is not run last.

**On A17's ledger.** A log MUST refuse rather than evict: discarding an unexpired
entry to make room silently reopens the replay window at exactly the moment the
log is under load, which is exactly when an attacker would arrange to be. A full
ledger is `ERR_RATE_LIMITED` (§9.5). Retention MUST be at least
`expires_ms + clock_skew_ms`, which is derived rather than configured, so it can
never be shorter than the window it protects. The ledger MUST survive a restart:
a log that rebuilds an empty ledger on startup has reopened the window for the
length of one validity period, and while §4.2's version chain independently
refuses the replays that matter today, a rule whose enforcement depends on
another rule is not the rule that was specified.

#### 4.5.6 What the wire codes are

There is no new error code. §9.5's table is unchanged and the mapping is:

| Refusal | §9.5 code |
|---|---|
| A2 decode, re-encode mismatch, charset | `ERR_MALFORMED` (1) |
| A4 wrong `log_id` | `ERR_UNSUPPORTED_VERSION` (2) — "a `log_id` this server does not serve" |
| A13, A16 signature failures | `ERR_BAD_SIGNATURE` (3) |
| A1, A3, A5–A12, A14, A15, A18, and A17 **as a replay** | `ERR_BAD_AUTHORIZATION` (4) |
| A17 refused because the ledger is **full of unexpired entries** | `ERR_RATE_LIMITED` (9) |
| the log's own authority set is misconfigured | `ERR_INTERNAL` (11) |

The last row is the one to notice. A misconfigured authority set is the
operator's fault, not the submitter's, and §9.5 is explicit that `ERR_INTERNAL`
carries no detail. A log that answered `ERR_BAD_AUTHORIZATION` there would blame
a user for an operator error and hide the operator error. A log MAY keep a finer
local distinction for its own operators — an operator debugging a real failed
submission needs to know whether the clock, the charset or the nonce was the
problem — but MUST NOT put it on the wire, for
[`WIRE.md` §10](./WIRE.md#10-error-codes)'s reason.

### 4.6 A log with no authority, and why it must say so

[ADR 0005](./decisions/0005-federation.md) requires that the directory be
self-hostable, and a self-hoster may have no user directory to vouch with. Such
a log **MAY** run with no configured authority. On it:

- A first entry is admitted on rule **A16 alone** — the submitter proves it holds
  the identity key it is publishing, and no party has said which person that key
  belongs to.
- A `platform_reset` cannot be admitted at all, because there is no authority to
  issue the `intent = reset` assertion §4.5.3 requires. A no-authority log is
  therefore a log on which a lost identity key means a lost handle, permanently
  — the same posture [ADR 0014](./decisions/0014-directory-key-rotation.md)
  gives a user who sets `no_reset`, applied to every handle at once. This is a
  consequence worth choosing deliberately rather than discovering.
- Handles mean **"whoever got there first"**, and that is a materially different
  statement from "whoever the directory says."

**No authority MUST be an explicit configuration, never an empty set.** An
authority set that is empty because somebody deleted a line refuses every
submission; a log that is deliberately unvouched admits them on A16. A log that
silently turned the first into the second would be downgraded by a typo. The two
MUST be distinguishable in configuration and MUST fail differently.

**And it MUST be reported.** A log MUST serve a signed policy document, and a
client MUST be able to learn from it whether handles on this log are vouched at
all, *before* it resolves anything.

```
struct { opaque key[32]; } AuthorityPublicKey;

struct {
    opaque             label<0..255>;   /* exactly "free2z/kt/v1/authority-policy" */
    uint16             kt_version;      /* 0x0001 */
    opaque             log_id[32];
    uint8              vouching;        /* 1 = vouched, 0 = unvouched */
    AuthorityPublicKey authorities<0..2^16-1>;  /* empty iff unvouched */
    uint64             max_validity_ms; /* §4.5 A9 — this log's cap  */
    uint64             clock_skew_ms;   /* §4.5 A10                  */
    uint32             asserted_versions<0..2^16-1>;
                                        /* the entry_version values at which an
                                           assertion is required; exactly [1] in
                                           kt_version 1 — a platform_reset is
                                           selected by kind, not by version */
    uint64             published_at_ms;
} AuthorityPolicyTBS;

struct {
    AuthorityPolicyTBS policy;
    opaque             signature[64];   /* Ed25519 by the log signing key */
} SignedAuthorityPolicy;
```

Served at `GET /.well-known/free2z-kt/v1/authority` (§9.2). A verifier MUST
reject a policy that contradicts itself — an unvouched log listing authorities,
or a vouched one listing none.

**This document is not a way to learn who the authorities are and trust them.**
An authority key a client learns from the log is a key the log chose, exactly as
§9.1 says of `reset_authority_pk`. The published list exists so a human can
compare it against a key they were told out of band. What the document gives a
client is the one thing it cannot get anywhere else: **whether this log claims
any handle vouching at all**, so that "unvouched" is a visible property of a
directory rather than something a user discovers after somebody takes their name.

**A client MUST NOT render a vouched and an unvouched handle identically.** This
is §8.3's rule about witness counts applied to the same failure: a client that
cannot distinguish the two is showing a reassuring name for a property it does
not have. An unreported no-authority mode is a downgrade attack surface — a log
that quietly drops its authority set would otherwise be indistinguishable from
one that never had one, and from one that still has one.

**Two honest limits on the reporting, both real.**

- **The policy is log-wide, not per-handle.** Nothing in the log records whether
  a *particular* handle was vouched when it was registered. A log that ran
  unvouched and later configured an authority serves a policy saying "vouched"
  while the handles registered before the change were not, and a client cannot
  tell which is which. A log SHOULD NOT make that transition on a directory that
  already has entries; nothing in this document can stop it.
- **The policy is signed by the log**, so it is a statement by the party a
  client is trying to hold at arm's length. It is exactly as strong as the log's
  other signed statements and no stronger: it makes a downgrade a **documented,
  attributable** act rather than an invisible one, and does not prevent it.

### 4.7 What a compromised authority can and cannot do

The authority is **the one non-cryptographic trust root in the directory**.
Everything else here is provable: `akd` proves the tree is append-only, §4.4
proves an entry was authorized by the key that held the handle before, §7 proves
the log did not equivocate. None of that answers the first question a user
actually asks — *is this `@alice` the `@alice` I know?* — because a
key-transparency log will faithfully, verifiably and permanently publish a key
for a handle for **whoever got there first**. Something has to say who owns a
handle, and no amount of cryptography derives it. This section says what
trusting that something costs, in the manner of
[`THREAT-MODEL.md` §4](./THREAT-MODEL.md#4-known-limits-stated-up-front).

**What a compromised authority cannot do.**

- **It cannot silently swap a live user's key.** `same_key` and `key_change`
  refuse an assertion outright (§4.5.3), so there is no path by which an
  authority signature authorizes a routine change to a handle that already has
  an entry. Rule 6 forbids a `same_key` entry from changing `identity_pk`; rule 7
  requires a `RotationProof` by the **outgoing** `identity_pk`, which a
  compromised authority does not hold. This is
  [ADR 0014](./decisions/0014-directory-key-rotation.md)'s guarantee and §4.5
  does not weaken it.
- **It cannot perform a reset on its own.** `platform_reset` requires §4.4 rule
  8's `ResetAuthorization` under the **pinned reset authority key** — a
  different key, held offline, pinned in clients, not the assertion key — plus
  the published cooldown, plus a `reset_count` in the tree head, plus the
  non-dismissible alarm of §8.2. §4.5 *adds* a requirement to that path and
  removes none, so a compromised assertion authority makes a reset harder, never
  easier.
- **It cannot use a stolen assertion.** A16 requires the identity private key the
  assertion is about. That is the point of the second signature.
- **It cannot replay across logs or across time without bound.** A4 pins the
  `log_id`, A9 caps the validity at a bound the *log* holds, A17 spends the
  nonce once. Assertions minted during a compromise expire within the cap once
  the compromise ends.

**What a compromised authority can do, and it is not small.**

- **It can claim any unregistered handle.** It mints an assertion for `@bob`
  naming an identity key it generated, and produces A16's binding signature
  because it chose that key. `@bob` is now a handle in the log, chained and
  witnessed and permanently correct-looking, belonging to the attacker. **This
  is the genuine residual and there is no prior key to check it against** — that
  is the whole difficulty of a first claim, and it does not go away by
  specifying it better. Nothing detects it: the person who would run §8.2's
  self-audit is not a user of the system, so there is no client anywhere with a
  pin to contradict. A peer who later resolves `@bob` is
  [#133](https://github.com/free2z/zuu/issues/133)'d, with every proof
  verifying.
- **It can deny service**, by refusing to issue. Visible to the user, and not
  something §4.5 addresses.
- **Anyone who can authenticate to the issuer as a user can obtain that user's
  assertions**, and **this document does not say what authorizes issuance.**
  That silence is not a detail. An issuer that mints an `intent = reset`
  assertion on the strength of an ordinary session token has made session theft
  the first step of a handle takeover, and the only things then standing between
  that and a completed takeover are §4.4 rule 8's separate offline key, its
  cooldown, and §8.2's alarm — all of which live in the *log*, none in the
  issuer. An issuer **SHOULD** require materially more for `intent = reset` than
  for `intent = bind` — a recent-authentication window, a second factor, or a
  proof from the outgoing identity key — and **this document does not fix
  which**, because it is an account-security decision and not a wire encoding.
  Named here rather than left to be discovered; §12.
- **It can keep minting for as long as it holds the key.** A9 bounds a *stolen
  assertion* and bounds the damage *after* eviction. It does not bound the
  compromise window itself. Eviction is a membership change in §4.6's authority
  set (rotation is set membership, not a succession protocol — a rotation
  ceremony would be a second trust root guarding the first), and it takes effect
  only when the log's configuration is changed.

**And the limit that constrains all of the above, stated because it is the one a
reader is most likely to assume away.** A `HandleAssertion` is **not committed to
the tree and not served to clients**. It travels in §9.2's submission envelope,
which is not part of `DirectoryEntry`, so it is not inside
`AkdValue = H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` and it does not
come back with a lookup. Every other row of §4.4's table is different in exactly
this respect: a `RotationProof` and a `ResetAuthorization` live inside
`EntryAuthorization`, are hashed into the value the tree commits to, and are
re-verified by every client on every lookup. §4.5 is not. **It is admission
control the log performs on itself, and no client, auditor or witness can check
that it happened.** A log that skipped §4.5 entirely would produce entries
indistinguishable from ones that passed it.

So state the property precisely: §4.5 closes the first-entry hole **against third
parties** — a stranger cannot claim `@alice` — and does **not** close it against
the log. §8.1 step 6 still verifies nothing at `entry_version == 1`, and §8.5's
table still says so. Making the first-entry authorization client-verifiable means
moving the assertion and the binding signature inside `EntryAuthorization` as a
fourth case, with the binding committing to `H(tls_codec(DirectoryEntryTBS))`
rather than to the full entry digest to avoid the circularity that would
otherwise create. That is a wire change to a structure two implementations have
already frozen, it is filed rather than done here, and until it lands this
section describes a property that does not hold.
[#649](https://github.com/free2z/zuu/issues/649),
[§13-S′](./ARCHITECTURE.md#13-open-questions), §12.

---

## 5. Epochs and the merge promise

### 5.1 Cadence

> **Invented here, and the values are proposed placeholders.**
> [§13-P](./ARCHITECTURE.md#13-open-questions). The *structure* of the rule
> matters more than the numbers, and is what §5.3 depends on.

- **The log publishes an epoch every `epoch_interval` seconds — proposed 600 —
  whether or not there is anything to publish.** An epoch with no submissions is
  a valid epoch: same monotonicity, same signature, same cosignatures, an
  append-only proof over zero insertions. **"Over zero insertions" is not
  producible with `akd`; see the correction at the end of this section.**
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

> **Correction (2026-08-24) — an empty epoch is not producible with `akd`, and
> what a log publishes for an epoch with no submissions is a heartbeat
> insertion.** Found by `f2z-kt` while implementing this section
> ([#633](https://github.com/free2z/zuu/issues/633)). The cadence rule and the
> argument for it stand unchanged and are the reason this correction exists at
> all; what does not stand is *"an append-only proof over zero insertions"* and
> the sentence about an empty epoch adding none.
>
> **Why `akd` cannot.** `akd::Directory::publish` with an empty update set does
> not advance the epoch: it filters the batch, finds nothing to insert, and
> returns the **current** `EpochHash` unchanged. There is no empty epoch
> transition, so there is no append-only proof over zero insertions to publish.
>
> **And numbering our way around it does not work either**, which is the half a
> reader could not derive from this document before. `akd::auditor::audit_verify`
> requires exactly one `AppendOnlyProof` segment per epoch transition, and §7.1's
> witness additionally pins each `proof.epochs[i]` to `heads[i].sth.epoch` —
> deliberately, so a log cannot satisfy a witness with a valid proof for a
> *different, earlier* range whose roots happen to line up. A
> `SignedTreeHead.epoch` running ahead of `akd`'s epoch would therefore make
> `/kt/v1/audit` (§9.2) unverifiable for every range containing an empty epoch.
> §5.1's cadence and §9.2's audit endpoint are **jointly unsatisfiable** as
> originally written, and this is where that is written down.
>
> **What a conforming log publishes instead.** Every epoch — with submissions or
> without — carries exactly one **heartbeat insertion**:
>
> ```
> AkdLabel = "free2z/kt/v1/heartbeat:"
> AkdValue = H("free2z/kt/v1/heartbeat-value", uint64be(epoch))
> ```
>
> The label is fixed, so each epoch commits the next version of one record. It is
> deliberately **not** of §3.3's `"free2z/kt/v1/handle:" || handle` form, and the
> bytes after the prefix are not a legal handle under §1.3, so no handle can
> address it and no client resolving a handle can be served it. The trailing `:`
> is load-bearing rather than cosmetic: without it the label is a proper prefix of
> the value label and `H` has no separator, which is
> [#602](https://github.com/free2z/zuu/issues/602)'s defect in miniature
> ([`WIRE.md` §1.3](./WIRE.md#13-conventions); `scripts/check-hash-domain-labels.mjs`
> enforces prefix-freeness over the union of every document's labels).
>
> **What was given up, precisely.** The published proof for an epoch with no
> submissions is over **one** insertion, not zero. `tree_size` (§6.1) counts
> heartbeats, because §6.1 defines it as total `(label, version)` insertions
> committed and a heartbeat is one; §6.3 rule 4 requires only monotonicity and is
> unaffected. The arithmetic a reader needs is that after epoch *e*,
> **`tree_size − e` is the number of directory insertions**. The cost is one leaf
> per epoch — about 52,000 a year at the proposed 600 s cadence, against a
> directory sized in millions — and the append-only proof for an otherwise-empty
> epoch stays O(1) rather than literally empty.
>
> **What was not given up.** The property the empty epoch existed for is
> detection of silence, and the heartbeat delivers it rather than resembling it:
> an epoch is published on cadence whether or not there is work, it increments
> `epoch` by exactly 1, it is signed under §6.2, it is cosignable under §7, it
> carries `published_at_ms`, and its absence is therefore a fault with a timestamp
> attached instead of an ambiguity. Nothing in §5.2, §6.3, §7 or §8.3 depends on
> an epoch having added nothing — only on there **being** one.
>
> **What an observer learns from a heartbeat: nothing new, and that is a
> conclusion rather than an omission.** The heartbeat is a constant, publicly
> known offset of exactly one insertion per epoch, and `epoch` and `tree_size` are
> both already in the signed tree head, so the true directory-insertion count is
> recovered exactly as `tree_size − epoch`. The same count was derivable from
> `tree_size` before heartbeats existed; heartbeats neither conceal a quiet epoch
> nor advertise a busy one. Inside the tree the heartbeat's node labels are
> VRF-derived like every other label (§3.1) and are not distinguishable from a
> directory entry by inspection — in an epoch with no submissions a witness can
> of course identify the single new leaf by elimination, which tells it the count
> it already had. `THREAT-MODEL.md` therefore gains **no** entry for this.
>
> **`akd`-imposed, not fundamental — so a future reader knows to re-check.** The
> upstream capability that would restore the original text is a `publish` that
> advances the epoch on an empty update set and emits a single-transition
> `AppendOnlyProof` segment containing no insertions, with `audit_verify`
> accepting it. Neither exists in `akd` 0.13. See §11.5.

> **Correction (2026-08-24, later the same day) — the cadence rule binds the
> log's *process*, not only its publishing code: a conforming log MUST NOT keep
> serving after whatever emits epochs has stopped.** Found while fixing
> [#684](https://github.com/free2z/zuu/issues/684). Nothing above is withdrawn;
> what is added is the half a reader could otherwise implement around.
>
> §5.1's whole argument is that a heartbeat converts silence from an ambiguity
> into a detectable fault. **That argument assumes something is still emitting
> heartbeats.** A log whose scheduler has died — panicked, cancelled, or never
> restarted after a transient — does not *fail* the cadence rule in a way any
> client can see: it goes on serving §9.2's endpoints correctly, `/kt/v1/sth`
> keeps returning the last valid signed tree head, every inclusion and
> consistency proof still verifies, and nothing errors. The detection mechanism
> is not tripped, it is **removed**, because there are no heartbeats left to
> miss.
>
> A witness following the log does eventually see it (§7: no new head for
> longer than the cadence), and the log's own operator sees it in
> `KT.md`-derived monitoring — but both are *external* observers on a delay, and
> a process-local probe answers `200` throughout. So the rule at the process
> level is:
>
> - **The epoch scheduler is supervised.** If it ends for any reason before an
>   orderly shutdown was requested, the log stops serving and the process exits
>   non-zero, within a bounded grace period so that a wedged scheduler cannot
>   hold the listening socket.
> - **A tick that fails is not that**, and is unchanged: an epoch the log could
>   not sign because a signer was briefly unreachable is logged and retried on
>   the next tick. Publishing late is within §5.2's `max_merge_delay_seconds`
>   promise; not publishing at all, silently and forever, is not.
>
> At `replicas: 1` this makes a dead scheduler a short, **visible** outage
> instead of a `Ready` pod serving a directory that has silently frozen. This is
> the same trade `WIRE.md`'s relay made for its listener and expiry tasks
> ([#671](https://github.com/free2z/zuu/issues/671),
> [#683](https://github.com/free2z/zuu/issues/683)), and it is the reason that
> trade generalises: an availability signal that stays green over a component
> that has stopped doing its job is worse than the outage it is hiding.

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
**That holds for `entry_version >= 2` and fails for a handle's first entry; see
the correction below.**

> **Correction (2026-08-24) — the demonstration is self-contained only for
> `entry_version >= 2`.** A consequence of §8.1's correction, and it is the
> sharpest one, so it is stated here rather than left to be derived.
>
> The proof the paragraph above needs is "`(handle, entry_version)` is not in the
> tree at this root." For a handle that **already has** an entry, that is
> producible and the mechanism is a **complete key-history proof** —
> `/kt/v1/history` with the complete parameter, verified by
> `akd_core::verify::history::key_history_verify` (§8.2) — from which the absence
> of the promised version follows, because the proof is over the whole version
> list. Name the mechanism, because "a non-membership proof" on its own does not
> identify it.
>
> For `entry_version == 1` — a handle with **no** entry at all — there is nothing
> to prove against: `akd` 0.13 has no proof for an unregistered label, so the
> complaint degrades to the same unproved assertion §8.1's correction describes,
> and a receipt for a handle's **first** entry cannot be turned into portable
> evidence. The victim can still publish the receipt, which is signed by the log
> and shows the promise; what they cannot supply is the other half — a checkable
> demonstration that the entry is absent.
>
> This lands on the same case as
> [§13-S′](./ARCHITECTURE.md#13-open-questions): a handle's first entry is the one
> whose authorization a *client* cannot check (§4.7) **and** the one whose
> non-inclusion cannot be proved. Both are recorded rather than reconciled,
> because they close by different means. (This paragraph named §13-S until
> 2026-08-24, when §4.5 answered what authorizes a first entry and §13-S moved to
> [§13.1 Closed](./ARCHITECTURE.md#131-closed); what remains open is the narrower
> §13-S′, and it is still the same handle-with-no-entry case.)

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

`tree_size` counts §5.1's per-epoch heartbeat insertions, because they are
`(label, version)` insertions and this field describes the tree rather than the
directory. After epoch *e*, the number of **directory** insertions is
`tree_size − e`. See §5.1's correction.

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
| `free2z/kt/v1/handle-assertion` | `HandleAssertionTBS` | authority (§4.5) |
| `free2z/kt/v1/assertion-binding` | `AssertionBindingTBS` | user's ISK (§4.5) |
| `free2z/kt/v1/authority-policy` | `AuthorityPolicyTBS` | log (§4.6) |

> **Correction (2026-08-24) — the last three rows are new, and the set was
> described as closed without them.** As first published this table covered the
> nine structures this document then signed and called the set closed. §4.5 and
> §4.6 add three signed structures, so the set is closed **as of this revision**
> rather than as of the first, and an implementer working from the first must add
> them. Nothing above changed: no existing label was renamed and no existing
> structure gained or lost a signer.

Three further labels in the `free2z/kt/v1/` namespace are **hash-domain labels,
not signing labels**, and are listed separately so nobody looks for a structure
that starts with them: `free2z/kt/v1/authority-id` and
`free2z/kt/v1/handle-id` derive the two ids inside a `HandleAssertionTBS`, and
`free2z/kt/v1/assertion-digest` derives the value an `AssertionBindingTBS`
commits to (§4.5.1). They are held to
[`WIRE.md` §1.3](./WIRE.md#13-conventions)'s prefix-freeness requirement along
with everything else in the namespace — note in particular that
`free2z/kt/v1/handle-id`, `free2z/kt/v1/handle-assertion` and §3.3's
`free2z/kt/v1/handle:` are mutually prefix-free, which is not an accident and is
enforced by `scripts/check-hash-domain-labels.mjs` on every pull request
([#602](https://github.com/free2z/zuu/issues/602)).

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
| `merge_delay_exceeded` | **Yes for `entry_version >= 2`**, given the `SubmissionReceipt` in `detail` plus a complete key-history proof at the covering root showing the promised version absent — all log-signed. **No for `entry_version == 1`**: `akd` cannot prove non-membership for a handle with no entry, so the report is an accusation with a signed promise attached and no checkable second half (§5.3's correction, §8.1's correction). |
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
   is *in the tree*, not that it was *authorized*. **At `entry_version == 1`
   there is still nothing here to verify.** §4.5 now says what authorizes a first
   entry, but it is checked by the log at submission and is not committed to the
   tree, so a client is served no artifact to check (§4.7's last paragraph). This
   step therefore establishes nothing about a handle being resolved for the first
   time, and a client MUST NOT present it as though it did.
7. Fetch §4.6's `SignedAuthorityPolicy` for this `log_id` and verify it under the
   log key already accepted in step 2. If the log reports itself **unvouched**,
   every handle on it means "whoever got there first" and the client MUST
   surface that — §4.6, and §8.3's rule about not displaying a reassuring number
   for a property the system does not have.
8. Pin `(handle, identity_pk, entry_version, prev_entry_hash, epoch)`.

**A handle that is not registered returns a proof of non-membership, not an
error.** **That is the requirement and not the shipped property — read the
correction below with it.** This is worth contrasting with
[`WIRE.md` §10](./WIRE.md#10-error-codes)'s existence-oracle rule, which
collapses "no such queue" and "not yours" into one code precisely so the relay
cannot be probed. The opposite conclusion here is correct for the opposite
reason: queue addresses are meant to be unguessable, and **handles are meant to
be public** — discovery is the directory's entire job. So "there is no such user"
is something the log should be made to *prove* rather than allowed to *assert*,
and the zero-knowledge set is exactly what makes that provable without revealing
the rest of the directory.

> **Correction (2026-08-24) — the log does not prove absence, and a v1 lookup
> answers an unregistered handle with an assertion that MUST be labelled
> unproved.** Found by `f2z-kt` while implementing §9.2
> ([#634](https://github.com/free2z/zuu/issues/634)). Everything above about
> *why* absence should be proved is unchanged and is why this is recorded as a
> limit rather than edited away. What does not hold is the word **returns**: as a
> statement of what a conforming log serves today, the paragraph promises a proof
> that cannot be produced.
>
> **`akd` 0.13 has no API that produces it.** `Directory::lookup` **errors** for
> a label with no user state — `StorageError::NotFound` — and produces no proof
> of anything. The `NonMembershipProof` that does exist inside a `LookupProof` is
> about the **freshness marker** of a label that *is* in the tree: it proves that
> a returned version is the current one, not that a label was never registered.
> There is no public entry point that asks for the latter.
>
> **What a conforming v1 log serves, and the requirement that replaces the
> promise.** The lookup response carries an explicit **presence discriminant**,
> and its absent value is named for what it is: an **unproved assertion**.
> Normatively, from this correction forward:
>
> - A log MUST distinguish present from absent on the wire, and MUST name the
>   absent case in a way that says it is unproved. `f2z-kt-core` spells it
>   `Presence::AbsentUnproved`.
> - A log MUST NOT return the absent case with a populated proof field, and MUST
>   NOT answer an unregistered handle with an error instead (§9.5 still has no
>   unknown-handle code; its reason has changed — see its correction).
> - A client MUST treat an absent answer as **unverified input**. It MAY show the
>   user "no such handle". It MUST NOT record it as an established fact about the
>   directory, MUST NOT conclude from it that a handle it has previously resolved
>   has been removed, and MUST NOT let it weaken or discard a pin it already
>   holds (step 8 above).
> - A client that holds a pin for a handle and is then told that handle does not
>   exist **MUST fail closed and alarm.** It must also be told plainly what it
>   has: a contradiction it **cannot prove to anyone**. The log signs tree heads,
>   not lookup responses, so an absent answer is not a signed statement, is not
>   non-repudiable, and cannot be published as evidence the way §7.3's
>   `rollback`, `fork` or `chain_break` reports can.
>
> **What this costs.** A log that can assert absence without proving it can deny
> that a user exists and be indistinguishable from a log telling the truth —
> which is the withholding attack the rest of this construction exists to bound,
> arriving at the one point where the bound is missing. It is a downgrade against
> **discovery** rather than against an established conversation: a peer already
> pinned is unaffected, and a peer who has never been resolved can be made to
> look like nobody. Recorded in
> [`THREAT-MODEL.md` §4.11](./THREAT-MODEL.md#411-an-unregistered-handle-is-asserted-not-proved),
> listed in §12, and open as
> [§13-T](./ARCHITECTURE.md#13-open-questions).
>
> **`akd`-imposed, not fundamental.** The upstream capability that would lift it
> is a `Directory::lookup` variant returning a non-membership proof, against the
> VRF-derived label, for a label with no user state — the tree can prove it, the
> API cannot ask. See §11.5.

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
| That an entry **after the first** was authorized under §4.4 | That the log did not refuse someone else's submission |
| Whether the log **claims** to vouch for handles at all (§4.6's signed policy) | That a handle's **first** entry came from whoever is entitled to the handle. §4.5 now says what authorizes `entry_version == 1`, and the log checks it; it is not committed to the tree and not served, so there is nothing for a client to verify (§4.7) |
| — | That a log which reports itself vouched actually applied §4.5 — or that a handle registered while it was unvouched was later re-vouched. The policy is log-wide, not per-handle (§4.6) |
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
| `GET` | `/.well-known/free2z-kt/v1/authority` | `SignedAuthorityPolicy` (§4.6) | anyone |
| `GET` | `/kt/v1/sth` | latest `SignedTreeHead` + `WitnessCosignature<>` | anyone |
| `GET` | `/kt/v1/sth/{epoch}` | that epoch's `SignedTreeHead` + cosignatures | anyone |
| `GET` | `/kt/v1/audit?from={e0}&to={e1}` | `AppendOnlyProof` (akd protobuf, §9.4) + both tree heads | witnesses in practice (§10) |
| `POST` | `/kt/v1/lookup` | `{handle}` → `DirectoryEntry` + `LookupProof` + tree head + cosignatures | anyone |
| `POST` | `/kt/v1/history` | `{handle, params}` → `DirectoryEntry<>` + `HistoryProof` + tree head + cosignatures | anyone |
| `POST` | `/kt/v1/submit` | `SubmissionEnvelope` → `SubmissionReceipt` | the handle's owner |
| `POST` | `/kt/v1/cosign` | `WitnessCosignature` → empty | witnesses |

Request and response bodies are `tls_codec`, `Content-Type:
application/octet-stream`, under [`WIRE.md` §3](./WIRE.md#3-serialization)'s
rules including re-encode equality — with the §9.4 exception.

`/kt/v1/lookup`'s response carries a **presence discriminant** whose absent value
is an unproved assertion rather than a proof, per §8.1's correction. `entry` and
`proof` are empty in that case, and a response that populates either while
claiming absence — or claims presence with them empty — is malformed.
```
struct {
    opaque label<0..255>;         /* exactly "free2z/kt/v1/submission" */
    uint16 kt_version;            /* 0x0001 */
    opaque entry<0..2^24-1>;      /* tls_codec(DirectoryEntry) */
    opaque assertion<0..2^24-1>;  /* tls_codec(HandleAssertion); empty where
                                     §4.5 A1 says none is carried */
    opaque identity_signature[64];/* the AssertionBinding signature, §4.5.2 */
} SubmissionEnvelope;
```

> **Correction (2026-08-24) — `/kt/v1/submit` takes a `SubmissionEnvelope`, not
> a bare `DirectoryEntry`.** The table said `DirectoryEntry` as first published,
> which was accurate for the rules that existed then and is not a shape §4.5 can
> be carried in: an assertion and its binding signature have nowhere to live
> inside a `DirectoryEntry`, and putting them there would have been a change to
> the structure the tree commits to (§4.7's last paragraph explains why that
> change is the *better* one and why it is filed rather than made here). An
> implementer working from the first revision must change the request body.
>
> `entry` is carried as **bytes rather than as a decoded structure**, so that
> §4.4's rule 1 applies re-encode equality to the bytes that arrived rather than
> to a structure the envelope's decoder already round-tripped. Decoding here and
> re-encoding for the validator would put a second codec between the wire and
> the rule, which is the parse-versus-verify gap
> [`WIRE.md` §3.3](./WIRE.md#33-the-re-encode-equality-rule--mandatory) exists to
> close.
>
> `label` and `kt_version` are a **type-and-version tag on an unsigned
> container**, not signing labels: nothing signs a `SubmissionEnvelope`, and
> §6.2's table is the set of labels that appear inside *signed* bytes. The tag is
> there because a decoder that checks a constant before reading a field is
> cheaper than one that infers the type from the shape.
>
> An **empty `assertion` field and an absent one are the same thing**, and §4.5's
> A1 decides which is correct for a given submission. `identity_signature` is
> **never optional on any path** — not on a vouched log, not on an unvouched one,
> where it is the whole of the check (§4.6).

`/kt/v1/cosign` is an inbound endpoint on the **log**, not on the witness: the
witness pushes outbound, keeping §9.3's promise that a witness needs no inbound
port, no certificate and no domain. The log then serves the cosignatures it
collected. §7.5 states the conflict of interest that creates and what a client
should do about it.

> **Correction (2026-08-24) — a log that recognises no witnesses accepts no
> cosignatures.** §9.5's `ERR_NOT_A_WITNESS` row calls the log's witness list
> *"advisory only"*, and the first implementation read that as licence to skip
> the check entirely when the list was empty. It was measured, not inferred:
> four freshly generated keys, named nowhere in a real log's configuration, were
> all accepted, `fsync`ed to the append-only journal, replayed at every startup,
> and served inside every `/kt/v1/sth` bundle
> ([#669](https://github.com/free2z/zuu/issues/669)).
>
> **A log MUST refuse a cosignature whose `witness_pk` is not one it has been
> configured to recognise, and an empty configured set recognises nobody.** A
> log MAY be run with no witnesses; what it may not do is collect cosignatures
> from strangers on their behalf.
>
> "Advisory" was and remains true of the *client*: §8.3's threshold is applied
> over the client's own configured set, and the log's list has no cryptographic
> bearing on it. It was never true of the *log*, which is where the list decides
> what gets an `fsync` on an append-only journal with no backup, what is held in
> memory for the life of the process, and what number a client sees in a
> tree-head bundle. A count inflated by anonymous keys is worse than a count of
> zero, because
> [`ARCHITECTURE.md` §9.3](./ARCHITECTURE.md#93-anti-equivocation-without-a-blockchain)
> already requires the UI to stop displaying a reassuring witness count that
> nothing independent stands behind — and this made the number reassuring and
> unfounded at the same time.
>
> Two consequences worth stating, because both are properties an implementation
> can be checked against:
>
> - **The bound is structural, not a tuned number.** Storage is idempotent per
>   `witness_pk` and every accepted key is on the configured list, so one epoch
>   holds at most as many cosignatures as there are configured witnesses. No
>   input grows the journal without bound.
> - **The configuration is re-applied at every startup.** A record already in
>   the journal from a key the log does not recognise MUST NOT be replayed into
>   what the log serves. The journal is append-only and keeps the evidence;
>   recovery from a period of fail-open operation is a configuration change and
>   a restart, never hand-editing a security-sensitive append-only file.
>
> `ERR_NOT_A_WITNESS`'s meaning is unchanged — it is still "from a key the log
> does not recognise" — and a log with no configured witnesses recognises none.

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
| 3 | `ERR_BAD_SIGNATURE` | An `auth_signature`, `RotationProof`, reset, cosignature, **authority signature or `AssertionBinding` signature** (§4.5 A13, A16) failed verification. |
| 4 | `ERR_BAD_AUTHORIZATION` | Structurally valid but §4.4's rules unmet — e.g. a key change with one signature (rule 7), a `same_key` entry that changes `identity_pk` (rule 6), or any of §4.5's rules other than the four §4.5.6 maps elsewhere (rule 11). |
| 5 | `ERR_VERSION_CONFLICT` | `entry_version` not `previous + 1`, `prev_entry_hash` mismatch, or a second entry for this handle in this epoch (§4.3). |
| 6 | `ERR_COOLDOWN` | A `platform_reset` whose `effective_at_ms` has not arrived. |
| 7 | `ERR_EPOCH_UNAVAILABLE` | The requested epoch or audit range is outside the served horizon (§9.3). |
| 8 | `ERR_RANGE_TOO_WIDE` | An audit range above the published maximum. |
| 9 | `ERR_RATE_LIMITED` | Retry later. |
| 10 | `ERR_NOT_A_WITNESS` | `/kt/v1/cosign` from a key the log does not recognise, **including every key when the log recognises none** (§9.2's correction). Advisory to the *client* — the log's opinion of who is a witness has **no bearing** on a client's configured set (§8.3) — and binding on the *log*. |
| 11 | `ERR_INTERNAL` | Log fault. Carries no detail, ever. |

**There is no "unknown handle" code**, deliberately: an unregistered handle is
answered with a non-membership proof (§8.1). "No such user" is a claim the log
must prove. **The absence of the code stands; the reason given for it does not —
see the correction below.**

> **Correction (2026-08-24) — the sentence above states the requirement, not the
> property this specification delivers.** `akd` 0.13 cannot produce a
> non-membership proof for a label that was never registered (§8.1's
> correction), so what a v1 log actually serves for an unregistered handle is an
> **unproved assertion of absence**, carried in the lookup response's presence
> discriminant and required by §8.1 to be labelled as unproved.
>
> **There is still no unknown-handle error code**, and that decision is
> unchanged — but it now rests on a weaker argument, and the weaker argument is
> the honest one. An error code is indistinguishable from a fault, carries no
> epoch and no tree head, and would let a log deny a user in a channel that
> looks like an outage. The presence discriminant at least forces the log to
> answer in-band, bundled with the cosigned `SignedTreeHead` it is standing on,
> and forces the client to see the word *unproved*. That is strictly better than
> an error code and strictly worse than a proof.
>
> **"No such user" is a claim the log must prove remains the requirement. It is
> not, today, a property this specification delivers.**
> [#634](https://github.com/free2z/zuu/issues/634), §11.5, §12,
> [§13-T](./ARCHITECTURE.md#13-open-questions),
> [`THREAT-MODEL.md` §4.11](./THREAT-MODEL.md#411-an-unregistered-handle-is-asserted-not-proved).

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

**Client verifier bundle**, `cdylib`, `akd_core` +
`vrf,whatsapp_v1,protobuf`: the size-optimised profile produced
**118,314 B**<!-- akd-metric:verifier_size_raw --> raw,
**47,940 B**<!-- akd-metric:verifier_size_gzip --> gzip -9, and
**39,631 B**<!-- akd-metric:verifier_size_brotli --> brotli -q11. The recommended
`opt-level=3` profile produced
**183,375 B**<!-- akd-metric:verifier_recommended_raw --> raw and
**48,116 B**<!-- akd-metric:verifier_recommended_brotli --> brotli -q11. Take
`opt-level=3`; the exact measurements and provenance are checked in at
[`evidence/akd-benchmark.json`](./evidence/akd-benchmark.json) and mechanically
bound to every published bundle-size value.

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

### 11.5 What `akd` 0.13 cannot do, and what upstream would have to add

§11.3 records one upstream wart. Two more surfaced when this document was first
implemented, and unlike the wart they are not one-line fixes — they are missing
capabilities, and each one caused a correction above. Collected here so a future
reader on a newer `akd` knows exactly what to re-check, and so a reader on 0.13
does not go looking for an API that is not there.

| Missing capability | What it would restore | Where the correction is |
|---|---|---|
| A `publish` that **advances the epoch on an empty update set**, emitting a single-transition `AppendOnlyProof` segment containing no insertions, which `audit_verify` accepts. | §5.1's literal empty epoch. Today `publish` filters the batch, finds nothing, and returns the current `EpochHash` unchanged, so the transition does not exist. | §5.1 ([#633](https://github.com/free2z/zuu/issues/633)) |
| A `Directory::lookup` variant returning a **non-membership proof for a label with no user state**, against the VRF-derived label. | §8.1's and §9.5's proved absence, and with it §5.3's evidence for a first entry. Today `lookup` errors with `StorageError::NotFound`; the `NonMembershipProof` inside a `LookupProof` is about a freshness marker for a label that is present, and is not this. | §8.1, §9.5, §5.3 ([#634](https://github.com/free2z/zuu/issues/634)) |

Both are limits of the **adopted library**, not of the construction: a sparse
Patricia tree over VRF-derived labels can prove that a label is absent, and an
append-only proof over zero insertions is a well-defined object. `akd` 0.13 has
no API that asks for either. Per
[`AGENTS.md`](../../AGENTS.md)'s prime directive, upstream is the preferred shape
for the second one in particular; it is materially larger than §11.3's one-line
change, and nothing here should be read as a promise that it is in flight.

---

## 12. What this document leaves open

Deliberately, and listed rather than invented.

- **~~What authorizes a handle's first entry.~~ Closed 2026-08-24 by §4.5, §4.6
  and §4.7.** Kept in the list rather than deleted, per this repository's
  convention that a reader arriving from an older citation should find the answer
  and not a hole. It said the question was open, blocking, and not the
  specification's to take; the decision turned out to be one the owner had
  already taken on [#305](https://github.com/free2z/zuu/issues/305) and which
  [#554](https://github.com/free2z/zuu/issues/554)'s brief did not name, so what
  §4.5 does is transcribe it and the two implementations that already
  interoperate under it. [#594](https://github.com/free2z/zuu/issues/594),
  [§13-S](./ARCHITECTURE.md#13-open-questions).
- **Proving that a handle is unregistered — open, and the specification's
  requirement stands unmet.** §8.1 and §9.5 require the log to *prove* absence;
  `akd` 0.13 cannot, so a v1 log asserts it and MUST label the assertion
  unproved. This is not a decision deferred but a property the adopted library
  does not offer, and until it does, a log can deny that a user exists and be
  indistinguishable from a log telling the truth. The option space is upstream
  support (§11.5), a per-epoch signed presence commitment that bounds the lie to
  one epoch rather than removing it, or continuing to serve a labelled
  assertion. None is chosen here.
  [#634](https://github.com/free2z/zuu/issues/634),
  [§13-T](./ARCHITECTURE.md#13-open-questions),
  [`THREAT-MODEL.md` §4.11](./THREAT-MODEL.md#411-an-unregistered-handle-is-asserted-not-proved).
- **Client verification of a first entry's authorization — open, and narrower
  than what it replaces.** A `HandleAssertion` is checked by the log and is not
  committed to the tree, so unlike every other row of §4.4's table it is not
  something a client, auditor or witness can check. §4.5 therefore closes the
  first-entry hole against third parties and not against the log (§4.7). Closing
  it means moving the assertion and its binding signature into
  `EntryAuthorization`, which is a wire change to a structure two
  implementations have frozen. Filed, not invented here.
  [#649](https://github.com/free2z/zuu/issues/649),
  [#594](https://github.com/free2z/zuu/issues/594).
- **What authorizes the *issuance* of a `HandleAssertion`.** §4.5 fixes
  everything a log does with an assertion and nothing about how a user gets one.
  In particular, whether `intent = reset` requires more than `intent = bind` —
  a recent-authentication window, a second factor, a proof from the outgoing
  identity key — is unspecified, and an issuer that treats them alike makes
  session theft the first step of a handle takeover (§4.7). This is an
  account-security decision rather than a wire encoding, which is why §4.5 does
  not invent one, and it is a real gap rather than a tidy deferral. The two
  conformance rules §4.5 states more strictly than a shipped implementation were
  tracked as [#651](https://github.com/free2z/zuu/issues/651) (`account_epoch`)
  and [#650](https://github.com/free2z/zuu/issues/650) (A17's ledger); **both
  are closed on the log side** — A17's ledger now survives a restart, and A18
  refuses a clock-shaped `account_epoch`. What is left is not a specification
  gap but an issuer that must hold a durable per-account counter, which A18 can
  bound but cannot verify (§4.5.4).
- **The authority key's own distribution and rotation.** §4.6 publishes the
  authority set in a document signed by the log, which is not a trust root —
  exactly the caveat §9.1 states for `reset_authority_pk`, and the same
  unanswered question §1.2 already lists for the reset authority key. Rotation is
  set membership and takes effect only when the log's configuration changes;
  there is no revocation artifact and no way for a client to learn that a key was
  evicted. The two gaps are the same gap and should be closed together.
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
