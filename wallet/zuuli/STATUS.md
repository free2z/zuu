# ZUULI product status

This is a release-readiness record, not a feature catalogue. A browser fixture,
compiled code path, successful package build, or store upload does **not** prove
that a product operation works. In this document, **production-observed** means
the non-mock path was actually exercised against `https://free2z.cash` or read
back from the named store. Authenticated, money-moving, wallet, KYC, and media
operations are not called working without recorded evidence from that path.

Last re-derived from `origin/main` at
`73b14ff4b7922b7577ac0ac5ed0129aaa5fcabb7` on 2026-08-31. Before a release,
update the evidence and disposition for every non-ready row; do not carry this
commit or date forward mechanically.

The required [wallet/zuuli gate](https://github.com/free2z/zuu/actions/runs/33340232985),
[rs gate](https://github.com/free2z/zuu/actions/runs/33340232961), and
four-target [packaging smoke](https://github.com/free2z/zuu/actions/runs/33340232992)
that gated the merge of [#818](https://github.com/free2z/zuu/pull/818) all
completed successfully on `0027653d851d131f4c3a0cc0d7f2ec0bc17546a1`. That
commit's tree is byte-identical to this anchor's
(`619233369a41b5e0377c19bbae71128ed4c0ef2f` for both), so those runs are gate
evidence for exactly this source rather than for a near neighbour. The
push-triggered [rs gate](https://github.com/free2z/zuu/actions/runs/33348442122)
at the anchor SHA itself also completed successfully; the anchor's
push-triggered `wallet/zuuli` gate
([33348442055](https://github.com/free2z/zuu/actions/runs/33348442055)) and
packaging smoke
([33348442119](https://github.com/free2z/zuu/actions/runs/33348442119)) were
still queued behind a saturated runner pool when this was re-derived and are
therefore not counted as evidence here. These are source, test, and
package-build evidence only. They add no product-operation or physical-device
evidence.

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
| Runtime transport | Production bundle → `free2z.cash`; development proxy → staging | `tauri-plugin-http` is registered and selected for packaged non-dev Tauri | The required frontend/Rust gate passes at the exact anchor, and the four-target package smoke passes on its unchanged release-impacting tree | Signed-store and unsigned packages exist; no per-surface native HTTP success is recorded here | **Wired, not runtime-proven.** The former claim that packaged HTTP registration was missing was false. |
| Public Articles, creator listing, search, Live discovery, AI models, and pricing | Public `zpage`, `creator`, `dyte/public`, `ai/models`, `pricing`, and `pricing/quote` endpoints | Shared native HTTP transport in packaged builds | Parser/component tests cover selected article, remote-data, and media contracts | Unfiltered collection/model/pricing production GETs returned HTTP 200 on 2026-08-31; Live returned a valid empty page. Filtered creator/article search was not probed | **Collection reads production-observed; search wired, not runtime-proven.** Signed-native rendering remains unrecorded. The source/test fixes for articles ([#337](https://github.com/free2z/zuu/issues/337), [#374](https://github.com/free2z/zuu/issues/374), [#250](https://github.com/free2z/zuu/issues/250), [#251](https://github.com/free2z/zuu/issues/251)) and pagination ([#252](https://github.com/free2z/zuu/issues/252), [#253](https://github.com/free2z/zuu/issues/253)) do not create signed-native or filtered-search runtime evidence. |
| Username/password and TOTP sign-in | Knox Basic login, OTP status/login, and authenticated user endpoints | Token-backed HTTP; no special native plugin | Session-boundary, login-destination, component, and browser lifecycle tests | Anonymous protected reads returned HTTP 403; no successful production login is recorded | **Wired, not runtime-proven; not release-ready.** Server-side TOTP enforcement: [#369](https://github.com/free2z/zuu/issues/369). Token custody: [#377](https://github.com/free2z/zuu/issues/377). |
| Login/link with Zcash | `auth/zcash/challenge` and `auth/zcash/login` | The shared plugin supports local recovery-phrase restore and transparent-address Zcash Signed Message signing | Native atomic-restore/signing tests and frontend restore/challenge lifecycle tests exercise local contracts | No production restore → native signature → Knox session round trip is recorded | **Restore is implemented and contract-tested, but the login path is not runtime-proven.** Recovery-phrase restore landed in [#428](https://github.com/free2z/zuu/pull/428); external-wallet signing remains unsupported. Physical recovery ceremony: [#246](https://github.com/free2z/zuu/issues/246). Wallet/login identity choice: [#329](https://github.com/free2z/zuu/issues/329). This is not ZIP-304. |
| Social login/link | Provider discovery, authorization start, callback exchange, and authenticated user endpoints | Desktop loopback and mobile private-scheme transports exist | Strict discovery parsing, transport selection, attempt fencing, error/retry UI, and 320/360 browser tests cover the client contract; the live preflight fails closed before opening provider URLs | Both discovery endpoints answered anonymously with HTTP 200 on 2026-08-31. The web/desktop endpoint reports `x` with `configured: true`, `google` and `github` `configured: false`; the mobile endpoint returns all three `configured: false`. No OAuth round trip is recorded on any platform | **Client contract fixed; backend-dependent and not runtime-proven.** A provider is selectable on desktop/web; none is on mobile. A `configured` flag is not a login — no authorization start, callback exchange, or resulting session has been performed on any platform, so signed-device login/link proof remains blocked. Public client follow-up: [#403](https://github.com/free2z/zuu/issues/403). Claimed-HTTPS release proof: [#242](https://github.com/free2z/zuu/issues/242). Association binding: [#380](https://github.com/free2z/zuu/issues/380). |
| Wallet create/restore/sync/receive/send/history | Lightwalletd and librustzcash through the shared plugin | Real Tauri Zcash plugin is registered | Plugin Rust tests, frontend wallet tests, and backend compilation run in CI | Packages have built, but no signed-device create/restore/sync/receive/send record is checked into this repository | **Wired, not runtime-proven; release stop until kick-the-tires evidence exists.** Send confirmation integrity: [#368](https://github.com/free2z/zuu/issues/368). Preserved-wallet import: [#272](https://github.com/free2z/zuu/issues/272). |
| AI conversations and billing | Model/personality APIs plus model-bound `ai/conversations/.../promptresponses` metering and authoritative balance refresh | Native HTTP | Component/state tests do not exercise a real metered conversation | Public model discovery returned HTTP 200; no authenticated production prompt and charge is recorded | **Wired, not runtime-proven.** The active UI uses the metered conversation path; the old flat-1-2Z description referred to legacy code. Conversation/model state: [#266](https://github.com/free2z/zuu/issues/266). |
| Livestream room/media | Public listing plus authenticated start/join and membership endpoints | Cloudflare RealtimeKit provider and meeting UI are mounted; camera/mic are native permissions | Membership reconciliation tests cover selected money-boundary races. [#818](https://github.com/free2z/zuu/pull/818) adds a browser test that loads the exact packaged `src-tauri/tauri.conf.json` CSP, proves the bundled SDK's first `api.realtime.cloudflare.com/v2/internals/participant-details` request is permitted, and uses a negative control that removes the added sources to reproduce the blocked-request boundary | Public listing returned HTTP 200 with zero active rooms; no native host/join/camera/mic session is recorded. Founder QA on a Play-distributed build reported `ERR0001` when tapping Join Free on an active stream ([#813](https://github.com/free2z/zuu/issues/813)); the packaged-CSP cause is fixed in source at this anchor but is in **no distributed build**, because `0.1.0+17` was cut before it | **Wired, not end-to-end proven.** The former missing-SDK claim was false. The packaged CSP allowed only legacy Dyte origins and blocked RealtimeKit's first Cloudflare request, which deterministically produced that `ERR0001`; [#816](https://github.com/free2z/zuu/issues/816) is closed by [#818](https://github.com/free2z/zuu/pull/818), which permits only the audited RealtimeKit HTTPS/WSS origins and no blanket `https:`/`wss:`. That is source and browser-test evidence only: **[#813](https://github.com/free2z/zuu/issues/813) stays open and unproven until a real active room is actually joined from signed Android and iOS builds** alongside the web viewer. Metadata/PPV: [#262](https://github.com/free2z/zuu/issues/262). Private streams: [#264](https://github.com/free2z/zuu/issues/264). Participant counts: [#265](https://github.com/free2z/zuu/issues/265). Purchase integrity: [#336](https://github.com/free2z/zuu/issues/336). |
| Articles read/write/comments/tips | Public zpage reads; authenticated create/update/comment/donation APIs | Native HTTP; markdown/media render inside the privileged webview | Markdown safety/media and donation idempotency/response tests | Public feed returned HTTP 200; authenticated publishing, commenting, and tipping are not production-proven | **Reads production-observed; writes and charges not runtime-proven.** Remote-content boundaries: [#367](https://github.com/free2z/zuu/issues/367), [#374](https://github.com/free2z/zuu/issues/374). Authoring: [#250](https://github.com/free2z/zuu/issues/250), [#251](https://github.com/free2z/zuu/issues/251). |
| Creator public profile and self-edit | Public creator detail/zpage reads; authenticated user mutation | Native HTTP | UI and remote-data tests do not prove a production profile read or mutation | The creator collection returned HTTP 200; no creator-detail read, authenticated edit, or media upload is recorded | **Detail and self-edit wired, not runtime-proven.** Avatar/banner upload remains absent. Linked identities are not authoritative across reloads: [#256](https://github.com/free2z/zuu/issues/256). |
| KYC application | Authenticated KYC profile, document, tax-form, signature, and submit endpoints | Native HTTP and file picker; no live-camera capture flow | UI tests do not exercise the production KYC contract | No production application or signed-device capture/upload is recorded | **Wired, not runtime-proven; incomplete.** “Live photo” is a file upload: [#257](https://github.com/free2z/zuu/issues/257). Tax-form invalidation: [#258](https://github.com/free2z/zuu/issues/258). This is an application flow, not payout/cash-out. |
| 2Z send/tip/membership | Authenticated donation and subscription APIs | Native HTTP | Donation and membership idempotency/reconciliation contract tests | No production charge is recorded | **Contract-tested, not runtime-proven.** Follow versus paid membership: [#261](https://github.com/free2z/zuu/issues/261). Creator purchase integrity: [#336](https://github.com/free2z/zuu/issues/336). |
| Buy 2Z with card | Authenticated Stripe Checkout creation, hosted Checkout, signed webhook credit, and a server-controlled return bridge | Native OS opener is used in packaged apps; the exact `cash.free2z.zuuli://checkout/return` route is registered on iOS/Android and claimed through the authenticated server bridge | #400 added signed-out gating, exact HTTPS host validation, actionable failures, and opener tests | Anonymous production checkout returned HTTP 403; no signed-in staging/live charge or signed-build return is recorded | **Wired, not runtime-proven.** Native return is blocked on an unshipped backend dependency tracked internally, so no native return has been exercised against a live charge. Track the end-to-end path in [#388](https://github.com/free2z/zuu/issues/388) and exact charge/credit integrity in [#399](https://github.com/free2z/zuu/issues/399). |
| Buy 2Z with ZEC | Public pricing/quote plus wallet spend and backend settlement/credit | Wallet bridge exists; production settlement is intentionally disabled | Quote parsing and explicit browser-only demo-boundary tests | Pricing and an exact 100-2Z quote returned HTTP 200; no spend/settlement exists | **Mock/demo only for settlement; unavailable in release builds:** [#155](https://github.com/free2z/zuu/issues/155). A price quote is not a top-up. |
| 2Z Activity | Authenticated Stripe purchase ledger | Native HTTP | Parsing/UI tests do not prove a complete ledger | Protected endpoint returned HTTP 403 anonymously; authenticated ledger not exercised | **Known incomplete:** the endpoint is purchases-only and cannot substantiate tips/AI/PPV totals ([#172](https://github.com/free2z/zuu/issues/172)). |
| E2EE messaging | Relay, key-transparency, and MLS services under `rs/` | `wallet/plugins/tauri-plugin-f2zmsg` builds, its two-instance integration test drives two engines over a real relay, and since [#750](https://github.com/free2z/zuu/pull/750) `wallet/zuuli/src-tauri` links it: `Cargo.toml` and its lock carry the plugin, `src/lib.rs` registers it, `src/messaging.rs` serves the enrollment trio, and both capability files grant it | The plugin's own crate gate runs in `zuuli.yml`; the app's gate additionally builds it into ZUULI for desktop, iOS and Android, and compiler-bound IPC probes assert the shipping routers route `plugin:f2zmsg|…` and the unprefixed enrollment commands. [#774](https://github.com/free2z/zuu/pull/774) adds frontend contract tests for exact-handle initiation, inbound decisions, witness-threshold refusal, single-flight proof of work, and authoritative event re-reads. [#767](https://github.com/free2z/zuu/pull/767), [#764](https://github.com/free2z/zuu/pull/764), and [#802](https://github.com/free2z/zuu/pull/802) add mutation-backed key-transparency and relay lifecycle coverage | **None.** Linking, routing, authorization, UI controls, and automated contracts are proven; no enrollment or message has been performed in a running ZUULI. First contact still cannot succeed at this anchor: [#756](https://github.com/free2z/zuu/pull/756) landed the `f2z-kt-client` crate and `directory.rs` ships a real `KtDirectory` — `/kt/v1/lookup` over HTTPS with §6.3 monotonicity, §8.3's threshold over the client's own witness set, `f2z_kt_core::verify` inclusion proofs, §4.4 re-authorization, and pinning — but the shipping default is still `directory::NoDirectory`, because `KT.md` §12 has not decided the log identity, signing key, shipped witness list, or default *t*. Even a configured directory cannot complete `start_conversation` because this anchor publishes no `KeyPackage`; the open [#769](https://github.com/free2z/zuu/pull/769) is not part of this snapshot | **Linked and reachable; still not usable.** Source now exposes enrollment plus fail-closed first-contact controls, but there is no physical-device evidence and **a user cannot start a conversation with anyone at this anchor.** [#753](https://github.com/free2z/zuu/issues/753) is closed: since [#759](https://github.com/free2z/zuu/pull/759) a messaging store that will not open no longer takes ZUULI down at launch. [#782](https://github.com/free2z/zuu/pull/782) additionally keeps pure `check_handle_eligibility` available in that faulted state while every engine- or storage-dependent command and the enrollment trio refuses with the same §8 code. Epic: [#305](https://github.com/free2z/zuu/issues/305). Do not describe ZUULI as having usable messaging because the plugin or UI is present. |
| Internal distribution and store presentation | GitHub release train, App Store Connect, and Google Play | Signed mobile bundles plus generated platform/store icons | Release identity, icon/store validators, protected state machines, and all-target packaging are gated | A read-only readback at 19:44Z on 2026-08-30 reports TestFlight `0.1.0+17` `uploaded`, `processed` and `availableToInternalTesters` all true, `VALID`/`IN_BETA_TESTING`, related to the one internal-only group, and the store audit at the same source reports the exact Play release 17 `present: true`. **Both internal tracks are current at build 17**, which closed the two-build Android gap left by the build 15 and 16 Play-upload failures ([#738](https://github.com/free2z/zuu/issues/738), [#751](https://github.com/free2z/zuu/issues/751)). No physical-device acceptance is recorded. The audits still find canonical listing copy unmatched and every declared screenshot set absent remotely | **iOS and Android internal delivery are both current at build 17; publication presentation and device acceptance are incomplete.** No delivered build yet carries the [#818](https://github.com/free2z/zuu/pull/818) RealtimeKit CSP fix. Store media: [#387](https://github.com/free2z/zuu/issues/387). Physical installs: [#238](https://github.com/free2z/zuu/issues/238). Play remains owner-selected Console email-list mode: [#296](https://github.com/free2z/zuu/issues/296). |

## Current production and distribution evidence

Safe unauthenticated requests on 2026-08-31 returned the following status and
top-level contracts:

```text
GET  /api/zpage/?page_size=1                 200  count,next,previous,results (count: 3900)
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

The social-provider configuration is unchanged from the 2026-08-26 audit.
`/api/auth/social/providers/`, the web/desktop endpoint, reports `x` with
`configured: true`; `google` and `github` remain `configured: false` there, and
the mobile endpoint `/api/auth/social/mobile/providers/` still returns all
three as `configured: false`. So a provider is selectable on desktop/web and
none is on mobile. A `configured` flag is a backend declaration, not a login:
no authorization start, callback exchange, or resulting session has been
performed on any platform, so this is not evidence that social login works.
`/api/dyte/public/` still reports `count: 0`, so the Live listing contract is
again observed against an empty collection rather than a populated one.

Distribution evidence is narrower and explicit:

- [Protected release run 33330274664](https://github.com/free2z/zuu/actions/runs/33330274664)
  built, signed, and delivered `0.1.0+17` on 2026-08-30 from
  `a4478fb1e920bc022a9ab49518d4f26264442837` and **succeeded overall**. Pinned
  immutable source, the whole iOS lane through App Store validation and
  TestFlight, the credential-free unsigned universal AAB,
  `Android / protected sign and Play upload`, both shipped-artifact provenance
  jobs, and the immutable GitHub release index all succeeded; the three macOS
  jobs and the Linux packages were skipped by the `mobile` target. This is the
  first release run since build 14 whose Play upload succeeded, so it closes the
  two-build Android gap. It carries **no** RealtimeKit CSP fix: `0.1.0+17` was
  cut at `a4478fb`, before [#818](https://github.com/free2z/zuu/pull/818).
- The two preceding runs failed on Android and are why the gap existed:
  [run 32911822458](https://github.com/free2z/zuu/actions/runs/32911822458)
  reached TestFlight with `0.1.0+16` on 2026-08-25 but failed
  `Android / protected sign and Play upload`
  ([#751](https://github.com/free2z/zuu/issues/751), the signed/unsigned AAB
  payload comparison sorting one side only, fixed by
  [#752](https://github.com/free2z/zuu/pull/752)), and
  [run 32885179531](https://github.com/free2z/zuu/actions/runs/32885179531)
  failed the same lane for build 15 on a different fault
  ([#738](https://github.com/free2z/zuu/issues/738), fixed by
  [#739](https://github.com/free2z/zuu/pull/739)).
- [TestFlight read-only recovery 33331705268](https://github.com/free2z/zuu/actions/runs/33331705268)
  read back `0.1.0+17` at 19:44Z on 2026-08-30, from source
  `a4478fb1e920bc022a9ab49518d4f26264442837` in read-only mode, with
  `uploaded`, `processed`, and `availableToInternalTesters` all true, build
  `bc423c2a-a887-444e-80e3-05b2f7912c12` `processingState: VALID`,
  `internalBuildState: IN_BETA_TESTING`, `usesNonExemptEncryption: false`, and
  the exact build relationship to the single internal-only group
  (`ZUULI Internal Testers`, `isInternalGroup: true`,
  `hasAccessToAllBuilds: false`) verified. It did not read or log tester
  identities.
- [Store listing audit 33331706146](https://github.com/free2z/zuu/actions/runs/33331706146)
  audited both providers against the same source with no provider failure and
  `publicationReady: false`, `contractPhase: "captured"`. Apple matched the app
  identity; `en-US` app info is present but unmatched, beta info and exact
  version info are absent, `versionCount` is zero, and both declared screenshot
  sets — four candidates each for iPhone 6.9-inch (`APP_IPHONE_67`) and iPad
  13-inch (`APP_IPAD_PRO_3GEN_129`) — have a remote count of zero. Play matched
  the identity and reported the exact release 17 **`present: true`**, which is
  the store-side confirmation that the Android track is current rather than an
  inference from a CI log; listing and details are present but unmatched,
  release notes are unmatched, and icon, feature graphic, phone, 7-inch, and
  10-inch counts are all zero. Play tester eligibility remains the
  owner-declared Console email-list mode with no API-visible Google Groups,
  which the API cannot enumerate either way. The temporary read-only Play edit
  was deleted without commit.

These runs prove package/store state, not product operations. No repository
record yet demonstrates the full physical-device checklist for wallet
recovery/sync/spend, OAuth, AI charging, Live media, KYC capture, card checkout,
or ZEC top-up. That checklist was re-derived for this audit and is still unmet:
as of 2026-08-31, neither the repository nor the physical-device tracking issues
record a signed-device wallet operation.

Read the "release stop" dispositions above for what they say. They bar calling
a surface **ready** and bar a public release; they have never barred an
internal build: builds 2 through 14 and build 17 all reached TestFlight and
Play internal carrying them, and 15 and 16 reached TestFlight carrying them. Internal
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
