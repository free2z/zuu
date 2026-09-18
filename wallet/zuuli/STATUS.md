# ZUULI product status

This is a release-readiness record, not a feature catalogue. A browser fixture,
compiled code path, successful package build, or store upload does **not** prove
that a product operation works. In this document, **production-observed** means
the non-mock path was actually exercised against `https://free2z.cash` or read
back from the named store. Authenticated, money-moving, and wallet operations
are not called working without recorded evidence from that path.

Last re-derived from `origin/main` at
`16fd11de731b7704b8619d7ae3e2ab2412683321` on 2026-09-18. Before a release,
update the evidence and disposition for every non-ready row; do not carry this
commit or date forward mechanically.

This audit supports the **existing internal TestFlight cohort**, tracked in
[#1010](https://github.com/free2z/zuu/issues/1010), and the two-tester internal
encrypted-chat test that is the "done" condition of
[#1022](https://github.com/free2z/zuu/issues/1022). It does not approve a public
release or a wider tester cohort. The row dispositions below retain the missing
authenticated and physical-device evidence explicitly. Internal builds are how
that evidence is collected; neither this audit nor the build supplies it.

**Read this before anything else**

On 2026-09-17 and 2026-09-18 the whole "start encrypted chat" product was
implemented and merged here, and its relay, key-transparency log, witness and
handle authority were deployed by the private backend. Nearly all of it is
covered by tests that run in the required gate, and the gate is green.

**None of it has ever run on a phone, and no signed build containing any of it
has ever been installed.** No enrollment, no directory publication, no message,
and no operating-system App Link delivery has been observed anywhere but a unit
test, an in-process loopback socket, or a relay harness on a CI runner. The
deployed log, relay and authority have never answered a shipped build. Producing
exactly that evidence is what this build is for. Nothing below may be read as
saying the flow works.

One thing is already known not to work. The deployed key-transparency log's
witness is **not cosigning**, so the bundled threshold of 1 is unmet and every
handle resolution refuses. Two testers cannot exchange a message until that is
fixed at the deployment, and it is fixed there, not here — see the directory
section below. Cutting these builds is still correct: the configuration points
at the log already, and cosignatures appear on new tree heads without a new
binary.

**Source re-derivation and its limits**

The previous marker named `737af8e840af2ac11641e03ab36e57f8e1071dba` on
2026-09-11. [#1017](https://github.com/free2z/zuu/pull/1017) recorded it for the
mechanical build-23 ceremony; the substantive audit behind it was
[#1015](https://github.com/free2z/zuu/pull/1015). This re-derivation compares
the complete merged tree at the marker above against that commit. Eleven commits
landed in between and **63 release-impacting paths changed** — the whole
messaging plugin, four new ZUULI backend modules, one new ZUULI frontend module,
the protected Android inspection step, and the release runbook. Each was
inspected. This is a substantive re-derivation, not an advanced marker.

- [#1019](https://github.com/free2z/zuu/pull/1019) makes ZUULI an **intent
  authority over a verified App Link**. `src-tauri/src/bridge.rs` is a new
  non-IPC transport registered in `setup()`: it accepts only
  `https://free2z.com/bridge/zuuli/#req=<hex>`, refuses a custom scheme, the
  `free2z.cash` host, a wrong path prefix, and anything in the **query**
  component, and it never parses what it carries. `src-tauri/src/intent.rs`
  gains `issue-device-credential`, which shows a native dialog, then performs
  the single in-process seed read and issues a `DeviceCredential`. The caller's
  validity window is advisory; ZUULI imposes its own backdate and lifetime. The
  reply address comes from a fixed `REGISTERED_CALLERS` table, never from the
  request, and every inbound call is `CallerTrust::Claimed`, so the dialog says
  the identity is **NOT CONFIRMED**. No certificate is registered, so an
  *attested* call is refused outright.
- [#1026](https://github.com/free2z/zuu/pull/1026) is the messaging activation
  (ADR 0017): a real `KtDirectory` with a pinned VRF key and reset authority, a
  `with_directory`/`with_default_relay` seam, `DirectoryEntry` submission from
  ZUULI carrying a Contract-C `HandleAssertion`, and one bundled file,
  `wallet/plugins/tauri-plugin-f2zmsg/internal-directory.conf`, as the only place
  a shipping build learns its log, witness, authority and relay.
- [#1027](https://github.com/free2z/zuu/pull/1027) requires the log to **vouch**
  the configured handle authority before the directory connects, pins the first
  verified policy, and latches the directory unusable if the log later stops
  vouching or vouches differently. It also seals the tree-head checkpoint into
  the device's own store, keyed under the device's secrets, so a missing
  checkpoint on a device that has already relied on the directory is
  `directory-state-invalid` rather than a silent trust-on-first-use.
- [#1028](https://github.com/free2z/zuu/pull/1028) adds
  `issue-device-credential-v2` (ADR 0017 §4.1), which publishes the device to
  the directory as part of issuing its credential, and one new app-crate
  command, `free2z_session_sync`, so the renderer can mirror the signed-in
  free2z session into a **write-only** native slot the intent authority reads.
  The order — plan, prompt, seed, assertion, submit — is pinned by a test, and
  everything at or after submission reports `Unavailable` rather than claiming
  nothing happened.
- [#1023](https://github.com/free2z/zuu/pull/1023) fixes the protected Android
  inspection that failed build 23; it is described in its own section below.
- [#1021](https://github.com/free2z/zuu/pull/1021) takes `rustls` past
  RUSTSEC-2026-0285 in all three wallet lockfiles.
  [#1029](https://github.com/free2z/zuu/pull/1029) takes `devalue` to 5.9.2 and
  touches no ZUULI or plugin file.
- [#1024](https://github.com/free2z/zuu/pull/1024) and
  [#1025](https://github.com/free2z/zuu/pull/1025) are the other half of the
  product — free2z's paid **Start encrypted chat** and e2e2z's chat-link route
  and "Enroll with ZUULI" — and change no file under `wallet/zuuli/` or
  `wallet/plugins/`. They matter here only because ZUULI is the authority they
  call.

**What the shipped ZUULI build gained, and what it did not**

No capability file changed. `src-tauri/capabilities/default.json` and
`mobile.json` are byte-identical to the previous audit, and
`shipping_capabilities_grant_no_messaging_permission` still reads the emitted
`capabilities.json` and finds no `f2zmsg:` grant under any name, with positive
controls on the Zcash grants. The packaged CSP, the Android manifest, the Apple
entitlements and the deep-link claims are likewise unchanged; the only
`tauri.conf.json` difference in the range is the build-23 identity.

What did change is the ungated app-crate command set. `generate_handler!`
consults no ACL, so these four are reachable from the webview and, under
[#367](https://github.com/free2z/zuu/issues/367), from a frame that resolves as
the main window: `f2zmsg_enrollment_status`, `f2zmsg_enroll`, `f2zmsg_unenroll`,
and now `free2z_session_sync`. `f2zmsg_enroll` additionally accepts a Knox token
and attempts directory publication. `free2z_session_sync` returns `()` and the
module carries a test that no command hands a token back out, so the widening is
that a caller reaching the invoke bridge can assert the wallet's session is
somebody else's — bounded by the publication ordering and the dialog, not by an
ACL. That is written down here rather than fixed; closing it is
[#905](https://github.com/free2z/zuu/issues/905)'s job. `frame-src` is `'none'`,
so the realistic attacker is an XSS in ZUULI's own origin.

The intent authority is **not** an IPC command. `intent.rs` reaches no invoke
handler, and a test reads `lib.rs` and fails if it ever does.

ZUULI still has no messaging UI: nothing under `wallet/zuuli/src/` mentions
`f2zmsg` or messaging. The one new frontend module is
`src/lib/auth/native-session.ts`, a session mirror.

**Build and execution evidence**

At this audit source the identities are ZUULI `0.1.0+23`, Free2Z `0.1.0+3`, and
E2E2Z `0.1.0+4`. These are independent app identities.

ZUULI build 23's protected release,
[run 34549813662](https://github.com/free2z/zuu/actions/runs/34549813662),
**delivered iOS and failed Android**. Its
[App Store validation and TestFlight job](https://github.com/free2z/zuu/actions/runs/34549813662/job/103112775184)
recorded all three transitions and emitted sanitized evidence on 2026-09-11 at
01:31:37 UTC: `uploaded`, `processed` and `availableToInternalTesters` all true,
build `c74a1089-9e47-4f6a-8deb-92b4f49bdd51` `VALID` / `IN_BETA_TESTING`,
`usesNonExemptEncryption: false`, related to the single internal-only group
`ZUULI Internal Testers` with the exact build relationship read back. **This is
the first signed, TestFlight-delivered ZUULI that post-dates the vault split**,
and it corrects the earlier record: what is on TestFlight is no longer only the
pre-vault build 20. It is still not device evidence — a processed build is a
build Apple accepted, not a build anybody ran.

Its
[Android signing job](https://github.com/free2z/zuu/actions/runs/34549813662/job/103115292958)
failed at `Inspect attested Android artifact without credentials`, before
signing or upload, so **no Play internal release exists for build 23**, and the
dependent Android provenance job and the immutable release index were skipped.
Play internal therefore still holds build 20. Build 21's protected run produced
no artifact, and build 22 failed at the profile UUID check.

Free2Z `0.1.0+3` and E2E2Z `0.1.0+4` were **not** delivered by their automatic
push runs. E2E2Z's push run
[34534687098](https://github.com/free2z/zuu/actions/runs/34534687098) stopped in
`Pin immutable source`, because a push resolves `target=mobile` and
`wallet/e2e2z/store-identity.json` still records
`google.playConsoleListing: "missing"`. Both builds were delivered by a manual
`workflow_dispatch` at `target=ios`
([e2e2z 34534721312](https://github.com/free2z/zuu/actions/runs/34534721312),
[free2z 34534723314](https://github.com/free2z/zuu/actions/runs/34534723314)),
each succeeding through `App Store validation and TestFlight`. Those workflows
upload; unlike ZUULI's they do **not** poll processing state or reconcile an
internal group, so internal-tester availability for a sibling build is an App
Store Connect action, not something a green job proves.

A separate GET-only App Store Connect readback on 2026-09-10 observed E2E2Z
`0.1.0+3` (app `6809219394`) and Free2Z `0.1.0+2` (app `6809219101`) as `VALID`,
`IN_BETA_TESTING`, unexpired and present in an internal group's build
relationship. That is distribution evidence for those earlier builds only, and
their groups do not grant access to every future build automatically.

The candidate tree's own CI is green. [#1028](https://github.com/free2z/zuu/pull/1028)'s
reviewed head passed the required
[wallet/zuuli gate](https://github.com/free2z/zuu/actions/runs/35291052572) and
the credential-free
[ZUULI packaging smoke](https://github.com/free2z/zuu/actions/runs/35291052403),
alongside [wallet/surfaces](https://github.com/free2z/zuu/actions/runs/35291052531)
and [rs](https://github.com/free2z/zuu/actions/runs/35291052485). A green gate
establishes only the checks it executed. It is not a package, not a signature,
and not a device.

**Automated evidence for the messaging work, and its exact boundary**

The messaging plugin has its own required job, `Rust / messaging plugin`, which
builds the **production** `f2z-relay` daemon and runs the plugin's tests against
it, then rebuilds at default features because what ships has no `relay-harness`,
then rejects generated-permission drift.
`two_instances_over_a_relay.rs::two_instances_exchange_messages_across_two_independent_relays`
drives two separate processes, each with its own store and device keys, through
real contact-queue, subscribe, send, read and acknowledge traffic and real MLS
private messages — with the **directory resolution substituted by a shared file**,
so it is not evidence about a key-transparency log.
`two_record_rollback_over_a_relay.rs` is the one test that runs against the
production relay daemon as a separate process.
`endpoint_before_credential.rs` covers the ADR 0017 §4.1 engine half against a
real relay socket. `engine_lifecycle.rs::first_contact_fails_closed_rather_than_resolving_an_unverified_key`
pins the `witness-threshold-unmet` refusal.

ZUULI's own directory-publication tests in `src-tauri/src/directory_publish.rs`
run against an **in-process loopback HTTP server**, not a deployed service: they
prove the Contract-C request carries no handle, that a plan discloses nothing
about the wallet, that no session means no request at all, that a handle
published under another identity is refused before anything is signed, and that
an assertion the log would refuse is caught before submission.

None of this is a deployed log, a deployed relay, a real handle authority, a
signed build, or a phone.

**The bundled directory configuration, and what it now points at**

`wallet/plugins/tauri-plugin-f2zmsg/internal-directory.conf` is compiled into
every build of the plugin, and both `wallet/zuuli/src-tauri` and
`wallet/e2e2z/src-tauri` link it. It is the only place a shipping build learns
which log, witness, handle authority and relay to use; there is no environment
or runtime override, by design, and a file with some placeholders and some real
values does **not compile**, because `build.rs` parses it with the runtime's own
grammar and fails the build of every crate that links the plugin.

Until this candidate it read `PLACEHOLDER` throughout, `bundled()` answered
`Unconfigured`, and the shipped engine kept `directory::NoDirectory` with no
relay. **That is no longer true.** [#1033](https://github.com/free2z/zuu/pull/1033)
fills it with the deployed internal values — log `https://kt.free2z.cash` with
`log_id` `05b5dc5aa07ecae55442b8b32b6b8bebcc6490031112caa30adefa84070dc7e9`, one
free2z-operated witness, `threshold = 1`, handle authority
`332e237e2f9db842905c2a6011f4d306824b2f33eef01686d5b29d69e843934f`, assertion
endpoint `https://free2z.cash/api/kt/handle-assertion/`, and relay
`wss://relay.free2z.cash/relay/v1` — and moves the fail-closed proof to a test
fixture, `src/internal_directory/placeholder.conf`, held to the shipped file's
key set so a new key cannot quietly narrow what is proven.

So these are the first ZUULI and e2e2z binaries configured to reach a production
service at all. That sentence is about configuration, not behaviour: no such
binary has been built, signed or installed.

The posture is deliberately weak and says so. free2z runs the log **and** its
only witness, so the configuration cannot assert independence: every `witness_pk`
is recorded as `independent: false`, the client reports zero independent
witnesses, and the "not independently witnessed" warning stays on screen. The
log is explicitly **disposable** and is wiped before any public launch — every
handle, entry and pin made against it dies with it. Wiping means a new genesis
key, hence a new `log_id`, plus listing the old key as retired; a reset under the
**same** key is refused as a rollback rather than absorbed.

**The deployed log's witness is not cosigning, and that blocks first contact.**
#1033 records zero cosignatures on every tree head the log served on 2026-09-17.
Re-checked independently for this audit on 2026-09-18 at 01:36 UTC:
`GET https://kt.free2z.cash/kt/v1/sth` returns a 314-byte bundle carrying the
bundled `log_id` and VRF key, whose trailing cosignature vector length is
**zero**. The bundled `threshold = 1` is therefore unmet, so `resolve_handle`
and `start_conversation` refuse with `witness-threshold-unmet` on these
configured builds exactly as they did on the unconfigured ones — for a different
reason, later in the flow, and entirely at the deployment's end. **Two internal
testers cannot exchange a message until `f2z-witness` posts cosignatures to that
log.** No check in this repository watches for that, and no change here can
supply it.

The correction this audit makes: the previous record said the shipping default
was `NoDirectory` because the log identity, signing key, witness list and
default *t* had not been decided. ADR 0017 decided them for one disposable
internal deployment, and the file now names them.

**Android self-permission inspection (#1023)**

Build 23's protected Android job greped bundletool's decoded manifest for the
**source** string `android:protectionLevel="signature"`. Bundletool never prints
that: aapt2 has already folded the flags into an integer, and the dump renders
`0x00000002`. The correct bundles of `0.1.0+22` and `0.1.0+23` were rejected by
that comparison ([#1016](https://github.com/free2z/zuu/issues/1016)).

[#1023](https://github.com/free2z/zuu/pull/1023) replaces the inline grep with
`scripts/android-self-permission.sh`, which accepts either rendering, converts
hex to an integer, and requires **exactly** the base `signature` value with no
flag bits — `privileged`, `development`, `appop` and `knownSigner` are rejected
rather than masked — and requires exactly one `<permission>` element, named
`<application-id>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. Thirteen fixtures
under `scripts/fixtures/android-self-permission/` are real
`bundletool dump manifest` and AGP merged-manifest output, and the positive
fixture is byte-identical to the build-22 dump quoted in #1016. The protected
job may not check out source, so `zuuli-release.yml` installs the checker from a
verbatim heredoc before any credential is materialized; a test parses the
workflow and asserts the heredoc equals the script byte-for-byte and that
install precedes inspection precedes signing. `zuuli-packaging.yml` now calls
the same script on AGP's merged manifest, so one rule covers both renderings.

This is a source-and-fixture fix under option 2 of the release-step evidence
policy. **No protected Android job has run since it merged**, so the fix has no
executed evidence, and Play internal remains at build 20 until one does.

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
| Runtime transport and content-security policy | Production bundle → `free2z.cash`; development proxy → staging | `tauri-plugin-http` is registered and selected for packaged non-dev Tauri; both capability files allow only `https://free2z.cash/*`, `https://*.free2z.cash/*` and `https://stage.free2z.cash/*` | Historical [#995 wallet-gate evidence](https://github.com/free2z/zuu/actions/runs/34191205336) and [packaging smoke](https://github.com/free2z/zuu/actions/runs/34191205364) cover the prior audited tree `44bee1a6`; the checks for merged `822721c6` are recorded above. `csp-policy.mjs` and its `tests/csp-policy.pw.ts` browser suite load the packaged `src-tauri/tauri.conf.json` policy itself. [#943](https://github.com/free2z/zuu/pull/943) narrowed that policy to `img-src 'self' data:` with `media-src`, `worker-src`, `object-src` and `frame-src` at `'none'`, and `connect-src` limited to `'self'` plus the free2z origins | Signed-store and unsigned packages exist; no per-surface native HTTP success is recorded here | **Wired, not runtime-proven.** The CSP is now narrow because the surfaces that needed it wide were removed, not because a permissive policy was made safe. `#801`'s remote-image allowance and `blob:` `img-src` are **gone** with the reader that used them. **2026-09-10 internal disposition:** Retain for internal observation; packaged production HTTP remains unproven. |
| App shell, mobile navigation, and localization | None | Safe-area insets and the mobile tab bar are native-surface concerns | Playwright geometry suites at 320/360px cover the primary nav and the More sheet. [#869](https://github.com/free2z/zuu/pull/869) fixed a real defect: `DialogContent`'s variant-scoped `ltr:-translate-x-1/2` was not dropped by tailwind-merge when the sheet overrode it with an unprefixed `translate-x-0`, so once the entrance animation's effect was removed the base utility won and the sheet snapped to `translateX(-50%)` — dialog `left` at **-160 at 320px and -180 at 360px**, exactly `-width/2`, deterministically on every run. `navigation.pw.ts` now waits on the dialog's own `getAnimations()` instead of measuring mid-tween. [#863](https://github.com/free2z/zuu/pull/863) gives Sonner toasts safe-area-aware offsets that clear the whole mobile tab bar; [#861](https://github.com/free2z/zuu/pull/861) mirrors layout for RTL locales, isolates bidi identifiers, and adds a source-policy gate against physical-direction utilities | No signed build has been observed on a physical device at any viewport. All geometry evidence is headless browser measurement | **Source and browser-test evidence only; never device-confirmed.** [#943](https://github.com/free2z/zuu/pull/943) also shrank what the shell navigates to: the More sheet now holds **Log in and About**, because Articles, Messages, Profile and Revenue share are no longer this app's surfaces. The build-18/19 off-screen More-sheet defect is fixed in source and covered by a test proven to fail without the fix, and has **not** been confirmed on a device. Physical-device acceptance: [#331](https://github.com/free2z/zuu/issues/331), [#238](https://github.com/free2z/zuu/issues/238). **2026-09-10 internal disposition:** Retain for internal device checks; browser geometry and locale tests are not device acceptance. |
| About & Feedback | None for the About row; the feedback handoff opens an external mail client or GitHub | Build identity is injected at bundle time from canonical `release.json`, the checked-out full source SHA, and the Tauri build platform; the OS opener performs the handoff | [#822](https://github.com/free2z/zuu/pull/822) binds version/build/channel/platform/source identity through release verification and artifact provenance, with drift, offline, clipboard, keyboard, screen-reader, and enlarged-text tests. [#823](https://github.com/free2z/zuu/pull/823) shows the complete outgoing subject and body before any handoff, keeps diagnostic attachment unavailable in the feedback composer, and scrubs wallet/auth/network/path/encoded-secret shapes at review and again before copy. [#868](https://github.com/free2z/zuu/pull/868) middle-truncates the commit SHA through the shared `truncateAddress()` helper instead of a head-only `slice(0, 12)`, scopes BIP-39 mnemonic detection explicitly to English and surfaces that limit in the composer copy, and fixes the regression where the new ellipsis matched the scrubber's own path shape and redacted every report. [#872](https://github.com/free2z/zuu/pull/872) binds the browser identity test to canonical `release.json` instead of a pinned build literal, so the test now actually asserts the binding `#822` claims — the literal matched only by coincidence of the current build and failed the required gate on the first release bump after it | No feedback report has been composed or sent from a signed build, and no build has been observed displaying its own identity on a device | **New visible surface in build 20; source and test evidence only.** The scrubber is a best-effort redactor over text the user can still edit before sending; it is not a guarantee, and non-English mnemonics are explicitly out of its detection scope and said so in the UI. Nothing here is device-proven. **2026-09-10 internal disposition:** Retain for internal identity/handoff checks without claiming a signed-device result. |
| Local diagnostics capture | No API, upload endpoint, or telemetry SDK | Browser/WebView error and rejection listeners; bootstrap and React boundary reporters; localStorage when available | `src/lib/diagnostics.test.ts` verifies ZUULI build identity and recovery-phrase redaction. Shared capture/redaction tests and E2E2Z's real-browser rejection, reload, and no-request controls cover the shared implementation; the historical frontend jobs passed on reviewed #995 head; the checks for merged `822721c6` are identified above | No signed ZUULI diagnostic capture or recovery has been observed | **Source/test evidence only.** #978 installs local capture; ZUULI has no diagnostic viewing/export UI and its feedback composer still refuses diagnostic attachment. Redaction bounds free text, does not guarantee all prose is secret-free, and must not substitute for safe error construction. Native panic capture: [#980](https://github.com/free2z/zuu/issues/980). **2026-09-10 internal disposition:** Retain local-only capture; no upload or signed-device recovery claim. |
| Username/password and TOTP sign-in | Knox Basic login, OTP status/login, and authenticated user endpoints | Token-backed HTTP; no special native plugin | Session-boundary, login-destination, component, and browser lifecycle tests | Anonymous protected reads returned HTTP 403; no successful production login is recorded | **Wired, not runtime-proven; not release-ready.** Server-side TOTP enforcement: [#369](https://github.com/free2z/zuu/issues/369). Token custody: [#377](https://github.com/free2z/zuu/issues/377). **2026-09-10 internal disposition:** Retain for internal authenticated testing; no successful login or TOTP enforcement is claimed. |
| Login/link with Zcash | `auth/zcash/challenge` and `auth/zcash/login` | The shared plugin supports local recovery-phrase restore and transparent-address Zcash Signed Message signing | Native atomic-restore/signing tests and frontend restore/challenge lifecycle tests exercise local contracts | No production restore → native signature → Knox session round trip is recorded | **Restore is implemented and contract-tested, but the login path is not runtime-proven.** Recovery-phrase restore landed in [#428](https://github.com/free2z/zuu/pull/428); external-wallet signing remains unsupported. Physical recovery ceremony: [#246](https://github.com/free2z/zuu/issues/246). Wallet/login identity choice: [#329](https://github.com/free2z/zuu/issues/329). This is not ZIP-304. **2026-09-10 internal disposition:** Retain for isolated internal recovery/sign-in testing; no production session is claimed. |
| Social login/link | Provider discovery, authorization start, callback exchange, and authenticated user endpoints | Desktop loopback and mobile private-scheme OAuth transports exist. #977 adds a separate verified-link claim for `/bridge/zuuli/`; it does not migrate the OAuth callback | Strict discovery parsing, transport selection, attempt fencing, error/retry UI, and 320/360 browser tests cover the client contract; the live preflight fails closed before opening provider URLs | Both discovery endpoints answered anonymously with HTTP 200 on 2026-09-10. The web/desktop endpoint reports `x` with `configured: true`, `google` and `github` `configured: false`; the mobile endpoint returns all three `configured: false`. No OAuth round trip is recorded on any platform | **Client contract fixed; backend-dependent and not runtime-proven.** A provider is selectable on desktop/web; none is on mobile. A `configured` flag is not a login — no authorization start, callback exchange, or resulting session has been performed on any platform, so signed-device login/link proof remains blocked. Public client follow-up: [#403](https://github.com/free2z/zuu/issues/403). Claimed-HTTPS release proof: [#242](https://github.com/free2z/zuu/issues/242). Association binding: [#380](https://github.com/free2z/zuu/issues/380). **2026-09-10 internal disposition:** Mobile providers remain unconfigured and unavailable; do not bypass discovery to expose one. |
| Wallet create/restore/sync/receive/send/history | Lightwalletd and librustzcash through the shared plugin | Real Tauri Zcash plugin is registered. [#805](https://github.com/free2z/zuu/pull/805) adds typed multi-wallet listing and switching through the ZUULI bridge and a new mobile capability, publishing inventory, active identity, and account-scoped data atomically and serializing concurrent switches | Plugin Rust tests, frontend wallet tests, and backend compilation run in CI. `#805` adds identity-store, bridge, lifecycle, concurrency, and fail-closed suites; the deterministic mock is what those exercise | Packages have built, but no signed-device create/restore/sync/receive/send record is checked into this repository. `#805` adds no device or lightwalletd evidence | **Wired, not runtime-proven; release stop until kick-the-tires evidence exists.** The identity store is a **foundation**: a switchable wallet inventory now exists in source and under test, and it has never selected a real account on a real device. Send confirmation integrity: [#368](https://github.com/free2z/zuu/issues/368). Preserved-wallet import: [#272](https://github.com/free2z/zuu/issues/272). **2026-09-10 internal disposition:** Retain for existing internal testers to collect #238 evidence; no cohort expansion or public readiness. |
| 2Z send/tip/membership, and the creator ZEC tip landing | Authenticated donation and subscription APIs; a ZEC tip is a wallet spend, not a 2Z charge | Native HTTP. The Wallet Send route still accepts a creator-tip route state and carries an alteration-detecting in-memory intent into the proposal/confirmation/execution path, locking the creator recipient and disclosing transparent-address privacy and memo limits | Donation and membership idempotency/reconciliation contract tests, plus the creator-tip unit and browser suites, including the fail-closed suites for missing, reloaded, changed, and wrong-network state | No production charge is recorded, and **no ZEC creator tip has ever been proposed or broadcast from a signed device** | **Contract-tested, not runtime-proven; the tip's originating surface is gone.** [#943](https://github.com/free2z/zuu/pull/943) removed the creator profile that issued the tip, so in a shipping ZUULI nothing can populate that route state and the landing route **always fails closed** — by design until [#905](https://github.com/free2z/zuu/issues/905) lands an authenticated issuer over a channel that is not a custom-scheme deep link (client association declarations from the closed [#461](https://github.com/free2z/zuu/issues/461) do not provide that transport). The 2Z send/membership tabs under `/wallet/fund` remain reachable and remain unproven. Follow versus paid membership: [#261](https://github.com/free2z/zuu/issues/261). Creator purchase integrity: [#336](https://github.com/free2z/zuu/issues/336). **2026-09-10 internal disposition:** Keep the creator-tip landing fail-closed; retain 2Z tabs as unproven internal paths. |
| Buy 2Z with card | Authenticated Stripe Checkout creation, hosted Checkout, signed webhook credit, and a server-controlled return bridge | Native OS opener is used in packaged apps; the exact `cash.free2z.zuuli://checkout/return` route is registered on iOS/Android and claimed through the authenticated server bridge | #400 added signed-out gating, exact HTTPS host validation, actionable failures, and opener tests | Anonymous production checkout returned HTTP 403; no signed-in staging/live charge or signed-build return is recorded | **Wired, not runtime-proven.** Backend deployment/enablement and signed-build charge/return evidence remain unverified. Track the end-to-end path in [#388](https://github.com/free2z/zuu/issues/388) and exact charge/credit integrity in [#399](https://github.com/free2z/zuu/issues/399). **2026-09-10 internal disposition:** Retain the guarded internal path; charge, credit and native return remain unverified. |
| Buy 2Z with ZEC | Public pricing/quote plus wallet spend and backend settlement/credit | Wallet bridge exists; production settlement is intentionally disabled | Quote parsing and explicit browser-only demo-boundary tests | Pricing and an exact 100-2Z quote returned HTTP 200; no spend/settlement exists | **Mock/demo only for settlement; unavailable in release builds:** [#155](https://github.com/free2z/zuu/issues/155). A price quote is not a top-up. **2026-09-10 internal disposition:** Keep release settlement disabled; do not present quote availability as a completed purchase. |
| 2Z Activity | Authenticated Stripe purchase ledger | Native HTTP | Parsing/UI tests do not prove a complete ledger | Protected endpoint returned HTTP 403 anonymously; authenticated ledger not exercised | **Known incomplete:** the endpoint is purchases-only and cannot substantiate tips/AI/PPV totals ([#172](https://github.com/free2z/zuu/issues/172)). **2026-09-10 internal disposition:** Retain the purchases-only experimental view; do not claim a complete ledger. |
| E2EE messaging (ZUULI as enrollment and intent authority; no frontend) | Relay, key-transparency log, handle authority, and MLS services under `rs/`, plus the free2z account API the Contract-C assertion is fetched from | `wallet/plugins/tauri-plugin-f2zmsg` builds, its two-instance integration test drives two engines over a real relay, and `wallet/zuuli/src-tauri` links and registers it — but **no capability grants the webview any `f2zmsg:` permission**, and neither capability file changed in this range. The plugin stays registered because enrollment needs its engine and store, and enrollment is the one messaging operation that needs the wallet seed, which must never cross IPC (`src/messaging.rs`, ADR 0016). [#1019](https://github.com/free2z/zuu/pull/1019) adds `src-tauri/src/bridge.rs`, a non-IPC App Link transport registered in `setup()`, and the `issue-device-credential` intent handler in `src-tauri/src/intent.rs`; [#1028](https://github.com/free2z/zuu/pull/1028) adds `issue-device-credential-v2`, which also publishes the device, and the write-only `free2z_session_sync` slot the authority reads a session from | `Rust / messaging plugin` is in the required gate: it builds the production `f2z-relay` daemon and runs the plugin's tests against it, then rebuilds at default features because what ships has no `relay-harness`. `two_instances_exchange_messages_across_two_independent_relays` drives two separate processes through real contact-queue, subscribe, send, read and acknowledge traffic and real MLS private messages — with **the directory substituted by a shared file**, so it says nothing about a key-transparency log. `two_record_rollback_over_a_relay.rs` is the one test that runs the production relay daemon as a separate process. `endpoint_before_credential.rs` covers the ADR 0017 §4.1 engine half. `first_contact_fails_closed_rather_than_resolving_an_unverified_key` pins the `witness-threshold-unmet` refusal. ZUULI's `directory_publish.rs` tests run against an **in-process loopback HTTP server**: a plan discloses nothing about the wallet, no session means no request at all, a handle published under another identity is refused before anything is signed, and an assertion the log would refuse is caught before submission. `the_capability_set_refuses_plugin_commands_but_not_the_enrollment_trio` and `shipping_capabilities_grant_no_messaging_permission` still hold; `the_intent_authority_is_not_reachable_from_the_webview` reads `lib.rs` and fails if `intent.rs` ever reaches the invoke handler | **None.** No enrollment, no directory publication, no message, and no operating-system App Link delivery has ever been performed by a running ZUULI. The deployed relay, log and handle authority have never answered a shipped build. There is still no messaging UI in this app to perform one from | **Implemented, gate-covered, and completely unexercised.** The surface moved to `wallet/e2e2z` ([#913](https://github.com/free2z/zuu/pull/913)); this app keeps the seed, issues `DeviceCredential`s, and now publishes a device to the directory on the caller's behalf. **The shipping build is now configured**: [#1033](https://github.com/free2z/zuu/pull/1033) fills `wallet/plugins/tauri-plugin-f2zmsg/internal-directory.conf` with the deployed log, its single free2z-operated witness, the handle authority and the relay, so a binary built from this source connects somewhere instead of failing closed on configuration. It still refuses `start_conversation`, for a new reason: the deployed log's tree heads carry **zero witness cosignatures**, independently re-checked on 2026-09-18, so the bundled `threshold = 1` is unmet and resolution answers `witness-threshold-unmet`. That is a deployment fix, not a change here, and it blocks the two-tester run. The posture is weak by construction and says so: free2z runs the log and its only witness, every witness is recorded as `independent: false`, the client reports zero independent witnesses, and the "not independently witnessed" warning stays on screen. The log is disposable and is wiped before any public launch. [#1027](https://github.com/free2z/zuu/pull/1027) makes the log's vouching of the handle authority mandatory, pins the first verified policy, and latches the directory unusable if the log later contradicts it; the tree head is sealed into the device's own store, so a missing checkpoint on a device that already relied on the directory is `directory-state-invalid`, never a silent trust-on-first-use. The residual risk that is written down rather than fixed has **grown**: the ungated app-crate set is now four commands — `f2zmsg_enrollment_status`, `f2zmsg_enroll`, `f2zmsg_unenroll`, `free2z_session_sync` — all webview-reachable and, under [#367](https://github.com/free2z/zuu/issues/367), reachable from a frame that resolves as the main window, and `f2zmsg_enroll` now also carries a Knox token and attempts publication. Closing that is [#905](https://github.com/free2z/zuu/issues/905)'s job. Epic: [#305](https://github.com/free2z/zuu/issues/305), this cut: [#1022](https://github.com/free2z/zuu/issues/1022). Do not describe ZUULI as having messaging, and do not describe the chat flow as working. **2026-09-18 internal disposition:** Ship it to the internal cohort to collect the missing device evidence; keep messaging absent from ZUULI's UI, keep the directory disposable, and claim nothing until two testers have exchanged a message on real phones. |
| Vault boundary: no remote content, no capture authority | None — that is the property | The packaged CSP, both capability files, the Android manifest, and the Apple entitlements and plists are all native-surface declarations | `csp-policy.mjs` with a `--self-test`, `surface-capability-authority.mjs`, `mobile-webview-authority.mjs`, `media-permission-manifests.node-test.mjs`, `android-device-catalog.node-test.mjs` and `macos-keychain-entitlements.mjs` each assert one half and each carries a negative control that fails on a reintroduced grant. The Rust IPC probe above proves the capability refusal at runtime rather than by re-reading JSON | The permission boundary is asserted against the **merged** manifest, not the source file: `zuuli-packaging.yml` checks AGP's merged manifest on every pull request and cross-checks the AAB member's bytes, and `zuuli-release.yml` re-checks it through `bundletool dump manifest` on the artifact that ships — the shape [#941](https://github.com/free2z/zuu/pull/941) established for e2e2z, with ZUULI's own reviewed list. Only `<uses-permission>` elements count, which is what tells a grant apart from a receiver's `android:permission` guard. No signed device has been observed installing without a camera or microphone prompt | **Source- and artifact-asserted; not device-observed.** After [#943](https://github.com/free2z/zuu/pull/943) and [#945](https://github.com/free2z/zuu/issues/945), ZUULI's own manifest declares `android.permission.INTERNET` and nothing else, and the *merged* manifest adds exactly three reviewed entries: `USE_BIOMETRIC`, which `ZcashPlugin.kt` uses to authenticate a `BiometricPrompt.CryptoObject` over the seed cipher; `androidx.biometric`'s `USE_FINGERPRINT`, which is unreachable at `minSdk 29` and is allowlisted rather than removed because it sits on the unlock path and removal needs a signed-device check ([#958](https://github.com/free2z/zuu/issues/958)); and `cash.free2z.zuuli.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, which `androidx.core` injects at API 33+ so dynamically registered receivers are not exported — app-scoped by its package prefix and signature-level, both checked in CI rather than assumed. `android.permission.DUMP` appears in the merged manifest too and is **not** a grant: it is the `android:permission` guard on `androidx.profileinstaller`'s `ProfileInstallReceiver`, and the CI assertion requires it to stay one. ZUULI additionally claims no macOS capture entitlement, ships no camera or microphone usage string, renders no remote or third-party content, and grants its webview no `f2zmsg:` permission. This row exists because the property is the product: every one of those is a grant on the process that holds the master seed ([#367](https://github.com/free2z/zuu/issues/367)). It has **not** been confirmed on a signed device that ZUULI installs and runs with no capture prompt and that wallet create/restore/send still work: [#238](https://github.com/free2z/zuu/issues/238). **2026-09-10 internal disposition:** Retain the narrowed declarations and required artifact checks; device installation and wallet operation still need #238 evidence. |
| Internal distribution and store presentation | GitHub release train, App Store Connect, and Google Play | Signed mobile bundles plus generated platform/store icons; desktop packages are built only by credential-free packaging smoke while desktop distribution is deferred | Release identity, icon/store validators, protected state machines, and all-target packaging are gated. The release-step execution table above records which protected and packaging-only paths have actually run. [#962](https://github.com/free2z/zuu/pull/962) added a certificate-against-profile signing preflight to `zuuli-release.yml`, held to option 2 of the release-step evidence policy by `scripts/verify-signing-identity.node-test.mjs`; [#966](https://github.com/free2z/zuu/pull/966) added [`docs/export-classification.md`](docs/export-classification.md), which is a written record and not a filing; [#1023](https://github.com/free2z/zuu/pull/1023) replaced the protected Android permission grep with `scripts/android-self-permission.sh` and thirteen real bundletool/AGP fixtures, and a test asserts the workflow's installed heredoc copy is byte-identical to the script | Build 23's [App Store validation and TestFlight job](https://github.com/free2z/zuu/actions/runs/34549813662/job/103112775184) recorded `uploaded`, `processed` and `availableToInternalTesters` for build `c74a1089-9e47-4f6a-8deb-92b4f49bdd51`, `VALID`/`IN_BETA_TESTING`, `usesNonExemptEncryption: false`, with the exact relationship to the internal-only group read back. Its [Android job](https://github.com/free2z/zuu/actions/runs/34549813662/job/103115292958) failed at `Inspect attested Android artifact without credentials` before signing or upload. Build 20's [TestFlight readback](https://github.com/free2z/zuu/actions/runs/33496768135) and [Play audit](https://github.com/free2z/zuu/actions/runs/33496770265) remain the most recent store-side readbacks, and the Play one is still the latest Play evidence. No physical-device acceptance and no protected desktop execution is recorded | **iOS and Android are at different builds, and neither has been opened on a phone.** Build 23 is the first signed, TestFlight-delivered ZUULI that post-dates the vault split, so TestFlight no longer holds only the pre-vault app; **Play internal still holds build 20**, because builds 21, 22 and 23 all failed before a Play upload and #1023's fix has no executed protected evidence yet. Build 24 is the first candidate that can close that gap. The listing copy and questionnaire notes were corrected in `#955` ([#946](https://github.com/free2z/zuu/issues/946)); **all 20 shipped ZUULI screenshots still depict routes this app no longer mounts**, tracked in [#956](https://github.com/free2z/zuu/issues/956), not fixed. The sibling surface captures are stale in a second, newer way: `wallet/e2e2z`'s `unenrolled-native-v1` capture can no longer be reproduced at all, because the app now makes startup calls (`e2e2z_enrollment_status`, and the deep-link plugin's current-URL read) that the harness's fake native layer answers with `Unexpected native command`. That breaks a re-capture, not the gate — `validateSurfaceCaptureRecord` checks the committed record against the current **contract** digest, not current source, so `npm run test:store-listing` is green and no release path consults these records. Fixing it means extending the harness and re-capturing **both** surfaces, since they share the contract digest; [#1035](https://github.com/free2z/zuu/pull/1035) does exactly that, as a real two-pass capture in the pinned container rather than an edited digest, and is deliberately held until after this release because it is itself release-impacting. Store media [#387](https://github.com/free2z/zuu/issues/387), shipped-artifact dependency reconciliation [#379](https://github.com/free2z/zuu/issues/379), and physical installs [#238](https://github.com/free2z/zuu/issues/238) remain open. Play remains owner-selected Console email-list mode: [#296](https://github.com/free2z/zuu/issues/296). **2026-09-18 internal disposition:** Existing internal cohort only; keep public publication and cohort widening deferred, including both known screenshot mismatches. |

## Current production and distribution evidence

Safe unauthenticated requests were **re-run for this audit** on 2026-09-18 at
01:36:05 UTC against the endpoints ZUULI's remaining surfaces actually reach,
plus the newly deployed messaging services, and returned the following status
and top-level contracts:

```text
GET  /api/auth/social/providers/             200  providers array (`x` `configured: true`)
GET  /api/auth/social/mobile/providers/      200  providers array (all `configured: false`)
GET  /api/auth/user/                         403  detail: authentication credentials were not provided
GET  /api/stripe/transactions/               403  detail: authentication credentials were not provided
GET  /api/stripe/create-checkout-session/    403  detail: authentication credentials were not provided
GET  /api/tuzis/my-subscriptions             403  detail: authentication credentials were not provided
GET  /api/e2ee/authority/                    200  public_key/authority_id/log_id/validity_ms
GET  /api/e2ee/chat-requests/price/          403  detail: authentication credentials were not provided
GET  https://kt.free2z.cash/kt/v1/sth        200  application/octet-stream, 314 bytes
GET  https://free2z.com/.well-known/assetlinks.json  200  three-app statement list
```

The three messaging results are **new production evidence, and they are about
the servers, not about this app**. `/api/e2ee/authority/` answers with
`public_key` `332e237e2f9db842905c2a6011f4d306824b2f33eef01686d5b29d69e843934f`
and `log_id` `05b5dc5aa07ecae55442b8b32b6b8bebcc6490031112caa30adefa84070dc7e9`,
a 300-second assertion validity. The key-transparency log serves a 314-byte
signed tree head carrying that same `log_id` and the bundled VRF key — and a
cosignature vector of length **zero**, which is the blocker recorded above. `assetlinks.json`, which returned 503 at the previous audit,
now returns 200 and is **byte-identical** to the reviewed declaration in
`docs/intent-bridge/association/assetlinks.json` (SHA-256
`286e6580e699fe8b3659eb138afca59456c3fa7e0bbc990f8957733e6d0564d5`). A served
association file is a precondition for Android App Link verification, not proof
of it: no signed build has been installed, so **no operating system has been
observed verifying these links**, and the same is true of the iOS AASA. The
chat-request price endpoint requires authentication, so the anonymous 403 is
only its access boundary.

The public content endpoints older pre-vault audits probed — `zpage`, `creator`,
`ai/models`, `dyte/public`, `pricing`, and `pricing/quote` — are **deliberately
absent from this list**. They are not endpoints this app calls any more, so
their availability is `wallet/free2z`'s evidence, not ZUULI's. The legacy client
functions and contract tests that still reached them are
**gone** as of [#979](https://github.com/free2z/zuu/pull/979); `src/lib/api/`
now holds only what `auth`, `home` and `wallet` import.

The 403s prove only the anonymous access boundary; they do not prove any
authenticated success path. `/api/kyc/user-profile` and `/api/openai/prompt`
answered 403 anonymously in prior audits; they were not re-probed here. ZUULI
mounts neither surface any more, so that historical backend evidence is not a
claim about this app.

The social-provider configuration is unchanged from the 2026-09-10 audit and was
re-confirmed by this probe. `/api/auth/social/providers/`, the web/desktop
endpoint, reports `x` with `configured: true`; `google` and `github` remain
`configured: false` there, and the mobile endpoint
`/api/auth/social/mobile/providers/` still returns all three as
`configured: false`. So a provider is selectable on desktop/web and none is on
mobile. A `configured` flag is a backend declaration, not a login: no
authorization start, callback exchange, or resulting session has been performed
on any platform, so this is not evidence that social login works.

Distribution evidence is narrower and explicit:

- [Protected release run 34549813662](https://github.com/free2z/zuu/actions/runs/34549813662)
  built, signed and delivered `0.1.0+23` to **TestFlight** on 2026-09-11 from
  `8dc999b8252b22010aea3c81f239717849b9bc91`, and **failed on Android**. Pinned
  immutable source, both credential-free unsigned artifacts,
  `iOS / system export and signing`,
  `iOS / credential-free signed artifact verification`,
  `iOS / App Store validation and TestFlight` and
  `iOS / credential-free shipped-artifact provenance` all succeeded; the iOS job
  read back `uploaded`, `processed` and `availableToInternalTesters` for build
  `c74a1089-9e47-4f6a-8deb-92b4f49bdd51` at 01:31:37 UTC.
  `Android / protected sign and Play upload` failed at
  `Inspect attested Android artifact without credentials`, before signing or
  upload, so the Android provenance job and the immutable release index were
  skipped and **no Play internal release exists for build 23**. The cause is
  [#1016](https://github.com/free2z/zuu/issues/1016), fixed in source by
  [#1023](https://github.com/free2z/zuu/pull/1023) and not yet executed.
- [Protected release run 34540973883](https://github.com/free2z/zuu/actions/runs/34540973883)
  **failed** for `0.1.0+22` on 2026-09-10 at `05b5f39f`. It produced the
  credential-free unsigned iOS archive, then its
  [iOS signing job](https://github.com/free2z/zuu/actions/runs/34540973883/job/103086738097)
  stopped at 23:25:57 UTC with `unexpected provisioning-profile UUID`, after
  decoding the temporary credential files but before keychain creation,
  certificate import, signing or export. Credential cleanup passed. The profile
  pin was re-derived in [#1014](https://github.com/free2z/zuu/issues/1014) and
  [#1017](https://github.com/free2z/zuu/pull/1017); build 23's successful iOS
  signing and export is the executed evidence that the replacement profile and
  its certificate pair are correct.
- [Protected release run 34086094245](https://github.com/free2z/zuu/actions/runs/34086094245)(https://github.com/free2z/zuu/actions/runs/34086094245)
  **failed** on 2026-09-07 at `7fe1b0a8`; the later build-22 attempt is
  recorded above.
  It stopped in `Pin immutable source` at
  `Verify exact source and release identity`, on this document's own staleness,
  before any build, signing, notarization, upload, tag, or store transaction.
  That protected run produced **no artifact**. Later credential-free smoke
  packages carry `0.1.0+21`, as recorded above; they are not signed or
  store-distributed build-21 evidence. The protected run's early failure also
  explains why the certificate-against-profile preflight added by
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
- The historical TestFlight readback and store audit below cover build 20's exact
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
2026-09-18, neither the repository nor the physical-device tracking issue
[#238](https://github.com/free2z/zuu/issues/238) records a signed-device wallet
operation, and the encrypted-chat flow added since the previous audit starts
that same checklist from nothing. The AI-charging, Live-media and KYC-capture
items the older pre-vault audit listed are not "still unmet" — those surfaces were
removed, so they are off this app's checklist rather than outstanding on it.

Two things changed since the previous audit said that every signed ZUULI
artifact predated the split. Build 23 is signed, delivered and available to the
internal TestFlight group, and it post-dates the split — so **iOS internal
testers can now install a post-vault ZUULI**, while **Play internal still holds
the pre-vault build 20**. Nothing about either statement is device evidence: a
processed build is one Apple accepted, and a present Play release is one Google
stored. No install, no launch, and no wallet operation on a physical phone is
recorded for any build. The store listing copy was corrected in `#955`; the
twenty shipped ZUULI screenshots still show routes this source does not mount,
and `wallet/e2e2z`'s surface capture can no longer be reproduced at all — see
the distribution row above for why neither blocks this release.

Read the "release stop" dispositions above for what they say. They bar calling
a surface **ready** and bar a public release; they have never barred an
internal build: builds 2 through 14 and builds 17 through 20 all reached
TestFlight and Play Internal carrying them, 15 and 16 reached TestFlight
carrying them, and build 23 reached TestFlight carrying them. Internal
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
