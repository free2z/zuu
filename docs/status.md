# Status of the three-app split

Source and availability re-derived on **2026-09-10** for the internal
TestFlight refresh in [#1010](https://github.com/free2z/zuu/issues/1010), and
the messaging sections re-derived on **2026-09-17** for
[#1022](https://github.com/free2z/zuu/issues/1022).
The exact audited source and release evidence are recorded in
[`wallet/zuuli/STATUS.md`](../wallet/zuuli/STATUS.md).

**One bridge family now dispatches, and it has not been observed doing so.**
e2e2z's enrollment transport sends `issue-device-credential-v2` over the
verified App Links that [#977](https://github.com/free2z/zuu/pull/977) landed,
and `internal-directory.conf` now names a deployed log, witness, handle
authority and relay, so a build from this source connects somewhere instead of
failing closed on configuration. **Free2Z's transport still refuses**: no
`execute-payment` or `sign-challenge` leaves that app. Nothing in either
direction has run on a real device — building, signing or installing the apps
together is not that observation.

Per-app details:
[`ZUULI readiness`](../wallet/zuuli/STATUS.md),
[`Free2Z`](../wallet/free2z/README.md), and
[`E2E2Z`](../wallet/e2e2z/README.md).
Store setup has its own evidence in
[`release/PLAY-STORE-SETUP.md`](release/PLAY-STORE-SETUP.md); source declarations
are not observations from a store or a physical device.

## 1. What works

The following are source implementations and automated checks. They do not
claim authenticated, money-moving, or signed-device product acceptance.

| Surface | Implemented and checked | Remaining boundary |
| --- | --- | --- |
| ZUULI | Wallet vault, registered Zcash plugin, narrow content policy, no messaging capability grants. `execute-payment` has an authority-side proposal, native confirmation and execution path | No bridge transport; physical wallet operations retain their explicit evidence gaps in the readiness matrix |
| Free2Z | Articles, creator/profile, Live, AI, Search and revenue-share surfaces. Scoped native HTTP is registered; the bundle is active and uses its own deep-link scheme | No wallet or messaging plugin and no app `invoke_handler`. Packaged social OAuth is deliberately unavailable; password sign-in is present but this audit performs no authenticated operation |
| E2E2Z | Messaging plugin, device public-key preparation, credential installation and seed-free unlock retry. Diagnostics viewing is present | No Zcash dependency or seed authority. Credential installation does not provide a transport or a credential issuer |
| Boundaries | `project-boundary.mjs`, `surface-capability-authority.mjs`, the delegated suites and the required gate enforce application separation and registered plugin/permission contracts | A passed check proves its tested contract, not OS link verification or a completed user operation |
| Intent wire format | Shared Rust/TypeScript vectors and [conformance tests](intent-bridge/CONFORMANCE.md) cover requests, responses and outcome uncertainty | Correlation does not authenticate the caller or response destination |

Free2Z's native layer landed in [#942](https://github.com/free2z/zuu/pull/942),
closing [#918](https://github.com/free2z/zuu/issues/918). HTTP is scoped and
stateless; the ten wallet OAuth commands were **not** copied into the content
app. Its packaged OAuth transport returns unavailable before opening a provider.
The earlier claim that the app's native layer is unwired and its bundle inactive
is obsolete.

## 2. What fails closed, by design

### 2.1 One transport dispatches; Free2Z's still refuses

| Caller | Shipping seam | Behavior |
| --- | --- | --- |
| Free2Z | `wallet/free2z/src/lib/bridge/intent-transport.ts` → `installedIntentTransport` | Rejects with `IntentTransportUnavailableError`; no intent is sent |
| E2E2Z | `wallet/e2e2z/src/lib/enrollment/transport.ts` → `appLinkTransport.ts` in a native runtime | **Dispatches** `issue-device-credential-v2` over a verified App Link. In a browser nothing is installed and the default refuses |

Client App Link/Universal Link declarations landed in
[#977](https://github.com/free2z/zuu/pull/977), and
[#1019](https://github.com/free2z/zuu/pull/1019) built e2e2z's transport on
them: one module installs it, `scripts/authority-boundary.node-test.mjs` allows
exactly one, and the two independent guards (`available`, checked before device
keys are sampled, and an unconditional refusal in `dispatch`) still stand for
every runtime that gets no transport. Free2Z's seam is unchanged and its
refusal still names [#461](https://github.com/free2z/zuu/issues/461)
historically. Remaining bridge work is tracked by
[#905](https://github.com/free2z/zuu/issues/905).

**No dispatch has been observed on a device.** A verified App Link is only a
transport once the operating system has verified the association on an
installed, signed build, and no such result is recorded here.

On 2026-09-10, `free2z.com`'s AASA returned 200 and was byte-identical to
[`association/apple-app-site-association.json`](intent-bridge/association/apple-app-site-association.json).
Its `assetlinks.json` endpoint returned 503. No signed-device link-verification
result was recorded in this audit. Serving an association, OS verification and
implementing a transport are separate requirements.

Free2Z's creator-tip response handling also preserves uncertainty: a lost answer,
`INTENT_UNAVAILABLE` or an unfamiliar status cannot assure the payer that nothing
happened. The guarded caller does not become a usable payment path until the
transport exists.

### 2.2 `sign-challenge` has no caller and no implementation

ZUULI answers this family with `INTENT_UNKNOWN_INTENT`. Free2Z's Login with Zcash
is absent. The security decision remains in
[`intent-bridge/AUTHORITY.md`](intent-bridge/AUTHORITY.md): caller attestation
and a meaningful confirmation cannot be substituted with an opaque challenge.
Profile and revenue-share were ported in [#927](https://github.com/free2z/zuu/pull/927);
they are no longer missing app surfaces.

### 2.3 e2e2z shows no enrolled state

[#1009](https://github.com/free2z/zuu/pull/1009) implements the install side of
[ADR 0016](e2ee/decisions/0016-enrollment-sealing-boundary.md): the engine stores
a device-local wrap key in the application's own custody namespace, installs a
signed credential, and offers a seed-free unlock retry. A repeated install
cannot overwrite an enrolled device's key; an already-unlocked retry preserves
the engine's running state. The wire result still contains only credential bytes.

**The whole enrollment round trip now exists, and a shipping build can now
reach it.** e2e2z opens its contact queue at the relay, sends
`issue-device-credential-v2` with the endpoint the relay issued, and ZUULI —
after a native confirmation that names the **free2z account** its session
belongs to, the device being added, and that the device will be PUBLISHED and
will answer first — reads the seed, fetches Contract C's assertion, issues the
credential, signs and submits the `DirectoryEntry`, and verifies the log's
receipt
([ADR 0017](e2ee/decisions/0017-internal-directory-activation.md) §4.1). e2e2z
installs the credential only if that succeeded, and reaches "Handle active"
only from its **own** verified lookup. The configuration that used to stop it is
gone: `internal-directory.conf` names the deployed relay, log, witness and
handle authority (§2.4). **What has not happened is the run.** No enrollment
has been completed on a device, over a real App Link, against the deployed
services; every claim above is a source claim plus an automated test against a
log and relay started inside the test process. A device with no network still
fails closed rather than hanging — the directory connects on first use, so a
launch never blocks on the log, and enrollment refuses with
`relay-unreachable` or `directory-unreachable` after the 15-second timeout.
ADR 0016 §6 still leaves `device_kem_pk` unresolved. The UI synthesizes no
enrolled status on any path.

### 2.4 The directory is configured, and it is disposable

[ADR 0017](e2ee/decisions/0017-internal-directory-activation.md) defines a
**disposable internal** directory. free2z runs the log and its only witness,
*t* = 1, and the witness is not counted as independent, so lookups resolve and
`independentWitnesses` stays `0` with the "not independently witnessed" warning
on screen.

`wallet/plugins/tauri-plugin-f2zmsg/internal-directory.conf` **is now filled
in**, so every build from this source constructs a real key-transparency client
and a default relay. It names `https://kt.free2z.cash` (log),
`wss://relay.free2z.cash/relay/v1` (relay), one free2z-operated witness at
*t* = 1, and `https://free2z.cash/api/kt/handle-assertion/` with the handle
authority key the log vouches for. Each value was checked against the live
service before it was committed: the log's signed tree head verifies under the
bundled `log_public_key` and carries the bundled `log_id`, its published
descriptor carries the same genesis key, VRF key, reset authority and a
`reset_cooldown_seconds` of 604800, its §4.6 authority policy is **vouched** and
lists exactly one authority — the bundled one — and
`GET https://free2z.cash/api/e2ee/authority/` publishes that same key against
that same `log_id`. The `log_id` is also derived from the log key independently
of the file, which is the check `build.rs` makes and a test restates.

**The deployed log is not being cosigned, so lookups are refused.** Every tree
head it serves — checked at epochs 1, 5, 20, 35, 38, 39 and 40 on 2026-09-17 —
carries **zero** cosignatures, while the bundled configuration requires *t* = 1.
A client bootstraps, verifies the head, accepts the vouched authority policy,
and then raises `WitnessThresholdUnmet`; `resolve` of any handle returns
`WitnessThresholdUnmet` rather than a key. That is `KT.md` §8.3 working as
designed — *"an unverified key here is the MITM"* — and it means **first contact
does not work against this deployment yet**, so e2e2z cannot reach "Handle
active", which comes only from its own verified lookup. The log's `/kt/v1/cosign`
endpoint is enabled and recognises witnesses (it answers `ERR_MALFORMED`, not
`ERR_NOT_A_WITNESS`), so the gap is that `f2z-witness` is not posting
cosignatures. **This is a server-side fix, not a client change**, and it is the
last thing between this configuration and a usable directory. Until it is fixed,
`witness_pk` is also the one bundled value that could not be checked against a
live signature, because the witness has produced none.

**This log is disposable and is wiped before any public launch.** Its own
descriptor says so (`free2z DISPOSABLE-INTERNAL prod log - will be wiped before
public launch`). Every handle, entry and pin made against it dies with it, and
the wipe procedure in ADR 0017 §3 — new genesis key, and the old one listed as
`retired_log_public_key` — is what lets a device set its stored checkpoint aside
instead of refusing it. No generation has been retired yet.

Tested **against a real log and witness**, in `f2z-kt-client`'s
`tests/seed_submission.rs`, which drives `AccountKeys` and `f2z-kt-client`
directly — every value the way ZUULI produces it, but not through ZUULI's
`f2zmsg_enroll`:

- A seed-signed `DirectoryEntry` carrying the backend's `HandleAssertion`
  (Contract C) is admitted, merged and resolved; a second device chains.
- The log refuses an assertion from any other authority key, or for another
  identity key.
- A log wiped under the same key is refused after a restart; only a checkpoint
  from a **named retired** generation is set aside.
- The client refuses a log whose signed authority policy does not vouch with
  exactly the bundled handle-authority key.

Tested **without** a real log, in the plugin's and ZUULI's own unit tests:

- ZUULI's `f2zmsg_enroll` path: Contract C against a loopback server, the
  assertion precheck, draft assembly, and the refusals — but the
  `publish_steps` orchestration itself has never run end to end against a log.
  It cannot be tested where it lives: `f2z-kt` and `f2z-witness` are AGPL-3.0,
  and a dev-dependency on either from ZUULI or from the plugin would put them
  in a shipping lockfile (`rs/README.md`'s licence boundary), while
  `f2z-kt-client` — which may dev-depend on them — cannot depend on Tauri. The
  honest closure is an observation against the deployed log, which §2.4's last
  bullet already says has not happened.
- The client keeps a verified receipt.
- `mergedAtEpoch` is set only from a verified lookup of the device's own handle.
- e2e2z keeps its "not independently witnessed" warning while fewer than two
  independent witnesses cosign, and says so when the directory is unusable.

Also implemented and tested against a real log, witness and relay
(ADR 0017 §4.1): a real `IssueDeviceCredentialRequestV2` admitted by the real
intent gate, the wallet's submission of another app's device, that device
finding its own key published at the address the relay issued, and a stranger
who knew only the handle claiming a key package there.

Not yet available:

- **Nothing has run on a device, and nothing in CI touches the deployed
  services.** The services answered when the configuration was written — that
  is a one-time check by a person, not a standing test. Every automated claim
  above is against a log, witness and relay started inside the test process.
- No ZUULI screen calls `f2zmsg_enroll`, so ZUULI's **own** device is still
  unpublished; an e2e2z device does not need it.
- A handle's *first* entry needs a signed-in free2z session in ZUULI, which the
  WebView publishes to a write-only native slot
  (`wallet/zuuli/src-tauri/src/session.rs`).
- Contract A's chat-request endpoint, the handle authority's issuance, and the
  install landing page are the private backend's; this repository verifies the
  authority key it was given and nothing else about them.

## 3. What is blocked

| Work | Current disposition |
| --- | --- |
| Cross-app transport and caller authentication | Free2Z's seam is still unimplemented; #905 and [caller-authentication decisions](intent-bridge/CALLER-AUTHENTICATION.md). e2e2z's enrollment family dispatches over a verified App Link (#1019), and a verified App Link authenticates the *responder*, not the caller |
| Credential issuance through the intent authority | Implemented for both credential families (#1019, ADR 0017 §4.1); `sign-challenge` is still `INTENT_UNKNOWN_INTENT`. Reachable in a shipping build now that the relay and log are configured, and never exercised on one |
| Messaging KEM/directory deployment | **Deployed and configured** for the disposable internal log (ADR 0017, §2.4): `internal-directory.conf` carries the log, witness, relay and handle-authority values, each checked against the live service. ADR 0016 §6's `device_kem_pk` stays open until the first *public* user, and a public directory's witness policy remains undecided |
| e2e2z directory publication | Implemented and now configured: `IssueDeviceCredentialRequestV2` carries the endpoint, `prepare_device_with_endpoint` opens the queue before install, and ZUULI signs, submits and verifies the receipt. Blocked only on **observation** — none of it has run against the deployed log, or on a device |
| Signed-device acceptance | Internal distribution supplies builds for observation; physical install, wallet and OS-link evidence remain separate requirements |
| Public release and broader tester rollout | Deferred while the readiness matrix contains unresolved operations and store-presentation gaps |

## 4. ZUULI hardening

The vault extraction landed in [#943](https://github.com/free2z/zuu/pull/943),
and [#955](https://github.com/free2z/zuu/pull/955) completed the capture-permission,
entitlement and store-copy cleanup. ZUULI no longer mounts the content or
messaging frontends. Its remaining feature directories are `about`, `auth`,
`home` and `wallet`; both capability files omit `f2zmsg:*`. The messaging plugin
remains linked for the app-crate enrollment API, which needs separate native
authority review and is not proof of usable messaging. Native acceptance is
still governed by the readiness record, not by the removal of those surfaces.

## 5. Keeping this page true

Update this page when a transport starts dispatching, an intent family gains an
authority implementation, a delegated app changes its capabilities, or recorded
source/store/device evidence changes. An issue closing is a reason to inspect the
implementation, not proof that every dependent feature works.
