# Releasing ZUULI

ZUULI ships from one reviewed commit under one immutable identity. The current
identity is `0.1.0+8`: marketing version `0.1.0`, Apple build `8`, Android
`versionCode` `8`, and package/bundle identifier `cash.free2z.zuuli`.

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
   profile's team, application identifier, well-formed UUID, exact associated
   domain entitlement, and certificate linkage before it signs. Regenerating
   that named profile changes its UUID; the protected profile bytes and these
   identities, rather than one historical UUID, are the release boundary.
4. Add internal TestFlight testers and complete the beta metadata after Apple
   processes the first upload. The exempt-encryption declaration described below
   is embedded in each package; do not answer the same question differently in
   App Store Connect.

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

Internal tester eligibility is managed additively with the protected
`ZUULI / Play tester groups` workflow. Its default private group is
`zuuli-internal-testers-free2z@googlegroups.com`. The workflow shares the
mobile-store concurrency lane, preserves every existing Google Group, commits
the requested group through the Android Publisher API, and verifies the result
through a fresh edit. It accepts only lowercase `@googlegroups.com` addresses;
Play's API does not support Console email lists. Run the offline transaction
tests before changing this path:

```bash
npm run test:play-testers
```

Primary references:

- Apple: https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/
- Apple distribution: https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases
- Android signing: https://developer.android.com/studio/publish/app-signing
- Google Publisher tracks: https://developers.google.com/android-publisher/tracks
- Tauri iOS/App Store: https://v2.tauri.app/distribute/app-store/
- Tauri Google Play: https://v2.tauri.app/distribute/google-play/

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
export ZUULI_CONFIRM_UPLOAD="$(jq -r '.version + "+" + (.build | tostring)' release.json)"
scripts/mobile-release.sh android --upload
```

These commands sign and validate without uploading. To make the irreversible
store call locally, the exact full `origin/main` source SHA and release identity
must both be confirmed:

```bash
export ZUULI_RELEASE_SOURCE_SHA="$(git rev-parse HEAD)"
export ZUULI_CONFIRM_UPLOAD=0.1.0+8
scripts/mobile-release.sh ios --upload
scripts/mobile-release.sh android --upload
```

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

1. Merge only with the required `gate` and `ZUULI / packaging smoke` green.
2. From a clean version worktree run
   `npm run release:bump -- --version=<VERSION> --build=<BUILD>`, review every
   generated change, run `npm run release:verify`, and merge the version PR.
3. A push to `main` that changes an existing `release.json` automatically pins
   the exact pushed SHA, proves that `build` strictly increased and `version`
   did not decrease, builds/signs both mobile artifacts, and uploads them to
   TestFlight and Play internal. Adding `release.json` for the first time is a
   no-upload baseline, so merging the release infrastructure itself is safe.
   Build `0.1.0+1` established the first Play internal release, and `0.1.0+2`
   confirmed repeatable Play delivery. Build `0.1.0+3` also reached Play
   internal, while its iOS job stopped before upload in Tauri's PKCS#12 import
   path. Build `0.1.0+4` proved the verified signing-keychain workaround by
   signing and exporting the iOS IPA, and it reached Play internal. Its iOS job
   stopped before verification/upload on a generated-plist ordering diff.
   Build `0.1.0+5` reached Play internal. Its iOS IPA signed, exported, and
   passed the local profile/signature verification, but Apple validation
   rejected the standalone `ZUULI.app/libapp.a` with error 90171 before upload.
   Build `0.1.0+6` keeps the Rust archive as a link-only input, removes it from
   Copy Bundle Resources, and makes both the generated-project contract and IPA
   verifier reject a future static-archive regression before Apple validation.
   It uploaded and processed successfully; App Store Connect initially marked it
   `MISSING_EXPORT_COMPLIANCE`, then moved it to `IN_BETA_TESTING` after the
   build-specific `usesNonExemptEncryption=false` answer. Build `0.1.0+7`
   persists that answer in the canonical and packaged iOS plists and makes the
   release contract, normalizer, and IPA inspection fail closed on drift. Its
   iOS upload succeeded, but its Android job failed before packaging an AAB
   because the plugin's app-data migration did not compile for the 32-bit
   armv7/i686 ABIs. Build `0.1.0+8` carries that Android compile fix along with
   the article image-rendering and media-host URL corrections; post-merge
   packaging on `main` is green for all four Android ABIs.
4. Inspect the signed packages, SBOMs, checksum manifests, and GitHub
   attestations. For a dry run or partial-failure recovery, dispatch **ZUULI /
   protected release** with the exact full SHA, identity, missing target, and
   the appropriate `dry_run` value. A real manual recovery requires the same
   exact-SHA and identity confirmations as automatic release: the SHA must be
   the commit that introduced that identity, and it must be monotonic relative
   to its first parent. It must also match the current `origin/main` release
   identity, so a superseded build cannot be recovered after a newer release.
   The initial `release.json` baseline is the only no-previous-identity
   exception. Desktop `dry_run=true` packaging does not load signing credentials
   or contact Apple's notarization service.
5. Optionally create an annotated (preferably signed) tag on that exact remote
   commit as `zuuli-v<VERSION>+<BUILD>`. If the matching tag exists before a
   manual recovery run, the workflow also maintains an idempotent draft GitHub
   release. Store upload authority does not depend on a tag.
6. Wait for App Store processing; assign the build to internal TestFlight.
   Confirm the Play internal release is available to the tester list.

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

Public production distribution also requires the claimed mobile OAuth release
gate documented in [`../../../docs/release/ZUULI-MOBILE-OAUTH.md`](../../../docs/release/ZUULI-MOBILE-OAUTH.md).
Run it against the exact immutable source commit being promoted; internal Play
and TestFlight candidates remain on the private transition until that gate and
the signed physical-device matrix pass.
