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
| `reset_cooldown_seconds` | ADR 0014's cooldown. | the log config's value (default 604800) |
| `witness_pk` | A witness key. Repeatable. **Always dependent.** | each `f2z-witness` public key, and the log config's `witness_pk` lines |
| `threshold` | *t*, from 1 to the number of witnesses. | — |
| `handle_authority_pk` | Contract C's signing key. | the log config's `authority_pk` |
| `handle_assertion_url` | Contract C's endpoint, `https://`. | the backend route in §5 |
| `relay_url` | The default relay, `wss://`. | the relay's public ingress |

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

**Filling it in is a one-file change** (workstream 9), plus flipping one test:
`the_checked_in_placeholders_fail_closed` asserts the unconfigured state, and a
filled file must replace it with an assertion on the real values.

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
- **The last verified tree head is persisted.** It is written to
  `f2zmsg-kt-checkpoint.bin` beside the store after every connect, sync and
  lookup, and read back through `KtClient::open` on the next launch. Before
  this, every launch trusted the log's head on first use again, which is the
  failure `KtClient::bootstrap`'s own documentation warns about. Now:
  - A checkpoint for **another** `log_id` is set aside (the reviewed build names
    a new log), and the device trusts the new log's first head.
  - A checkpoint for **this** log is resumed. The first sync then applies §6.3
    against it, so a log reset under the same key is **refused as a rollback**.
  - A checkpoint that does not decode, or does not verify, is refused rather
    than replaced.
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

### 4.1 e2e2z, and the one request field it needs

**This PR publishes ZUULI's own device. It does not yet publish an e2e2z
device.** A `ContactEndpoint` carries the `contact_addr` that the relay issued
to the device that opened the queue. Only that device knows it. #1019's
`IssueDeviceCredentialRequestV1` carries `handle`, `device_pk`,
`device_kem_pk` and the requested validity window, and nothing else. ZUULI
therefore cannot build a publishable entry for an e2e2z device from what
arrives.

**Decision.** A follow-up adds the requesting device's endpoint to the
request, as `IssueDeviceCredentialRequestV2` (a new versioned body, so v1's
vectors stay frozen):

```text
struct {
    opaque handle<0..255>;
    opaque device_pk[32];
    opaque device_kem_pk<0..2^24-1>;
    uint64 not_before_ms;
    uint64 not_after_ms;
    opaque contact_relay_url<1..255>;   /* wss:// */
    opaque contact_relay_id[32];
    opaque contact_addr[32];
} IssueDeviceCredentialRequestV2;
```

ZUULI signs these into the entry with the steps above. The response stays
`IssueDeviceCredentialResultV1`.

**Why this is consistent with ADR 0016 §4's "no new fields".** That rule
forbids an *unsigned copy of a value already fixed by a signed structure*.
The rule exists because an unauthenticated responder would get to choose the
copy, and the copy would win. The endpoint is not a copy of anything. It is a
new input that the *requester* supplies and ZUULI then signs over with the
`DirectoryAuthKey`. A hostile requester that passes the caller registry and the
user's confirmation can already obtain a credential for its own `device_pk`.
Choosing where that device receives first contact adds nothing beyond that.
The confirmation should name the relay host so the user can see it.

**Why the response still gains nothing.** e2e2z learns that its device merged
the way ZUULI does, by a verified lookup of its own handle (§6). That code
already runs in e2e2z's `start_engine`, because the plugin is shared. A receipt
in the response would be log-signed and so self-authenticating, but e2e2z has no
use for it: the receipt is the *submitter's* evidence (`KT.md` §5.3), and ZUULI
keeps it.

**What the follow-up also needs.** e2e2z has to open its contact queue before
it asks. That means an engine entry point that connects the default relay and
creates the queue from the pending device's queue seed before
`install_identity`. That work belongs to the e2e2z workstream.

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
| `f2z-kt-client` | `tests/seed_submission.rs` (5) | Against a **real** log and witness: a seed-signed enrollment is admitted, merged and resolved with `independent() == 0`; a second device chains; an unconfigured authority and another identity key are refused. A log wiped under the same key is refused after a restart. Another log's checkpoint is set aside; a corrupt or forged one is refused |
| `f2z-kt` | `adversarial.rs`: `an_assertion_signed_by_an_unconfigured_authority_is_refused`, `an_assertion_forged_under_the_configured_authority_id_is_refused` | Contract C on the log |
| `f2z-authority` | `tests/contract_c_vectors.rs` (2) | The vectors match the code; the vector passes the log's check; the stranger does not |
| plugin | `internal_directory::tests` (7) | Fail-closed parsing |
| plugin | `engine` tests | Bundled witness state, `set_witness_set` refusal, receipt recording, `mergedAtEpoch` only from a verified lookup, truthful `blocked` |
| ZUULI | `directory_publish::tests` (10) | Contract C against a loopback server (POST, token, JSON body, base64url decoding, refusals, oversize), the precheck, draft assembly, and refusing another wallet |
| e2e2z | `index.witness-warning.test.tsx` (4) | The warning stays up until two independent witnesses cosign |

**Mutations, run on this branch**, each by editing the guard, running the
suite, and restoring (`CONFORMANCE.md`'s method):

| Guard mutated | Test that failed |
|---|---|
| `f2z-authority` rule 12: any configured key accepted regardless of `authority_id` | `an_assertion_signed_by_an_unconfigured_authority_is_refused`, `an_assertion_from_an_unconfigured_authority_is_refused_by_the_log` |
| `f2z-authority` rule 13: authority signature result ignored | `an_assertion_forged_under_the_configured_authority_id_is_refused` |
| ZUULI `precheck` accepts everything | `the_precheck_refuses_what_the_log_would_refuse` |
| `KtClient::open`: any unusable checkpoint bootstraps instead of refusing | `a_checkpoint_for_another_log_is_set_aside_and_anything_else_wrong_is_refused` |
| `KtClient::open`: the checkpoint is ignored | both wipe tests |
| e2e2z: warning keyed on the threshold only | `stays up when the threshold is met…`, `stays up with one independent witness…` |

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
   genesis signing key**, which gives it a new `log_id`, and ship its values in
   this file. Devices running the new build set the old checkpoint aside and
   start trusting the new log. Held receipts and `mergedAtEpoch` values refer to
   the old log, so re-enrollment is required.
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

- **e2e2z publication:** §4.1's request body, e2e2z opening its contact queue
  before install, and ZUULI publishing from `issue_device_credential`.
- **A ZUULI trigger.** Nothing in ZUULI's UI calls `f2zmsg_enroll` today. The
  command publishes when invoked with `knoxToken`.
- **Real values** in `internal-directory.conf`. The deployment has published
  every value except `handle_authority_pk`, which is not minted yet. A file
  with some placeholders is malformed by design, so the values land together
  in a follow-up once the key exists and the services answer.
- **The backend endpoint** (workstream 7).
- **Persisted pins and alarms.** The tree-head checkpoint survives a restart.
  Per-handle pins and the alarm log do not yet, so a key change seen in one
  session is not remembered in the next. The conversation's own stored peer
  identity still catches a change for existing conversations.
- **One environment per build.** The file holds one directory. Pointing
  development builds at staging would need a second file selected at build
  time.
- **Observation on devices.** Nothing here has run against a deployed log.
