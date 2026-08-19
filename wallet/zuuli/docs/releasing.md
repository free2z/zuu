# Releasing ZUULI

ZUULI ships from one reviewed commit under one immutable identity. Do not copy a
"current" version or build number from this runbook: read and verify the
canonical identity from the release source every time:

```bash
npm run release:verify
jq -er '.version + "+" + (.build | tostring)' release.json
```

The verifier prints the identity only after proving that the marketing version,
Apple build, Android `versionCode`, application identifier, and every other
generated representation agree.

`release.json` schema v2 is the source of truth. It must remain valid UTF-8 and
byte-canonical pretty-printed JSON; the verifier uses fatal UTF-8 decoding and
compares the original bytes with the canonical serialization, rejecting invalid
bytes plus duplicate or escaped property names before their last-value-wins
semantics can hide ambiguity. `npm run
release:verify` fails if the npm, Cargo, Tauri, generated Xcode, or generated
Gradle representation disagrees. Never fix a release mismatch with Tauri's
`--ignore-version-mismatches` switch. The same contract pins
`iosUsesNonExemptEncryption` to `false`; verification requires both the source
and generated iOS plists to carry the matching Boolean.

The train pins Node `24.18.0`, Rust `1.97.1`, Java `21.0.12`, Xcode `26.6`,
Android SDK/build tools `36`/`36.0.0`, Android NDK `27.0.12077973`, Gradle
`8.14.3` with its distribution checksum, Fastlane `2.237.0` through a
checksum-bearing Bundler `4.0.3` lockfile, and Syft `1.50.0`. Action dependencies
are commit-SHA pinned. Upgrade these together in a reviewed dependency PR.

## Build cache trust boundary

Packaging and protected release share target-specific Rust dependency caches so
reruns do not rebuild the entire Zcash graph. Cache identity includes the host,
Rust environment, Cargo manifests/lockfiles, and an explicit Xcode or Android
NDK/ABI discriminator in the action's effective `shared-key`. Cargo validates
its fingerprints when restored artifacts are used. The action prunes crates in
the configured `wallet/zuuli/src-tauri` workspace root before saving; path
dependencies outside that root, including the shared Zcash plugin and vendored
Zcash crates, may be restored when their fingerprints still match. Every final
package is freshly produced. Caches are an optimization, not release evidence
or a trust substitute; the cache-free canary proves the complete graph from
source.

Only credential-free `ZUULI / packaging smoke` pushes on `main` may save these
caches. Pull requests and manual runs restore only, preventing large native PR
entries from evicting the release families.
Protected release jobs explicitly restore without saving because their runners
later materialize signing and store credentials. Never cache `node_modules`,
frontend output, Gradle/Xcode native build trees, packages, `release-artifacts`,
provisioning profiles, Keychains, keystores, API keys, or runner-temporary
directories. `node scripts/verify-ci-cache-policy.mjs` enforces this topology.

The scheduled packaging run skips all Rust caches and rebuilds the Android,
iOS-device, Linux, and macOS release targets cold. Manual operators can dispatch
the same proof with `cold_rust_cache=true`. Pull-request cache entries are scoped
by GitHub to that PR merge ref; the cache cleanup workflow runs from trusted base
code when the PR closes and deletes only entries returned for that exact ref. A
daily recovery sweep handles missed close events and older npm/Gradle entries,
but deletes an entry only after its ref matches `refs/pull/<number>/merge` and GitHub's pull
request API confirms that exact PR is closed. Repository cache eviction may make
a release build cold, but must never affect correctness.

## One-time owner bootstrap

The owner has created both store records and the dedicated automation
principals. Their current state is recorded here so a fresh operator does not
repeat bootstrap work or substitute unrelated credentials.

### App Store Connect (Corpora Inc)

