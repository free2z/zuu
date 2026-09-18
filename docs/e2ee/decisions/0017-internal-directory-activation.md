# ADR 0017 — Activating messaging on a disposable internal directory

**Status:** Accepted (2026-09-17), on the owner decisions recorded in
[#1022](https://github.com/free2z/zuu/issues/1022) ·
**Refs:** [#1022](https://github.com/free2z/zuu/issues/1022) (Contract C),
[#594](https://github.com/free2z/zuu/issues/594),
[#649](https://github.com/free2z/zuu/issues/649),
[#1019](https://github.com/free2z/zuu/pull/1019),
[ADR 0013](./0013-key-transparency-log.md), [ADR 0014](./0014-directory-key-rotation.md),
[ADR 0015](./0015-key-package-publication.md), [ADR 0016](./0016-enrollment-sealing-boundary.md) ·
**Constrains:** [`../KT.md` §4.5, §5.3, §8.3, §12](../KT.md),
[`../CLIENT-CONTRACT.md` §3.2, §3.11](../CLIENT-CONTRACT.md),
`wallet/plugins/tauri-plugin-f2zmsg/internal-directory.conf`

> **Scope.** This decides how **internal testers** get a working directory. It
> does not decide `KT.md` §12's questions for a public log. Every choice below
> is made on the explicit premise that the log is wiped before the first public
> user, and §8 lists what has to change before that.

## 1. Context

The messaging engine works end to end in tests: two processes exchange MLS
messages over a real relay, and a real log plus a real witness serve first
contact. Users still could not message anyone, for five reasons:

1. The production engine was built with `NoDirectory`, which refuses every
   lookup. `Engine::with_directory` had only a test caller, and `KtDirectory`
   was never constructed.
2. No build had a relay configured. `start_engine` always ended `degraded`.
3. Nothing ever submitted a `DirectoryEntry`. `KtClient` deliberately cannot,
   and `DirectoryAuthKey::sign_directory_entry` had only a test caller.
4. `mergedAtEpoch` was written `None` and never set, so e2e2z's first-contact
   screen could not appear in any build.
5. `KT.md` §12 leaves the log's identity, the witness list and *t* undecided, and
   `DirectoryConfig` has no `Default` so that no build invents them.

The owner decided (#1022) to unblock internal testing without deciding §12 for
the public:

- **A disposable internal log.** free2z runs the log **and** its only witness.
  The "not independently witnessed" warning stays visible, and the log is wiped
  before public launch. That also postpones ADR 0016 §6 (`device_kem_pk`) to
  before the first *public* user.
- **A proven handle mapping.** The free2z backend signs a `HandleAssertion`
  (Contract C). The log admits a handle's first entry only with an assertion
  from the configured authority key.

## 2. Decision 1 — the posture, and exactly what it guarantees

**Shape.** One log. One witness, run by free2z and configured as **dependent**.
*t* = 1. One handle authority key, held by the free2z backend. One default
relay.

A root cosigned by that witness meets *t*, so lookups resolve and first contact
works. `WitnessStanding::independent()` is 0. So `EngineStatus.independentWitnesses`
is 0, and e2e2z keeps the "The directory is not independently witnessed yet"
warning on screen. The warning now keys on *independence* as well as the
threshold: fewer than two independent witnesses (`KT.md` §8.3) keeps it up,
with copy that says this is an internal directory free2z controls.

### 2.1 What it does guarantee

- **Every entry is authorized by the user's seed.** The log refuses any entry
  that fails `KT.md` §4.4 (the `DirectoryAuthKey` signature, the chain, the
  credentials). No party without the seed can change a handle's keys through a
  routine update.
- **A first entry needs free2z's assertion, bound to the identity key.** A
  third party cannot claim `@alice` first. A stolen assertion is useless,
  because the log also requires the named identity key's signature over the
  binding (`f2z-authority`).
- **Lookups are proved.** Every resolved key is proved by an inclusion proof
  against a signed tree head that the configured witness cosigned.
  Each client's §6.3 monotonicity state still catches a log that rewrites
  *that client's* view over time.
- **The relay cannot choose whose key a `Welcome` encrypts to.** Key packages
  are still authenticated against the proved entry (ADR 0015).
- **Receipts are evidence.** An admitted submission yields a
  `SubmissionReceipt` that is checked against the pinned log key, then kept.

### 2.2 What it does not guarantee, stated so nobody reads it in

- **No anti-equivocation.** free2z runs the log and the witness, so it can show
  different people different keys and leave no evidence. This is the property
  §8.3 says costs two independent witnesses. It is absent.
- **free2z can take a handle.** The authority that vouches for first entries is
  free2z. It can issue an assertion binding any handle to a key it holds. The
  seed protects an *existing* entry from routine changes. It does not protect a
  handle from the party that decides who owns it.
- **First-entry authorization is not auditable by third parties.** The
  assertion is checked by the log and not committed to the tree (`KT.md` §12,
  [#649](https://github.com/free2z/zuu/issues/649)).
- **Absence is asserted, not proved** (`KT.md` §12, #634).
- **Credentials attest a KEM key nobody holds** (ADR 0016 §6).
- **Nothing is permanent.** Every handle, entry, pin and safety number made
  against this log disappears when it is wiped.

These are acceptable for named internal testers who can read the warning. They
are not acceptable for anyone else.

## 3. Decision 2 — how the configuration reaches devices

**A checked-in file, compiled in, that fails closed:**
[`wallet/plugins/tauri-plugin-f2zmsg/internal-directory.conf`](../../../wallet/plugins/tauri-plugin-f2zmsg/internal-directory.conf),
read with `include_str!` and parsed by
`tauri_plugin_f2zmsg::internal_directory`. Both ZUULI and e2e2z link the plugin,
so both apps get the same values from the same reviewed file.

| Key | Meaning | Must equal |
|---|---|---|
| `posture` | Always `internal-disposable`. Any other value is refused. | — |
| `log_url` | The log's origin, `https://`. | the log's public ingress |
| `log_public_key` | The log's **genesis** signing key. | the key behind `f2z-kt`'s `signing_key_file` |
| `log_id` | `BLAKE2b-256("free2z/kt/v1/log-id" ‖ log_public_key)`. It must equal that derivation, so a key and an id pasted from two different logs are refused. | the id the log publishes |
| `vrf_public_key` | The log's ECVRF key, **pinned**: a first tree head that carries another key is refused, and §6.3 refuses any later change. | the key in the log's tree heads |
| `reset_authority_pk` | ADR 0014's reset authority, pinned. | the log config's `reset_authority_pk` |
| `reset_cooldown_seconds` | ADR 0014's cooldown, **at least 604800** (seven days). The client enforces it on every reset it sees, and the window protects only a user who opens the app inside it; a smaller value is a code change, reviewed as one. | the log config's value (default 604800) |
| `witness_pk` | A witness key. Repeatable. **Always dependent.** | each `f2z-witness` public key, and the log config's `witness_pk` lines |
| `threshold` | *t*, from 1 to the number of witnesses. | — |
| `handle_authority_pk` | Contract C's signing key. | the log config's `authority_pk` |
| `handle_assertion_url` | Contract C's endpoint, `https://`. | the backend route in §5 |
| `relay_url` | The default relay, `wss://`. | the relay's public ingress |
| `retired_log_public_key` | A genesis key of a log generation this build has left. Repeatable, absent until the first wipe. Only a checkpoint from a listed generation may be set aside. | the previous log's genesis key |

**Fail-closed rules.**

- While **every** key and URL reads `PLACEHOLDER`, the build is unconfigured.
  The engine keeps `NoDirectory` and no relay is added, so the app never
  connects anywhere.
- A file that mixes placeholders and real values is **malformed**. So is any
  unknown key, repeated key, wrong URL scheme, key that is not 64 lowercase hex
  characters, duplicate witness, or out-of-range threshold. The unit test
  `the_checked_in_file_is_well_formed` fails the build on a malformed file. A
  binary that somehow carried one logs the reason and stays unconfigured.
- There is no environment variable and no remote configuration.
- The file **cannot** mark a witness independent. That setting is not in the
  grammar.

**Filling it in was a one-file change** (workstream 9), plus moving one test.
`the_checked_in_placeholders_fail_closed` asserted the unconfigured state over
the shipped file; the shipped file is now filled, so that property is proven over
`src/internal_directory/placeholder.conf` — a test-only fixture held to the
shipped file's key set — by `a_placeholder_file_fails_closed`, and
`the_shipped_file_configures_the_internal_deployment` asserts the real values.

**Why not the alternatives.** Configuration fetched from the log would let the
log choose its own witnesses, which §8.3 forbids. An environment variable would
point shipping builds at a log without a reviewed diff. A per-app copy would let
ZUULI and e2e2z disagree about which log they trust.

**What the engine does with it** (`lib.rs::with_bundled_directory`):

- `with_directory(BundledDirectory)`: a `KtDirectory` that connects on first
  use rather than inside `setup`. A launch never blocks on the log and never
  fails because of it (#753). Until a connection succeeds, the threshold reads
  unmet.
- `with_default_relay(relay_url)`: `start_engine` adds that relay through the
  ordinary `add_relay` path when no relay is configured. A relay that would need
  an insecure-transport opt-in is stored and **not** connected.
- `get_witness_set_state` and `list_witnesses` report the bundled policy, which
  is the one actually in effect. `set_witness_set` is refused, because a stored
  set that nothing reads would make the reported state false.
- `start_engine` refreshes the directory's root on a blocking thread before it
  decides between `running` and `degraded`.
- `EngineStatus.directoryBlocked` carries §3's two persistent refusals and
  nothing else. It is read from the directory on every status call, so the
  inbound pump's `lastError` — which is rewritten every few seconds with the
  current relay weather — cannot take the UI's explanation away while the
  condition still holds.
- **The log's signed authority policy is required, not merely reported.**
  `KT.md` §8.1 step 7 has a client *fetch* §4.6's policy and show what it says.
  A build compiled for one log with one authority expects more, so
  `KtDirectory` calls `KtClient::require_authority_policy` with the bundled
  `handle_authority_pk`: the policy must be fetched, verify under the accepted
  log key, say **vouched**, and list **exactly** that key — no key missing and
  none extra. A connection is refused unless all of that holds, under the code
  that names what actually happened: `directory-unvouched` for a policy that
  verified and says something else, `directory-unreachable` when the endpoint
  did not answer, `directory-rate-limited` when it refused, and
  `directory-protocol-violation` for a document that does not decode or whose
  signature does not verify. Lookups, submissions and `start_engine`'s refresh
  all fail closed either way, and e2e2z says so on the page.
  Without this, a log deployed without its authority would take first-come
  registrations while the app went on resolving them, which is the whole value
  of Contract C. The comparison is on public keys, and `authority_id` is
  `H("free2z/kt/v1/authority-id", pk)`, so equal key sets are equal id sets.
  The policy is also **pinned for the life of the connection**: the first one
  verified is kept with its `published_at_ms` zeroed and its lists sorted (the
  set comparison must not turn a reordering into a change), and it is checked
  again on every root refresh — `start_engine`'s, and any later one — so a
  policy that differs in any other field makes the directory unusable from
  then on, for lookups and submissions alike. It is deliberately *not*
  re-fetched on every lookup: that would put a second round trip in front of
  each one, and a log that keeps its policy while equivocating is `KT.md`
  §8.5's limit rather than something a refetch would catch.

  **What "unusable from then on" is scoped to, exactly.** The latch lives on
  the connection, and a connection is rebuilt when the engine re-attaches the
  checkpoint store — that is, after a lock/unlock cycle, an unenroll, or a
  restart. So a log that serves a changed policy, is locked away from, and is
  unlocked again gets asked once more; if it still serves the changed policy
  it latches again immediately, and if it has gone back to the bundled
  authority it is usable. Nothing is lost by that: the **durable** pin is the
  key compiled into this build, which no amount of restarting moves, and the
  per-connection pin only adds "and it has not changed while we were
  connected". Persisting the whole document beside the checkpoint was
  considered and rejected for this posture: it would make a legitimate
  `max_validity_ms` change on a disposable log a support call, and the
  property it would add — noticing a change across a restart — is already
  covered for the only field that decides anything, the authority key itself.

  **Only a statement about vouching is latched.** A policy that verified and
  says the wrong thing latches; so does one whose signature does not verify
  under the accepted log key, or that names another `log_id`, because neither
  is a bad moment. Everything else — unreachable, refused (`ERR_RATE_LIMITED`
  among them), an answer that does not decode — is reported and forgotten. An
  earlier version of this branch latched every failure, which meant one 429
  from the log's own authority endpoint made the directory permanently
  unusable, under a code §8's table tells the client to retry. What this cannot establish is `KT.md` §8.5's limit: that the
  log *applied* the policy it signed.
- **The last verified tree head is persisted, sealed, in the engine's store.**
  It is written after every connect, sync and lookup, and read back through
  `KtClient::open` on the next launch. Before this, every launch trusted the
  log's head on first use again, which is the failure `KtClient::bootstrap`'s
  own documentation warns about. It lives in `f2zmsg.sqlite` beside the
  identity, sealed with ChaCha20-Poly1305 under a key derived from this
  device's unsealed queue seed (`engine::SealedCheckpoints`) — not in a loose
  file, where deleting it or flipping one byte was enough to reset this
  device's trust. Now:
  - A checkpoint for **this** log is resumed. The first sync then applies §6.3
    against it, so a log reset under the same key is **refused as a rollback**.
  - A checkpoint for a **listed** `retired_log_public_key`, whose signature
    verifies under that generation's key, is set aside, and the device trusts
    the new log's first head. The reviewed build says which generation it left;
    the device does not infer it.
  - Everything else is **refused**, with `directory-state-invalid`, and the
    directory stays unusable on that device: a checkpoint naming a log this
    build neither trusts nor lists as retired (which is what a flipped `log_id`
    is), one whose signature does not verify, one that does not decode, one
    that does not open under this device's key, and a **missing** one on a
    device that has already relied on the directory — it holds a receipt, a
    merged epoch or a conversation. `SignedTreeHead::verify` checks `log_id`
    before the signature, so `WrongLog` alone says nothing about who signed the
    bytes; the signature is now checked under the accepted key regardless of
    the id, and a head the *current* key signed for a foreign id is the log
    misbehaving rather than a generation change.
  - **The safe recovery is explicit and destructive, by choice.** There is no
    "reset the directory state" button: a button that clears the evidence of
    what this device saw is a button an attacker wants the user to press, and a
    single-purpose reset would have to be reasoned about separately from the
    pins and conversations that were established against that history. The
    recovery is `f2zmsg_unenroll`, which the user already has to type a
    confirmation for: it deletes the identity, its sealed secrets and the
    checkpoint in one transaction, and the next enrollment starts from a
    genuine first use. The UI says exactly that.
  - The first save is **mandatory**: `connect_with` fails if it cannot store
    the head, because a device that went on to use the directory with nothing
    saved would refuse itself on the next start. Later saves are best-effort —
    saving less is safe, since the prefix is verified again after a restart,
    and only loses progress.
  - Durability is SQLite's, not a hand-rolled `fsync`: one transaction per
    save under `synchronous = FULL` and WAL (`f2z-msg-store`), so a completed
    save is on disk and a crash leaves the old record or the new one.
  - What this does **not** stop is a party who can rewrite `f2zmsg.sqlite`
    arbitrarily: the three signals that say "this device has relied on the
    directory" — a receipt, a merged epoch, a conversation — are plaintext
    records beside the sealed one, so that party can delete the checkpoint and
    the evidence together and get trust-on-first-use back. Two honest gaps in
    the same rule: a device that has only ever *resolved* handles, and one
    holding nothing but a pending contact request, carry none of those signals
    either, so deleting their checkpoint is indistinguishable from a first
    run. Closing this properly needs a monotonic counter inside the sealed
    record — the seal is authenticated, so a counter in it cannot be rolled
    back without the device key — and that is the shape to reach for when pins
    and alarms are persisted, since they need the same record. The party this
    protects against can equally rewrite stored peer identities today, and the
    store's lack of at-rest encryption is `f2z-msg-store`'s recorded gap
    (`store.rs`). The claim here is narrower and true: the checkpoint is no
    longer a loose file whose deletion or one-byte edit silently re-trusts the
    log.
  - Pins and alarms are still per-process (see §10).

## 4. Decision 3 — enrollment and `DirectoryEntry` submission

**The seed-holding app signs; the plugin carries the bytes; the log decides.**

```text
ZUULI  f2zmsg_enroll { handle, knoxToken? }
  │  install_identity + unlock                 (unchanged, ADR 0016)
  │  engine.start()                            default relay → contact queue → key packages
  │  engine.refresh_enrollment()               already merged? stop
  │  engine.submission_pending(log_id, now)    receipt from this log, deadline not
  │                                            passed? stop (a retry would collide)
  │  engine.directory_publication()            credential, relay_url, relay_id, contact_addr,
  │                                            and the verified published entry, if any
  │  first entry only:
  │    POST handle_assertion_url {identity_key, intent: bind}   Token <knox>   (§5)
  │  AccountKeys::sign_directory_submission    DirectoryAuthKey signs the entry,
  │                                            IdentitySigningKey signs the binding
  │  precheck                                  f2z-authority's rules, locally, on the
  │                                            bundled authority key
  │  engine.submit_directory_entry()           POST /kt/v1/submit; receipt verified
  │                                            against the pinned log key and against
  │                                            (handle, version, entry hash); kept
  └  engine.refresh_enrollment()               mergedAtEpoch once a lookup proves it
```

- **Signing lives in `f2z-msg-identity`**
  (`AccountKeys::sign_directory_submission`,
  `IdentitySigningKey::sign_assertion_binding`). Those keys expose no general
  signer, so every structure they sign must be named in that crate.
- **Carrying and checking live in `f2z-kt-client::submit`.** The helper takes
  bytes that were already signed and checks the receipt that comes back.
  `KtClient` itself still has no submit method.
- **A first entry is version 1 with an assertion. A later entry is a
  `same_key` update with none.** A later entry chains to the verified
  predecessor and keeps its devices and revocations. The enrolling device's
  endpoint goes **first**, because clients use the first endpoint
  (`ARCHITECTURE.md` §13-G). A predecessor that belongs to another identity key
  is refused locally, since changing it would be a `key_change` or
  `platform_reset`, not an enrollment.
- **Failure never fails the enrollment.** The device is installed either way. A
  refusal is logged with its detail and recorded as the reason in
  `EnrollmentStatus.blocked`. Calling `f2zmsg_enroll` again retries publication.
- **The Knox token** comes from the WebView on the call that needs it. The
  WebView is the only place ZUULI holds one. Rust uses it for one request, never
  logs it (`EnrollArgs`' `Debug` redacts it), and does not keep it. Without a
  token a first entry is `blocked: "handle-ineligible"`.

### 4.1 e2e2z's device, published by the wallet — **implemented**

**Decided as a follow-up, and shipped.** A `ContactEndpoint` carries the
`contact_addr` that the relay issued to the device that opened the queue. Only
that device knows it. #1019's `IssueDeviceCredentialRequestV1` carries
`handle`, `device_pk`, `device_kem_pk` and the requested validity window, and
nothing else, so ZUULI could not build a publishable entry for an e2e2z device
from what arrived — which is why version 1 answers with a credential and
publishes nothing, and still does.

**Decision.** The requesting device sends its endpoint, as
`IssueDeviceCredentialRequestV2`:

```text
struct {
    opaque handle<0..255>;
    opaque device_pk[32];
    opaque device_kem_pk<0..2^24-1>;
    uint64 not_before_ms;
    uint64 not_after_ms;
    opaque contact_relay_url<0..255>;   /* wss://, non-empty, bridge text */
    opaque contact_relay_id[32];
    opaque contact_addr[32];
} IssueDeviceCredentialRequestV2;
```

The response stays `IssueDeviceCredentialResultV1`.

**It is a new family code (4), not a version field in the payload.** Version
1's payload carries no tag, so the only selector that refuses instead of
best-guessing is the one `payload` is already opaque behind
(`PROTOCOL.md` §3.2). Code 2 keeps meaning exactly what it meant and its vector
is frozen — e2e2z builds already in testers' hands send it — and the two never
decode as each other: canonical decoding refuses version 2's trailing fields as
trailing bytes, and version 1 is version 2 truncated.

**Why this is consistent with ADR 0016 §4's "no new fields".** That rule
forbids an *unsigned copy of a value already fixed by a signed structure*. The
rule exists because an unauthenticated responder would get to choose the copy,
and the copy would win. The endpoint is not a copy of anything. It is a new
input that the *requester* supplies and ZUULI then signs over with the
`DirectoryAuthKey`. A hostile requester that passes the caller registry and the
user's confirmation can already obtain a credential for its own `device_pk`.
Choosing where that device receives first contact adds nothing beyond that —
and the confirmation names the relay host, so the choice is visible.

**Why the response still gains nothing.** e2e2z learns that its device merged
the way ZUULI does, by a verified lookup of its own handle (§6). That code
already runs in the shared plugin. A receipt in the response would be
log-signed and so self-authenticating, but the receipt is the *submitter's*
evidence (`KT.md` §5.3), and ZUULI keeps it — in a short list of the last 16,
because evidence past `merge_by_ms` is a retry rather than a record.

#### What e2e2z does before it asks

`Engine::prepare_device_with_endpoint`: sample the device keys, add this
build's default relay through the ordinary `add_relay` path if none is
configured, connect, and `CREATE_CONTACT_QUEUE` with the receive key derived
from the **pending** device's queue seed. The queue is held beside the pending
keys and committed by `install_identity`, so it cannot outlive the keys it
belongs to — a second `prepare_device` discards it. A build with no relay
refuses here, `relay-unreachable`, rather than enrolling a device nobody could
reach. An abandoned enrollment leaves an idle queue at the relay, which expires
on its own.

#### The order ZUULI runs, and the rule it keeps

```text
  admit                       every guard, one call
  plan_publication            WHOSE session this is (free2z names the account)
                              and what the log already publishes. No seed, and
                              nothing about this wallet on the wire.
  native confirmation         names the ACCOUNT, the device, the relay host, the
                              devices already published, and PUBLISHED
    ▼ approved
  messaging::account_keys     the one seed read, in process
  vouch_first_entry           Contract C — the request that carries identity_pk,
                              now that an approval exists
  issue_device_credential     the wallet's own lifetime policy
  adding_device → sign        DirectoryAuthKey signs the entry, IdentitySigningKey
                              the binding (the same drafting rule §4 uses)
  precheck                    f2z-authority's rules, locally
  ─────────────────────────── the phase boundary
  submit_entry_for_device     POST /kt/v1/submit; the receipt is verified against
                              the pinned log key and kept
  → the credential is answered only now
```

**Version 1's rule holds here: the wallet's custody is not opened, and nothing
about this wallet leaves the process, until somebody has said yes.** The first
version of this work broke that — it derived the account's public identity key
and fetched the assertion *before* the dialog, so that the dialog could name a
handle the authority had signed. Adversarial review found what that costs, and
it is not worth the handle:

- The Knox token reaches this process through §4.1's write-only slot, and an
  app-crate command is **not capability-gated**. ZUULI's CSP forbids frames
  (`frame-src 'none'`), so the `#367` deputy needs an XSS in ZUULI's own origin
  rather than a hostile embed — but anything that reaches the invoke bridge can
  write a **foreign** session into the slot, which is a capability the slot
  would otherwise be adding. With the assertion fetched before the dialog, that
  hands this wallet's `identity_pk` to somebody else's account and asks the
  authority to bind it there, with no user interaction at all.
- The same ordering let an unattested caller make ZUULI decrypt the wallet's
  custody, unprompted, by sending a request.

So the plan is built from two answers that disclose nothing: free2z says which
**account** the session belongs to (that request carries the session's own token
and nothing else), and the log says whether it already publishes the handle (an
ordinary unauthenticated lookup). The confirmation names the account. The seed
is read, and `identity_pk` is sent, only after the approval — and the
publication is still refused unless the authority signs the handle the app asked
for.

**What the account name buys, stated narrowly.** It does not make a poisoned
slot harmless; it makes it *visible and inert*: publishing under somebody else's
account now requires a human to approve a dialog naming that account, and a
declined or ignored request leaks nothing about the victim — no identity key, no
custody read, no assertion issued. The residual is a user who approves a
publication under an account they do not recognise.

**The confirmation says PUBLISHED**, because `ARCHITECTURE.md` is explicit that
adding a device to an account is what a wiretap looks like. It names:

- the **free2z account** the session belongs to, as free2z named it;
- the **handle**, when the log already publishes one — from the log, never from
  the request. A first entry has no such name yet, so it says so rather than
  rendering a handle the requesting app chose;
- the **device**, as a head-and-tail fingerprint of its `device_pk`, so the
  person can tell which device is being added;
- that **every new conversation will reach this device first, ahead of the N
  devices already published** — because `adding_device` puts the new endpoint at
  index 0 and a resolving client uses the first one (`ARCHITECTURE.md` §13-G).
  Approving is not "one more device"; it is "this device answers first";
- the **relay host** where that will happen.

#### Certainty is a property of the phase, not of the code

`INTENT_HANDLE_UNAVAILABLE` promises the caller that nothing was submitted.
Everything up to and including the local precheck can keep that promise. Nothing
after `submit_entry_for_device` can: the log may have admitted the entry and
lost or mangled the answer, and a receipt whose `handle` field is not a handle
arrives as `handle-ineligible` — a code that would otherwise travel as a certain
"nothing happened" for an entry that is about to merge. So the submission and
everything after it is `INTENT_UNAVAILABLE` unconditionally, by a mapping
function that ignores its argument, and a source-asserted test keeps the certain
mapping on its own side of the boundary.

**A device is installed only if it was published.** Unlike ZUULI's own
enrollment — where publication may fail and be retried, because the device is
already installed — this path answers with the credential only after the log
admitted the entry and the receipt verified. A refusal means nothing was
installed anywhere, so the person retries rather than holding a credential
nobody can find. The cost is recorded in §10.

**Refusals**, and what a caller may say about them:

| Refusal | Status | Certain? |
|---|---|---|
| no free2z session in ZUULI, no bound handle, or another handle | `INTENT_HANDLE_UNAVAILABLE` (13, new) | yes — every site that produces it is before the submission; the last one runs after a credential has been minted in memory, which persists nothing |
| the user declined | `INTENT_NOT_CONFIRMED` (9) | yes |
| no directory in this build, the log refused, the log did not answer | `INTENT_UNAVAILABLE` (12) | **no** — `PROTOCOL.md` §6.2's rule; a submission whose answer was lost may still merge |

#### What is accepted, and what it costs

- **The contact endpoint is the requesting app's to choose**, and nothing binds
  it beyond the hostname the user reads in the confirmation. A caller that
  passes the registry and the confirmation can point first contact at a relay it
  controls — which learns *that* someone is contacting this handle, and can
  withhold delivery. It cannot read anything: first contact is an MLS `Welcome`
  encrypted to a key package authenticated against the proved entry (ADR 0015).
  The follow-up, when there is more than one relay in the deployment, is to
  refuse an endpoint whose `relay_id` the wallet has not itself authenticated a
  connection to — today the bundled build has exactly one relay, so the cheap
  form of that check is "the published relay must be the bundled one", and it is
  recorded here rather than added blind before the deployment exists.
- **The pre-dialog lookup makes ZUULI a handle-resolution oracle** for a
  registered caller: send a request, watch how long it takes or whether the
  dialog says "no published devices yet". The log is a public directory and the
  same lookup is available to anyone who can reach it, so this discloses nothing
  the caller could not learn directly — what it does add is that *this wallet*
  performed it. Accepted for the internal deployment.
- **An unattested caller can still make ZUULI show a dialog**, and with it make
  one authenticated request (the account probe) to free2z. That is the same
  standing weakness every family on this bridge has — a caller identifier nobody
  attests (`CALLER-AUTHENTICATION.md` §2) — and the dialog is the control.

#### Answered: what the deployed authority records at issuance (workstream 7)

**Does the authority record the handle → `identity_pk` binding when it *issues*
an assertion, or only when the log admits the entry?** This was open here; the
backend has answered it, and what follows is **the behaviour of the deployed
authority**, not a protocol guarantee. The log, not the backend, is where
"was this entry admitted?" lives, and nothing below is enforced by the byte
format or by anything this repository can check.

- **The assertion is never recorded.** The issuing app (`ktauth`) has no models,
  by design: no row, no log line, and nothing that stores `identity_pk`, the
  intent, the nonce or the assertion bytes. A declined or abandoned enrollment
  therefore leaves nothing on the backend that names the identity key — which is
  what the question was really asking. The design above never depended on this
  (nothing is issued before an approval), and it is better than the design
  needed.
- **One write can happen, and it is not about the enrollment.** Before signing,
  the endpoint calls `ensure_username_handle(user)`: if the account has no
  handle row at all, and its lowercased username is eligible, unreserved and
  unheld, that handle is reserved for that account. This is the same reservation
  the migration already performed for all 1,586 bound accounts; it exists so an
  account created mid-deploy is not stuck, and it binds an account to *its own*
  handle, never to a key.
- **It cannot be farmed.** It is a one-time transition per account — after the
  migration every eligible account already has its row, so calls only read —
  ineligible, collision-losing and reserved-word accounts never get a row and
  receive `409 handle_unclaimed`, and the endpoint is capped at 10 requests per
  hour per account. The most any caller can cause is a single insert of the
  binding their own account was already entitled to.
- **Issuance still writes some state**, as §5.2 requires: the issuer must never
  reuse an `(authority_id, nonce)` pair and must keep `account_epoch` as a
  durable counter. That state is about the *account*, and identifies no wallet.

Because nothing about a wallet is retained, the endpoint has nothing extra to
disclose and the enrollment UI has no additional retention to state.

#### The session slot, argued on its own merits

§9 records that carrying the Knox token in Rust state was rejected for
`f2zmsg_enroll`, because the WebView can pass one per call and a second
long-lived copy buys nothing. That reasoning does not reach this path: the
request arrives from the operating system, is handled entirely in Rust, and has
no argument to carry a token on. A renderer-supplied session *per intent* would
mean the WebView naming the account an inbound request is answered under, which
is the confused deputy `intent.rs` exists to avoid.

So `wallet/zuuli/src-tauri/src/session.rs` holds one **write-only** slot, in
memory, for the process. Publication into it is serialized through a
single-slot queue on the renderer side, so the value the wallet ends up holding
is the last value the renderer asked for and not the last `invoke` to return —
a sign-in that overtakes a sign-out would otherwise leave a live session in the
wallet after the user signed out. The WebView publishes the token it already holds
whenever it changes and once at startup — including `null`, so "signed out" is
stated rather than inferred from silence, and so a cold start that is handed an
intent before the window finishes loading waits for an answer instead of
assuming one. Nothing reads it back over IPC: the command returns `()`, and a
test asserts this module exposes no command that hands a token out.

What it does not widen: the renderer already holds *the user's* token and
already authenticates every free2z call with it, and it can already call
`f2zmsg_enroll` with it. What writing the slot adds is the ability to name
**somebody else's** session, and that is why the flow above resolves the account
before it discloses anything and shows the name to the user. A slot somebody
else wrote costs a declined dialog.

## 5. Decision 4 — Contract C, ratified for this directory

### 5.1 The endpoint (implemented by the private backend)

```text
POST {handle_assertion_url}                 https://free2z.cash/api/kt/handle-assertion/
Authorization: Token <knox>
Content-Type: application/json
{"identity_key": "<base64url, 32 raw bytes>", "intent": "bind"}

200  {"assertion": "<base64url of tls_codec(HandleAssertion)>",
      "handle": str, "issued_ms": int, "expires_ms": int}
401 / 403   not authenticated
409         {"reason": "handle_unclaimed"}: the account has no bound handle
429         rate limited
503         a bounded reason code: the authority key is not configured
```

- **POST, not GET.** An identity key in a URL would land in load-balancer
  access logs beside the account.
- **The backend chooses the handle** from the authenticated account. The client
  sends no handle. It refuses a response whose `handle`, or whose signed
  assertion, names any handle other than the one it is enrolling (precheck
  rule 6).
- **base64url encoding.** ZUULI sends `identity_key` without padding, as
  Django's `urlsafe_base64_encode` produces it, and accepts `assertion` with or
  without padding. The decoded `assertion` is parsed only by `f2z-authority`'s
  own decoder.
- **Response handling.** Redirects are not followed, so a redirect cannot carry
  the token elsewhere. Bodies over 4096 bytes, and decoded assertions over 1024
  bytes, are refused. A v1 assertion is at most 290 bytes.
- **Related endpoints** the enrollment UX may use, all with Knox auth except
  the diagnostic:
  - `GET /api/e2ee/handle/` returns the account's handle status.
  - `POST /api/e2ee/handle/claim/` binds a handle. Binding is permanent.
  - `GET /api/e2ee/authority/` is an anonymous deployment diagnostic. Clients
    **must** bundle the authority key and never fetch it.

### 5.2 The byte format

The format is `f2z-authority`'s, unchanged, in the TLS presentation language,
big-endian:

```text
struct {
    opaque label<0..255>;      /* "free2z/kt/v1/handle-assertion" (29 bytes) */
    opaque authority_id[32];   /* BLAKE2b-256("free2z/kt/v1/authority-id" || authority_pk) */
    opaque log_id[32];         /* the bundled log's id */
    opaque handle<1..30>;      /* [a-z0-9_]{1,30} */
    opaque handle_id[32];      /* BLAKE2b-256("free2z/kt/v1/handle-id" || handle) */
    opaque identity_pk[32];    /* the request's identity_key, decoded */
    uint8  intent;             /* bind(1); reset(2) is not issued by this endpoint */
    uint32 account_epoch;      /* the account's DURABLE counter, < 2^20; 0 for a first bind */
    uint64 issued_ms;          /* now */
    uint64 expires_ms;         /* issued_ms < expires_ms <= issued_ms + 900000 */
    opaque nonce[16];          /* fresh CSPRNG bytes per assertion */
} HandleAssertionTBS;

struct {
    HandleAssertionTBS assertion;
    opaque signature[64];      /* Ed25519 (RFC 8032) over tls_codec(HandleAssertionTBS) */
} HandleAssertion;
```

Here `H(label, x)` is unkeyed BLAKE2b-256 over `label || x`. That was checked
independently in Python while the vectors were written.

**Issuer obligations**, all enforced by the log:

- `issued_ms` may be at most 2 minutes ahead of the log's clock.
- The validity window may be at most 15 minutes.
- An `(authority_id, nonce)` pair is never reused.
- `account_epoch` is a counter, never a clock (below 2^20, and at most 16 above
  its predecessor).

### 5.3 Who signs, who verifies, and where the key is configured

| Role | Party | Key material |
|---|---|---|
| Signs | the free2z backend (workstream 7) | the authority **private** key, backend-only |
| Verifies, authoritatively | `f2z-kt` on `/kt/v1/submit` | log config `authority_pk = <hex>` |
| Pre-checks, advisory | ZUULI before submitting | `handle_authority_pk` in `internal-directory.conf` |
| Does not verify | resolving clients | the assertion is not in the tree (#649) |

The three values must be the same public key. If ZUULI's bundled key disagrees
with the backend's, the first device that enrolls reports it as a failed
precheck rule, before anything reaches the log.

### 5.4 Shared test vectors

[`rs/crates/f2z-authority/tests/fixtures/handle-assertion-v1.vectors`](../../../rs/crates/f2z-authority/tests/fixtures/handle-assertion-v1.vectors),
kept in sync by `tests/contract_c_vectors.rs`. From `authority_seed`, `log_id`,
`handle`, `identity_pk`, `intent`, `account_epoch`, `issued_ms`, `expires_ms` and
`nonce`, an issuer must produce `tbs`, `signature` and `assertion` byte for byte.
`stranger_assertion` must be refused. The layout, both hash derivations and the
Ed25519 signature were reproduced with Python's `cryptography` and `hashlib`
independently of this crate.

## 6. Decision 5 — what `mergedAtEpoch` means

**`mergedAtEpoch` is the epoch of the first root at which a verified lookup of
this device's own handle showed an entry publishing this device's `device_pk`.**

- It is set only by `Engine::refresh_enrollment`, which also runs inside
  `start_engine` when a directory is configured. The value is the epoch of that
  first proof. A later lookup at a later epoch does not move it.
- **A receipt is not a merge.** A `SubmissionReceipt` promises a merge by
  `merge_by_ms` and carries no epoch (`KT.md` §5.3). It is stored as
  `StoredIdentity.directory_receipt` and makes `blocked` null, which the UI shows
  as "submitted". It never sets `mergedAtEpoch`.
- `blocked` is:
  - null once merged;
  - `directory-unreachable` when the build has no log;
  - null while a receipt is held;
  - otherwise the code of the last publication failure.

## 7. Evidence

| Layer | Test | What it pins |
|---|---|---|
| `f2z-msg-identity` | `directory::tests` (7) | Version, chain and assertion boundaries; both signatures verify under the seed keys; the binding commits to the assertion |
| `f2z-kt-client` | `submit::tests` (4) | A receipt under another key, or for another entry or version, or with a trailing byte, is refused |
| `f2z-kt-client` | `tests/seed_submission.rs` (6) | Against a **real** log and witness: a seed-signed enrollment is admitted, merged and resolved with `independent() == 0`; a second device chains; an unconfigured authority and another identity key are refused. A log wiped under the same key is refused after a restart. Only a **named retired** generation's checkpoint is set aside; an unlisted log, a flipped `log_id`, a foreign id signed by the current key, a forged, corrupt or truncated one are each refused with their own verdict. The signed authority policy must vouch with exactly the bundled key: unvouched, another key, an extra key, a policy signed by anyone else, and an unanswered fetch are all refused |
| `f2z-kt` | `adversarial.rs`: `an_assertion_signed_by_an_unconfigured_authority_is_refused`, `an_assertion_forged_under_the_configured_authority_id_is_refused` | Contract C on the log |
| `f2z-authority` | `tests/contract_c_vectors.rs` (2) | The vectors match the code; the vector passes the log's check; the stranger does not |
| plugin | `internal_directory::tests` (15) | Fail-closed parsing; `#` inside a value, non-ASCII and confusable characters, URLs with userinfo or no host, the cooldown floor, retired generations, the required authority, and that `build.rs` runs this same grammar and stops the build |
| plugin | `directory::tests` (5), `engine::directory_state_tests` (5) | A bundled directory with no sealed state refuses instead of trusting on first use; the sealed store round-trips a head, refuses an edited or transplanted record, refuses a missing one on a device that has relied on the directory, and unenroll clears it and detaches the store |
| e2e2z | `index.witness-warning.test.tsx` (5 more) | `directory-unvouched` and `directory-state-invalid` are said on the page, keyed on `directoryBlocked`, so the relay weather rewriting `lastError` neither raises nor clears them |
| plugin | `engine` tests | Bundled witness state, `set_witness_set` refusal, receipt recording, `mergedAtEpoch` only from a verified lookup, truthful `blocked` |
| ZUULI | `directory_publish::tests` (20) | Contract C against a loopback server (POST, token, JSON body, base64url decoding, refusals, oversize), the precheck, draft assembly, refusing another wallet; the account probe (its URL, that it carries only the session, and every answer it refuses); a plan that reaches the network once and discloses nothing about this wallet; a remembered account costing no request; a handle published under another identity refused before anything is signed; and a log refusal publishing nothing |
| ZUULI | `intent::tests` (11 new) | Version 2 reaches its own dispatch and neither other family answers for it; the answer echoes the version that was asked; the confirmation says PUBLISHED, names the **account**, the device fingerprint and the first-contact order, and never the request's handle; a hostile `purpose` or account name cannot add a line; both refusal-certainty mappings; and the publish order — plan, prompt, seed, assertion, submit — source-asserted |
| ZUULI | `session::tests` (4) | The slot is write-only and redacts; a reader waits for the first publication; and a resolved account is reused only for the session it was resolved for |
| ZUULI (renderer) | `native-session.test.ts` (6) | The wallet ends up holding the **last value asked for**, not the last `invoke` to return; a value overtaken before dispatch is never sent; and neither a refusing wallet nor a reporter that throws can wedge the queue |
| `f2z-intent` | `wire::tests`, `tests/wire_vectors.rs` | Version 2's endpoint rules (scheme, host, zero address, zero relay id) and every version-1 rule it inherits; the two payload versions never decode as each other; the **frozen** version-1 vector still parses as version 1, under the same digest |
| plugin | `tests/endpoint_before_credential.rs` (3) | Against a real relay: the contact queue exists before any identity does, `install_identity` commits exactly that queue, a second preparation discards the first, a build with no relay refuses, and a `ws://` default is judged like any other relay |
| plugin | `engine::activation_tests` (+3) | An issuer-submitted device is waiting rather than blocked, and still says so with no log; an entry for another device is looked up and submitted with no identity present, its receipt kept and bounded; a refused submission keeps nothing |
| `f2z-kt-client` | `tests/intent_publication.rs` (2) | Against a **real** log, witness and relay: a real `IssueDeviceCredentialRequestV2` is admitted by the real gate, the wallet signs and submits the entry, the requesting device sees its own key published at the address the relay issued, a stranger who knew only the handle claims a key package there and it authenticates against the proved entry, a second device chains and goes first, and the log refuses a forged authority and a second first entry |
| e2e2z | `index.witness-warning.test.tsx` (4) | The warning stays up until two independent witnesses cosign |
| e2e2z | `tests/enrollment-flow.pw.ts` (+3) | In a real browser: the request carries the endpoint the device opened and is family 4; the screen moves from "Submitted, not yet active" to "Handle active" only once a lookup shows the merge; status 13 reads as "ZUULI couldn't confirm @alice is yours"; a build with no relay stops before asking |

**Mutations, run on this branch**, each by editing the guard, running the
suite, and restoring (`CONFORMANCE.md`'s method):

| Guard mutated | Test that failed |
|---|---|
| `f2z-authority` rule 12: any configured key accepted regardless of `authority_id` | `an_assertion_signed_by_an_unconfigured_authority_is_refused`, `an_assertion_from_an_unconfigured_authority_is_refused_by_the_log` |
| `f2z-authority` rule 13: authority signature result ignored | `an_assertion_forged_under_the_configured_authority_id_is_refused` |
| ZUULI `precheck` accepts everything | `the_precheck_refuses_what_the_log_would_refuse` |
| `KtClient::open`: any unusable checkpoint bootstraps instead of refusing | `only_a_named_retired_generation_is_set_aside_and_anything_else_wrong_is_refused` |
| `KtClient::open`: the checkpoint is ignored | both wipe tests |
| e2e2z: warning keyed on the threshold only | `stays up when the threshold is met…`, `stays up with one independent witness…` |
| `f2z-intent`: family 2 decodes the version-2 body | `the_two_credential_payload_versions_never_decode_as_each_other`, `the_frozen_v1_credential_request_still_parses_as_v1` |
| `f2z-intent`: the `wss://` scheme check dropped | `a_v2_endpoint_must_be_a_real_wss_relay` |
| `f2z-intent`: the all-zero endpoint check dropped | `a_v2_endpoint_must_be_a_real_wss_relay` |
| shared TS: the version-2 encoder's endpoint rules dropped | `refuses a version-2 payload with …` (13 cases) |
| ZUULI `vouched_handle`: the authority signature result ignored | `an_assertion_that_does_not_verify_names_no_handle` |
| ZUULI: the predecessor identity check dropped | `a_handle_published_under_another_identity_is_refused_before_anything_is_signed` |
| ZUULI `sign_for_publication`: the precheck skipped | `an_assertion_the_log_would_refuse_is_caught_before_submission` |
| ZUULI: the assertion fetched, or the seed read, before the confirmation | `the_publish_order_is_plan_then_prompt_then_seed_then_assertion_then_submit` |
| ZUULI `refusal_after_submission`: delegating to the certain mapping | `nothing_after_the_submission_claims_that_nothing_happened`, `the_certain_refusal_mapping_is_never_applied_after_the_submission` |
| ZUULI (renderer): the single-slot queue replaced by a generation counter | `leaves the wallet holding the last value asked for, not the last to arrive` |
| ZUULI (renderer): the `finally` that re-arms the queue, or the guard around a throwing reporter | `keeps publishing after a reporter throws` |
| ZUULI `publish_confirmation`: a name taken from the request | `the_publish_confirmation_never_renders_the_requested_handle` |
| ZUULI: the dialog moved after the entry is signed | `the_publish_order_is_plan_then_prompt_then_seed_then_assertion_then_submit` |
| plugin `install_identity`: the pending contact queue not committed | `the_queue_is_opened_before_the_credential_and_installed_with_it` |
| plugin `prepare_device`: the pending queue not cleared | `a_second_preparation_discards_the_first_queue` |
| plugin `enrollment_status`: `submitted_by_issuer` ignored | `an_issuer_submitted_device_is_waiting_rather_than_blocked` |

**Mutations for this hardening pass** (#1022, same method):

| Guard mutated | Test that failed |
|---|---|
| `KtClient::open`: another log's checkpoint bootstraps with no retired list | `only_a_named_retired_generation_is_set_aside_and_anything_else_wrong_is_refused` |
| `KtClient::open`: the foreign-id-under-the-current-key check removed | the same test, on the `WrongLog` assertion |
| `KtClient::open`: the checkpoint ignored entirely | the same test and `a_log_wiped_under_the_same_key_is_refused_after_a_restart` |
| `require_authority_policy`: `exact = true` | `the_bundled_client_requires_exactly_the_bundled_authority` |
| `internal-directory.conf` given a `#` inside a URL | **the build**: `cargo build` failed with `internal-directory.conf is malformed (ADR 0017 §3): line 90` |
| parser: the cooldown floor removed | `the_reset_cooldown_has_a_floor` |
| parser: the printable-ASCII rule removed | `values_are_printable_ascii_only` |
| parser: a retired key may equal the current log key | `retired_generations_are_real_distinct_and_not_the_current_log` |
| `directory_config()`: `required_authority: None` | `the_bundled_authority_becomes_the_required_authority` |
| `BundledDirectory`: connects without a checkpoint store | both `directory::tests` |
| `SealedCheckpoints::load`: a record that does not open treated as absent | `an_edited_or_transplanted_record_is_refused_rather_than_ignored` |
| `SealedCheckpoints::load`: the missing-but-relied-on rule removed | `a_missing_record_is_refused_once_the_device_has_relied_on_the_directory` |
| `clear_identity`: the checkpoint left behind | `unenrolling_clears_the_checkpoint_and_detaches_the_store` |
| e2e2z: the unvouched banner never rendered | `names an unvouched log and what it means` |
| `recheck_policy`: every policy-fetch failure latched (the pre-review behaviour) | `only_a_statement_about_vouching_is_latched` |
| `comparable_policy`: compare the lists in order | `a_reordered_policy_is_the_same_policy` |
| the banner keyed on `lastError` again | `stays up while the relay weather rewrites lastError` (plus both banner tests) |
| `SealedCheckpoints::load`: a store read failure reported as a damaged record | `a_store_that_will_not_answer_is_not_a_damaged_record` |

After restoring, all 20 `adversarial` tests, all 5 `seed_submission` tests and
all 4 e2e2z warning tests passed.

## 8. What must change before public launch

1. **Independent witnesses.** At least two witnesses run by parties outside
   free2z, with *t* and the independence rule decided (`KT.md` §12, §13-Q). The
   parser accepts only `posture = internal-disposable`, so a public posture needs
   a code change and cannot be done by editing the file alone. That is
   deliberate.
2. **`device_kem_pk`** (ADR 0016 §6): remove or redefine the field before any
   public entry exists.
3. **Wipe the log, correctly.** Start the replacement log with a **new
   genesis signing key**, which gives it a new `log_id`, ship its values in
   this file, **and list the old genesis key as `retired_log_public_key`**.
   Devices running the new build set the old checkpoint aside — but only
   because the build named that generation — and start trusting the new log. A
   build that forgot the line leaves every existing device with
   `directory-state-invalid` until it enrolls again, which is the conservative
   direction. Held receipts and `mergedAtEpoch` values refer to the old log, so
   re-enrollment is required.
   **Do not reset a log under its existing key.** A device that verified the
   old history refuses the new one as a rollback (§3), so messaging stays
   unusable on that device until a build with a new `log_id` arrives. That
   refusal is deliberate: a reset has to be visible, and a reset under the same
   key is indistinguishable from an attack.
   `reset_authority_pk` is a different mechanism. It authorizes a *per-handle*
   `platform_reset` (ADR 0014), not a log wipe.
4. **Authority key distribution and rotation** (`KT.md` §12), and the issuance
   policy for `intent = reset`.
5. **Third-party auditability of first entries** (#649), or an explicit decision
   to ship without it.
6. **Remove the internal copy** in e2e2z's warning, or replace it with the
   public posture's.

## 9. Alternatives rejected

- **Leave `NoDirectory` and hand testers a debug build that resolves
  unverified keys.** That is #133's MITM, and training testers to accept it is
  the wrong habit.
- **Count free2z's witness as independent so the warning goes away.** That
  would display a reassuring number for a property the deployment does not
  have. §8.3 forbids it.
- **Unvouched first entries (`AuthoritySet::none`).** That means
  first-come-first-served handles, which the owner rejected in favour of a
  proven mapping.
- **Let the plugin fetch the assertion.** The plugin is also linked into
  e2e2z, and the assertion only has value next to the seed-derived binding
  signature, which only ZUULI can produce.
- **Set `mergedAtEpoch` from the receipt.** The receipt has no epoch, and a
  promise is not an inclusion.
- **Carry the Knox token in Rust state.** That would keep a long-lived
  credential in a second place. The per-call argument keeps it for one request.
  The e2e2z intent path (§4.1) will need a session slot, and that follow-up
  should argue for it on its own merits.

## 10. What is left

- **A ZUULI trigger.** Nothing in ZUULI's UI calls `f2zmsg_enroll` today, so
  ZUULI's *own* device is still unpublished until something invokes it with a
  `knoxToken`. An e2e2z device does not need one: §4.1's path publishes it, and
  ZUULI's own entry can arrive later as a routine update.
- **A refused publication discards a device.** §4.1 answers with the credential
  only after the log admitted the entry, so a refusal leaves e2e2z with nothing
  — and a retry samples fresh device keys and a fresh queue. If the refusal was
  an *ambiguous* one (the submission left, the answer did not), the abandoned
  device may already be published, and the next entry carries it forward as a
  device nobody holds the key for. On a disposable internal log that is noise
  rather than damage; before a public log it needs either a revocation on retry
  or a resumable pending device.
- **ZUULI must be signed in to free2z** for a handle's *first* entry, because
  Contract C's assertion is issued against that session. A later device needs no
  session: the published entry is the evidence.
- **The merge is polled, not pushed.** e2e2z re-reads on focus and every 20
  seconds while it is enrolled and not yet merged. Nothing tells a device that
  an epoch closed.
- ~~**Real values** in `internal-directory.conf`.~~ **Landed.** The file names
  the deployed log, its single free2z-operated witness, the handle authority and
  the relay, and each value was checked against the live service before it was
  committed — the signed tree head under the bundled log key, the published
  descriptor's genesis/VRF/reset-authority/cooldown, the §4.6 policy's vouching
  for exactly the bundled authority, and the backend's own
  `GET /api/e2ee/authority/`. No generation is retired yet.
- ~~**The backend endpoint** (workstream 7).~~ Deployed; this repository
  verifies the authority key it was given and nothing else about it.
- **Persisted pins and alarms.** The tree-head checkpoint survives a restart,
  sealed in the engine's store. Per-handle pins and the alarm log do not yet,
  so a key change seen in one session is not remembered in the next. The
  conversation's own stored peer identity still catches a change for existing
  conversations. When they are persisted, they belong in the same sealed
  record, and the §3 refusals apply to them unchanged.
- **The authority policy is pinned per connection, not per device.** A
  lock/unlock cycle, an unenroll or a restart rebuilds the connection and asks
  again. Across all of them the bundled `handle_authority_pk` is the pin, which
  is the stronger half; a log that changed `max_validity_ms` between two
  connections is not detected. §3 says why that trade is the right one here.
- **One environment per build.** The file holds one directory. Pointing
  development builds at staging would need a second file selected at build
  time.
- **The deployed log's witness is not cosigning.** Every tree head the log
  served on 2026-09-17, from epoch 1 to the current one, carried **zero**
  cosignatures, so *t* = 1 is unmet and every `resolve` is refused with
  `WitnessThresholdUnmet` (§2.1's "no anti-equivocation" is about *independence*;
  this is the threshold itself). The log's `/kt/v1/cosign` is enabled and
  recognises witnesses, so `f2z-witness` is simply not posting. First contact
  cannot work until it does, and it is a deployment fix, not a change here.
  It also leaves `witness_pk` as the one bundled value with no live signature to
  check it against.
- **Observation on devices.** Nothing here has run on a device, and no
  automated check reaches the deployed services — the verification above was a
  person checking once, at the moment the file was filled in.
