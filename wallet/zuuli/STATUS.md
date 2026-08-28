# ZUULI product status

This is a release-readiness record, not a feature catalogue. A browser fixture,
compiled code path, successful package build, or store upload does **not** prove
that a product operation works. In this document, **production-observed** means
the non-mock path was actually exercised against `https://free2z.cash` or read
back from the named store. Authenticated, money-moving, wallet, KYC, and media
operations are not called working without recorded evidence from that path.

Last re-derived from `origin/main` at
`1deb9926598b7af8883abab879841ed8bf1d973f` on 2026-08-26. Before a release,
update the evidence and disposition for every non-ready row; do not carry this
commit or date forward mechanically.

## Evidence boundaries

- `VITE_MOCK=1` selects normal API/wallet fixtures for UI/demo work. It is useful
  for layout, deterministic screenshots, and component development, but it is
  never backend, payment, media, authentication, or wallet evidence. It is not
  a network-isolation guarantee for a native profile with persisted OAuth
  recovery state; offline proof needs a fresh plain-browser profile plus network
  controls.
- A development run uses the Vite proxy and defaults to
  `https://stage.free2z.cash`, not production. A production bundle defaults to
  `https://free2z.cash`; packaged Tauri calls use the registered native HTTP
  plugin. See [`vite.config.ts`](vite.config.ts), [`src/lib/env.ts`](src/lib/env.ts),
  [`src/lib/api/http.ts`](src/lib/api/http.ts), and
  [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs).
- **Wired, not runtime-proven** means source reaches a real API or native
  command, but this repository has no successful production operation recorded
  for it.
- **Known broken/incomplete** means a visible path has a confirmed contract,
  safety, settlement, deployment, or product gap. It blocks calling that path
  ready.

## Source-and-runtime-backed matrix