1. The explicit App ID `cash.free2z.zuuli` exists under team `F9AV5HKF6N`.
2. App Store Connect app `6799322201` is `ZUULI`, bundle
   `cash.free2z.zuuli`, SKU `zuuli-ios`, with `en-US` localization.
3. The protected environment contains the Admin ASC key, dedicated ZUULI Apple
   Distribution certificate, and profile `ZUULI App Store CI`. CI verifies the
   profile's team, application identifier, UUID, and certificate linkage before
   it signs.
4. Maintain exactly one internal TestFlight group named `ZUULI Internal Testers`.
   The name and internal-only requirement are fixed in
   `scripts/asc-testflight.mjs`; ordinary release and read-only recovery refuse
   a missing, duplicate, or external group. The protected bootstrap transaction
   below is the only automation allowed to create it. Group membership remains
   an owner-managed App Store Connect concern. Automation never reads or logs
   tester resources or email addresses. The exempt-encryption declaration
   described below is embedded in each package; do not answer the same question
   differently in App Store Connect.

### Google Play (Corpora)

1. In Play Console **All apps → Create app**, create `ZUULI` for
   `cash.free2z.zuuli`, accept Play App Signing, and finish the mandatory app,
   policy, data-safety, and tester setup pages.
2. Generate a dedicated upload key, back it up offline, and retain the same key
   for future updates. Play App Signing protects the app-signing key; CI holds
   only the replaceable upload key.
3. Create a dedicated Google Cloud service account, enable the Android Publisher
   API, and grant that principal release permission to ZUULI only. The dedicated
   principal is
   `corpan-play-verifier@corpora1.iam.gserviceaccount.com`; the release script
   rejects a different service-account document.
4. Let the protected workflow attempt the first signed AAB through the Publisher
   API. If Google returns its package-initialization blocker, upload that exact
   signed AAB to the internal-testing release once in Play Console; subsequent
   protected uploads use the API.

The Play app record already exists for `cash.free2z.zuuli`, and the dedicated
principal has been granted ZUULI admin access. Fastlane's Play JSON-key
validation succeeds for this account. Build `0.1.0+1` completed the first API
upload to the internal track, and `0.1.0+2` confirmed the repeatable protected
path. Subsequent protected releases use the same dedicated principal and upload
key. Do not weaken the account check or upload a debug key.

