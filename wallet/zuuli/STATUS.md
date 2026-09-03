# ZUULI product status

This is a release-readiness record, not a feature catalogue. A browser fixture,
compiled code path, successful package build, or store upload does **not** prove
that a product operation works. In this document, **production-observed** means
the non-mock path was actually exercised against `https://free2z.cash` or read
back from the named store. Authenticated, money-moving, wallet, KYC, and media
operations are not called working without recorded evidence from that path.

Last re-derived from `origin/main` at
`39ce2e6ed9ca834451f8d4cc69de16e68660c0ae` on 2026-09-01. Before a release,
update the evidence and disposition for every non-ready row; do not carry this
commit or date forward mechanically.

This is the widest anchor since build 14. Thirty-five commits landed between
`e2be49c8` (the build-19 anchor) and this one; two of them are build 19's own
ceremony ([#842](https://github.com/free2z/zuu/pull/842) and
[#843](https://github.com/free2z/zuu/pull/843)) and one is this build's own
STATUS re-derive ([#870](https://github.com/free2z/zuu/pull/870)), so
**thirty-two PRs reach a build for the first time in `0.1.0+20`**:

- **ZUULI application and UI** — the off-screen mobile More sheet
  ([#869](https://github.com/free2z/zuu/pull/869)), About commit-SHA
  middle-truncation and English-scoped BIP-39 detection
  ([#868](https://github.com/free2z/zuu/pull/868)), safe-area-aware snackbars
  ([#863](https://github.com/free2z/zuu/pull/863)), RTL layout mirroring and
  bidi identifier isolation ([#861](https://github.com/free2z/zuu/pull/861)),
  autocomplete-first discovery
  ([#803](https://github.com/free2z/zuu/pull/803)), the privacy-safe feedback
  composer ([#823](https://github.com/free2z/zuu/pull/823)), exact About build
  identity ([#822](https://github.com/free2z/zuu/pull/822)), truthful
  participant counts ([#798](https://github.com/free2z/zuu/pull/798)), live
  join tickets bound to meetings
  ([#819](https://github.com/free2z/zuu/pull/819)), and mock/`handle.rs`
  handle-eligibility parity
  ([#864](https://github.com/free2z/zuu/pull/864)).
- **Build, boundary, and release tooling** — real wallet project boundaries
  ([#862](https://github.com/free2z/zuu/pull/862)), the DMG shipped-artifact
  SBOM canary ([#866](https://github.com/free2z/zuu/pull/866)), the
  store-capture toolchain image
  ([#857](https://github.com/free2z/zuu/pull/857)), Playwright in documented
  local verification ([#845](https://github.com/free2z/zuu/pull/845)), the
  Actions cache ceiling ([#846](https://github.com/free2z/zuu/pull/846)), and
  the markdown-only Rust-matrix skip
  ([#848](https://github.com/free2z/zuu/pull/848)), and the About identity
  test bound to canonical `release.json`
  ([#872](https://github.com/free2z/zuu/pull/872)).
- **`rs/` and messaging** — rejecting a `same_key` entry that rotates
  `directory_auth_pk` ([#841](https://github.com/free2z/zuu/pull/841)), MLS
  group restore after a receive rollback
  ([#781](https://github.com/free2z/zuu/pull/781)), fail-closed relay error
  contexts ([#800](https://github.com/free2z/zuu/pull/800)), a discriminating
  test for the relay `MAX_CONCURRENT` cap
  ([#867](https://github.com/free2z/zuu/pull/867)), reserved queue-creation
  coverage ([#860](https://github.com/free2z/zuu/pull/860)), the
  `cfg_attr(derive(Debug))` scanner blind spot
  ([#858](https://github.com/free2z/zuu/pull/858)), and the withdrawn PoW
  calibration claim ([#859](https://github.com/free2z/zuu/pull/859)).
- **Dependency and documentation hygiene** —
  [#855](https://github.com/free2z/zuu/pull/855),
  [#856](https://github.com/free2z/zuu/pull/856),
  [#853](https://github.com/free2z/zuu/pull/853),
  [#854](https://github.com/free2z/zuu/pull/854),
  [#849](https://github.com/free2z/zuu/pull/849),
  [#850](https://github.com/free2z/zuu/pull/850),
  [#852](https://github.com/free2z/zuu/pull/852), and
  [#847](https://github.com/free2z/zuu/pull/847).

`#872` is here because the build-20 bump was attempted first and **failed the
required gate**. `tests/about.pw.ts` pinned the release identity as literals —
`getByText("19")` and a regex containing `Build: 19` — so bumping to 20 broke
it by construction. That is a defect that would have failed *every* future
ZUULI release, and build 20 is simply the first bump since
[#822](https://github.com/free2z/zuu/pull/822) added the About build-identity
binding (`#822` landed after build 19 was cut). It could not ride in the
release source commit, because `status-freshness.mjs` correctly refuses a
non-ceremony release-impacting change there, so it landed ahead of the bump and
this anchor moved to include it. The test now reads canonical `release.json`,
which is also the stronger assertion: it fails if the rendered identity and
`release.json` ever disagree, which a frozen literal cannot detect.

Gate evidence at this anchor is complete at exactly the shipped content, which
was not true at the build-19 anchor:

- The anchor's tree, `29bc409c`, is **identical** to the tree of `#872`'s PR
  head `9067fc2`. Its completed
  [wallet/zuuli gate](https://github.com/free2z/zuu/actions/runs/33484401714),
  [rs gate](https://github.com/free2z/zuu/actions/runs/33484401681), and
  [four-target packaging smoke](https://github.com/free2z/zuu/actions/runs/33484401736)
  are therefore evidence for this source, not for a near neighbour — the
  build-18 precedent, which the build-19 anchor could not use.
- The anchor's parent `cdbe378` independently carries its own completed
  [wallet/zuuli gate](https://github.com/free2z/zuu/actions/runs/33480800517),
  [rs gate](https://github.com/free2z/zuu/actions/runs/33480800541), and
  [packaging smoke](https://github.com/free2z/zuu/actions/runs/33480800528).
- The previous anchor `9c78e90`'s own runs, recorded as still in flight in the
  snapshot this one replaces, have since all concluded successfully:
  [wallet/zuuli](https://github.com/free2z/zuu/actions/runs/33479067797),
  [rs](https://github.com/free2z/zuu/actions/runs/33479067721), and the
  [packaging smoke](https://github.com/free2z/zuu/actions/runs/33479067766).
  That closes the coverage gap that snapshot had to leave open for `#864`,
  `#868`, and `#869`.
- The anchor's own push-triggered
  [wallet/zuuli](https://github.com/free2z/zuu/actions/runs/33487961129),
  [rs](https://github.com/free2z/zuu/actions/runs/33487961126), and
  [packaging smoke](https://github.com/free2z/zuu/actions/runs/33487961119) runs
  were still in flight when this was re-derived and are **not** counted; they
  are redundant with the tree-identical evidence above, not a substitute for it.

These are source, test, and package-build evidence only. They add no
product-operation or physical-device evidence. Nothing in this anchor was
exercised on a physical device. Build 20 was subsequently read back from both
stores as recorded below; that is distribution evidence, not physical-device
acceptance.

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

## Release-path execution disposition

ZUULI currently ships mobile internal builds only; desktop distribution is
deferred and is not currently shipped. Protected release builds 17 through 20
all selected the `mobile` target. Their Linux package and three macOS jobs were
therefore skipped, including macOS system signing, notarization, and credential
cleanup. A credential-free packaging smoke is not evidence that those protected
desktop jobs ran.

The six release paths audited by [#754](https://github.com/free2z/zuu/issues/754)
have the following run-linked evidence and retention-bounded artifacts. Credential
handoffs expire after 1 day, packaging artifacts after 14 days, and protected
finalizer and release-index artifacts after 90 days; these links are evidence of
execution, not a permanent artifact archive.

| Evidence ID | Release path | Evidence class | Distribution | Exact execution evidence | Fixture/checker evidence and remaining boundary |
|---|---|---|---|---|---|
| `android-protected-sign-upload` | Android signed payload comparison, `signed_abis`, `signing-record.json`, `CHECKSUMS`, and Play upload | `protected-executed` | `mobile-shipped` | `Android / protected sign and Play upload` succeeded for [build 17](https://github.com/free2z/zuu/actions/runs/33330274664/job/99310600158), [18](https://github.com/free2z/zuu/actions/runs/33355762719/job/99382950495), [19](https://github.com/free2z/zuu/actions/runs/33369623712/job/99427020050), and [20](https://github.com/free2z/zuu/actions/runs/33494458918/job/99819565832). In each job, `Materialize, sign, verify, optionally upload, and destroy credentials` succeeded, followed by a successful three-file signed-artifact handoff. Build 20's [read-only store audit](https://github.com/free2z/zuu/actions/runs/33496770265) independently found the exact Play build 20 release present and deleted its audit edit without committing it. | `aab-payload-digest.node-test.mjs` exercises a real `jarsigner` fixture and rejects payload mutation and ordering drift. `apple-credential-boundary.node-test.mjs` rejects removal of the digest comparison, signed-output records, upload transaction, or fail-closed step behavior. |
| `android-credential-cleanup` | Android credential and signed-output destruction | `protected-executed` | `mobile-shipped` | Both `Destroy ephemeral Android credentials` and `Destroy signed Android output` succeeded in each of the four signer jobs above. Artifact upload occurred between them, so the success-path order itself executed. | `apple-credential-boundary.node-test.mjs` rejects skipped or soft-failed credential cleanup and wrong cleanup/upload order. No secret values are retained as evidence. |
| `android-finalization` | Android credential-free finalization | `protected-executed` | `mobile-shipped` | `Android / credential-free shipped-artifact provenance` succeeded for [build 17](https://github.com/free2z/zuu/actions/runs/33330274664/job/99310771734), [18](https://github.com/free2z/zuu/actions/runs/33355762719/job/99383153475), [19](https://github.com/free2z/zuu/actions/runs/33369623712/job/99427364135), and [20](https://github.com/free2z/zuu/actions/runs/33494458918/job/99819938900), including signed-AAB verification, unpacking, Syft, inventory binding, checksums/provenance, attestation, and artifact upload. | `apple-credential-boundary.node-test.mjs` locks the complete finalizer and rejects weakened verification or ordering; the canonical-payload fixtures reject altered, undeclared, escaping, and symlinked members. |
| `release-index` | Immutable release index | `protected-executed` | `mobile-shipped` | `Immutable GitHub release index` succeeded for [build 17](https://github.com/free2z/zuu/actions/runs/33330274664/job/99310819089), [18](https://github.com/free2z/zuu/actions/runs/33355762719/job/99417503165), [19](https://github.com/free2z/zuu/actions/runs/33369623712/job/99442471138), and [20](https://github.com/free2z/zuu/actions/runs/33494458918/job/99820072758); source-binding verification and index artifact upload both ran. | `release-tag-identity.node-test.mjs` accepts a complete source-bound index fixture and rejects wrong source, duplicate/missing provenance, recursive prior indexes, malformed identity, and invalid roots. `apple-credential-boundary.node-test.mjs` rejects missing Android finalizer/index dependencies. |
| `linux-packaging` | Linux audit instrumentation, artifact SBOMs/bindings, and labeled source inventory | `packaging-executed` | `desktop-deferred` | Build 20's credential-free [Linux packaging job](https://github.com/free2z/zuu/actions/runs/33494458922/job/99813293131) succeeded through pinned Cargo audit instrumentation, real-package inspector fixtures, AppImage/deb/rpm scans, bindings, the labeled source inventory, checksums/provenance, and upload. | `artifact-sbom.node-test.mjs` uses real AppImage/deb/rpm canaries and rejects missing instrumentation, decorative or source-substituted artifact scans, early manifests, and altered bindings. The protected Linux release job remains unexecuted because releases are mobile-only. |
| `macos-packaging` | macOS artifact SBOMs/bindings, labeled source inventory, and Keychain entitlement policy | `packaging-executed-protected-unexecuted` | `desktop-deferred` | Build 20's credential-free [macOS packaging job](https://github.com/free2z/zuu/actions/runs/33494458922/job/99813293260) succeeded through the Keychain/capture source policy, real package collection, DMG/ZIP scans, bindings, labeled source inventory, checksums/provenance, and upload. | `artifact-sbom.node-test.mjs` uses real ZIP and `hdiutil` DMG canaries. `macos-keychain-entitlements.node-test.mjs` rejects missing or altered app/team/keychain groups and capture entitlements. Protected macOS system signing, notarization, and credential cleanup remain deliberately unexecuted while desktop shipping is deferred. |

## Source-and-runtime-backed matrix

| Surface | Real API/backend dependency | Native integration | Automated evidence | Production/native evidence | Current status and linked gaps |
|---|---|---|---|---|---|
| Runtime transport | Production bundle → `free2z.cash`; development proxy → staging | `tauri-plugin-http` is registered and selected for packaged non-dev Tauri. [#801](https://github.com/free2z/zuu/pull/801) added `https://*.free2z.cash/*` to both capability HTTP allowlists and put `https://free2z.cash` and `https://*.free2z.cash` into the packaged `connect-src`, plus `blob:` in `img-src` | The required frontend/Rust gate and the four-target packaging smoke both pass on a tree identical to this anchor's, at `#872`'s PR head, so every release-impacting path here is gate-covered at exactly the shipped content. [#862](https://github.com/free2z/zuu/pull/862) additionally makes `wallet/shared/` a real `@free2z/wallet-shared` package and adds a required boundary scanner so neither app can reach into the other's source | Signed-store and unsigned packages exist; no per-surface native HTTP success is recorded here | **Wired, not runtime-proven.** The former claim that packaged HTTP registration was missing was false. |
| App shell, mobile navigation, and localization | None | Safe-area insets and the mobile tab bar are native-surface concerns | Playwright geometry suites at 320/360px cover the five-item primary nav and the More sheet. [#869](https://github.com/free2z/zuu/pull/869) fixes a real defect: `DialogContent`'s variant-scoped `ltr:-translate-x-1/2` was not dropped by tailwind-merge when the sheet overrode it with an unprefixed `translate-x-0`, so the instant the entrance animation's effect was removed the base utility won and the sheet snapped to `translateX(-50%)`. Reverting only that class change reproduced it deterministically — dialog `left` at **-160 at 320px and -180 at 360px**, exactly `-width/2` — on every run, not intermittently. The same PR makes `navigation.pw.ts` wait on the dialog's own `getAnimations()` instead of measuring mid-tween. [#863](https://github.com/free2z/zuu/pull/863) gives Sonner toasts safe-area-aware offsets that clear the whole mobile tab bar; [#861](https://github.com/free2z/zuu/pull/861) mirrors layout for RTL locales, isolates bidi identifiers, and adds a source-policy gate against physical-direction utilities | No signed build has been observed on a physical device at any viewport. All geometry evidence is headless browser measurement | **A user-facing mobile-navigation defect shipped in builds 18 and 19 and is first fixed in build 20.** On a narrow viewport the More sheet — the only route to Articles, Messages, Profile, Revenue share, and About — rendered fully off-screen at rest once its entrance animation ended. It is fixed in source and covered by a test that was proven to fail without the fix; it has **not** been confirmed on a device. RTL and inset behaviour are likewise source and browser-test evidence only. Physical-device acceptance for the shell: [#331](https://github.com/free2z/zuu/issues/331), [#238](https://github.com/free2z/zuu/issues/238). |
| About & Feedback | None for the About row; the feedback handoff opens an external mail client or GitHub | Build identity is injected at bundle time from canonical `release.json`, the checked-out full source SHA, and the Tauri build platform; the OS opener performs the handoff | [#822](https://github.com/free2z/zuu/pull/822) binds version/build/channel/platform/source identity through release verification and artifact provenance, with drift, offline, clipboard, keyboard, screen-reader, and enlarged-text tests. [#823](https://github.com/free2z/zuu/pull/823) shows the complete outgoing subject and body before any handoff, fails closed with **no** diagnostic, log, stack, or runtime capture because traceback safety is not proven, and scrubs wallet/auth/network/path/encoded-secret shapes at review and again before copy. [#868](https://github.com/free2z/zuu/pull/868) middle-truncates the commit SHA through the shared `truncateAddress()` helper instead of a head-only `slice(0, 12)`, scopes BIP-39 mnemonic detection explicitly to English and surfaces that limit in the composer copy, and fixes the regression where the new ellipsis matched the scrubber's own path shape and redacted every report. [#872](https://github.com/free2z/zuu/pull/872) binds the browser identity test to canonical `release.json` instead of a pinned build literal, so the test now actually asserts the binding `#822` claims — the literal matched only by coincidence of the current build and failed the required gate on the first release bump after it | No feedback report has been composed or sent from a signed build, and no build has been observed displaying its own identity on a device | **New visible surface in build 20; source and test evidence only.** The scrubber is a best-effort redactor over text the user can still edit before sending; it is not a guarantee, and non-English mnemonics are explicitly out of its detection scope and said so in the UI. Nothing here is device-proven. |
| Public Articles, creator listing, search, Live discovery, AI models, and pricing | Public `zpage`, `creator`, `dyte/public`, `ai/models`, `pricing`, and `pricing/quote` endpoints | Shared native HTTP transport in packaged builds | Parser/component tests cover selected article, remote-data, and media contracts. [#797](https://github.com/free2z/zuu/pull/797) routes this surface's copy through a repo-wide message catalog (`en`/`es`/`fr`) with build-boundary and copy-policy tests; that is a source and test change to presentation only, and it adds no backend evidence. [#803](https://github.com/free2z/zuu/pull/803) replaces the Articles topic-pill wall with a topic autocomplete and adds mixed topic/creator/page suggestions to global Search, with tests for stale-response rejection, identity dedupe, and distinguishing a transport failure from an empty corpus — client contract only | Unfiltered collection/model/pricing production GETs returned HTTP 200 on 2026-09-01; Live returned a valid empty page. Filtered creator/article search and the new autocomplete endpoints were not probed against production | **Collection reads production-observed; search wired, not runtime-proven.** Signed-native rendering remains unrecorded. The source/test fixes for articles ([#337](https://github.com/free2z/zuu/issues/337), [#374](https://github.com/free2z/zuu/issues/374), [#250](https://github.com/free2z/zuu/issues/250), [#251](https://github.com/free2z/zuu/issues/251)) and pagination ([#252](https://github.com/free2z/zuu/issues/252), [#253](https://github.com/free2z/zuu/issues/253)) do not create signed-native or filtered-search runtime evidence. |
| Username/password and TOTP sign-in | Knox Basic login, OTP status/login, and authenticated user endpoints | Token-backed HTTP; no special native plugin | Session-boundary, login-destination, component, and browser lifecycle tests | Anonymous protected reads returned HTTP 403; no successful production login is recorded | **Wired, not runtime-proven; not release-ready.** Server-side TOTP enforcement: [#369](https://github.com/free2z/zuu/issues/369). Token custody: [#377](https://github.com/free2z/zuu/issues/377). |
| Login/link with Zcash | `auth/zcash/challenge` and `auth/zcash/login` | The shared plugin supports local recovery-phrase restore and transparent-address Zcash Signed Message signing | Native atomic-restore/signing tests and frontend restore/challenge lifecycle tests exercise local contracts | No production restore → native signature → Knox session round trip is recorded | **Restore is implemented and contract-tested, but the login path is not runtime-proven.** Recovery-phrase restore landed in [#428](https://github.com/free2z/zuu/pull/428); external-wallet signing remains unsupported. Physical recovery ceremony: [#246](https://github.com/free2z/zuu/issues/246). Wallet/login identity choice: [#329](https://github.com/free2z/zuu/issues/329). This is not ZIP-304. |
| Social login/link | Provider discovery, authorization start, callback exchange, and authenticated user endpoints | Desktop loopback and mobile private-scheme transports exist | Strict discovery parsing, transport selection, attempt fencing, error/retry UI, and 320/360 browser tests cover the client contract; the live preflight fails closed before opening provider URLs | Both discovery endpoints answered anonymously with HTTP 200 on 2026-09-01. The web/desktop endpoint reports `x` with `configured: true`, `google` and `github` `configured: false`; the mobile endpoint returns all three `configured: false`. No OAuth round trip is recorded on any platform | **Client contract fixed; backend-dependent and not runtime-proven.** A provider is selectable on desktop/web; none is on mobile. A `configured` flag is not a login — no authorization start, callback exchange, or resulting session has been performed on any platform, so signed-device login/link proof remains blocked. Public client follow-up: [#403](https://github.com/free2z/zuu/issues/403). Claimed-HTTPS release proof: [#242](https://github.com/free2z/zuu/issues/242). Association binding: [#380](https://github.com/free2z/zuu/issues/380). |
| Wallet create/restore/sync/receive/send/history | Lightwalletd and librustzcash through the shared plugin | Real Tauri Zcash plugin is registered. [#805](https://github.com/free2z/zuu/pull/805) adds typed multi-wallet listing and switching through the ZUULI bridge and a new mobile capability, publishing inventory, active identity, and account-scoped data atomically and serializing concurrent switches | Plugin Rust tests, frontend wallet tests, and backend compilation run in CI. `#805` adds identity-store, bridge, lifecycle, concurrency, and fail-closed suites; the deterministic mock is what those exercise | Packages have built, but no signed-device create/restore/sync/receive/send record is checked into this repository. `#805` adds no device or lightwalletd evidence | **Wired, not runtime-proven; release stop until kick-the-tires evidence exists.** The identity store is a **foundation**: a switchable wallet inventory now exists in source and under test, and it has never selected a real account on a real device. Send confirmation integrity: [#368](https://github.com/free2z/zuu/issues/368). Preserved-wallet import: [#272](https://github.com/free2z/zuu/issues/272). |
| AI conversations and billing | Model/personality APIs plus model-bound `ai/conversations/.../promptresponses` metering and authoritative balance refresh | Native HTTP | Component/state tests do not exercise a real metered conversation | Public model discovery returned HTTP 200; no authenticated production prompt and charge is recorded | **Wired, not runtime-proven.** The active UI uses the metered conversation path; the old flat-1-2Z description referred to legacy code. Conversation/model state: [#266](https://github.com/free2z/zuu/issues/266). |
| Livestream room/media | Public listing plus authenticated start/join and membership endpoints | Cloudflare RealtimeKit provider and meeting UI are mounted; camera/mic are native permissions. [#804](https://github.com/free2z/zuu/pull/804) adds an explicit-intent camera/microphone preflight with device enumeration and a confirmed preview before provisioning, and locks the exact Android/iOS/macOS capture manifests — macOS `Entitlements.plist` capture entitlements and `Info.macos.plist` usage strings now exist where they did not | Membership reconciliation tests cover selected money-boundary races. [#818](https://github.com/free2z/zuu/pull/818) adds a browser test that loads the exact packaged `src-tauri/tauri.conf.json` CSP, proves the bundled SDK's first `api.realtime.cloudflare.com/v2/internals/participant-details` request is permitted, and uses a negative control that removes the added sources to reproduce the blocked-request boundary. [#817](https://github.com/free2z/zuu/pull/817) adds a strict `meeting_type` contract suite, and `#804` adds mutation-sensitive preflight and permission-manifest suites. [#819](https://github.com/free2z/zuu/pull/819) strictly parses the RealtimeKit participant JWT and binds token, authoritative join response, discovery meeting, provider environment, role, and expiry before SDK initialization, replaces same-token retry with a fresh participant-only join that rejects replay/room-rotation/environment drift, and classifies CSP, offline, transport, timeout, malformed/expired ticket, provider-rejection, and ended-room faults into actionable copy emitting only allowlisted diagnostics. [#798](https://github.com/free2z/zuu/pull/798) removes local host/viewer count synthesis and represents counts as `number \| null` so absent or failed hydration renders as unknown rather than fabricated | Public listing returned HTTP 200 with zero active rooms on 2026-09-01; no native host/join/camera/mic session is recorded, and the preflight has never run against a real camera or microphone on a device. Founder QA on a Play-distributed build reported `ERR0001` when tapping Join Free on an active stream ([#813](https://github.com/free2z/zuu/issues/813)); `0.1.0+18` was the first build to carry the packaged-CSP fix and `0.1.0+19` also carries it, and per their own release runs both were signed and uploaded to Play Internal *and* TestFlight — but **neither has been read back from either store**, so neither is confirmed available to a tester on either platform, and no tester has joined a room from either | **Wired, not end-to-end proven.** The former missing-SDK claim was false. The packaged CSP allowed only legacy Dyte origins and blocked RealtimeKit's first Cloudflare request, which deterministically produced that `ERR0001`; [#816](https://github.com/free2z/zuu/issues/816) is closed by `#818`, which permits only the audited RealtimeKit HTTPS/WSS origins and no blanket `https:`/`wss:`. `#817` additionally corrects the paid-stream wire value the client sent — it serialized `pay-per-view` where the free2z contract's enum is `ppv` — and now fails closed on an unknown, missing, or mismatched kind and on a missing, zero, negative, or malformed PPV rate instead of silently making a stream free or paid; that fix is likewise in no read-back build. `#819` closes [#815](https://github.com/free2z/zuu/issues/815) and removes a second class of join failure — an unbound or replayed ticket — but it is source and browser-test evidence only and reaches a build for the first time in `0.1.0+20`. All of this remains source and browser-test evidence: **[#813](https://github.com/free2z/zuu/issues/813) stays open and unproven. No real active room has been joined from signed Android and iOS builds.** Builds 18 and 19 both shipped the CSP fix and neither has been read back, so nobody has verified the join on either platform. Metadata/PPV: [#262](https://github.com/free2z/zuu/issues/262). Private streams: [#264](https://github.com/free2z/zuu/issues/264). Participant counts: `#798` stops the client fabricating and sorting by synthesized counts, but [#265](https://github.com/free2z/zuu/issues/265) stays **open** — no populated production room has been observed rendering a real count. Purchase integrity: [#336](https://github.com/free2z/zuu/issues/336). |
| Articles read/write/comments/tips | Public zpage reads; authenticated create/update/comment/donation APIs | Native HTTP; markdown/media render inside the privileged webview. [#801](https://github.com/free2z/zuu/pull/801) auto-loads validated raster images from `free2z.cash` and its HTTPS subdomains, inspects every redirect before requesting the next hop, renders only local `blob:` URLs, and keeps per-item consent for third-party media behind a persistent Strict image-privacy switch | Markdown safety/media and donation idempotency/response tests, plus `#801`'s remote-media policy, redirect, native media-authority, and first-party image browser suites | Public feed returned HTTP 200; authenticated publishing, commenting, and tipping are not production-proven. No packaged build has been observed rendering a real first-party image | **Reads production-observed; writes and charges not runtime-proven.** The image change narrows what the reader will fetch without consent to an audited first-party scope; it is a source and test change and is in no read-back build. Remote-content boundaries: [#367](https://github.com/free2z/zuu/issues/367), [#374](https://github.com/free2z/zuu/issues/374). Authoring: [#250](https://github.com/free2z/zuu/issues/250), [#251](https://github.com/free2z/zuu/issues/251). |
| Creator public profile and self-edit | Public creator detail/zpage reads; authenticated user mutation | Native HTTP | UI and remote-data tests do not prove a production profile read or mutation | The creator collection returned HTTP 200; no creator-detail read, authenticated edit, or media upload is recorded | **Detail and self-edit wired, not runtime-proven.** Avatar/banner upload remains absent. Linked identities are not authoritative across reloads: [#256](https://github.com/free2z/zuu/issues/256). |
| KYC application | Authenticated KYC profile, document, tax-form, signature, and submit endpoints | Native HTTP and file picker; no live-camera capture flow | UI tests do not exercise the production KYC contract | No production application or signed-device capture/upload is recorded | **Wired, not runtime-proven; incomplete.** “Live photo” is a file upload: [#257](https://github.com/free2z/zuu/issues/257). Tax-form invalidation: [#258](https://github.com/free2z/zuu/issues/258). This is an application flow, not payout/cash-out. |
| 2Z send/tip/membership, and creator ZEC tips | Authenticated donation and subscription APIs; a ZEC tip is a wallet spend, not a 2Z charge | Native HTTP; [#799](https://github.com/free2z/zuu/pull/799) adds a distinct ZEC creator-tip choice that carries an alteration-detecting in-memory intent into the existing Wallet Send proposal/confirmation/execution path, locks the creator recipient, fails closed on missing, reloaded, changed, or wrong-network state, retires accepted intents so browser history cannot reuse them, and discloses transparent-address privacy and memo limits | Donation and membership idempotency/reconciliation contract tests, plus `#799`'s creator-tip unit and browser suites | No production charge is recorded, and **no ZEC creator tip has ever been proposed or broadcast from a signed device** — the tip path inherits the wallet row's unproven state wholesale | **Contract-tested, not runtime-proven.** The ZEC tip is a new *visible affordance over an unproven spend path*: its intent locking is tested, its settlement is not. Follow versus paid membership: [#261](https://github.com/free2z/zuu/issues/261). Creator purchase integrity: [#336](https://github.com/free2z/zuu/issues/336). |
| Buy 2Z with card | Authenticated Stripe Checkout creation, hosted Checkout, signed webhook credit, and a server-controlled return bridge | Native OS opener is used in packaged apps; the exact `cash.free2z.zuuli://checkout/return` route is registered on iOS/Android and claimed through the authenticated server bridge | #400 added signed-out gating, exact HTTPS host validation, actionable failures, and opener tests | Anonymous production checkout returned HTTP 403; no signed-in staging/live charge or signed-build return is recorded | **Wired, not runtime-proven.** Native return is blocked on an unshipped backend dependency tracked internally, so no native return has been exercised against a live charge. Track the end-to-end path in [#388](https://github.com/free2z/zuu/issues/388) and exact charge/credit integrity in [#399](https://github.com/free2z/zuu/issues/399). |
| Buy 2Z with ZEC | Public pricing/quote plus wallet spend and backend settlement/credit | Wallet bridge exists; production settlement is intentionally disabled | Quote parsing and explicit browser-only demo-boundary tests | Pricing and an exact 100-2Z quote returned HTTP 200; no spend/settlement exists | **Mock/demo only for settlement; unavailable in release builds:** [#155](https://github.com/free2z/zuu/issues/155). A price quote is not a top-up. |
| 2Z Activity | Authenticated Stripe purchase ledger | Native HTTP | Parsing/UI tests do not prove a complete ledger | Protected endpoint returned HTTP 403 anonymously; authenticated ledger not exercised | **Known incomplete:** the endpoint is purchases-only and cannot substantiate tips/AI/PPV totals ([#172](https://github.com/free2z/zuu/issues/172)). |
| E2EE messaging | Relay, key-transparency, and MLS services under `rs/` | `wallet/plugins/tauri-plugin-f2zmsg` builds, its two-instance integration test drives two engines over a real relay, and since [#750](https://github.com/free2z/zuu/pull/750) `wallet/zuuli/src-tauri` links it: `Cargo.toml` and its lock carry the plugin, `src/lib.rs` registers it, `src/messaging.rs` serves the enrollment trio, and both capability files grant it | The plugin's own crate gate runs in `zuuli.yml`; the app's gate additionally builds it into ZUULI for desktop, iOS and Android, and compiler-bound IPC probes assert the shipping routers route `plugin:f2zmsg|…` and the unprefixed enrollment commands. [#774](https://github.com/free2z/zuu/pull/774) adds frontend contract tests for exact-handle initiation, inbound decisions, witness-threshold refusal, single-flight proof of work, and authoritative event re-reads. [#767](https://github.com/free2z/zuu/pull/767), [#764](https://github.com/free2z/zuu/pull/764), and [#802](https://github.com/free2z/zuu/pull/802) add mutation-backed key-transparency and relay lifecycle coverage. Since the build-18 anchor, [#833](https://github.com/free2z/zuu/pull/833) covers authorization-before-commit ordering for all six relay-state commands, [#836](https://github.com/free2z/zuu/pull/836) reparses Rust with `syn` in `workspace_debug_scan` and redacts `Finding`'s `Debug`, [#835](https://github.com/free2z/zuu/pull/835) encodes a push once and fans it out with an encode-failure test, [#840](https://github.com/free2z/zuu/pull/840) binds handle-candidate eligibility to shipping parity, and [#834](https://github.com/free2z/zuu/pull/834) retires `with_simulated_channel_binding` from the relay testkit. Since the build-19 anchor, [#781](https://github.com/free2z/zuu/pull/781) restores MLS group state after a receive rollback, [#800](https://github.com/free2z/zuu/pull/800) makes the plugin fail closed on relay error contexts, [#864](https://github.com/free2z/zuu/pull/864) puts `mock.ts::evaluateHandle` and `handle.rs::eligibility` on one shared `docs/e2ee/fixtures/handle-eligibility.json` table — the mock previously answered `not-signed-in` where the authoritative Rust answers `punctuation` for the empty username, proven by running the new parity test against the unmodified mock first — [#867](https://github.com/free2z/zuu/pull/867) replaces a relay `MAX_CONCURRENT` test that passed with the cap removed with one that fails, and pins `REQUEST_TIMEOUT`'s floor at compile time against tuzi's k8s probe timeouts, [#860](https://github.com/free2z/zuu/pull/860) covers the reserved queue-creation mode through `Server::start`, and [#858](https://github.com/free2z/zuu/pull/858) closes a `cfg_attr(derive(Debug))` blind spot in `workspace_debug_scan` | **None.** Linking, routing, authorization, UI controls, and automated contracts are proven; no enrollment or message has been performed in a running ZUULI. The **`KeyPackage` blocker is now closed in source**: [#769](https://github.com/free2z/zuu/pull/769) merged at `127e600` and **is** part of this snapshot — the previous snapshot's claim that it was not is corrected here. It adds `PUBLISH_KEY_PACKAGES` (`0x0032`, signed by the contact queue's receive key) and `CLAIM_KEY_PACKAGE` (`0x0033`, unsigned behind a proof-of-work stamp), stores the pool at the relay hosting the device's contact queue under the `contact_addr` its directory entry already publishes, and makes `MlsEngine::add_member` take a `VerifiedKeyPackage` whose only constructor is the verifying one, so no relay-supplied bytes can join a group without the directory check. What still blocks first contact is one layer up: [#756](https://github.com/free2z/zuu/pull/756) landed the `f2z-kt-client` crate and `directory.rs` ships a real `KtDirectory` — `/kt/v1/lookup` over HTTPS with §6.3 monotonicity, §8.3's threshold over the client's own witness set, `f2z_kt_core::verify` inclusion proofs, §4.4 re-authorization, and pinning — but **the shipping default is still `directory::NoDirectory`**, which fails closed, because `KT.md` §12 has not decided the log identity, signing key, shipped witness list, or default *t*. `start_conversation` on the shipped configuration therefore still refuses with `witness-threshold-unmet` | **Linked and reachable; still not usable.** The blocker moved but did not clear: a `KeyPackage` can now be published and claimed, and **a user still cannot start a conversation with anyone in a shipped build**, because the default directory resolves nothing. There is no physical-device evidence. The spec/code divergence recorded at the build-19 anchor is now closed: [#839](https://github.com/free2z/zuu/pull/839) added `KT.md` rule 13 — a `same_key` entry at `entry_version >= 2` MUST NOT rotate `directory_auth_pk`, and the log MUST reject one that does with `ERR_BAD_AUTHORIZATION` — while `f2z-kt-core`'s `submit.rs` verified `auth_signature` against the previous entry's key without comparing the value the new entry published, so a validly signed entry could take over directory writes. [#841](https://github.com/free2z/zuu/pull/841) fixes that and closes [#837](https://github.com/free2z/zuu/issues/837); it landed **after** build 19 was cut, so `0.1.0+19` ships the divergence and `0.1.0+20` is the first build without it. That is a source fix to an unreachable surface — the shipping directory still resolves nothing, so nothing in a shipped build exercises the submission path either way. [#753](https://github.com/free2z/zuu/issues/753) is closed: since [#759](https://github.com/free2z/zuu/pull/759) a messaging store that will not open no longer takes ZUULI down at launch. [#782](https://github.com/free2z/zuu/pull/782) additionally keeps pure `check_handle_eligibility` available in that faulted state while every engine- or storage-dependent command and the enrollment trio refuses with the same §8 code. Epic: [#305](https://github.com/free2z/zuu/issues/305). Do not describe ZUULI as having usable messaging because the plugin or UI is present. |
| Internal distribution and store presentation | GitHub release train, App Store Connect, and Google Play | Signed mobile bundles plus generated platform/store icons; desktop packages are built only by credential-free packaging smoke while desktop distribution is deferred | Release identity, icon/store validators, protected state machines, and all-target packaging are gated. [#866](https://github.com/free2z/zuu/pull/866) adds the real `hdiutil` DMG canary that closed the last artifact-format gap in [#379](https://github.com/free2z/zuu/issues/379)'s first acceptance criterion. The release-step execution table above records which protected and packaging-only paths have actually run | Build 20's [TestFlight readback](https://github.com/free2z/zuu/actions/runs/33496768135) proved `uploaded`, `processed`, and `availableToInternalTesters`, `VALID`/`IN_BETA_TESTING`, and the exact internal-group relationship. Its [Play audit](https://github.com/free2z/zuu/actions/runs/33496770265) found the exact build 20 release present and destroyed the uncommitted audit edit. No physical-device acceptance or protected desktop execution is recorded | **Build 20 is confirmed in both mobile stores; desktop is not currently shipped.** A green upload or readback is distribution evidence, not device acceptance. Store media [#387](https://github.com/free2z/zuu/issues/387), shipped-artifact dependency reconciliation [#379](https://github.com/free2z/zuu/issues/379), and physical installs [#238](https://github.com/free2z/zuu/issues/238) remain open. Play remains owner-selected Console email-list mode: [#296](https://github.com/free2z/zuu/issues/296). |

## Current production and distribution evidence

Safe unauthenticated requests were **re-run fresh for this anchor** on
2026-09-01 and returned the following status and top-level contracts:

```text
GET  /api/zpage/?page_size=1                 200  count,next,previous,results (count: 3901)
GET  /api/creator/?page_size=1               200  count,next,previous,results (count: 76)
GET  /api/ai/models/?page_size=1             200  count,next,previous,results (count: 9)
GET  /api/dyte/public/?page_size=1           200  count,next,previous,results (count: 0)
GET  /api/pricing/                           200  pricing snapshot (7 sources)
GET  /api/pricing/quote/?tuzis=100           200  exact quote
GET  /api/auth/social/providers/             200  providers array (`x` `configured: true`)
GET  /api/auth/social/mobile/providers/      200  providers array (all `configured: false`)
```

Safe anonymous probes of `/api/auth/user/`, `/api/openai/prompt`,
`/api/kyc/user-profile`, `/api/stripe/transactions/`, and
`/api/stripe/create-checkout-session/` returned HTTP 403. That proves only the
anonymous access boundary; it does not prove any authenticated success path.

The social-provider configuration is unchanged from the 2026-08-26 audit and
was re-confirmed by this probe.
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

- [Protected release run 33494458918](https://github.com/free2z/zuu/actions/runs/33494458918)
  built, signed, and delivered `0.1.0+20` on 2026-09-01 from
  `894f4371e0a6267dc91c05841053c90d21cccbb8` and **succeeded overall**. Both
  mobile lanes, both shipped-artifact provenance jobs, and the immutable
  release index succeeded; the Linux and three macOS jobs were skipped by the
  `mobile` target. The subsequent
  [TestFlight readback](https://github.com/free2z/zuu/actions/runs/33496768135)
  proved the exact build uploaded, processed, available to internal testers,
  `VALID`/`IN_BETA_TESTING`, and related to the internal-only group. The
  [read-only store audit](https://github.com/free2z/zuu/actions/runs/33496770265)
  found the exact Play build 20 release `present: true` and deleted its edit
  without committing it. Neither readback is physical-device evidence.
- [Protected release run 33369623712](https://github.com/free2z/zuu/actions/runs/33369623712)
  built, signed, and delivered `0.1.0+19` on 2026-08-31 from
  `cafa48855d06c6eb3225e3c4c4264e99b8c46142` and **succeeded overall**. Pinned
  immutable source, the credential-free unsigned iOS archive and universal AAB,
  `iOS / system export and signing`,
  `iOS / credential-free signed artifact verification`,
  `iOS / App Store validation and TestFlight`,
  `Android / protected sign and Play upload`, both shipped-artifact provenance
  jobs, and the immutable GitHub release index all succeeded; the three macOS
  jobs and the Linux packages were skipped by the `mobile` target. **No
  readback and no store audit has been run at build 19.**
- [Protected release run 33355762719](https://github.com/free2z/zuu/actions/runs/33355762719)
  delivered `0.1.0+18` from `992bf2f5` and has since **concluded
  successfully**, correcting the build-19 re-derive's in-flight snapshot: the
  iOS lane completed through `iOS / App Store validation and TestFlight`,
  alongside the Play upload it had already finished, and the immutable release
  index succeeded. So build 18 reached **both** tracks. **No readback and no
  store audit has been run at build 18 either**, so a green upload job remains
  the only evidence for both 18 and 19, on both platforms.
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
- The newest TestFlight readback and store audit now sit at build 20's exact
  source. Builds 18 and 19 still have no direct store-side readback; the later
  build-20 observation does not retroactively prove either historical build.
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
as of 2026-09-01, neither the repository nor the physical-device tracking issues
record a signed-device wallet operation.

Read the "release stop" dispositions above for what they say. They bar calling
a surface **ready** and bar a public release; they have never barred an
internal build: builds 2 through 14 and builds 17, 18, and 19 all reached
TestFlight and Play Internal carrying them, and 15 and 16 reached TestFlight
carrying them. Internal
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
