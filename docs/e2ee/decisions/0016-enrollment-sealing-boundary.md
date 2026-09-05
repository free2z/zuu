# ADR 0016 — Enrollment sealing: a per-device wrap key, and a response that carries only what it signs

**Status:** Accepted (2026-09-05) for §3 and §4; **one part deliberately left
open** — see [§6](#6-device_kem_pk-is-not-resolved-here) ·
**Refs:** [#928](https://github.com/free2z/zuu/issues/928),
[#926](https://github.com/free2z/zuu/issues/926),
[#905](https://github.com/free2z/zuu/issues/905),
[#904](https://github.com/free2z/zuu/issues/904),
[#929](https://github.com/free2z/zuu/issues/929),
[#461](https://github.com/free2z/zuu/issues/461),
[ADR 0002](./0002-multi-device.md), [ADR 0006](./0006-zcash-coupling.md),
[ADR 0015](./0015-key-package-publication.md) ·
**Constrains:** [`../../intent-bridge/PROTOCOL.md` §3.3](../../intent-bridge/PROTOCOL.md#33-family-payloads),
[`../ARCHITECTURE.md` §4.2](../ARCHITECTURE.md#42-derivation-proposed) ·
**Nothing here is implemented.** This is the decision
[#928](https://github.com/free2z/zuu/issues/928)'s revised acceptance criteria
require *before* a wire change, and it changes no code.

> **Invented here.**
> [`../ARCHITECTURE.md` §4.2](../ARCHITECTURE.md#42-derivation-proposed) says
> what `BackupWrapKey` is for — *"Wraps local encrypted history so it survives
> reinstall on the same seed"* (`../ARCHITECTURE.md:287`) — and says device keys
> are *"generated on-device from the OS CSPRNG, never seed-derived, never
> exported"* (`../ARCHITECTURE.md:289-296`). It does **not** say what seals the
> device secrets at rest. The implementation chose `BackupWrapKey`, and that
> choice was never written down as a decision. This is the decision, made
> explicitly and the other way.

## 1. Context

Everything below is a fact about the tree at `main`, with the line to check it.

**Fact 1 — `IdentityInstall` requires the seed-derived wrap key.**
`wallet/plugins/tauri-plugin-f2zmsg/src/engine.rs:206-216` declares
`IdentityInstall`, whose `wrap_key: [u8; 32]` is documented **in place** as
*"the seed-derived `BackupWrapKey` (`ARCHITECTURE.md` §4.2)"*
(`engine.rs:212-215`). `install_identity` consumes it at `engine.rs:549`, and
`unlock` takes the same 32 bytes at `engine.rs:571`. ZUULI supplies it from
`account.backup_wrap` at `wallet/zuuli/src-tauri/src/messaging.rs:195` and
`:199`.

**Fact 2 — `cash.free2z.e2e2z` must never hold it.** That app is defined by
holding device keys and a `DeviceCredential` and nothing seed-derived
(`wallet/e2e2z/src-tauri/src/device.rs:3-13`), and
`wallet/e2e2z/scripts/authority-boundary.node-test.mjs:10-35` enforces the three
routes by which seed authority could arrive. So the obvious fix — widen
`IssueDeviceCredentialResultV1` to carry the wrap key — is not available. #928's
own correction comment says so, and it is right.

**Fact 3 — the result type carries one field.**
`rs/crates/f2z-intent/src/wire.rs:349-352`:
`struct IssueDeviceCredentialResultV1 { credential: Body }`. The TypeScript half
matches at `wallet/shared/src/intent/wire.ts:328`.

**Fact 4 — e2e2z registers no install command.**
`wallet/e2e2z/src-tauri/src/lib.rs:30-31` registers exactly one command,
`device::e2e2z_device_credential_keys`. There is no consumer for a credential
that came back.

**Fact 5 — `device_kem_pk` is 1,216 random bytes with no private half.**
`engine.rs:3390-3391` samples it from `rand::rng()` and no private key is kept.
`engine.rs:229-238` documents why at length. It is transmitted for the first
time by #926.

And one fact that decides the whole question, which #928 does not mention:

**Fact 6 — the seal covers only material that is never seed-derivable, and
never covers history.** `seal` at `engine.rs:3416` encrypts a `DeviceSecrets`,
which is exactly `{ device_signing_key, queue_seed }`
(`engine.rs:3383-3402` samples both from the OS CSPRNG;
`wallet/plugins/tauri-plugin-f2zmsg/src/store.rs:200`). The SQLite database
beside it — MLS group state and message plaintext — is **not encrypted at all**,
and `store.rs:40-50` says so in as many words. So the property the seal actually
buys today is narrow and is stated narrowly at `store.rs:186-192`: *"a copy of
the store taken without the mnemonic cannot sign as this identity."*

## 2. Why the wrap key was in the wrong place before e2e2z existed

The account/device split of §4.2 is a **scope** rule, and the current seal
violates it in the direction nobody was watching.

- The seal's *contents* are device-scoped: sampled per device, never exported,
  and by construction **not recoverable from the seed**
  (`../ARCHITECTURE.md:289-296`, and `engine.rs:219-223`'s own comment:
  *"Restoring the mnemonic restores the identity; it does not resurrect a
  device."*).
- The seal's *key* is account-scoped: one 32-byte value per mnemonic, long-term
  (`../ARCHITECTURE.md:287`), shared by every device that account ever enrolls.

Sealing device-scoped material under an account-scoped key gains nothing and
costs something specific:

- **It gains nothing for recovery.** With the mnemonic and no store there is
  nothing to unseal. With the store and no mnemonic the correct recovery has
  always been re-enrollment with fresh device keys, because the sealed contents
  cannot be re-derived. The one case it serves — same machine, store intact,
  mnemonic available — is served just as well by a key the device kept.
- **It costs blast radius.** One key opens the device secrets of *every* device
  of that account, on every machine, for the life of the mnemonic. A per-device
  key confines a compromise to the device that leaked it.
- **It is not the job §4.2 assigns that key.** §4.2 gives `BackupWrapKey` local
  *history*, which has a genuine restore requirement and is the case where an
  account-scoped key is right. That use is unimplemented (`store.rs:40-50`).
  The key is currently doing a job it was not specified for, and not doing the
  one it was.

None of that was urgent while the only app holding device secrets was the app
holding the seed. e2e2z makes it decisive.

## 3. Decision 1 — sealing happens where the secrets are, under a per-device wrap key

**The app that generated a device's secrets seals them, under a `DeviceWrapKey`
it generates from the OS CSPRNG and holds. `IdentityInstall.wrap_key` is
removed. No wrap key crosses the bridge, in either direction, ever.**

Concretely, and this is a sketch for an implementer rather than a patch:

- `prepare_device` (`engine.rs:475`) samples a third value alongside
  `device_signing_key` and `queue_seed`: a 32-byte `DeviceWrapKey`. It is a
  device secret in exactly the sense of `../ARCHITECTURE.md:289-296` — CSPRNG,
  never seed-derived, never exported — and it never appears in
  `DevicePublicKeys`.
- `install_identity` seals `DeviceSecrets` under it and writes the key to the
  **OS secret store**, in a different storage domain from the SQLite file it
  protects.
- On open, the engine asks the secret store for the key. Present ⇒ unsealed.
  Absent or unavailable ⇒ `locked`, which stays a real state.
- **The secret-store item is namespaced per application, not per plugin.**
  `tauri-plugin-f2zmsg` is linked into **both** apps, so a plugin-level service
  constant would give ZUULI and e2e2z the *same* item name on a shared store —
  mutual overwrite, or one app silently opening the other's key. The precedent
  to copy is `tauri-plugin-zcash`'s `const SERVICE = "cash.free2z.zuuli.seed.v1"`
  (`wallet/plugins/tauri-plugin-zcash/src/wallet/keychain.rs:17`): a constant
  that names **one app and one purpose**. The plugin must therefore take the
  service name from the host application at setup rather than declaring one, and
  the two names must be distinct — e.g. `cash.free2z.zuuli.f2zmsg.wrap.v1` and
  `cash.free2z.e2e2z.f2zmsg.wrap.v1`. This is not tidiness; on the platform of
  §3.3's stated assumption it is the difference between two device stores and
  one.
- **`locked` needs an exit, and this decision must supply it.** Today the exit
  is `f2zmsg_enroll` re-deriving the wrap key from the seed
  (`messaging.rs:150-157`), and §10 records that duty going away. Nothing in the
  sketch above replaces it, and a transient failure — a keychain locked at
  launch, D-Bus not yet up — would otherwise leave an engine with no way back.
  So the engine keeps an explicit **retry** operation that re-asks the secret
  store and unlocks on success, available to both apps and needing no seed. It
  is the same `unlock` with its argument removed, and it must be reachable from
  e2e2z, which is the app that cannot fall back to enrollment.
- **This applies to ZUULI too.** One sealing scheme, not two. Two would be two
  chances to disagree about what `locked` means, and the second one would only
  ever be exercised in the app nobody was looking at.
- **Nothing needs migrating.** Existing stores hold `SealedSecrets` under
  `BackupWrapKey` and nothing would be able to open them, so a migration would
  be required if any existed. None do, for the reason §4.2's own `CKDh`
  correction gives and §6 quotes: no user has a messaging identity and no
  directory entry exists (`../ARCHITECTURE.md:266-270`). That is the *whole*
  justification for skipping migration, it is the same asymmetry that argues for
  settling `device_kem_pk` now, and it stops being true on the day the first
  user enrolls — so this change must land before that day or grow a migration.

### 3.1 What each app ends up holding

| | ZUULI | e2e2z |
|---|---|---|
| Mnemonic / `S` | yes, in the OS keychain (`wallet/plugins/tauri-plugin-zcash/src/wallet/keychain.rs:702`) | **no** |
| ISK, CSK, `DirectoryAuthKey`, `BackupWrapKey` | derived in process, per call, dropped (`messaging.rs:219-245`) | **no** |
| `DeviceSignatureKey`, `queue_seed` | its own, sealed under its own `DeviceWrapKey` | its own, sealed under its own `DeviceWrapKey` |
| `DeviceWrapKey` | its own, in the OS secret store | its own, in the OS secret store |
| `DeviceCredential` | its own | its own, received over the bridge |

### 3.2 What crosses the bridge

Request: `handle`, `device_pk`, `device_kem_pk`, two timestamps
(`PROTOCOL.md` §3.3). Response: one `DeviceCredential`.

**Every byte in both directions is public material.** No secret crosses, so
there is no secret for a hostile transport to steal, and no secret whose
confidentiality the transport has to provide. Given that #461 has not landed and
#929 is open, that is not a nicety — it is the property that makes the exchange
designable at all today. See [§7](#7-what-this-does-not-assume-about-the-channel).

### 3.3 What an attacker gets

Read this as *what a full compromise of one app yields that it would not
otherwise*, holding the other app intact.

| Attacker has | Under today's design | Under this decision |
|---|---|---|
| **e2e2z alone** | not reachable — e2e2z cannot enroll at all | this device's signing key, queue seed and credential; can send and read as **this device**. **Not** the seed, ISK, `DirectoryAuthKey`, `BackupWrapKey`, or any other device of the account. Cannot issue a credential, cannot publish a directory entry, cannot add a device |
| **ZUULI alone** | the seed, hence ISK ⇒ can mint credentials and publish directory entries for the handle; **plus** `BackupWrapKey`, which opens the device secrets of every device of that account whose store it can read | the seed, hence ISK ⇒ can mint credentials and publish directory entries — i.e. **full account takeover, which the seed always was**. It does **not** additionally open any other device's secrets |
| **a copy of the store file** | cannot sign (needs the mnemonic) | cannot sign (needs the secret-store item) |
| **store file *and* secret store** | cannot sign without the mnemonic | can sign as that device |

Two honest readings of that table:

1. The `ZUULI alone` row barely moves, because seed compromise was already total
   for the *account*. What changes is that it stops being total for every
   *device*: `BackupWrapKey` is removed from the path, so a stolen mnemonic no
   longer decrypts a device store it happens to also have. That is a strict
   improvement, and a small one.
2. The last row is a **real reduction against ZUULI's status quo**, and it is
   the price of this decision. It is smaller than it looks, because on every
   platform where the current seal is implemented, the mnemonic *is itself* an
   OS secret-store item (`keychain.rs:702`, service entry `seed_{wallet_id}`).
   The attacker needs the same class of access to reach either. What changes is
   which item, not how hard the item is to get.

**The assumption both containment claims rest on, stated because it is not true
everywhere.** "A per-device key confines a compromise to one device", and "an
attacker with e2e2z alone learns nothing about ZUULI's device", both require the
OS secret store to **isolate one application's item from another's**. macOS
keychain ACLs bind an item to the code signature that created it, and Windows
credential storage is per-user-per-target with the same effect. **The
freedesktop Secret Service is not like that**: `linux-native-sync-persistent`
(§3.5) mirrors into a per-user collection with **no per-application isolation**,
so on Linux a compromised e2e2z can read ZUULI's item, and with the
user-readable store file beside it can unseal ZUULI's device secrets.

That is a genuine partial re-connection of the two apps this split exists to
separate, and it does not exist today — today ZUULI's wrap key is **never
persisted at all**, it is re-derived per call and dropped
(`messaging.rs:219-243`). It is adjacent to a pre-existing question rather than
a new hole, because the mnemonic already lives in the same Secret Service
(`keychain.rs:702`), so an attacker with arbitrary read of that collection has
had a better prize available all along. But a document making containment claims
has to say which platform they hold on, so: **on macOS and Windows the table
above is accurate as written; on Linux the `e2e2z alone` row's "not any other
device of the account" is conditional on Secret Service isolation this repo does
not have.** Closing it needs a per-application secret store on Linux, and that
is out of scope here and belongs with §8's uncertainty 1.

And the row that is not in the table because the option is rejected, stated so
the contrast is visible: **under §9's option A — widening the result to carry
`BackupWrapKey` — an attacker who compromises e2e2z alone gets a seed-derived
account key.** Not the seed, and not ISK, so no forgery and no takeover. But it
opens the device secrets of *every* device of that account whose store the
attacker can reach, including ZUULI's on the same machine, and it does so from
the app the whole split exists to keep un-privileged. That is the row that
decides this ADR, and it is the difference between a device compromise and an
account-wide one.

### 3.4 Restore from seed — the test any answer here has to pass

§4.2's whole point is that restoring the mnemonic restores identity. It is worth
being exact about what "identity" means there, because it is narrower than it
first reads and the narrowness is what makes this decision safe:

> Per-device, generated on-device from the OS CSPRNG, **never seed-derived,
> never exported** — `../ARCHITECTURE.md:289-290`
>
> Restoring the mnemonic restores the *identity*; it does not resurrect a
> device. — `engine.rs:221-223`

So:

- **Restore onto a new machine.** Re-derive ISK from the mnemonic, sample fresh
  device keys, issue a fresh credential, publish. Identical before and after
  this decision, because the old device's secrets were never recoverable either
  way. This is ADR 0002's add-a-device flow, and
  `../ARCHITECTURE.md:318-322`'s rule applies: the registration is a wiretap and
  must be surfaced.
- **Restart on the same machine, store intact.** Today: ZUULI re-derives
  `BackupWrapKey` and unlocks (`messaging.rs:155`). Under this decision: the
  engine reads `DeviceWrapKey` from the secret store and unlocks, with no seed
  involved — which is the only reason e2e2z can restart at all.
- **Restore of the mnemonic with a store present but no secret-store item**
  (a wiped keychain, a migrated profile). Today: recoverable. Under this
  decision: **not** recoverable; the device re-enrolls. That is the one
  regression, it is confined to ZUULI, and §9 lists the hybrid that buys it
  back if it turns out to matter.

**No design in this ADR breaks restore**, because restore was never a property
of the seal.

### 3.5 The failure this decision must not create

If `DeviceWrapKey` is unretrievable at launch and the app re-enrolls
automatically, every launch mints a new device, a new credential and a new
directory entry — and `../ARCHITECTURE.md:318-322` requires every one of those
to be surfaced to the user and to the log. A notification storm is the visible
symptom; an append-only log full of one user's phantom devices is the durable
one.

So the rule is: **an app that cannot durably hold a `DeviceWrapKey` must refuse
to enroll, not enroll into a state it cannot reopen.** Fail closed at the
moment the cost is one refusal, not at the moment it is a log entry.

One objection to that rule deserves answering rather than leaving for review,
because Fact 6 raises it: the seal protects only the signing key, while MLS
group state and message plaintext sit **unencrypted** beside it
(`store.rs:40-50`). An attacker holding the store file already reads every
message; refusing to enroll defends only "cannot sign as this identity". Is a
hard refusal proportionate to that narrow property?

I think yes, but on a different ground than the one it looks like: the refusal
is not primarily protecting the seal, it is preventing this section's first paragraph
— an app that re-enrolls on every launch, minting a directory entry and a
wiretap notification each time. That harm is durable, public and append-only,
and it does not depend on how much the seal is worth. §9's option F is the
alternative that keeps enrollment working with a weaker seal, and it is the one
to reach for if this refusal turns out to lock real users out.

This is load-bearing on Linux, where the secret store is
`linux-native-sync-persistent` over D-Bus and a machine with no Secret Service
daemon has none, and on mobile, where
`wallet/plugins/tauri-plugin-zcash/src/wallet/keychain.rs:332-352` returns
`UnavailableStore` for every non-desktop target. See
[§8](#8-what-i-am-not-certain-about).

## 4. Decision 2 — `IssueDeviceCredentialResultV1` needs no new fields

**It stays `struct { opaque credential<0..2^24-1>; }`. Nothing is added.**

#928's original criterion asked for `identity_pk` and `BackupWrapKey`. The wrap
key is answered by §3. The other two fields — and `handle`, which
`install_identity` also takes — are answered by looking at what a
`DeviceCredential` already is:

```text
DeviceCredentialTBS = { label, identity_pk, handle, device_pk,
                        device_kem_pk, not_before_ms, not_after_ms }
signature           = Sign(ISK, canonical(DeviceCredentialTBS))
```

(`rs/crates/f2z-kt-core/src/entry.rs:73` and the surrounding struct;
`rs/crates/f2z-msg-identity/src/credential.rs:105-133`.)

`identity_pk` and `handle` are **already inside the credential, covered by the
signature**. Carrying them again beside it would create a second, *unsigned*
copy of two values that the signed structure already fixes — and under #929 that
second copy is chosen by whoever answered, not by whoever signed. Two sources
for one value is how they end up disagreeing, and here the unsigned one would
win, because it is the one `install_identity` currently stores
(`engine.rs:537-538` writes `install.handle` and `install.identity_pk`
verbatim).

So the rule the install step must follow is the inverse of the widening:

> **`install_identity` takes `handle` and `identity_pk` *from the parsed
> credential*, and stops accepting them as separate arguments.**

`IdentityInstall` becomes `{ credential, submitted_at }` — three fields
removed, none added.

**That rule is about values the *responder* supplies, and it must not be read as
forbidding a comparison against a value the *caller already holds*.** The
distinction is the whole of #929. A second copy of `handle` travelling *beside*
the credential is attacker-chosen and worthless. The handle the user typed into
**this session** is not: `requestDeviceCredential(handle)`
(`wallet/e2e2z/src/lib/enrollment/issueDeviceCredential.ts`) holds it at the
exact moment the credential comes back, it never travelled in the response, and
it is the caller's own intent rather than anyone's claim.

So the rule has a second half, and it is not optional:

> **The caller MUST refuse a credential whose `handle` is not the one it
> requested.**

Why that is load-bearing rather than belt-and-braces: `validate_at` verifies the
signature under the credential's **own embedded `identity_pk`**
(`rs/crates/f2z-msg-mls/src/credential.rs:157-162`). That is self-*consistency*,
not authenticity. A hostile responder mints its own ISK and signs a perfectly
well-formed credential for **any handle it likes**, and every check in
`validate_for_leaf` passes. Compared against what this session asked for, it is
refused. Not compared, e2e2z installs it and stores the attacker's handle and
`identity_pk` as its own identity — §7's fabrication landing in the store
instead of being caught at the door.

It is also the **only** check trust-on-first-response permits. There is no
trusted `identity_pk` to verify against on a first enrollment (§7), so *"is this
the handle I asked for"* is the entire authenticity budget available at this
layer. Deleting it because it superficially resembles the widening this section
rejects would be the most expensive misreading of this ADR.

Where it lives is a free choice and both are acceptable: in the renderer before
it invokes (the handle is already in scope there), or as an explicit
`expected_handle` argument to the install command (§5). Either way it adds **no
wire field** and is fully compatible with Decision 2.

### 4.1 What that also fixes, which is a live gap today

`install_identity` reaches `MlsEngine::new` (`engine.rs:527`), which calls
`validate_for_leaf` (`rs/crates/f2z-msg-mls/src/engine.rs:255`). That does check
the credential's signature under its own `identity_pk`, its structural validity,
its window, and — the binding that matters — that `credential.device_pk` equals
the prepared signer's public key
(`rs/crates/f2z-msg-mls/src/credential.rs:183-190`).

It does **not** check that `credential.handle == install.handle`, or that
`credential.identity_pk == install.identity_pk`. Nothing else does either;
`engine.rs:501-556` is the whole function. Today that is harmless, because the
caller that supplies both is the same process that issued the credential
(`messaging.rs:190-198`). The moment the credential arrives over a bridge and
the handle arrives from a renderer, it stops being harmless: e2e2z would store
and display a handle the credential does not attest.

Taking both from the credential removes the divergence instead of adding a
comparison, which is the same move ADR 0015 makes for `KeyPackage` fetching —
authenticate against the signed object rather than beside it.

### 4.2 `submitted_at`

The one field with no home inside the credential.
`StoredIdentity.submitted_at` is §3.2 UI bookkeeping — *"a directory submission
does not take effect instantly … so the UI shows 'submitted', not 'active'"*
(`engine.rs:542-547`) — and in ZUULI it is simply the local clock at issuance
(`messaging.rs:196`).

Take it from **the installing app's own clock**. It is local bookkeeping, not a
security value, and a responder-supplied timestamp would be one more unsigned
field an unauthenticated responder gets to choose. Consistency with the
credential is available for free by checking it against the credential's own
`not_before_ms`, which *is* signed.

### 4.3 Then #928's wire criterion is satisfied by not doing it

The revised criterion reads *"Only then update `IssueDeviceCredentialResultV1`
in **both** halves, with canonical decode/re-encode equality preserved."* Under
this decision the update is empty: no field is added, so `WIRE.md` §3.3's
re-encode equality is preserved trivially and the 130-byte vector of
`PROTOCOL.md` §3.6 is untouched. The work moves to `IdentityInstall`, which is
a Rust API and not a wire format, and is therefore free to change.

## 5. Decision 3 — where the install step lives in e2e2z

**An app-crate command, `e2e2z_install_device_credential`, beside
`e2e2z_device_credential_keys` in `wallet/e2e2z/src-tauri/src/device.rs`,
registered in the same `invoke_handler` at `wallet/e2e2z/src-tauri/src/lib.rs:30`.
It needs no capability entry and no `zcash:*` grant.**

Why an app-crate command, and not a plugin command:

- **`CLIENT-CONTRACT.md` §2.2's rule, already followed by its sibling.**
  `device.rs:37-46` gives the argument for `e2e2z_device_credential_keys` and it
  transfers word for word: app-crate commands carry no `plugin:` prefix and need
  no capability, and the plugin's command surface is the population §3 pins and
  `wallet/zuuli/scripts/messaging-contract.node-test.mjs` compares in both
  directions. Enrollment is precisely what §2.2 keeps off the plugin's IPC
  surface.
- **The plugin is linked into ZUULI too.** A plugin command that installs an
  identity would appear on ZUULI's IPC surface as well, where
  `messaging.rs:15-30` spends its whole header explaining why enrollment must
  not be reachable that way.

What capability it needs: **none.** A capability grants *plugin* commands
(`messaging.rs:33-36`), and this is not one. e2e2z's
`capabilities/default.json` keeps its 42 named `f2zmsg:*` grants
(`set_relay_trust` is deliberately absent — it is the one grant that is a
security downgrade) and its zero `zcash:*` grants, and `authority-boundary.node-test.mjs` keeps passing
unchanged — which is the point, and is checkable: the install path reads no
seed, links no `tauri-plugin-zcash`, and invokes no `plugin:zcash|` command.

Its signature, precisely enough to implement:

```rust
#[tauri::command]
pub async fn e2e2z_install_device_credential<R: Runtime>(
    app: AppHandle<R>,
    // { credential: String (hex), expectedHandle: String } — camelCase per §3
    args: InstallDeviceCredentialArgs,
) -> Result<EnrollmentStatus>
```

Two arguments, and the asymmetry between them is the point.

`credential` is the credential's canonical bytes as hex — the same encoding
`device.rs:60-64` argues for on the way out. `expectedHandle` is §4's second
half: the handle **this caller requested**, so the command can refuse a
credential attesting a different one. (An implementation that instead performs
that comparison in the renderer before invoking may take one argument; what is
not acceptable is performing it nowhere.)

**No identity key and, above all, no wrap key.** The credential comes back
through the renderer
(`wallet/e2e2z/src/lib/enrollment/issueDeviceCredential.ts` resolves a
`Uint8Array` to JavaScript), so *anything* in this command's arguments has been
in the webview's garbage-collected heap. A `wrap_key` parameter would mean a
**seed-derived** key had been there — exactly the exposure `messaging.rs:22-30`
refuses for the mnemonic.

That argument is about **secrets**, and it does not reach `expectedHandle`: a
handle is a public string the user typed, carries zero seed authority, and is
already in that heap because the user typed it there. The test to apply to a
proposed argument is *"what authority does this carry, and where did it come
from"* — not *"how few arguments can this have"*. `wrap_key` fails it;
`expectedHandle` passes it and is required. **The install command's signature is
where the account/device split is either kept or lost, and it is short enough to
read.**

Two ordering facts an implementer must not lose:

- **`prepare_device` is not idempotent** (`device.rs:48-54`,
  `engine.rs:483-491`): a second call replaces the pending secrets and discards
  the previous ones. A credential issued for a discarded key set will be refused
  by `validate_for_leaf`'s `DeviceKeyMismatch` (§4.1) rather than installed —
  which is correct, and is a refusal the UI has to be able to explain.
- The command must stay **out of** the enrollment trio e2e2z refuses
  (`messaging.rs:42-51`). `f2zmsg_enroll` needs the seed and will always refuse
  in e2e2z; this command needs none and is a different operation with a
  different name, not a re-opening of that door.

## 6. `device_kem_pk` is not resolved here

**Stated plainly, because #928 asks for exactly this and the alternative is a
false claim: enrollment remains incomplete after a round trip completes, and
this is the reason.**

The circularity is real and is already documented twice
(`engine.rs:229-238`, `wallet/plugins/tauri-plugin-f2zmsg/README.md:297-304`):
the credential must carry `DeviceInitKey.public`, but the HPKE init key MLS
actually uses is generated inside each OpenMLS `KeyPackage`, and a device
publishes *many* key packages over its life and consumes them
([ADR 0015](./0015-key-package-publication.md)). There is no single init key for
a long-lived credential to bind. §4.2's `device_kem_pk` assumes one; RFC 9420
does not have one.

Three things are worth adding to the record, because they change what the fix
should be:

1. **The field has no consumer, and the obvious consumer is already rejected.**
   `WIRE.md` §12.6's authentication does not read `device_kem_pk` at all
   (`README.md:305-314`, and the check table at
   `rs/crates/f2z-msg-mls/src/keypackage.rs:35-49`), and ADR 0015's rejected
   alternative 4 explains why using it as an init key would be *worse* than
   leaving it unused: it is a directory-lifetime key, so every first contact
   would share one permanently-reused init key
   (`0015-key-package-publication.md:150-168`).
2. **The init key is already authenticated, transitively.** The credential binds
   `identity_pk → device_pk`; RFC 9420 §10 has the `KeyPackage` signed under the
   leaf's `signature_key`, which `validate_for_leaf` requires to be that same
   `device_pk`; the `KeyPackage` carries the init key. So a peer already has a
   signature chain from the account identity to the init key it encrypts to,
   without `device_kem_pk`. What the placeholder costs is a *second, independent*
   path — which `README.md:305-314` already says, and which ADR 0015 says we do
   not want built the obvious way.
3. **Therefore the likely correct fix is to remove or redefine the field, not to
   fill it.** Filling it with a genuinely held X-Wing keypair is implementable
   — the ciphersuite is `MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519`
   (`rs/crates/f2z-msg-mls/src/engine.rs:107`), so keygen exists in the
   dependency tree — and it would make the credential honest. But it would
   produce a long-term secret with **no protocol role**: "a key nobody uses"
   instead of "a key nobody holds". That is better and it is not resolution.

Removing it is a change to `DeviceCredentialTBS` — a signed structure published
to an append-only log, declared at `KT.md:264` as `opaque
device_kem_pk<1..2^16-1>` and enforced non-empty at
`rs/crates/f2z-kt-core/src/entry.rs:92`. That is expensive *later* and cheap
*now*, for the reason §4.2's own `CKDh` correction gives: *"no user has a
messaging identity, no directory entry exists, and no peer has pinned a safety
number. The cost of this correction is zero today and unbounded after the first
user"* (`../ARCHITECTURE.md:266-270`). The same asymmetry applies, with the same
force, and it is the argument for settling this before the transport rather than
after.

**This ADR does not settle it**, because it is a key-transparency wire question
with an upstream OpenMLS dimension, and deciding it inside a document about
where sealing happens would be deciding it quietly. It needs its own issue and
its own ADR.

### 6.1 What that means for anyone tempted to declare enrollment working

When #461 lands and the round trip completes end to end, the observable result
will be: e2e2z asks, ZUULI confirms, a credential comes back, it installs,
`enrollment_status` reports enrolled. **That will not mean enrollment works.**
It will mean the transport works.

Until `device_kem_pk` is resolved, ZUULI signs — and the directory would publish
— a credential attesting a key **nobody holds**. The failure is silent by
construction: nothing validates the field, so nothing rejects it. It cannot be
found by testing the path that was just built, and it will still be there after
every test on that path is green.

So the honest status line stays: *the transport is unblocked; enrollment is
not.* Anyone shipping the transport should write that sentence down at the same
time.

## 7. What this does not assume about the channel

#929 is correct and this design is built on top of it, not around it:
correlation proves the responder **saw** the request, never that it **is**
ZUULI. Under #461 there is no transport at all, so today nothing can answer.
When there is one, an app that received the request holds the 32-byte
`request_id` and can answer with a credential of its own making.

What §3 and §4 give, and it is not nothing:

- **No secret to steal.** Public keys out, a public credential back
  (§3.2). A hostile responder learns this device's public keys and the handle
  the user typed. It does not learn a key.
- **The credential is the only self-authenticating object in the exchange, and
  it is the only thing trusted.** §4's "no new fields" is what makes that
  statement true rather than aspirational: there is no unsigned field beside it
  for a forger to choose.
- **A forged credential does not yield impersonation.** The attacker never gets
  the device private key, so it cannot sign as the device. It can bind *this*
  device's `device_pk` to an `identity_pk` of its own.

What it does **not** give, stated without hedging: on a first enrollment the
caller has never seen the account's real `identity_pk`, so it cannot tell a
genuine credential from a fabricated one *by its signature*. There is no key to
check that signature against. That is trust-on-first-response, and no
arrangement of this result type fixes it — it is #929's question, answered at
#929's layer.

**One check is still available and §4 makes it mandatory:** the credential's
`handle` must be the handle this session requested. It does not establish who
signed, but it does refuse the fabrication that costs most — a credential for a
handle the user never asked for, installed as this device's identity. It is the
whole authenticity budget TOFU allows here, and it is the difference between
"#929 is an open question" and "#929 is an open question and we also skipped the
one thing we could have done about it."

Where it is eventually caught: the key-transparency directory. A fabricated
credential's `device_pk` is not in the real `DirectoryEntry`'s `devices` set, so
peers refuse it (`keypackage.rs:35-49`) and the self-audit of §9.2 raises the
divergence. The failure mode is **"messaging silently does not work"**, not
"the attacker becomes you" — unless the attacker also controls the directory
view, which is the threat key transparency exists for.

**A design note that follows from this and should not be lost:** the install
step must not present its result as authoritative. e2e2z should not render
"enrolled as @alice" on the strength of an installed credential alone. That is
the same fail-closed line `issueDeviceCredential.ts:27-38` already holds when it
refuses to synthesize an `EnrollmentStatus`, carried one step further.

## 8. What I am not certain about

Flagged rather than smoothed over, because this touches protocol design and a
confident wrong answer is worse than a marked doubt.

1. **Whether the OS secret store is the right home for `DeviceWrapKey` on every
   platform, and what happens where it is not.** The precedent exists —
   `keyring 3.6.3`, per-platform, at
   `wallet/plugins/tauri-plugin-zcash/Cargo.toml:72-86` — but it is in the crate
   e2e2z must not link, so `tauri-plugin-f2zmsg` would need its own copy of that
   feature matrix. And on **mobile there is no backend at all**:
   `keychain.rs:332-352` returns `UnavailableStore` for every non-desktop
   target. I do not know what mobile custody looks like for either app, and I
   did not resolve it. §3.5's "refuse rather than enroll" is my proposed answer
   and it is a policy I am inferring from the tree's fail-closed doctrine, not
   one I read anywhere.
2. **Whether §6's claim-2 signature chain is complete.** I read RFC 9420 §10 as
   requiring the `KeyPackage` signature under `leaf_node.signature_key`, which
   with `validate_for_leaf`'s binding gives identity → device → init key. I did
   not verify against OpenMLS's implementation that no path accepts a
   `KeyPackage` whose init key is outside that signature's coverage. If it is
   not complete, §6's recommendation to remove the field is wrong and the
   answer is a real long-term KEM key.
3. ~~**Whether removing `identity_pk` and `handle` from `IdentityInstall` has a
   caller I did not find.**~~ **Resolved during review of this PR: there are
   exactly five construction sites and they are the ones named** —
   `messaging.rs:191`, `wallet/plugins/tauri-plugin-f2zmsg/src/bin/peer.rs:462`,
   and three integration tests (`tests/engine_lifecycle.rs:49`,
   `tests/last_resort_rotation.rs:45`,
   `tests/two_record_rollback_over_a_relay.rs:334`). Kept here with its
   resolution rather than deleted, because a doubt that turned out to be
   over-cautious is worth as much to the next reader as one that turned out to
   be real.
4. **Whether one sealing scheme across both apps is worth the ZUULI regression
   in §3.4's third row.** I argued it is, on the grounds that the mnemonic is
   itself a keychain item so the barrier class is unchanged. Someone who values
   "the mnemonic alone recovers a device store" as a product promise should read
   §9's hybrid and may reasonably choose it.
5. **`submitted_at`'s intended semantics.** I read it as issuance time because
   that is what `messaging.rs:196` passes, but §3.2's language is about
   *directory* submission and no directory exists yet. If it is meant to be the
   log's merge submission, §4.2 is wrong about which clock owns it.

### What would change my mind

- **On §3:** evidence that some flow genuinely needs to recover a device's
  secrets from the mnemonic alone — a supported migration, a documented support
  procedure. I looked and did not find one; §4.2 says the opposite. If one
  exists, §9's hybrid becomes the answer rather than the fallback.
- **On §4:** a field `install_identity` needs that is genuinely *not* derivable
  from the credential and *not* local. I believe there is exactly one candidate
  (`submitted_at`) and that it is local. A second would need arguing on its
  merits, and it should be argued as "why must a hostile responder be allowed to
  choose this value", because that is what adding it means.
- **On §6:** uncertainty 2 resolving the other way.

## 9. Alternatives rejected

### A. Widen `IssueDeviceCredentialResultV1` to carry `BackupWrapKey`

**Rejected, and it is the thing #928 was originally filed to do.** It ships a
seed-derived 32-byte key into `cash.free2z.e2e2z`, which is the one thing
`../ARCHITECTURE.md` §4.2 and the whole three-app split forbid. It is worse than
the abstract statement makes it sound: the credential arrives in the renderer
(`issueDeviceCredential.ts` resolves to the webview), so the wrap key would land
in a garbage-collected JavaScript heap — the exposure `messaging.rs:22-30`
refuses for the mnemonic, granted to a key derived from it.

### B. ZUULI performs the sealing and returns only sealed material

**Rejected as impossible without breaching the other half of the split.** ZUULI
cannot seal what it does not have, and the device secrets live in e2e2z's plugin
process (`engine.rs:489` puts them in `pending_device` and nothing exports
them). For ZUULI to seal them, e2e2z would have to **send its device private
keys over the bridge** — forbidden by `../ARCHITECTURE.md:289-290` ("never
exported") and by `PROTOCOL.md` §1's stated invariant that *"device private keys
never leave their app."*

Trading one breach for another is not a fix; it is the same breach pointed the
other way, and the other way is worse, because a leaked device key is
immediately usable to impersonate the device whereas a leaked wrap key needs the
store as well.

### C. ZUULI holds the wrap key and e2e2z asks for an unseal each launch

**Rejected on three independent grounds**, any one sufficient:

- It makes every e2e2z launch require ZUULI installed, running, and a human
  approving a dialog. That is the runtime coupling #904 split the apps to
  remove.
- `PROTOCOL.md` §3.4 caps every intent at five minutes and one use because
  *"nothing here is a continuous grant"*. A per-launch unseal is a continuous
  grant wearing a five-minute window.
- It still delivers the wrap key to e2e2z at the end. Every construction where
  e2e2z can decrypt its own secrets is one where e2e2z holds the key that does
  it, whatever the delivery looks like.

### D. Hybrid — per-device seal, plus an account-level recovery envelope

**Not rejected. Deferred, and it is the fallback if §3.4's third row turns out
to matter.**

The shape: `DeviceSecrets` sealed under `DeviceWrapKey` as in §3, and
*additionally*, in an app that holds the seed, one extra store record
`Enc(BackupWrapKey, DeviceWrapKey)`. e2e2z writes no such record and is
unaffected. ZUULI can then still open its device store from the mnemonic when
the OS secret store fails — which is a genuine availability benefit on Linux,
where a missing Secret Service daemon otherwise means a permanently `locked`
engine.

It loses to §3 on two counts today, and neither is overwhelming:

- It reintroduces the account-scoped blast radius of §2 for ZUULI: the extra
  record means the mnemonic once again opens any ZUULI device store the attacker
  can read.
- It is two code paths — the one every developer runs (ZUULI, with the envelope)
  and the one that only ever runs in the app with less scrutiny (e2e2z,
  without). §3's "one sealing scheme" argument is precisely that the second path
  is the one that breaks quietly.

If §8's uncertainty 1 resolves badly — if secret-store availability is worse in
practice than desktop `keyring` suggests — this becomes the right answer for
ZUULI, and e2e2z's `locked` story has to be solved some other way regardless.

### E. Leave `IdentityInstall` alone and give e2e2z its own second engine API

**Rejected.** A second install path, used only by the app with no seed, is a
path with no first-party developer running it daily. `AUTHORITY.md` §8's
surviving-mutation postmortem is the local precedent: the two undefended guards
were both on the paths nobody exercised. One `install_identity` that both apps
call is the version that stays correct.

### F. Degrade rather than refuse where there is no secret store

**Not rejected. Named, and left to the implementation with a condition.**

The alternative to §3.5's hard refusal: where no OS secret store is available,
hold `DeviceWrapKey` in the app's own data directory beside the store it seals,
and say so in the UI. It buys strictly less than a secret-store item — an
attacker who copies the directory gets both halves — but it is not nothing: it
still defeats the common accident, which is a copy of the SQLite file alone
(a backup, a sync tool, a crash dump, a "send me your `f2zmsg.sqlite`"). And
per Fact 6 the file it sits beside already contains the message plaintext, so
the *incremental* loss is narrower than it first reads.

It loses to a refusal on one point and it is the deciding one: a degradation
that is silent is a degradation nobody ever revisits. If this is implemented it
must be **visible in the UI and reported in engine status**, not a fallback the
code takes quietly. With that condition it is a reasonable answer for a Linux
desktop with no Secret Service daemon, and it is the escape hatch if §3.5's
refusal proves too strict in practice.

## 10. Consequences

- `IdentityInstall` loses three fields and gains none:
  `{ credential, submitted_at }`. `install_identity` reads `handle` and
  `identity_pk` out of the parsed credential (§4), which also closes the two
  unchecked divergences of §4.1.
- `Engine::unlock`'s signature changes: it no longer takes a seed-derived key.
  `EngineState::locked` survives as a state but its **meaning changes**, and
  `CLIENT-CONTRACT.md` §6.1 says the old meaning in two places — *"the seed is
  unavailable"* (`../CLIENT-CONTRACT.md:1403-1404`) and *"local history is
  wrapped under a seed-derived key"* (`:1442-1444`). Both need rewording.
  **No test catches it if they are not**, and an earlier revision of this ADR
  claimed one did: `messaging-contract.node-test.mjs` pins §3's command set,
  §5.1's events, the relay error-code rows and SHA-256 digests of specific Rust
  bodies — none of which read §6.1's prose, and none of whose digests cover
  `install_identity`, `unlock` or `f2zmsg_enroll`. Corrected here rather than
  quietly dropped, because "there is a safety net" and "there is no safety net"
  are opposite instructions to the person doing the work.
- `f2zmsg_enroll`'s documented double duty as the unlock path
  (`messaging.rs:53-66`) goes away: unlocking no longer needs the seed, so it
  stops being an operation only ZUULI can perform. **That duty must be
  replaced, not merely removed** — §3's retry operation is the replacement, and
  without it a transient secret-store failure leaves `locked` with no exit,
  where today `f2zmsg_enroll` recovers it. Nothing else about `f2zmsg_enroll`
  changes.
- **No store migration, and the reason is load-bearing rather than
  convenient** (§3): existing `SealedSecrets` under `BackupWrapKey` would be
  unopenable, and none exist only because nothing has shipped. The window is
  open until the first user enrolls.
- `tauri-plugin-f2zmsg` gains an OS-secret-store dependency with the
  per-platform feature matrix `tauri-plugin-zcash` already pins
  (`Cargo.toml:72-86`), and a defined refusal where there is no backend (§3.5,
  §8).
- The intent-bridge wire format does **not** change. `PROTOCOL.md` §3.6's
  130-byte vector, the `f2z-intent` conformance vectors and
  `wallet/zuuli/src/lib/intent-bridge.test.ts` are untouched.
- e2e2z gains one app-crate command and **no capability entry and no `zcash:*`
  grant** (§5), so `authority-boundary.node-test.mjs` passes unchanged — which
  is the mechanical statement that this design kept the boundary.
- #928's fourth criterion — *"a test that would fail if any seed-derived
  material appears in an e2e2z-bound payload"* — is answerable under this
  decision in the strongest available form, because the payload is **entirely
  public by construction** (§3.2). The test is a field-set assertion over both
  the request and the result types, in the shape
  `device.rs:122-137` already uses for `DeviceCredentialKeys`. Under any other
  option it would have had to be a taint analysis.
- `device_kem_pk` stays open (§6). Enrollment stays incomplete regardless of
  what #461 does.
