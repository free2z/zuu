# Status of the three-app split

Source and availability re-derived on **2026-09-10** for the internal
TestFlight refresh in [#1010](https://github.com/free2z/zuu/issues/1010).
The exact audited source and release evidence are recorded in
[`wallet/zuuli/STATUS.md`](../wallet/zuuli/STATUS.md).

**The three apps are separate, but they do not communicate through the intent
bridge yet.** Both shipping transport implementations refuse dispatch. Building,
signing or installing the apps together does not change that behavior.

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

### 2.1 There is no transport

| Caller | Shipping seam | Behavior |
| --- | --- | --- |
| Free2Z | `wallet/free2z/src/lib/bridge/intent-transport.ts` → `installedIntentTransport` | Rejects with `IntentTransportUnavailableError`; no intent is sent |
| E2E2Z | `wallet/e2e2z/src/lib/enrollment/transport.ts` → installed `IntentTransport` | Refuses before preparing device keys and refuses dispatch |

Client App Link/Universal Link declarations landed in
[#977](https://github.com/free2z/zuu/pull/977). The closed
[#461](https://github.com/free2z/zuu/issues/461) records that association work;
its closure does not implement an `IntentTransport`. Both refusal types still
name #461 in source, so that reference in an error is historical rather than a
live implementation milestone. Remaining bridge work is tracked by
[#905](https://github.com/free2z/zuu/issues/905).

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

**The whole enrollment round trip now exists**, and no shipping build can run
it. e2e2z opens its contact queue at the relay, sends
`issue-device-credential-v2` with the endpoint the relay issued, and ZUULI —
after a native confirmation that names the handle **free2z's authority signed**
and says the device will be PUBLISHED — issues the credential, signs and submits
the `DirectoryEntry`, and verifies the log's receipt
([ADR 0017](e2ee/decisions/0017-internal-directory-activation.md) §4.1). e2e2z
installs the credential only if that succeeded, and reaches "Handle active"
only from its **own** verified lookup. What stops it in a shipping build is the
configuration: `internal-directory.conf` holds placeholders, so there is no
relay to open a queue at and no log to publish to, and enrollment refuses with
`relay-unreachable`. ADR 0016 §6 still leaves `device_kem_pk` unresolved. The UI
synthesizes no enrolled status on any path.

### 2.4 The directory is wired, and ships unconfigured

[ADR 0017](e2ee/decisions/0017-internal-directory-activation.md) defines a
**disposable internal** directory. free2z runs the log and its only witness,
*t* = 1, and the witness is not counted as independent. The engine now
constructs a real key-transparency client and a default relay **when**
`wallet/plugins/tauri-plugin-f2zmsg/internal-directory.conf` is filled in. The
file is checked in with placeholder values, so **every build from this source
is still `NoDirectory` with no relay** until the deployment supplies real
values in a reviewed change.

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

- The backend endpoint and the deployed services do not exist, so every build
  from this source still has no relay and no log.
- No ZUULI screen calls `f2zmsg_enroll`, so ZUULI's **own** device is still
  unpublished; an e2e2z device does not need it.
- A handle's *first* entry needs a signed-in free2z session in ZUULI, which the
  WebView publishes to a write-only native slot
  (`wallet/zuuli/src-tauri/src/session.rs`).
- Nothing has run against a deployed log or on a device.

## 3. What is blocked

| Work | Current disposition |
| --- | --- |
| Cross-app transport and caller authentication | Unimplemented; #905 and [caller-authentication decisions](intent-bridge/CALLER-AUTHENTICATION.md). No shipping dispatch path |
| Credential issuance through the intent authority | Implemented for both credential families (#1019, ADR 0017 §4.1); `sign-challenge` is still `INTENT_UNKNOWN_INTENT`. Unreachable in shipping builds, which have no configured relay or log |
| Messaging KEM/directory deployment | ADR 0016 §6 remains open. The internal directory's configuration is decided (ADR 0017), but its values are placeholders until the log, witness, relay and handle-assertion endpoint are deployed. A public directory's witness policy remains undecided |
| e2e2z directory publication | Implemented: `IssueDeviceCredentialRequestV2` carries the endpoint, `prepare_device_with_endpoint` opens the queue before install, and ZUULI signs, submits and verifies the receipt. Blocked only on the deployment — and on observation, since none of it has run against a deployed log |
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
