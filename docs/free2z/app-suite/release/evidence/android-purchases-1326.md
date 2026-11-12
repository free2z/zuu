# Free2Z #1326 local validation — 2026-11-12

This is implementation evidence, **not release-owner policy approval or
signed-device acceptance**. The decision record remains pending and public
Android distribution remains blocked.

Source base: `b4e3d79334b6ee56f0796776db6251e821d5dd4a`. The artifacts were
built from the #1326 working tree before commits; the implementation-file digest
below identifies those source contents. `release.json` is unchanged: `cash.free2z.free2z`,
`0.1.0+4`, minimum Android API 29. Native configuration pins NDK
`27.0.12077973`; the store workflow builds a universal unsigned AAB, then signs
in a separate protected job and verifies the signed payload. No signing or
upload job was run here. Tests used Linux, Node `24.18.1`, and repository Rust
`1.97.1`; Node is older than CI's `24.22.2` but in the documented Node 24 line.

## Checks and reproducible commands

Run npm commands in `wallet/free2z` and repository guards from the root.

| Check | Result / scope |
| --- | --- |
| `npm run typecheck`; `npm run typecheck:tests` | Passed. Includes the new browser tests and the `unavailable` gate variant. |
| Targeted Vitest: purchases/availability, auth paid-intent/action, checkout/native-return, i18n catalog/source policy, and bridge tests | 348 tests passed across 9 files. Covers real and mock public purchase helpers, direct request calls, encoded/absolute/query routes, stale intents, expired/server-refused claims, cancel/processing/credited receipt recovery, safe Unicode entitlement reads, unchanged non-Android checkout validation, and existing ZEC bridge authority/replay rules. |
| Playwright: `android-purchase-availability.pw.ts`, `ai-paid-intent.pw.ts`, `mobile-navigation.pw.ts` | 10 passed in the final sequential run (57.8s), including existing membership cancellation with renewal withheld. English/Spanish/French direct routes include funding, AI, creator, PPV and articles. Existing web AI login/back/abandonment and phone navigation retained. Browser native-flag simulation is UI evidence only. |
| `node --test scripts/{purchase-policy,release-path,ui-copy-truncation}.node-test.mjs` | 16 passed. Policy binding mutations detect removing the HTTP/opener wrapper, Android target selection, immutable flag, shared native inventory, or distribution blocker. These source alarms alone are not runtime proof. |
| `node scripts/test-purchase-policy-native.mjs` | Pinned Rust compiled the actual native predicate module: 2 runtime tests passed. Removing the quote rule and replacing `any` with fail-open `all` each failed the independent bypass assertions as expected. Temporary probe files/processes are removed by the script. This is a Linux predicate executable, not an Android app. |
| `node ../zuuli/scripts/surface-capability-authority.mjs` and its node tests | Live guard passed; 28 mutation/control tests passed. Existing no-wallet-authority and URL-scoped native HTTP capabilities remain unchanged. The existing “plugin not initialized” mutation now removes the initialization call inside the wrapper; its old exact unwrapped call no longer matched. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --test http_scope --no-default-features` | 7 passed using the actual plugin IPC dispatch, production restriction wrapper and real embedded ACL. Direct writes/quotes, alternative AI/translation/SDK/MCP paths, redirects, external billing launches and remote WebView navigation refused; receipts, safe Unicode identities, reconciliation/cancellation, ordinary reads and existing entitlements admitted. First run built from a fresh Linux target directory in 24m 51s. Android policy was forced on the host; no Android runtime/device claim. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | 3 passed: no own invoke handler, no privileged plugin, no cookie-jar feature. |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib --tests --no-deps -- -D warnings` | Passed, pinned Rust 1.97.1. Native commands above used `-j 2` and debug-info-off dev/test profile overrides to fit local disk; no shipping features or lockfiles changed. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`; `git diff --check` | Passed. |
| Project namespace and Markdown link guards | Passed with new documents staged: namespace census 5,601 tracked paths; Markdown guard checked 280 documents, 1,395 relative links and 560 heading anchors. New documents use the already registered Free2Z namespace. |

The wallet surface Playwright configuration discovers `tests/*.pw.ts` directly;
its protected `zuuli / surfaces (free2z)` job runs `npm test`. The new tests are
in that population, and `npm test` now also runs the production Android-target
asset verification. No Svelte browser spec or Svelte shard list changed. No
server API, OpenAPI contract, generated client, MCP schema or capability was
added or changed.

## Artifact classification and limits

The actual Android build was attempted, credential-free:

```sh
./node_modules/.bin/tauri android build --ci --aab -- --locked
```

It exited 1 **before compilation**:

```text
ANDROID_HOME not set, trying to locate Android SDK...
failed to ensure Android environment: Android SDK not found.
```

There is no local SDK/NDK, no installed Rust Android target, no signed-device
connection and no connected Play Console/Android Publisher tool in this session.
A read-only GitHub Actions artifact query for
`unsigned-free2z-android-0.1.0+4-b4e3d79334b6ee56f0796776db6251e821d5dd4a`
returned `total_count: 0`. This is a bounded exact-name lookup, not a claim that
no historical Android build exists. No signed store candidate was available to
inspect.

Only approximately 4 GB was available before the native host build; a full
SDK/NDK plus universal native build could not be provisioned in that space.
**No APK/AAB was produced or inspected. There is no APK/AAB hash to report.**
This limitation is not satisfied by the host tests below.

`TAURI_ENV_PLATFORM=android npm run build` did produce real production frontend
assets, with mock mode off. `npm run test:android-purchase-assets` drives those
built assets through Chromium and verifies `/ai` and replay-shaped `/fund`
remain unavailable **without** injecting the native flag. The test is also
wired into `npm test`. API calls are aborted by this artifact test so its wrong-
target negative control cannot contact a production backend.

The wrong-target artifact negative control builds with
`TAURI_ENV_PLATFORM=ios`, requires the Android route assertion to fail, then
restores and verifies the Android production assets. This is an asset-binding
negative control, not Android WebView/device proof.

Local build and test logs are retained as `/tmp/free2z-1326-*.log`. They contain
technical validation only. The final asset archive/hash and acceptance checklist are recorded below.

## External acceptance remains pending

1. Release-owner decision on current policies and the exact candidate artifact,
   with documented program eligibility/enrollment if an exception is proposed.
2. Actual unsigned Android artifact build/inspection on a provisioned runner,
   followed by signed-artifact identity/payload verification.
3. Signed physical-device acceptance for direct purchase routes, IPC and remote
   navigation, login/replay/recovery, existing membership cancellation/access,
   Unicode identities, ZEC wallet handoff and generic third-party UGC links.
4. Fresh private console readback resolving the historical draft-listing versus
   current source-identity discrepancy. Account identities remain private.

No store console setting, rating answer, integration enrollment, signing key,
release, or submission was changed. A local test pass cannot lift the public
Android distribution blocker.


## Final local artifact and checklist

- Artifact type: **Android-target production web assets only**, mock mode off;
  not an APK/AAB, not signed and not a store build.
- Local archive: `wallet/free2z/src-tauri/target/1326-evidence/android-target-production-assets.zip`.
- SHA-256: `fc0f66f919733a859a126af082d4917e5b359b6c008135cba4ad8e63c7e2b821`.
- Size: 3,401,526 bytes, 205 members. Source/asset file hashes and the digest
  algorithm are in the adjacent ignored local `source-and-assets.json`.
- Implementation-file digest (wallet files only, including untracked source):
  `cdbad31bfc836cab93669068edd0549c91ebc0689fda5e65a48d9dc47a02a4a6`.
  The base HEAD remains unchanged; this digest is not a Git commit or a trusted
  build-provenance attestation.
- Final `npm run test:android-purchase-assets`: production build passed and
  Chromium artifact test passed (1 test, 2.6s), with no native-flag injection.
  Static archive inspection additionally found the SDK purchase, AI gateway,
  economy purchase and zpage policy markers. Static strings alone are not the
  enforcement proof.
- Wrong-target control: the iOS-target assets failed specifically because the
  unavailable state was absent on `/ai`; restored Android assets passed.
- Cleanup verified: no task server listens on 1435/1436/1437, no owned Cargo or
  rustc process remains, and no native-probe temporary directory remains. No
  containers or volumes were created. The prepared checkout is retained.

Local acceptance:

- [x] Complete owning-app entrypoint inventory, including alternate raw API
  bridge paths and authenticated recovery, documented beside the decision.
- [x] Current official Google policy links and dated engineering interpretation.
- [x] Proposed unavailable default explicitly pending owner review; Android
  public distribution preflight blocked independently of store setup.
- [x] UI, API helpers, common transport, native HTTP/opener and navigation
  enforcement, with meaningful runtime, policy and binding negative controls.
- [x] English/Spanish/French routes, unchanged web login flows, separate ZEC tip
  controls and existing membership cancellation covered by browser tests.
- [x] Actual production Android-target frontend asset build and inspection.
- [ ] Android APK/AAB build and inspection — missing SDK/NDK/targets locally;
  exact-name existing-artifact lookup returned none.
- [ ] Release-owner policy selection and signed-device/store acceptance —
  external, unavailable here; **public Android distribution remains blocked**.
