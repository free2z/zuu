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

**Enrollment is still unavailable in shipping builds.** The transport refuses,
ZUULI has no `issue-device-credential` authority handler, and ADR 0016 §6 leaves
`device_kem_pk` unresolved. The shipping directory also remains `NoDirectory`.
No directory identity, witness policy or working chat session is supplied by this
install step. The UI retains its wallet-app enrollment refusal and does not
synthesize an enrolled status.

## 3. What is blocked

| Work | Current disposition |
| --- | --- |
| Cross-app transport and caller authentication | Unimplemented; #905 and [caller-authentication decisions](intent-bridge/CALLER-AUTHENTICATION.md). No shipping dispatch path |
| Credential issuance through the intent authority | `INTENT_UNKNOWN_INTENT`; an E2E2Z install command does not issue a credential |
| Messaging KEM/directory deployment | ADR 0016 §6 and the undecided directory/witness configuration remain open |
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