| Surface | Real API/backend dependency | Native integration | Automated evidence | Production/native evidence | Current status and linked gaps |
|---|---|---|---|---|---|
| Runtime transport | Production bundle → `free2z.cash`; development proxy → staging | `tauri-plugin-http` is registered and selected for packaged non-dev Tauri | The required frontend/Rust gate and four-target package smoke pass on the current tree | Signed-store and unsigned packages exist; no per-surface native HTTP success is recorded here | **Wired, not runtime-proven.** The former claim that packaged HTTP registration was missing was false. |
| Public Articles, creator listing, search, Live discovery, AI models, and pricing | Public `zpage`, `creator`, `dyte/public`, `ai/models`, `pricing`, and `pricing/quote` endpoints | Shared native HTTP transport in packaged builds | Parser/component tests cover selected article, remote-data, and media contracts | Unfiltered collection/model/pricing production GETs returned HTTP 200 on 2026-08-26; Live returned a valid empty page. Filtered creator/article search was not probed | **Collection reads production-observed; search wired, not runtime-proven.** Signed-native rendering remains unrecorded. Article gaps: [#337](https://github.com/free2z/zuu/issues/337), [#374](https://github.com/free2z/zuu/issues/374), [#250](https://github.com/free2z/zuu/issues/250), [#251](https://github.com/free2z/zuu/issues/251). Search/pagination gaps: [#252](https://github.com/free2z/zuu/issues/252), [#253](https://github.com/free2z/zuu/issues/253). |
| Username/password and TOTP sign-in | Knox Basic login, OTP status/login, and authenticated user endpoints | Token-backed HTTP; no special native plugin | Session-boundary, login-destination, component, and browser lifecycle tests | Anonymous protected reads returned HTTP 403; no successful production login is recorded | **Wired, not runtime-proven; not release-ready.** Server-side TOTP enforcement: [#369](https://github.com/free2z/zuu/issues/369). Token custody: [#377](https://github.com/free2z/zuu/issues/377). |
| Login/link with Zcash | `auth/zcash/challenge` and `auth/zcash/login` | The shared plugin supports local recovery-phrase restore and transparent-address Zcash Signed Message signing | Native atomic-restore/signing tests and frontend restore/challenge lifecycle tests exercise local contracts | No production restore → native signature → Knox session round trip is recorded | **Restore is implemented and contract-tested, but the login path is not runtime-proven.** Recovery-phrase restore landed in [#428](https://github.com/free2z/zuu/pull/428); external-wallet signing remains unsupported. Physical recovery ceremony: [#246](https://github.com/free2z/zuu/issues/246). Wallet/login identity choice: [#329](https://github.com/free2z/zuu/issues/329). This is not ZIP-304. |
| Social login/link | Provider discovery, authorization start, callback exchange, and authenticated user endpoints | Desktop loopback and mobile private-scheme transports exist | Strict discovery parsing, transport selection, attempt fencing, error/retry UI, and 320/360 browser tests cover the client contract; the live preflight fails closed before opening provider URLs | Both discovery endpoints answered anonymously with HTTP 200 on 2026-08-26. The web/desktop endpoint now reports `x` with `configured: true`, `google` and `github` `configured: false`; the mobile endpoint still returns all three `configured: false`. No OAuth round trip is recorded on any platform | **Client contract fixed; backend-dependent and not runtime-proven.** A provider is selectable on desktop/web for the first time; none is on mobile. A `configured` flag is not a login — no authorization start, callback exchange, or resulting session has been performed on any platform, so signed-device login/link proof remains blocked. Public client follow-up: [#403](https://github.com/free2z/zuu/issues/403). Claimed-HTTPS release proof: [#242](https://github.com/free2z/zuu/issues/242). Association binding: [#380](https://github.com/free2z/zuu/issues/380). |
| Wallet create/restore/sync/receive/send/history | Lightwalletd and librustzcash through the shared plugin | Real Tauri Zcash plugin is registered | Plugin Rust tests, frontend wallet tests, and backend compilation run in CI | Packages have built, but no signed-device create/restore/sync/receive/send record is checked into this repository | **Wired, not runtime-proven; release stop until kick-the-tires evidence exists.** Send confirmation integrity: [#368](https://github.com/free2z/zuu/issues/368). Preserved-wallet import: [#272](https://github.com/free2z/zuu/issues/272). |
| AI conversations and billing | Model/personality APIs plus model-bound `ai/conversations/.../promptresponses` metering and authoritative balance refresh | Native HTTP | Component/state tests do not exercise a real metered conversation | Public model discovery returned HTTP 200; no authenticated production prompt and charge is recorded | **Wired, not runtime-proven.** The active UI uses the metered conversation path; the old flat-1-2Z description referred to legacy code. Conversation/model state: [#266](https://github.com/free2z/zuu/issues/266). |
| Livestream room/media | Public listing plus authenticated start/join and membership endpoints | Cloudflare RealtimeKit provider and meeting UI are mounted; camera/mic are native permissions | Membership reconciliation tests cover selected money-boundary races | Public listing returned HTTP 200 with zero active rooms; no native host/join/camera/mic session is recorded | **Wired, not end-to-end proven.** The former missing-SDK claim was false. Metadata/PPV: [#262](https://github.com/free2z/zuu/issues/262). Private streams: [#264](https://github.com/free2z/zuu/issues/264). Participant counts: [#265](https://github.com/free2z/zuu/issues/265). Purchase integrity: [#336](https://github.com/free2z/zuu/issues/336). |
| Articles read/write/comments/tips | Public zpage reads; authenticated create/update/comment/donation APIs | Native HTTP; markdown/media render inside the privileged webview | Markdown safety/media and donation idempotency/response tests | Public feed returned HTTP 200; authenticated publishing, commenting, and tipping are not production-proven | **Reads production-observed; writes and charges not runtime-proven.** Remote-content boundaries: [#367](https://github.com/free2z/zuu/issues/367), [#374](https://github.com/free2z/zuu/issues/374). Authoring: [#250](https://github.com/free2z/zuu/issues/250), [#251](https://github.com/free2z/zuu/issues/251). |
| Creator public profile and self-edit | Public creator detail/zpage reads; authenticated user mutation | Native HTTP | UI and remote-data tests do not prove a production profile read or mutation | The creator collection returned HTTP 200; no creator-detail read, authenticated edit, or media upload is recorded | **Detail and self-edit wired, not runtime-proven.** Avatar/banner upload remains absent. Linked identities are not authoritative across reloads: [#256](https://github.com/free2z/zuu/issues/256). |
| KYC application | Authenticated KYC profile, document, tax-form, signature, and submit endpoints | Native HTTP and file picker; no live-camera capture flow | UI tests do not exercise the production KYC contract | No production application or signed-device capture/upload is recorded | **Wired, not runtime-proven; incomplete.** “Live photo” is a file upload: [#257](https://github.com/free2z/zuu/issues/257). Tax-form invalidation: [#258](https://github.com/free2z/zuu/issues/258). This is an application flow, not payout/cash-out. |
| 2Z send/tip/membership | Authenticated donation and subscription APIs | Native HTTP | Donation and membership idempotency/reconciliation contract tests | No production charge is recorded | **Contract-tested, not runtime-proven.** Follow versus paid membership: [#261](https://github.com/free2z/zuu/issues/261). Creator purchase integrity: [#336](https://github.com/free2z/zuu/issues/336). |
| Buy 2Z with card | Authenticated Stripe Checkout creation, hosted Checkout, signed webhook credit, and a server-controlled return bridge | Native OS opener is used in packaged apps; the exact `cash.free2z.zuuli://checkout/return` route is registered on iOS/Android and claimed through the authenticated server bridge | #400 added signed-out gating, exact HTTPS host validation, actionable failures, and opener tests | Anonymous production checkout returned HTTP 403; no signed-in staging/live charge or signed-build return is recorded | **Wired, not runtime-proven.** Native return is blocked on an unshipped backend dependency tracked internally, so no native return has been exercised against a live charge. Track the end-to-end path in [#388](https://github.com/free2z/zuu/issues/388) and exact charge/credit integrity in [#399](https://github.com/free2z/zuu/issues/399). |
| Buy 2Z with ZEC | Public pricing/quote plus wallet spend and backend settlement/credit | Wallet bridge exists; production settlement is intentionally disabled | Quote parsing and explicit browser-only demo-boundary tests | Pricing and an exact 100-2Z quote returned HTTP 200; no spend/settlement exists | **Mock/demo only for settlement; unavailable in release builds:** [#155](https://github.com/free2z/zuu/issues/155). A price quote is not a top-up. |
| 2Z Activity | Authenticated Stripe purchase ledger | Native HTTP | Parsing/UI tests do not prove a complete ledger | Protected endpoint returned HTTP 403 anonymously; authenticated ledger not exercised | **Known incomplete:** the endpoint is purchases-only and cannot substantiate tips/AI/PPV totals ([#172](https://github.com/free2z/zuu/issues/172)). |
| E2EE messaging | Relay, key-transparency, and MLS services under `rs/` | `wallet/plugins/tauri-plugin-f2zmsg` builds, its two-instance integration test drives two engines over a real relay, and since [#750](https://github.com/free2z/zuu/pull/750) `wallet/zuuli/src-tauri` links it: `Cargo.toml` and its lock carry the plugin, `src/lib.rs` registers it, `src/messaging.rs` serves the enrollment trio, and both capability files grant it | The plugin's own crate gate runs in `zuuli.yml`; the app's gate additionally builds it into ZUULI for desktop, iOS and Android, compiler-bound IPC probes assert the shipping routers route `plugin:f2zmsg|…` and the unprefixed enrollment commands, and `rs/crates/f2z-kt-client/tests/first_contact.rs` completes a conversation cold against a real `f2z-kt` log, a real `f2z-witness`, and a real relay | **None.** Linking, routing, authorization, and first contact are proven only by automated tests; no enrollment or message has been performed in a running ZUULI. `WIRE.md` §12.6 now supplies and authenticates the MLS `KeyPackage` needed to complete `start_conversation`, but the shipping default remains `directory::NoDirectory`, because `KT.md` §12 has not decided the log identity, signing key, shipped witness list, or threshold *t*. Therefore `resolve_handle`, `start_conversation`, and `accept_contact_request` fail closed with `witness-threshold-unmet` — the required behaviour under §6.4, not a placeholder | **Linked and reachable; still not usable.** A tester receives the Messages surface and can reach enrollment, but **cannot start a conversation with anyone in the shipping configuration.** The remaining blocker is operator configuration — a log identity, signing key, witness list, and threshold — not missing first-contact protocol code. [#753](https://github.com/free2z/zuu/issues/753) is closed: since [#759](https://github.com/free2z/zuu/pull/759) a messaging store that will not open no longer takes ZUULI down at launch. Follow-up [#762](https://github.com/free2z/zuu/issues/762) is open: `check_handle_eligibility` refuses on a faulted store even though its answer is pure. Epic: [#305](https://github.com/free2z/zuu/issues/305). Do not describe ZUULI as having messaging merely because the plugin is linked. |
| Internal distribution and store presentation | GitHub release train, App Store Connect, and Google Play | Signed mobile bundles plus generated platform/store icons | Release identity, icon/store validators, protected state machines, and all-target packaging are gated | A read-only readback at 01:19Z on 2026-08-26 reports TestFlight `0.1.0+16` `uploaded`, `processed` and `availableToInternalTesters` all true, `VALID`/`IN_BETA_TESTING`, related to the one internal-only group. **Play is two builds behind: the audit against this audit's source reports the exact release 16 `present: false`**, because builds 15 and 16 both failed before Play upload ([#738](https://github.com/free2z/zuu/issues/738), [#751](https://github.com/free2z/zuu/issues/751)); 14 remains the latest Play internal build. No physical-device acceptance is recorded. The audits found canonical listing copy unmatched and every declared screenshot set absent remotely | **iOS internal delivery is current; Android is two builds behind; publication presentation and device acceptance are incomplete.** Store media: [#387](https://github.com/free2z/zuu/issues/387). Physical installs: [#238](https://github.com/free2z/zuu/issues/238). Play remains owner-selected Console email-list mode: [#296](https://github.com/free2z/zuu/issues/296). |

## Current production and distribution evidence

Safe unauthenticated requests on 2026-08-26 returned the following status and
top-level contracts:

```text
GET  /api/zpage/?page_size=1                 200  count,next,previous,results (count: 3891)
GET  /api/creator/?page_size=1               200  count,next,previous,results (count: 77)
GET  /api/ai/models/?page_size=1             200  count,next,previous,results (count: 9)
GET  /api/dyte/public/?page_size=1           200  count,next,previous,results (count: 0)
GET  /api/pricing/                           200  pricing snapshot
GET  /api/pricing/quote/?tuzis=100           200  exact quote
GET  /api/auth/social/providers/             200  providers array (`x` `configured: true`)
GET  /api/auth/social/mobile/providers/      200  providers array (all `configured: false`)
```

Safe anonymous probes of `/api/auth/user/`, `/api/openai/prompt`,
`/api/kyc/user-profile`, `/api/stripe/transactions/`, and
`/api/stripe/create-checkout-session/` returned HTTP 403. That proves only the
anonymous access boundary; it does not prove any authenticated success path.

One contract moved since 2026-08-25: `/api/auth/social/providers/`, the
web/desktop endpoint, now reports `x` with `configured: true`. Read it
precisely. This is the first configured provider on any platform — `google`
and `github` are still `configured: false` there, and the mobile endpoint
`/api/auth/social/mobile/providers/` still returns all three as
`configured: false`. So a provider is now selectable on desktop/web and none is
on mobile. A `configured` flag is a backend declaration, not a login: no
authorization start, callback exchange, or resulting session has been performed
on any platform, so this is not evidence that social login works.
`/api/dyte/public/` still reports `count: 0`, so the Live listing contract is
again observed against an empty collection rather than a populated one.

Distribution evidence is narrower and explicit:

- [Protected release run 32911822458](https://github.com/free2z/zuu/actions/runs/32911822458)
  ran for `0.1.0+16` on 2026-08-25 at 23:40Z and **failed overall**. Its whole
  iOS lane succeeded — pinned immutable source, credential-free unsigned
  archive, system export and signing, credential-free signed artifact
  verification, App Store validation and TestFlight, and credential-free
  shipped-artifact provenance — and the credential-free unsigned universal AAB
  built. **`Android / protected sign and Play upload` failed**, so no Play
  internal release exists for build 16, and Android provenance, the immutable
  GitHub release index, the Linux packages, and all three macOS jobs were
  skipped. The Android fault is
  [#751](https://github.com/free2z/zuu/issues/751) — the signed/unsigned AAB
  payload comparison sorted one side and not the other — fixed by
  [#752](https://github.com/free2z/zuu/pull/752) after the run. Build 15's
  Android failure was a different fault,
  [#738](https://github.com/free2z/zuu/issues/738), fixed by
  [#739](https://github.com/free2z/zuu/pull/739).
- [Protected release run 32624780318](https://github.com/free2z/zuu/actions/runs/32624780318)
  built, signed, and delivered `0.1.0+14` on 2026-08-23, including Play
  internal. That is still the newest build on the Play internal track: builds
  15 and 16 both reached TestFlight and both died before Play upload, so
  **Play is two builds behind**.
- [TestFlight read-only recovery 32918530448](https://github.com/free2z/zuu/actions/runs/32918530448)
  read back `0.1.0+16` at 01:19Z on 2026-08-26, from source
  `e53b9da24fd2c483895f3476886b41a8f71ad7ee` in read-only mode, with
  `uploaded`, `processed`, and `availableToInternalTesters` all true, build
  `31a85e04-3c07-478b-9296-c50dbc3c8d2d` `processingState: VALID`,
  `internalBuildState: IN_BETA_TESTING`, `usesNonExemptEncryption: false`, and
  the exact build relationship to the single internal-only group
  (`ZUULI Internal Testers`, `isInternalGroup: true`,
  `hasAccessToAllBuilds: false`) verified. It did not read or log tester
  identities.
- [Store listing audit 32930587236](https://github.com/free2z/zuu/actions/runs/32930587236)
  audited both providers against this audit's source with no provider failure
  and `publicationReady: false`, `contractPhase: "captured"`. Apple matched the
  app identity; `en-US` app info is present but unmatched, beta info and exact
  version info are absent, `versionCount` is zero, and both declared screenshot
  sets — four candidates each for iPhone 6.9-inch (`APP_IPHONE_67`) and iPad
  13-inch (`APP_IPAD_PRO_3GEN_129`) — have a remote count of zero. Play matched
  the identity and reported the exact release 16 **`present: false`**, which is
  the store-side confirmation of the Android gap above rather than an inference
  from a CI log; listing and details are present but unmatched, release notes
  are unmatched, and icon, feature graphic, phone, 7-inch, and 10-inch counts
  are all zero. Play tester eligibility remains the owner-declared Console
  email-list mode with no API-visible Google Groups, which the API cannot
  enumerate either way. The temporary read-only Play edit was deleted without
  commit.

These runs prove package/store state, not product operations. No repository
record yet demonstrates the full physical-device checklist for wallet
recovery/sync/spend, OAuth, AI charging, Live media, KYC capture, card checkout,
or ZEC top-up. That checklist was re-derived for this audit and is still unmet:
nothing has been added to this repository since 2026-08-19 that records a
signed-device wallet operation.

Read the "release stop" dispositions above for what they say. They bar calling
a surface **ready** and bar a public release; they have never barred an
internal build: builds 2 through 14 all reached TestFlight and Play internal
carrying them, and 15 and 16 reached TestFlight carrying them. Internal
distribution is the mechanism by which the
missing device evidence gets collected — see [#234](https://github.com/free2z/zuu/issues/234)
and [#238](https://github.com/free2z/zuu/issues/238) — so shipping a further
internal build is how these rows get closed, not a way around them. What must
never happen is a build described as ready, or promoted beyond the internal
tracks, while they stand. Do not record secrets, credentials, seed words, tester
identities, or sensitive identity documents when that evidence is obtained.

## Release rule

The release checklist in [`docs/releasing.md`](docs/releasing.md) must consume
this matrix. A target cannot be called ready while a visible path for that
target is **known broken/incomplete**, or while a required money,
authentication, wallet, KYC, or media operation is merely mock-tested,
source-wired, packaged, uploaded, or listed. Supply the missing production and
native evidence, or remove/disable the visible affordance in the release build
and link the reviewed disposition here.
