# ZUULI product status

This is a release-readiness record, not a feature catalogue. A browser fixture,
compiled code path, successful package build, or store upload does **not** prove
that a product operation works. In this document, **production-observed** means
the non-mock path was actually exercised against `https://free2z.cash` or read
back from the named store. Authenticated, money-moving, and wallet operations
are not called working without recorded evidence from that path.

Last re-derived from `origin/main` at
`c2f88d9285ca3436cd24052a7671709451e134f4` on 2026-09-07. Before a release,
update the evidence and disposition for every non-ready row; do not carry this
commit or date forward mechanically.

This re-derive is not a build cut, and it follows a failed one. **No signed
build has been cut since `0.1.0+20`.**
[#976](https://github.com/free2z/zuu/pull/976) wrote the identity `0.1.0+21`
into `release.json` at `7fe1b0a8`, before this anchor, and the
protected release that push fired
([run 34086094245](https://github.com/free2z/zuu/actions/runs/34086094245))
**failed in its first job**, `Pin immutable source`, because this document had
not been re-derived after the release-impacting changes listed below. Nothing
was built, signed, uploaded, or tagged; no protected environment was entered
and no credential was materialized. `0.1.0+21` exists only as a file.

The previous anchor `e129284c` was recorded by
[#955](https://github.com/free2z/zuu/pull/955), and it was stale the moment it
merged: [#954](https://github.com/free2z/zuu/pull/954) landed between the commit
`#955` audited and `#955`'s own merge, so the recorded anchor never covered its
own parent. That rebase race, not a content error, is the first thing this
re-derive corrects. Seventeen commits landed on `main` between `e129284c` and
this anchor. Everything below still reaches a build for the first time in the
*next* build; none of it is in any shipped or read-back artifact.

The split is the reason this document changed shape rather than only its
evidence. ZUULI is no longer the app the previous anchor described:

- **ZUULI is now a wallet vault.**
  [#943](https://github.com/free2z/zuu/pull/943) (#904 phase 4) took
  `src/features/` from twelve directories to four — `about`, `auth`, `home`,
  `wallet` — deleted the entire Markdown/Mermaid/remote-media tree, dropped the
  frontend lockfile from 709 to 351 packages, narrowed the packaged CSP to
  `img-src 'self' data:` with `media-src`, `worker-src`, `object-src` and
  `frame-src` all `'none'` and `connect-src` limited to `'self'` plus free2z,
  and removed every `f2zmsg:*` capability grant from both capability files.
- **The content and messaging surfaces moved into their own apps.**
  [#912](https://github.com/free2z/zuu/pull/912) (articles),
  [#920](https://github.com/free2z/zuu/pull/920) (Live, AI, Search),
  [#927](https://github.com/free2z/zuu/pull/927) (Profile and revenue-share
  application) and [#938](https://github.com/free2z/zuu/pull/938) (their
  Playwright coverage) built `wallet/free2z`;
  [#913](https://github.com/free2z/zuu/pull/913) built `wallet/e2e2z` and
  [#941](https://github.com/free2z/zuu/pull/941) gave it a mobile release path;
  [#909](https://github.com/free2z/zuu/pull/909) and
  [#942](https://github.com/free2z/zuu/pull/942) scaffolded and wired their
  native layers. Since the previous anchor both of those apps have moved on
  without ZUULI: [#963](https://github.com/free2z/zuu/pull/963) stood up the
  free2z mobile release path and
  [#972](https://github.com/free2z/zuu/pull/972) cut `cash.free2z.free2z`
  `0.1.0+2`, while [#959](https://github.com/free2z/zuu/pull/959),
  [#968](https://github.com/free2z/zuu/pull/968) and
  [#974](https://github.com/free2z/zuu/pull/974) cut and fixed
  `cash.free2z.e2e2z` `0.1.0+2`. Those are separate apps with separate
  evidence, and **none of their store or build evidence is ZUULI's**. For
  **this** document they only subtract: a row deleted below is a surface ZUULI
  no longer ships, not a surface that became proven somewhere else.
- **The cross-surface intent bridge**, which is how a delegated surface asks
  this one to spend: [#911](https://github.com/free2z/zuu/pull/911) (versioned
  protocol, no transport), [#914](https://github.com/free2z/zuu/pull/914) (the
  ZUULI authority side, natively confirmed),
  [#924](https://github.com/free2z/zuu/pull/924) (the free2z caller side),
  [#926](https://github.com/free2z/zuu/pull/926) (the issue-device-credential
  intent, still fail closed), and ADR 0016
  ([#935](https://github.com/free2z/zuu/pull/935)) on where enrollment sealing
  happens. Custom-scheme deep links are not an authenticated channel, so no
  cross-surface transport ships: [#461](https://github.com/free2z/zuu/issues/461).
- **`rs/` messaging and key transparency** —
  [#944](https://github.com/free2z/zuu/pull/944),
  [#953](https://github.com/free2z/zuu/pull/953),
  [#950](https://github.com/free2z/zuu/pull/950),
  [#937](https://github.com/free2z/zuu/pull/937),
  [#902](https://github.com/free2z/zuu/pull/902),
  [#899](https://github.com/free2z/zuu/pull/899),
  [#898](https://github.com/free2z/zuu/pull/898),
  [#897](https://github.com/free2z/zuu/pull/897),
  [#896](https://github.com/free2z/zuu/pull/896),
  [#895](https://github.com/free2z/zuu/pull/895),
  [#885](https://github.com/free2z/zuu/pull/885),
  [#882](https://github.com/free2z/zuu/pull/882),
  [#879](https://github.com/free2z/zuu/pull/879), and
  [#878](https://github.com/free2z/zuu/pull/878).
- **ZUULI-local and tooling** —
  [#875](https://github.com/free2z/zuu/pull/875) (TestFlight beta-tester invite
  capability), [#888](https://github.com/free2z/zuu/pull/888) (the release-step
  evidence policy this document's disposition table answers to),
  [#886](https://github.com/free2z/zuu/pull/886),
  [#883](https://github.com/free2z/zuu/pull/883),
  [#919](https://github.com/free2z/zuu/pull/919),
  [#933](https://github.com/free2z/zuu/pull/933),
  [#932](https://github.com/free2z/zuu/pull/932),
  [#887](https://github.com/free2z/zuu/pull/887), and
  [#881](https://github.com/free2z/zuu/pull/881).

**What the previous anchor listed as *not yet* in it, and what has landed
since.** The vault cleanup `#943` deferred is now in this source and verified
against it: [#945](https://github.com/free2z/zuu/issues/945) dropped the Android
`CAMERA`/`RECORD_AUDIO`/`MODIFY_AUDIO_SETTINGS` permissions, the macOS
`com.apple.security.device.camera`/`.audio-input` entitlements, and the Apple
camera/microphone usage strings; [#946](https://github.com/free2z/zuu/issues/946)
was this document and the store listing; and
[#916](https://github.com/free2z/zuu/issues/916) was verified as already closed
by `#943`. All three shipped in `#955`, and at this anchor
`src-tauri/gen/android/app/src/main/AndroidManifest.xml` declares
`android.permission.INTERNET` and nothing else. The release-impacting changes
after that are:

- [#954](https://github.com/free2z/zuu/pull/954) added `wallet/free2z` to
  `scripts/rtl-source-policy.mjs`'s reviewed surfaces with an empty residual
  inventory and pinned its one directional-transform site. The policy checker
  lives in ZUULI's `scripts/` and is gated by ZUULI's own suite, so a change to
  it is release-impacting here even though the defect it fixed was free2z's.
- [#957](https://github.com/free2z/zuu/pull/957) scoped the `wallet/zuuli`
  workflow's Rust matrix to Rust changes and gated the surfaces suites, and
  [#963](https://github.com/free2z/zuu/pull/963) extended the same workflow
  again. Job selection is now conditional, so **which** jobs a given commit's
  gate actually ran has to be read off that commit's run rather than assumed.
- [#962](https://github.com/free2z/zuu/pull/962) added
  `scripts/verify-signing-identity.mjs` and wired a certificate-against-profile
  preflight into `zuuli-release.yml`, so an imported `.p12` holding an identity
  the provisioning profile does not embed now fails before signing. Its
  disposition under [`docs/releasing.md`](docs/releasing.md) is option 2, the
  mutation-sensitive fixture `scripts/verify-signing-identity.node-test.mjs`.
  **The preflight itself has never executed in a protected release run**: the
  only release fired since it merged is build 21's, which failed in
  `Pin immutable source` before any signing job started.
- [#966](https://github.com/free2z/zuu/pull/966) added
  [`docs/export-classification.md`](docs/export-classification.md), a per-app
  export-compliance record. It is a reviewed written record, not evidence of a
  filing or of any store's acceptance of one.
- [#971](https://github.com/free2z/zuu/pull/971) changed
  `wallet/plugins/tauri-plugin-f2zmsg/src/engine.rs` while fixing the fake
  relay's keepalive. ZUULI links that plugin for enrollment only and grants its
  webview no `f2zmsg:` permission, so this changes the crate ZUULI builds
  without changing anything ZUULI can reach.
- [#976](https://github.com/free2z/zuu/pull/976) is the build-21 identity
  itself, described above.
- [#979](https://github.com/free2z/zuu/pull/979) deleted the dead content-API
  client layer the previous anchor recorded as residual: the profile, AI,
  articles, comments, live and KYC clients, the livestream/subscription/search
  helpers, the `tuzi` subscription methods and the `discover` creator-page
  methods, with their fixtures, types and contract tests. `src/lib/api/` now
  holds only `checkout`, `donation`, `http`, `social-providers`, and the trimmed
  `free2z`/`mock-data`/`types`. This removes unreachable code; it proves nothing
  new about the surfaces that remain.

- [#977](https://github.com/free2z/zuu/pull/977) added each app's separate
  `https://free2z.com/bridge/<app>/` App Link / Universal Link claim,
  regenerated Android filters and iOS associated-domain entitlements, and
  added mutation-sensitive association and release-identity checks. ZUULI's
  OAuth registration tests now distinguish its two existing custom-scheme
  routes from the third, domain-bound bridge route. This is client
  registration evidence only: it neither supplies bridge transport nor proves
  OS verification or an OAuth round trip on a signed device. The serving-side
  deployment and device verification remain tracked in
  [#461](https://github.com/free2z/zuu/issues/461).
- [#985](https://github.com/free2z/zuu/pull/985) advanced E2E2Z's release
  identity to `0.1.0+3`; that is separate from ZUULI's build 21.
- [#978](https://github.com/free2z/zuu/pull/978) installed shared local
  diagnostics capture in all three apps. ZUULI now records window errors,
  unhandled rejections, bootstrap failures and error-boundary failures into a
  bounded store, with localStorage persistence when available. Its About
  feedback composer still attaches no diagnostics and has no diagnostics
  screen; E2E2Z alone gained the screen. This changes ZUULI's runtime data
  handling even though it adds no ZUULI UI or upload path. The shared
  redactor runs before storage, but short ordinary prose can survive, so
  error messages must not interpolate sensitive user content. Native panic
  capture remains separate work in [#980](https://github.com/free2z/zuu/issues/980).

**What is committed alongside this re-derive and is therefore *not* in the
anchor:** this document, and the `STATUS_DOCUMENT_SHA256` re-pin in
`scripts/status-freshness.mjs` that seals it. Nothing else.

Gate evidence at this anchor is complete for the jobs recorded in its own
push-triggered runs, checked on 2026-09-07:

- The [`wallet/zuuli` gate](https://github.com/free2z/zuu/actions/runs/34099238710)
  succeeded on this exact commit. Its frontend, both delegated-surface suites,
  ZUULI backend, shared and messaging plugins, Android 32-bit, formatting,
  supply-chain, Linux/Android and Apple/Windows crypto targets, and native
  macOS/Windows lint and test jobs succeeded. Only the Zuuallet schema-freshness
  job was skipped.
- The [`rs` gate](https://github.com/free2z/zuu/actions/runs/34099238836)
  and the separate [`wallet/surfaces` run](https://github.com/free2z/zuu/actions/runs/34099238929)
  succeeded on this commit. The latter ran the Free2Z and E2E2Z Rust jobs;
  their frontend suites also ran inside the required ZUULI gate.
- [Packaging smoke](https://github.com/free2z/zuu/actions/runs/34099238883)
  succeeded on this commit: release identity, unsigned iOS target app,
  unsigned Android AAB, Linux packages, and macOS universal app. These are
  credential-free package builds, not signed-device observations.
- The [protected build-21 release](https://github.com/free2z/zuu/actions/runs/34086094245)
  at `7fe1b0a8` failed in `Pin immutable source`; every subsequent job was
  skipped. No release run was fired at this anchor.

These are source, test, and package-build evidence only. They add no
product-operation or physical-device evidence. Nothing in this anchor was
exercised on a physical device, and nothing in it has been built into a signed
artifact at all: the newest signed build remains `0.1.0+20`, which predates the
whole split. Build 20 was read back from both stores as recorded below; that is
distribution evidence for an app that no longer resembles this source.

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
| `macos-packaging` | macOS artifact SBOMs/bindings, labeled source inventory, and Keychain entitlement policy | `packaging-executed-protected-unexecuted` | `desktop-deferred` | Build 20's credential-free [macOS packaging job](https://github.com/free2z/zuu/actions/runs/33494458922/job/99813293260) succeeded through the Keychain/capture source policy, real package collection, DMG/ZIP scans, bindings, labeled source inventory, checksums/provenance, and upload. | `artifact-sbom.node-test.mjs` uses real ZIP and `hdiutil` DMG canaries. `macos-keychain-entitlements.node-test.mjs` rejects missing or altered app/team/keychain groups and, since #945, rejects a *reintroduced* `com.apple.security.device.camera` or `.audio-input` entitlement and any reintroduced camera or microphone usage description. Protected macOS system signing, notarization, and credential cleanup remain deliberately unexecuted while desktop shipping is deferred. |

## Source-and-runtime-backed matrix

| Surface | Real API/backend dependency | Native integration | Automated evidence | Production/native evidence | Current status and linked gaps |
|---|---|---|---|---|---|
| Runtime transport and content-security policy | Production bundle → `free2z.cash`; development proxy → staging | `tauri-plugin-http` is registered and selected for packaged non-dev Tauri; both capability files allow only `https://free2z.cash/*`, `https://*.free2z.cash/*` and `https://stage.free2z.cash/*` | The required `wallet/zuuli` gate, the separate delegated-surface Rust run, and four-target packaging smoke all succeeded on this exact anchor; the run links and job selection are recorded above. `csp-policy.mjs` and its `tests/csp-policy.pw.ts` browser suite load the packaged `src-tauri/tauri.conf.json` policy itself. [#943](https://github.com/free2z/zuu/pull/943) narrowed that policy to `img-src 'self' data:` with `media-src`, `worker-src`, `object-src` and `frame-src` at `'none'`, and `connect-src` limited to `'self'` plus the free2z origins | Signed-store and unsigned packages exist; no per-surface native HTTP success is recorded here | **Wired, not runtime-proven.** The CSP is now narrow because the surfaces that needed it wide were removed, not because a permissive policy was made safe. `#801`'s remote-image allowance and `blob:` `img-src` are **gone** with the reader that used them. |
| App shell, mobile navigation, and localization | None | Safe-area insets and the mobile tab bar are native-surface concerns | Playwright geometry suites at 320/360px cover the primary nav and the More sheet. [#869](https://github.com/free2z/zuu/pull/869) fixed a real defect: `DialogContent`'s variant-scoped `ltr:-translate-x-1/2` was not dropped by tailwind-merge when the sheet overrode it with an unprefixed `translate-x-0`, so once the entrance animation's effect was removed the base utility won and the sheet snapped to `translateX(-50%)` — dialog `left` at **-160 at 320px and -180 at 360px**, exactly `-width/2`, deterministically on every run. `navigation.pw.ts` now waits on the dialog's own `getAnimations()` instead of measuring mid-tween. [#863](https://github.com/free2z/zuu/pull/863) gives Sonner toasts safe-area-aware offsets that clear the whole mobile tab bar; [#861](https://github.com/free2z/zuu/pull/861) mirrors layout for RTL locales, isolates bidi identifiers, and adds a source-policy gate against physical-direction utilities | No signed build has been observed on a physical device at any viewport. All geometry evidence is headless browser measurement | **Source and browser-test evidence only; never device-confirmed.** [#943](https://github.com/free2z/zuu/pull/943) also shrank what the shell navigates to: the More sheet now holds **Log in and About**, because Articles, Messages, Profile and Revenue share are no longer this app's surfaces. The build-18/19 off-screen More-sheet defect is fixed in source and covered by a test proven to fail without the fix, and has **not** been confirmed on a device. Physical-device acceptance: [#331](https://github.com/free2z/zuu/issues/331), [#238](https://github.com/free2z/zuu/issues/238). |
| About & Feedback | None for the About row; the feedback handoff opens an external mail client or GitHub | Build identity is injected at bundle time from canonical `release.json`, the checked-out full source SHA, and the Tauri build platform; the OS opener performs the handoff | [#822](https://github.com/free2z/zuu/pull/822) binds version/build/channel/platform/source identity through release verification and artifact provenance, with drift, offline, clipboard, keyboard, screen-reader, and enlarged-text tests. [#823](https://github.com/free2z/zuu/pull/823) shows the complete outgoing subject and body before any handoff, keeps diagnostic attachment unavailable in the feedback composer, and scrubs wallet/auth/network/path/encoded-secret shapes at review and again before copy. [#868](https://github.com/free2z/zuu/pull/868) middle-truncates the commit SHA through the shared `truncateAddress()` helper instead of a head-only `slice(0, 12)`, scopes BIP-39 mnemonic detection explicitly to English and surfaces that limit in the composer copy, and fixes the regression where the new ellipsis matched the scrubber's own path shape and redacted every report. [#872](https://github.com/free2z/zuu/pull/872) binds the browser identity test to canonical `release.json` instead of a pinned build literal, so the test now actually asserts the binding `#822` claims — the literal matched only by coincidence of the current build and failed the required gate on the first release bump after it | No feedback report has been composed or sent from a signed build, and no build has been observed displaying its own identity on a device | **New visible surface in build 20; source and test evidence only.** The scrubber is a best-effort redactor over text the user can still edit before sending; it is not a guarantee, and non-English mnemonics are explicitly out of its detection scope and said so in the UI. Nothing here is device-proven. |
| Local diagnostics capture | No API, upload endpoint, or telemetry SDK | Browser/WebView error and rejection listeners; bootstrap and React boundary reporters; localStorage when available | `src/lib/diagnostics.test.ts` verifies ZUULI build identity and recovery-phrase redaction. Shared capture/redaction tests and E2E2Z's real-browser rejection, reload, and no-request controls cover the shared implementation; the exact-anchor frontend jobs passed | No signed ZUULI diagnostic capture or recovery has been observed | **Source/test evidence only.** #978 installs local capture; ZUULI has no diagnostic viewing/export UI and its feedback composer still refuses diagnostic attachment. Redaction bounds free text, does not guarantee all prose is secret-free, and must not substitute for safe error construction. Native panic capture: [#980](https://github.com/free2z/zuu/issues/980). |
| Username/password and TOTP sign-in | Knox Basic login, OTP status/login, and authenticated user endpoints | Token-backed HTTP; no special native plugin | Session-boundary, login-destination, component, and browser lifecycle tests | Anonymous protected reads returned HTTP 403; no successful production login is recorded | **Wired, not runtime-proven; not release-ready.** Server-side TOTP enforcement: [#369](https://github.com/free2z/zuu/issues/369). Token custody: [#377](https://github.com/free2z/zuu/issues/377). |
| Login/link with Zcash | `auth/zcash/challenge` and `auth/zcash/login` | The shared plugin supports local recovery-phrase restore and transparent-address Zcash Signed Message signing | Native atomic-restore/signing tests and frontend restore/challenge lifecycle tests exercise local contracts | No production restore → native signature → Knox session round trip is recorded | **Restore is implemented and contract-tested, but the login path is not runtime-proven.** Recovery-phrase restore landed in [#428](https://github.com/free2z/zuu/pull/428); external-wallet signing remains unsupported. Physical recovery ceremony: [#246](https://github.com/free2z/zuu/issues/246). Wallet/login identity choice: [#329](https://github.com/free2z/zuu/issues/329). This is not ZIP-304. |
| Social login/link | Provider discovery, authorization start, callback exchange, and authenticated user endpoints | Desktop loopback and mobile private-scheme OAuth transports exist. #977 adds a separate verified-link claim for `/bridge/zuuli/`; it does not migrate the OAuth callback | Strict discovery parsing, transport selection, attempt fencing, error/retry UI, and 320/360 browser tests cover the client contract; the live preflight fails closed before opening provider URLs | Both discovery endpoints answered anonymously with HTTP 200 on 2026-09-01. The web/desktop endpoint reports `x` with `configured: true`, `google` and `github` `configured: false`; the mobile endpoint returns all three `configured: false`. No OAuth round trip is recorded on any platform | **Client contract fixed; backend-dependent and not runtime-proven.** A provider is selectable on desktop/web; none is on mobile. A `configured` flag is not a login — no authorization start, callback exchange, or resulting session has been performed on any platform, so signed-device login/link proof remains blocked. Public client follow-up: [#403](https://github.com/free2z/zuu/issues/403). Claimed-HTTPS release proof: [#242](https://github.com/free2z/zuu/issues/242). Association binding: [#380](https://github.com/free2z/zuu/issues/380). |
| Wallet create/restore/sync/receive/send/history | Lightwalletd and librustzcash through the shared plugin | Real Tauri Zcash plugin is registered. [#805](https://github.com/free2z/zuu/pull/805) adds typed multi-wallet listing and switching through the ZUULI bridge and a new mobile capability, publishing inventory, active identity, and account-scoped data atomically and serializing concurrent switches | Plugin Rust tests, frontend wallet tests, and backend compilation run in CI. `#805` adds identity-store, bridge, lifecycle, concurrency, and fail-closed suites; the deterministic mock is what those exercise | Packages have built, but no signed-device create/restore/sync/receive/send record is checked into this repository. `#805` adds no device or lightwalletd evidence | **Wired, not runtime-proven; release stop until kick-the-tires evidence exists.** The identity store is a **foundation**: a switchable wallet inventory now exists in source and under test, and it has never selected a real account on a real device. Send confirmation integrity: [#368](https://github.com/free2z/zuu/issues/368). Preserved-wallet import: [#272](https://github.com/free2z/zuu/issues/272). |
| 2Z send/tip/membership, and the creator ZEC tip landing | Authenticated donation and subscription APIs; a ZEC tip is a wallet spend, not a 2Z charge | Native HTTP. The Wallet Send route still accepts a creator-tip route state and carries an alteration-detecting in-memory intent into the proposal/confirmation/execution path, locking the creator recipient and disclosing transparent-address privacy and memo limits | Donation and membership idempotency/reconciliation contract tests, plus the creator-tip unit and browser suites, including the fail-closed suites for missing, reloaded, changed, and wrong-network state | No production charge is recorded, and **no ZEC creator tip has ever been proposed or broadcast from a signed device** | **Contract-tested, not runtime-proven; the tip's originating surface is gone.** [#943](https://github.com/free2z/zuu/pull/943) removed the creator profile that issued the tip, so in a shipping ZUULI nothing can populate that route state and the landing route **always fails closed** — by design until [#905](https://github.com/free2z/zuu/issues/905) lands an authenticated issuer over a channel that is not a custom-scheme deep link ([#461](https://github.com/free2z/zuu/issues/461)). The 2Z send/membership tabs under `/wallet/fund` remain reachable and remain unproven. Follow versus paid membership: [#261](https://github.com/free2z/zuu/issues/261). Creator purchase integrity: [#336](https://github.com/free2z/zuu/issues/336). |
| Buy 2Z with card | Authenticated Stripe Checkout creation, hosted Checkout, signed webhook credit, and a server-controlled return bridge | Native OS opener is used in packaged apps; the exact `cash.free2z.zuuli://checkout/return` route is registered on iOS/Android and claimed through the authenticated server bridge | #400 added signed-out gating, exact HTTPS host validation, actionable failures, and opener tests | Anonymous production checkout returned HTTP 403; no signed-in staging/live charge or signed-build return is recorded | **Wired, not runtime-proven.** Native return is blocked on an unshipped backend dependency tracked internally, so no native return has been exercised against a live charge. Track the end-to-end path in [#388](https://github.com/free2z/zuu/issues/388) and exact charge/credit integrity in [#399](https://github.com/free2z/zuu/issues/399). |
| Buy 2Z with ZEC | Public pricing/quote plus wallet spend and backend settlement/credit | Wallet bridge exists; production settlement is intentionally disabled | Quote parsing and explicit browser-only demo-boundary tests | Pricing and an exact 100-2Z quote returned HTTP 200; no spend/settlement exists | **Mock/demo only for settlement; unavailable in release builds:** [#155](https://github.com/free2z/zuu/issues/155). A price quote is not a top-up. |
| 2Z Activity | Authenticated Stripe purchase ledger | Native HTTP | Parsing/UI tests do not prove a complete ledger | Protected endpoint returned HTTP 403 anonymously; authenticated ledger not exercised | **Known incomplete:** the endpoint is purchases-only and cannot substantiate tips/AI/PPV totals ([#172](https://github.com/free2z/zuu/issues/172)). |
| E2EE messaging (enrollment only; no frontend) | Relay, key-transparency, and MLS services under `rs/` | `wallet/plugins/tauri-plugin-f2zmsg` builds, its two-instance integration test drives two engines over a real relay, and `wallet/zuuli/src-tauri` links and registers it — but **no capability grants the webview any `f2zmsg:` permission**. The plugin stays registered because enrollment needs its engine and store, and enrollment is the one messaging operation that needs the wallet seed, which must never cross IPC (`src/messaging.rs`, ADR 0016) | The plugin's own crate gate runs in `zuuli.yml`; the app's gate additionally builds it into ZUULI for desktop, iOS and Android. `the_capability_set_refuses_plugin_commands_but_not_the_enrollment_trio` drives the shipping capability set through a mock webview and shows the two halves answering differently: `plugin:f2zmsg|…` is refused by the ACL before its body runs, with the refusal naming the `f2zmsg:` permissions ZUULI no longer grants, while the three app-crate enroll commands are still routed because `generate_handler!` does not consult the ACL at all. `shipping_capabilities_grant_no_messaging_permission` reads the same shipping artifact and asserts no `f2zmsg:` grant survives under any name, with a positive control on the Zcash grants | **None.** No enrollment and no message has ever been performed in a running ZUULI, and after the split there is no messaging UI in this app to perform one from | **Reachable only as an enrollment authority, and still not usable.** The surface moved to `wallet/e2e2z` ([#913](https://github.com/free2z/zuu/pull/913)); this app keeps the seed and the ability to issue a `DeviceCredential`, and nothing else. The shipping directory default is still `directory::NoDirectory`, which fails closed, because `KT.md` §12 has not decided the log identity, signing key, shipped witness list, or default *t*, so `start_conversation` on the shipped configuration refuses with `witness-threshold-unmet`. The residual risk that is written down rather than fixed: the enrollment trio is webview-reachable and, under [#367](https://github.com/free2z/zuu/issues/367), reachable from a frame that resolves as the main window; a hostile caller could submit an attacker-chosen handle or unenroll behind a confirmation string. Closing that is [#905](https://github.com/free2z/zuu/issues/905)'s job. Epic: [#305](https://github.com/free2z/zuu/issues/305). Do not describe ZUULI as having messaging. |
| Vault boundary: no remote content, no capture authority | None — that is the property | The packaged CSP, both capability files, the Android manifest, and the Apple entitlements and plists are all native-surface declarations | `csp-policy.mjs` with a `--self-test`, `surface-capability-authority.mjs`, `mobile-webview-authority.mjs`, `media-permission-manifests.node-test.mjs`, `android-device-catalog.node-test.mjs` and `macos-keychain-entitlements.mjs` each assert one half and each carries a negative control that fails on a reintroduced grant. The Rust IPC probe above proves the capability refusal at runtime rather than by re-reading JSON | The permission boundary is asserted against the **merged** manifest, not the source file: `zuuli-packaging.yml` checks AGP's merged manifest on every pull request and cross-checks the AAB member's bytes, and `zuuli-release.yml` re-checks it through `bundletool dump manifest` on the artifact that ships — the shape [#941](https://github.com/free2z/zuu/pull/941) established for e2e2z, with ZUULI's own reviewed list. Only `<uses-permission>` elements count, which is what tells a grant apart from a receiver's `android:permission` guard. No signed device has been observed installing without a camera or microphone prompt | **Source- and artifact-asserted; not device-observed.** After [#943](https://github.com/free2z/zuu/pull/943) and [#945](https://github.com/free2z/zuu/issues/945), ZUULI's own manifest declares `android.permission.INTERNET` and nothing else, and the *merged* manifest adds exactly three reviewed entries: `USE_BIOMETRIC`, which `ZcashPlugin.kt` uses to authenticate a `BiometricPrompt.CryptoObject` over the seed cipher; `androidx.biometric`'s `USE_FINGERPRINT`, which is unreachable at `minSdk 29` and is allowlisted rather than removed because it sits on the unlock path and removal needs a signed-device check ([#958](https://github.com/free2z/zuu/issues/958)); and `cash.free2z.zuuli.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, which `androidx.core` injects at API 33+ so dynamically registered receivers are not exported — app-scoped by its package prefix and signature-level, both checked in CI rather than assumed. `android.permission.DUMP` appears in the merged manifest too and is **not** a grant: it is the `android:permission` guard on `androidx.profileinstaller`'s `ProfileInstallReceiver`, and the CI assertion requires it to stay one. ZUULI additionally claims no macOS capture entitlement, ships no camera or microphone usage string, renders no remote or third-party content, and grants its webview no `f2zmsg:` permission. This row exists because the property is the product: every one of those is a grant on the process that holds the master seed ([#367](https://github.com/free2z/zuu/issues/367)). It has **not** been confirmed on a signed device that ZUULI installs and runs with no capture prompt and that wallet create/restore/send still work: [#238](https://github.com/free2z/zuu/issues/238). |
| Internal distribution and store presentation | GitHub release train, App Store Connect, and Google Play | Signed mobile bundles plus generated platform/store icons; desktop packages are built only by credential-free packaging smoke while desktop distribution is deferred | Release identity, icon/store validators, protected state machines, and all-target packaging are gated. The release-step execution table above records which protected and packaging-only paths have actually run. [#962](https://github.com/free2z/zuu/pull/962) added a certificate-against-profile signing preflight to `zuuli-release.yml`, held to option 2 of the release-step evidence policy by `scripts/verify-signing-identity.node-test.mjs`; [#966](https://github.com/free2z/zuu/pull/966) added [`docs/export-classification.md`](docs/export-classification.md), which is a written record and not a filing | Build 20's [TestFlight readback](https://github.com/free2z/zuu/actions/runs/33496768135) proved `uploaded`, `processed`, and `availableToInternalTesters`, `VALID`/`IN_BETA_TESTING`, and the exact internal-group relationship. Its [Play audit](https://github.com/free2z/zuu/actions/runs/33496770265) found the exact build 20 release present and destroyed the uncommitted audit edit. No physical-device acceptance or protected desktop execution is recorded, and the newest release run — build 21's — failed before entering any protected environment, so the `#962` preflight has never run | **Build 20 is confirmed in both mobile stores, and build 20 is not this app.** Build 21 is an identity in `release.json` with no artifact behind it. Build 20 predates the whole split, so what is confirmed in the stores is the pre-vault ZUULI. The listing copy and questionnaire notes were corrected in `#955` ([#946](https://github.com/free2z/zuu/issues/946)) and are in this anchor; **all 20 shipped screenshots — five device sets × `01-articles-fresh`, `02-semantic-search`, `03-article-reader`, `04-creator-profile` — still depict routes this app no longer mounts** and cannot be re-captured here, because `store-screenshot-contract.mjs`'s `CAPTURE_SHOTS` hard-codes those four routes and capture is pinned to a `linux/amd64` Playwright container. That is tracked in [#956](https://github.com/free2z/zuu/issues/956), not fixed. Store media [#387](https://github.com/free2z/zuu/issues/387), shipped-artifact dependency reconciliation [#379](https://github.com/free2z/zuu/issues/379), and physical installs [#238](https://github.com/free2z/zuu/issues/238) remain open. Play remains owner-selected Console email-list mode: [#296](https://github.com/free2z/zuu/issues/296). |

## Current production and distribution evidence

Safe unauthenticated requests were **re-run fresh for this anchor** on
2026-09-07 against the endpoints ZUULI's remaining surfaces actually reach, and
returned the following status and top-level contracts:

```text
GET  /api/auth/social/providers/             200  providers array (`x` `configured: true`)
GET  /api/auth/social/mobile/providers/      200  providers array (all `configured: false`)
GET  /api/auth/user/                         403  detail: authentication credentials were not provided
GET  /api/stripe/transactions/               403  detail: authentication credentials were not provided
GET  /api/stripe/create-checkout-session/    403  detail: authentication credentials were not provided
GET  /api/tuzis/my-subscriptions             403  detail: authentication credentials were not provided
```

The public content endpoints the previous anchor probed — `zpage`, `creator`,
`ai/models`, `dyte/public`, `pricing`, and `pricing/quote` — are **deliberately
absent from this list**. They are not endpoints this app calls any more, so
their availability is `wallet/free2z`'s evidence, not ZUULI's. The legacy client
functions and contract tests that still reached them at the previous anchor are
**gone** as of [#979](https://github.com/free2z/zuu/pull/979); `src/lib/api/`
now holds only what `auth`, `home` and `wallet` import.

The 403s prove only the anonymous access boundary; they do not prove any
authenticated success path. `/api/kyc/user-profile` and `/api/openai/prompt`
answered 403 anonymously as well, but ZUULI mounts neither surface any more, so
that is recorded as a fact about the backend rather than about this app.

The social-provider configuration is unchanged from the 2026-09-01 audit and was
re-confirmed by this probe. `/api/auth/social/providers/`, the web/desktop
endpoint, reports `x` with `configured: true`; `google` and `github` remain
`configured: false` there, and the mobile endpoint
`/api/auth/social/mobile/providers/` still returns all three as
`configured: false`. So a provider is selectable on desktop/web and none is on
mobile. A `configured` flag is a backend declaration, not a login: no
authorization start, callback exchange, or resulting session has been performed
on any platform, so this is not evidence that social login works.

Distribution evidence is narrower and explicit:

- [Protected release run 34086094245](https://github.com/free2z/zuu/actions/runs/34086094245)
  is the newest release run and it **failed**, on 2026-09-07, at `7fe1b0a8`.
  It stopped in `Pin immutable source` at
  `Verify exact source and release identity`, on this document's own staleness,
  before any build, signing, notarization, upload, tag, or store transaction.
  `0.1.0+21` is therefore an identity with **no artifact of any kind** behind
  it. It is also the reason the certificate-against-profile preflight added by
  [#962](https://github.com/free2z/zuu/pull/962) still has no executed
  evidence.
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
record yet demonstrates the full physical-device checklist for the surfaces this
app still has: wallet recovery/sync/spend, OAuth, card checkout, or ZEC top-up.
That checklist was re-derived for this audit and is still unmet: as of
2026-09-07, neither the repository nor the physical-device tracking issues record
a signed-device wallet operation. The AI-charging, Live-media and KYC-capture
items the previous anchor listed are not "still unmet" — those surfaces were
removed, so they are off this app's checklist rather than outstanding on it.

Every signed artifact named above predates the split. **Nothing in this anchor
has been packaged into a signed build, uploaded, or read back from any store**,
so the distribution evidence in this section is evidence about the pre-vault
ZUULI. The store listing copy was corrected in `#955` and is in this anchor; the
twenty shipped screenshots still show routes this source does not mount.

Read the "release stop" dispositions above for what they say. They bar calling
a surface **ready** and bar a public release; they have never barred an
internal build: builds 2 through 14 and builds 17 through 20 all reached
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
authentication, or wallet operation is merely mock-tested, source-wired,
packaged, uploaded, or listed. Supply the missing production and
native evidence, or remove/disable the visible affordance in the release build
and link the reviewed disposition here.
