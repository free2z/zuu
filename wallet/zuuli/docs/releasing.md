# Releasing ZUULI

ZUULI ships from one reviewed commit under one immutable identity. The current
identity is `0.1.0+1`: marketing version `0.1.0`, Apple build `1`, Android
`versionCode` `1`, and package/bundle identifier `cash.free2z.zuuli`.

`release.json` is the source of truth. `npm run release:verify` fails if the npm,
Cargo, Tauri, generated Xcode, or generated Gradle representation disagrees.
Never fix a release mismatch with Tauri's `--ignore-version-mismatches` switch.

The train pins Node `24.18.0`, Rust `1.88.0`, Java `21.0.12`, Xcode `26.6`,
Android SDK/build tools `36`/`36.0.0`, Android NDK `27.0.12077973`, Gradle
`8.14.3` with its distribution checksum, Fastlane `2.237.0` through a
checksum-bearing Bundler `4.0.3` lockfile, and Syft `1.50.0`. Action dependencies
are commit-SHA pinned. Upgrade these together in a reviewed dependency PR.

## One-time owner bootstrap

Apple and Google require the owner to create a new app record in their web
consoles. This is intentionally outside CI.

### App Store Connect (Corpora Inc)

1. In Certificates, Identifiers & Profiles, register the explicit App ID
   `cash.free2z.zuuli` under team `F9AV5HKF6N` and enable only the capabilities
   present in the committed entitlements.
2. In App Store Connect **Apps**, create `ZUULI` with that bundle ID. Record the
   SKU privately. App Store Connect API keys cannot create app records.
3. Create an App Store Connect API key with the Admin role so Xcode automatic
   provisioning can manage certificates and profiles. Save the `.p8`
   exactly once and record its key ID and issuer ID.
4. Create/download an App Store Connect distribution profile if automatic
   provisioning is not used. The protected CI lane uses Xcode automatic
   provisioning authenticated by the API key.
5. Add internal TestFlight testers and complete the export-compliance/beta
   metadata prompts after Apple processes the first upload.

### Google Play (Corpora)

1. In Play Console **All apps → Create app**, create `ZUULI` for
   `cash.free2z.zuuli`, accept Play App Signing, and finish the mandatory app,
   policy, data-safety, and tester setup pages.
2. Generate a dedicated upload key, back it up offline, and retain the same key
   for future updates. Play App Signing protects the app-signing key; CI holds
   only the replaceable upload key.
3. Create a dedicated Google Cloud service account, enable the Android Publisher
   API, and grant that principal release permission to ZUULI only.
4. Google requires the first signed AAB to establish the package/signature in
   Play Console. Upload the locally produced AAB to the internal-testing release
   once; after that, the protected workflow performs uploads through the API.

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
paths, a partial Android signing setup, and dirty source trees.

Apple variables:

```text
APPLE_TEAM_ID
ASC_KEY_ID
ASC_ISSUER_ID
ASC_KEY_PATH                 path to the .p8 file
```

The Apple Distribution identity must already be present in the login Keychain.
Xcode may obtain the matching provisioning profile with the API key.

Android variables:

```text
ANDROID_KEYSTORE_PATH        path to the upload-key JKS
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
PLAY_SERVICE_ACCOUNT_JSON   path to the JSON file; upload only
```

From a clean, tagged worktree with locked dependencies installed:

```bash
npm ci
/opt/homebrew/opt/ruby/bin/bundle install # Android upload tooling on this Mac
npm run release:verify
scripts/mobile-release.sh ios
scripts/mobile-release.sh android
```

These commands sign and validate without uploading. To make the irreversible
store call, the release tag must point at `HEAD` and the exact identity must be
confirmed:

```bash
export ZUULI_CONFIRM_UPLOAD=0.1.0+1
scripts/mobile-release.sh ios --upload
scripts/mobile-release.sh android --upload
```

## Protected GitHub release

Create a GitHub environment named `zuuli-app-stores` and restrict deployments to
protected release tags. In founder mode the owner can dispatch it directly and
can admin-merge after every automated gate is green; add a required environment
approver when another operator is consistently available. Ordinary PR workflows
have read-only permissions and never reference this environment or its secrets.

Environment variables:

```text
APPLE_TEAM_ID
ASC_KEY_ID
ASC_ISSUER_ID
APPLE_DEVELOPER_ID_IDENTITY
```

Environment secrets:

```text
ASC_KEY_BASE64
APPLE_DISTRIBUTION_CERTIFICATE_BASE64
APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD
ANDROID_KEYSTORE_BASE64
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
PLAY_SERVICE_ACCOUNT_JSON_BASE64
APPLE_DEVELOPER_ID_CERTIFICATE_BASE64
APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD
```

The final two are needed only for direct-download macOS signing/notarization.
Base64 values are decoded only into mode-0700 runner-temporary directories and
destroyed even when a job fails. GitHub never exports store secrets into a PR.

1. Merge only with the required `gate` and `ZUULI / packaging smoke` green.
2. From a clean version worktree run
   `npm run release:bump -- --version=<VERSION> --build=<BUILD>`, review every
   generated change, run `npm run release:verify`, and merge the version PR.
3. Create an annotated (preferably signed) tag on that exact remote commit as
   `git tag -s zuuli-v<VERSION>+<BUILD> <SHA>` and push it. Signed uploads refuse
   a lightweight, missing, mismatched, or non-`origin/main` tag.
4. Dispatch **ZUULI / protected release** with the full 40-character commit SHA,
   exact identity, desired target, and `dry_run=true`.
5. Inspect the signed package, SBOM, checksum manifest, GitHub attestation, and
   App Store validation. Then select the release tag in the workflow's **Use
   workflow from** control and dispatch the same SHA/identity with
   `dry_run=false`. The tag selection is mandatory and lets environment branch
   policy protect the credential-bearing run.
6. Wait for App Store processing; assign the build to internal TestFlight.
   Confirm the Play internal release is available to the tester list.

Store build numbers are append-only. Signed packages are not bit-reproducible:
timestamps and signatures can change on a rebuild, while neither store permits a
different package to replace an uploaded version/build. Never change source under
an existing identity. After a partial failure, inspect both stores and the draft
GitHub release, then rerun only the missing target; an existing release asset is
accepted only when its checksum matches and is never overwritten. If an upload is
ambiguous or a different artifact is required, increment `build`, merge, tag, and
dispatch again.

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