Internal tester eligibility remains in the owner-selected Play Console
email-list mode during 0.1.x testing (#296). No repository workflow adds,
migrates, or removes testers. The Publisher API cannot enumerate or manage the
Console email-list membership. The protected read-only store audit reports the
owner-declared mode and whether the API exposes a conflicting Google Groups
configuration, without emitting addresses or claiming email-list eligibility
was verified. Run the offline boundary tests before changing this path:

```bash
npm run test:store-listing
```

Primary references:

- Apple: https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/
- Apple distribution: https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases
- Apple exact-build query: https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds
- Apple internal-state values: https://developer.apple.com/documentation/appstoreconnectapi/internalbetastate
- Apple group relationship: https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betagroups-_id_-relationships-builds
- Android signing: https://developer.android.com/studio/publish/app-signing
- Google Publisher tracks: https://developers.google.com/android-publisher/tracks
- Tauri iOS/App Store: https://v2.tauri.app/distribute/app-store/
- Tauri Google Play: https://v2.tauri.app/distribute/google-play/

### Store listing source and protected audit

`store/manifest.json` and `store/locales/` are the canonical locale mapping,
proposed copy, classification proposals, and exact media contract. During Phase
A, `publicationReady` is false and every screenshot set is empty while #267,
#1257, and #255 complete. Run:

```bash
npm run store:validate
npm run test:store-listing
npm run store:validate -- --publish # must fail during Phase A
```

The protected `ZUULI / Store listing read-only audit` workflow compares current
App Store Connect and Play state with an exact current `main` source SHA. Apple
requests are GET-only. Google requires an ephemeral edit to read listings and
images; the audit always deletes it and never sends PUT or commit. Its evidence
contains locale/media counts and status booleans only—never remote copy, image
URLs, Google Group addresses, or tester identities. A provider failure still
uploads this sanitized evidence when available, including a fixed operation
stage such as `listings`, `internal-track`, or `images:phoneScreenshots`. Stages
come from a code allowlist, never a provider URL or response. If a primary audit
failure is followed by failure to delete its temporary Play edit, evidence also
sets `temporaryEditCleanupFailed: true` while retaining the primary stage. The
workflow then fails after credential cleanup; an artifact is not a successful
audit verdict.

The Publisher API does not expose Play Console email-list membership. An exact
empty `Testers` resource therefore means zero API-visible Google Groups, not
zero internal testers; the audit preserves the owner-declared email-list mode
and never reads or changes tester identities.

Dispatch only after the source has merged:

```bash
source_sha=$(git rev-parse origin/main)
gh workflow run zuuli-store-audit.yml --ref main \
  -f "source_sha=$source_sha" \
  -f provider=both
```

The public App Store lookup returning no record or the public Play page
returning 404 does not prove anything about protected/internal listing state.
Only the authenticated audit is authoritative. Its Play tester-mode result can
detect an API-visible Google Groups configuration but cannot enumerate Console
email-list membership; that limitation is part of the evidence, not success
claimed by inference.

`ZUULI / Store listing publication gate` is protected by the same serialized
environment. Phase A intentionally contains no store writer and no publication
credentials: exact current SHA, release identity, locale allowlist, offline
tests, and `--publish` validation all precede a terminal fail-closed stop. A
later reviewed screenshot/publication phase must add mocked provider writes and
fresh readback before that stop can be replaced. Never dispatch it as evidence
of publication while `publicationReady` is false.

## Local signed dry run

Credentials are paths or environment values; never paste a private key, service
account document, seed phrase, or password into a command line. Disable shell
tracing (`set +x`) before loading them. The scripts reject symlink credential
paths, a partial Android signing setup, and dirty source trees. Python 3 is a
release prerequisite: the standard-library plist verifier preserves duplicate
evidence that Apple's semantic plist tools discard.

Apple variables:

```text
APPLE_TEAM_ID
ASC_KEY_ID
ASC_ISSUER_ID
ASC_KEY_PATH                 path to the .p8 file
ZUULI_PREFLIGHT_KEYCHAIN     path to an unlocked, ephemeral signing keychain
IOS_MOBILE_PROVISION         base64-encoded ZUULI App Store CI profile
```

The protected release validates that the certificate, profile, team, and App ID
are linked, removes the decoded PKCS#12 file, and keeps the unlocked ephemeral
keychain in the user search list through Tauri and Xcode export. The import ACL
trusts only `codesign` and `xcodebuild`. Tauri receives only the provisioning
profile—not the distribution P12 and not the ASC API credentials—so Xcode signs
the archive directly and neither Tauri 2.11.4 PKCS#12-import path can run. This
avoids the path that could not read this dedicated P12 on macOS 26. The release
script rejects certificate variables and Tauri-facing `APPLE_API_*` variables,
proves the dedicated identity is still present and discoverable, prepares every
signing key that Tauri updates in a validated generated-project shape, then
restores the
committed Automatic-debug project byte-for-byte after the build. The resulting
IPA is unpacked and its exact embedded profile, distribution signature,
certificate linkage, signed entitlements, and packaged encryption declaration
are verified before Apple validation or upload. The plist verifier rejects
duplicate root keys before semantic decoding: it walks XML dictionary entries
directly and, for binary plists, inspects the raw object table and dictionary key
references. This matters because `plutil` and ordinary plist decoders collapse
duplicate keys and can disagree about which value wins. Both same-value and
conflicting duplicates are invalid; no binary duplicate ambiguity is accepted.
The workflow then restores the original keychain search list and fails if the
keychain, installed profile, or credential directory survives cleanup.

The implicit-format import regression is reported upstream as
[`tauri-apps/tauri#15843`](https://github.com/tauri-apps/tauri/issues/15843).
Remove this workaround only after the fixed Tauri release is upgraded here and
the protected path has proved the replacement import and cleanup behavior.

Android variables:

```text
ANDROID_KEYSTORE_PATH        path to the upload-key JKS
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
ANDROID_UPLOAD_CERT_SHA256   uppercase colon-delimited SHA-256 certificate fingerprint
PLAY_SERVICE_ACCOUNT_JSON   path to the JSON file; upload only
```

Keep both credential files outside the repository with owner-only permissions.
After installing the locked bundle below, verify the Play hook through its path;
the command does not print or copy the document:

```bash
chmod 600 "$PLAY_SERVICE_ACCOUNT_JSON"
FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec fastlane run \
  validate_play_store_json_key json_key:"$PLAY_SERVICE_ACCOUNT_JSON"
```

From a clean worktree at a commit on `origin/main`, with locked dependencies
installed:

```bash
npm ci
/opt/homebrew/opt/ruby/bin/bundle install # Android upload tooling on this Mac
npm run release:verify
scripts/mobile-release.sh ios
scripts/mobile-release.sh android
```

If and only if the Publisher API returns its first-package initialization
blocker, produce the signed AAB locally without granting that process upload
authority:

```bash
scripts/mobile-release.sh android
```

Then upload
`release-artifacts/ZUULI-<VERSION>+<BUILD>-android.aab` once through Play Console
to the internal track. Do not use the `z/hhanh00/zwallet/docker/*.jks` samples:
ZUULI needs its own backed-up upload key. After Google accepts that first
AAB, releases use the exact audited command:

```bash
export ZUULI_RELEASE_SOURCE_SHA="$(git rev-parse HEAD)"
export ZUULI_CONFIRM_UPLOAD="$(jq -er '.version + "+" + (.build | tostring)' release.json)"
scripts/mobile-release.sh android --upload
```

These commands sign and validate without uploading. To make the irreversible
store call locally, the exact full `origin/main` source SHA and release identity
must both be confirmed:

```bash
export ZUULI_RELEASE_SOURCE_SHA="$(git rev-parse HEAD)"
export ZUULI_CONFIRM_UPLOAD="$(jq -er '.version + "+" + (.build | tostring)' release.json)"
scripts/mobile-release.sh ios --upload
scripts/mobile-release.sh android --upload
```

The iOS upload command does not stop at Transporter acceptance. After `altool`
accepts the IPA, it polls the exact app `6799322201`, bundle
`cash.free2z.zuuli`, marketing version, iOS platform, and build number for at
most 45 minutes. It records `uploaded`, `processed`, and
`internal_group_available` as distinct transitions; invalid binaries,
processing exceptions, missing or contradictory export compliance, expired
builds, unknown states, duplicate exact identities, and bounded timeouts fail
with sanitized diagnostics. Once valid, it idempotently adds the build to
`ZUULI Internal Testers` only when absent and reads the group's build
relationship back before the protected job can succeed. The resulting
`ZUULI-<VERSION>+<BUILD>-testflight.json` is sanitized release evidence and
contains no tester resources.

## Protected GitHub release

The GitHub environment `zuuli-app-stores` holds the dedicated mobile signing and
store credentials. In founder mode it has no required reviewer or wait timer;
add a required environment approver when another operator is consistently
available. Ordinary PR workflows have read-only permissions and never reference
this environment or its secrets.

Environment variables:

```text
APPLE_TEAM_ID
ASC_KEY_ID
ASC_ISSUER_ID
ANDROID_UPLOAD_CERT_SHA256
APPLE_DEVELOPER_ID_IDENTITY
```

Environment secrets:

```text
ASC_KEY_BASE64
APPLE_DISTRIBUTION_CERTIFICATE_BASE64
APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD
APPLE_PROVISIONING_PROFILE_BASE64
ANDROID_KEYSTORE_BASE64
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
PLAY_SERVICE_ACCOUNT_JSON_BASE64
APPLE_DEVELOPER_ID_CERTIFICATE_BASE64
APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD
```

Create the protected environment before installing credentials. Feed the Play
JSON through standard input so neither the JSON nor its base64 encoding appears
in shell history or process arguments:

```bash
gh api --method PUT repos/free2z/zuu/environments/zuuli-app-stores \
  --input - <<<'{"wait_timer":0,"prevent_self_review":false}' >/dev/null
base64 < "$PLAY_SERVICE_ACCOUNT_JSON" | tr -d '\n' | \
  gh secret set PLAY_SERVICE_ACCOUNT_JSON_BASE64 \
    --repo free2z/zuu --env zuuli-app-stores
```

The final two are needed only for direct-download macOS signing/notarization.
Base64 values are decoded only into mode-0700 runner-temporary directories and
destroyed even when a job fails. GitHub never exports store secrets into a PR.

1. Re-derive [`../STATUS.md`](../STATUS.md) from the candidate source and current
   production/native evidence. Every visible **known broken/incomplete** path
   must either be fixed and evidenced or be removed/disabled for that target
   with its reviewed disposition linked in the matrix. Mock, compile, package,
   upload, and listing evidence cannot satisfy an operation that the matrix
   requires to run. Do not start promotion with a stale commit/date or an
   undispositioned non-ready row.
2. Merge only with the required `gate` and `ZUULI / packaging smoke` green.
3. From a clean version worktree run
   `npm run release:bump -- --version=<VERSION> --build=<BUILD>`, review every
   generated change, run `npm run release:verify`, and merge the version PR.
4. A push to `main` that changes an existing `release.json` automatically pins
   the exact pushed SHA, proves that `build` strictly increased and `version`
   did not decrease, builds/signs both mobile artifacts, and uploads them to
   TestFlight and Play internal. Adding `release.json` for the first time is a
   no-upload baseline, so merging the release infrastructure itself is safe.
   Do not infer the current identity or latest store state from a prose build
   narrative. The selected immutable milestones below explain prior release
   fixes; omission of a later build does not mean it does not exist. For a new
   release, read `release.json`, inspect that identity's exact protected run,
   and confirm both stores directly.

   | Identity | Durable protected-run evidence | Historical result |
   |---|---|---|
   | `0.1.0+2` | [run 31245152190](https://github.com/free2z/zuu/actions/runs/31245152190) | Play internal succeeded; iOS exposed the PKCS#12 import failure. |
   | `0.1.0+3` | [run 31248731230](https://github.com/free2z/zuu/actions/runs/31248731230) | Play internal succeeded; iOS again stopped before upload. |
   | `0.1.0+4` | [run 31253299730](https://github.com/free2z/zuu/actions/runs/31253299730) | Play internal succeeded; iOS signing/export passed, then generated-plist ordering failed. |
   | `0.1.0+5` | [run 31254971614](https://github.com/free2z/zuu/actions/runs/31254971614) | Play internal succeeded; Apple rejected a bundled static archive with error 90171. |
   | `0.1.0+6` | [run 31257912883](https://github.com/free2z/zuu/actions/runs/31257912883) | Both protected jobs succeeded after the static archive became link-only; App Store Connect required the build-specific exempt-encryption answer before beta testing. |
   | `0.1.0+7` | [run 31270095364](https://github.com/free2z/zuu/actions/runs/31270095364) | iOS upload succeeded with the declaration packaged; Android exposed the 32-bit app-data-migration compile error. |
   | `0.1.0+8` | [run 31293265075](https://github.com/free2z/zuu/actions/runs/31293265075) | Play internal succeeded and Apple accepted the iOS upload after the cross-ABI fix; the historical workflow did not prove TestFlight group availability. |
   | `0.1.0+9` | [run 31301302280](https://github.com/free2z/zuu/actions/runs/31301302280) | Play internal succeeded and Apple accepted the iOS upload; the historical workflow did not prove TestFlight group availability. |
   | `0.1.0+10` | [run 31323759501](https://github.com/free2z/zuu/actions/runs/31323759501) | Play internal succeeded and Apple accepted the iOS upload; use the protected read-only recovery below for current processing/group evidence. |

   Packaging is a separate credential-free signal. Query the
   [scheduled packaging runs](https://github.com/free2z/zuu/actions/workflows/zuuli-packaging.yml?query=event%3Aschedule)
   for the release commit instead of calling a fixed run "latest"; for example,
   [run 32006817573](https://github.com/free2z/zuu/actions/runs/32006817573)
   is the cache-free, all-target success recorded for the commit audited by
   issue #389.
5. Inspect the signed packages, SBOMs, checksum manifests, and GitHub
   attestations. For a dry run or partial-failure recovery, dispatch **ZUULI /
   protected release** with the exact full SHA, identity, missing target, and
   the appropriate `dry_run` value. A real manual recovery requires the same
   exact-SHA and identity confirmations as automatic release: the SHA must be
   the commit that introduced that identity, and it must be monotonic relative
   to its first parent. It must also match the current `origin/main` release
   identity, so a superseded build cannot be recovered after a newer release.
   The initial `release.json` baseline is the only no-previous-identity
   exception. This current-main restriction applies to a protected release that
   can rebuild or upload. The read-only TestFlight observation below
   intentionally accepts an exact identity-establishing SHA that remains on
   `main`, including a superseded build, because it cannot change App Store
   Connect. Desktop `dry_run=true` packaging does not load signing credentials or
   contact Apple's notarization service.
6. Optionally create an annotated (preferably signed) tag on that exact remote
   commit as `zuuli-v<VERSION>+<BUILD>`. If the matching tag exists before a
   manual recovery run, the workflow also maintains an idempotent draft GitHub
   release. Store upload authority does not depend on a tag.
7. Require the iOS job's sanitized state evidence to show all three Booleans:
   `uploaded`, `processed`, and `availableToInternalTesters`. A successful upload
   alone is not TestFlight delivery. Confirm the Play internal release is
   available to the tester list.

### Read-only TestFlight recovery

To inspect an already-uploaded build without rebuilding, re-uploading, or
changing App Store Connect, dispatch **ZUULI / TestFlight read-only recovery**
from `main`. For Build 10 use source
`6359bbe8ddbb23a5024383b1ce780a00b76c5e3f` and identity `0.1.0+10`. The workflow
requires that exact commit to be on `main` and to be the commit that established
the identity. It uses the protected ASC key only to read the fixed app, exact
build, TestFlight build detail, internal groups, and the configured group's
build relationship. The workflow has no ensure/upload option and never requests
tester resources.

The recovery succeeds only if the exact build is processed, export compliance
is resolved as the packaged `false` declaration, and the group relationship is
visible on a fresh read. If it reports `INTERNAL_GROUP_MISSING` for the current
release identity, use the protected bootstrap transaction below. Future uploads
then have no setup gap: the protected release performs the idempotent
relationship transaction and readback itself.

### Protected TestFlight group bootstrap

The one-time **ZUULI / TestFlight protected bootstrap** workflow is a narrowly
scoped write transaction for the current release identity. It requires the
exact identity-establishing commit to remain on `main`, requires that identity
to still equal `origin/main`'s current `release.json`, and runs the complete
offline mock suite before loading the protected ASC credential. It creates
`ZUULI Internal Testers` only after a fresh lookup proves the name absent, with
`isInternalGroup=true` and `hasAccessToAllBuilds=false`; a duplicate or external
group fails closed. A run makes at most one create request; an ambiguous response
switches permanently to bounded readback polling instead of risking a duplicate.
It then relates only the exact processed build and requires
fresh group and build-relationship readback. An ambiguous create or relationship
response is accepted only when that readback proves the requested state landed.
The workflow never requests tester membership or identities and emits only the
sanitized state evidence.

For Build 10, after the bootstrap workflow is merged and its required gate is
green, dispatch it once and then repeat the read-only proof:

```bash
gh workflow run zuuli-testflight-bootstrap.yml --repo free2z/zuu --ref main \
  -f source_sha=6359bbe8ddbb23a5024383b1ce780a00b76c5e3f \
  -f identity=0.1.0+10
gh workflow run zuuli-testflight-recovery.yml --repo free2z/zuu --ref main \
  -f source_sha=6359bbe8ddbb23a5024383b1ce780a00b76c5e3f \
  -f identity=0.1.0+10
```

The create contract follows Apple's [Create a Beta Group](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betagroups)
API and its required app relationship. Do not use this workflow for a superseded
identity; read-only recovery may still inspect historical builds.

Store build numbers are append-only. Signed packages are not bit-reproducible:
timestamps and signatures can change on a rebuild, while neither store permits a
different package to replace an uploaded version/build. Never change source under
an existing identity. Every protected store transaction shares one concurrency
lane across all identities, and GitHub's **rerun failed jobs** preserves
already-successful platform jobs. After a partial failure, inspect both stores
and the draft GitHub release, then
rerun only the missing target; an existing release asset is accepted only when
its checksum matches and is never overwritten. If an upload is ambiguous or a
different artifact is required, increment `build`, merge, and let the exact new
source run automatically.

## Kick-the-tires gate

Before widening either tester cohort:

- install TestFlight on a physical iPhone/iPad and Play internal on API 29 and a
  current Android device;
- create a new 24-word wallet, back it up offline, and prove restore in an
  isolated profile;
- migrate the legacy development wallet and compare its expected address;
- sync to tip, receive a tiny amount, restart during sync, send a tiny amount,
  and confirm the durable-send recovery UI after forced interruption;
- exercise Free2Z login/deep-link return, article playback, AI, and live media;
- verify denial paths for camera/microphone, offline startup, app upgrade with
  wallet data intact, and delete/reinstall behavior;
- record device/OS/build, checksums, transactions, failures, and stop/go decision
  on issue #238 without recording secrets or seed words.

Any seed-recovery, signing, wallet-consistency, store-validation, or ambiguous
broadcast failure stops promotion. Disable the workflow environment or remove
tester availability while investigating; never reuse that build identity for a
fix.

## Release records for cryptography

ZUULI contains cryptography; `ITSAppUsesNonExemptEncryption=false` means the app
uses only encryption exempt from Apple's documentation requirement, not that the
app uses no cryptography. The recorded basis for the current App Store answer is
that ZUULI's non-OS cryptography uses published, non-proprietary algorithms and
is limited to its Zcash wallet and financial-transaction functionality. Build 6
proved this answer through App Store Connect, and Build 7 makes it package data.

Apple directs apps that use no encryption *or only exempt encryption* to set the
Boolean to `NO`; omitting the key causes the export-compliance questions to recur
for each upload. Apple also says the developer remains responsible for the
classification and may have separate reporting obligations. See Apple's
[`ITSAppUsesNonExemptEncryption` property-list reference](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption),
[`Overview of export compliance`](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance),
and [`Complying with Encryption Export Regulations`](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations).

Re-evaluate this declaration before shipping any proprietary or non-standard
cryptography, or any material change to how encryption is used. Store
export-compliance checkboxes are declarations, not an export classification.
Before public production distribution, Corpora should retain a concise
export-classification memo covering the applicable EAR, encryption, and
mass-market analysis. Record the conclusion and supporting facts without
asserting a specific ECCN in this runbook.
