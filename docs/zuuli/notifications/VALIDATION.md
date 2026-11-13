# #384 validation — 2026-11-13

Refs #384. Public activation, provider acceptance and physical-device evidence
remain OPEN. See [DECISION.md](./DECISION.md) for the proposed privacy/retention
policy and remaining acceptance criteria. No unlinkability, guaranteed wake or
server-side shielded-payment detection claim is made.

## Implementation and persistence checks

The native secure record now saves explicit consent, queue capabilities and an
absolute bootstrap expiry before requesting the OS token. Delayed token callbacks
signal Rust reconciliation without a second consent tap. The original bootstrap
token is retained across a lost registration reply; rotation follows acknowledgement.
A real HTTP fixture exercises that lost acknowledgement against the production
service, then proves rotation and revocation on the resulting queue.

Native disable atomically stores off, a cancellation revision and the disabled
serialized lease in one Keychain/Keystore record write. Save, clear and asynchronous
completions compare that revision; an old lease alone is never consent. Clear
preserves cancellation across restart. Tests include interrupted disable, failed
save, old off/lease representation, delayed callbacks, restart, denied permission,
expiry, replay, rotation ambiguity and real queue/HTTP privacy/abuse controls.

- Server/protocol/lifecycle tests: 19 passed, including the real-HTTP lost-reply
  case and eight native engine cases compiling the exact production source.
- Actual Kotlin `NotificationRecord.kt`: seven shared persisted-record fixtures
  passed under Kotlin 1.9.25/JVM with checksum-pinned compiler artifacts. This
  executes the production transition code; it does not execute Android Keystore
  or claim Android SDK/device acceptance. The same fixtures run against the
  production Swift Foundation transition code in the Apple CI lane.
- Focused frontend/locale/session/wallet-identity suite: 114 passed, one worker.
- Full project-boundary audit: passed across five projects, 532 source files,
  2,411 module references and three constrained production Vite builds after
  installing the sibling dependencies.
- Full shipping ZUULI Linux build: passed on Ubuntu 24.04.4 and Rust 1.97.1.
  The target began empty; a missing `Manager` import was fixed when the clean
  graph reached the wallet-deletion fence. Exact bounded build command:

```sh
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_OPT_LEVEL=0 \
CARGO_TARGET_DIR=/tmp/zuu384-r2-ship \
cargo build --locked --manifest-path wallet/zuuli/src-tauri/Cargo.toml \
  --config 'profile.dev.package."*".opt-level=0' \
  --config 'profile.dev.build-override.opt-level=0' -j2
```

This is an Ubuntu host build, not a container verdict. No compiler/toolchain pin,
shipping dependency version, advisory suppression or CI waiver changed.

The required native CI paths also compile the real notification Swift package
against the iOS SDK and the real Kotlin/Tauri/Firebase adapter against Android
SDK APIs, without signing, launch, provider enrollment or keys. Local SDKs are
unavailable, so those results are not claimed in advance. Required Android Rust
checking retains the pinned NDK 27.0.12077973/API-29 command binding.

## Broad validation

The first browser run was not green: 81 observed passes, 11 observed failures,
then stopped. It included a dirty-checkout About/source-SHA assertion and Chromium
resource errors/timeouts during concurrent builds. The source identity assertion
was preserved. Broad browser checks are being repeated serially on the committed
implementation, with their final verdict recorded separately below.

An initial concurrent locale source-policy run hit six original 5-second test
timeouts; its isolated rerun passed all 114 focused tests without changing any
assertion or timeout. Earlier disk-exhausted native attempts remain failed evidence,
not passing checks. The full shipping build and full boundary gaps are now closed.

Raw evidence is retained under `/tmp/zuu384-r2-*.log`, notably `shipping2.log`,
`core2.log`, `kotlin.log`, `frontend-tests2.log` and `boundary.log`. No raw provider
credentials, device tokens, signed-device artifact identifiers or account data
are published here.

## External acceptance still open

- Physical signed iOS/Android background delivery and OS/device/runtime evidence.
- Provider credentials, APNs entitlement/topic, Firebase resources and private
  no-log ingress acceptance; none was provisioned or uploaded here.
- OS permission/token/cold-start/logout/reset behavior and real secure-store
  execution; pure state and browser fixtures do not replace these checks.
- Privacy-owner acceptance of stable token, IP and timing correlation.
- A separately reviewed payment wake trigger/detection design. The service has
  no viewing key or other authority to detect shielded payments.

The PR must use Refs #384 and leave the issue open. Public enrollment and rollout
remain disabled; no real funds or real device pushes are used in this validation.
