# ZUULI phone replacement and app-family recovery

Refs #1020. Real hardware acceptance remains **OPEN**, including #951. This is
not a closure record and no screen authorizes erasing the original phone.

## Supported ceremony and limitations before starting

Open Wallet → **Move to a new phone** (also available from wallet setup).
The new ceremony keeps words in the native plugin/Rust boundary, never in the
WebView, URL, diagnostics or a screenshot fixture. The pre-existing generic
create/restore/reveal screens still use their reviewed sensitive-entry/display
leases; this change does not claim to remove those existing DOM pathways.

There is no reviewed authenticated device-to-device transfer or portable encrypted
backup capsule in this repository. None is invented here. Quick Start, iCloud/
Finder restore, Android restore and Samsung Smart Switch are not wallet recovery.
Both Android and iPhone destinations use the same native mnemonic recovery path,
including cross-OS recovery. This requires entering the offline phrase; routine
seed-free migration remains unsupported. No seed, viewing key, device credential,
or hardware wrapping key is exported by the new commands. No cloud/escrow service,
backup password, cryptography, intent family, HTTP API or MCP authority is added.

1. **Old phone:** keep it working. Select each wallet separately. Read its
   discovery metadata, authenticate to view the phrase in the native dialog,
   write the words privately on paper, and keep the metadata with the offline
   record. Metadata contains addresses and transaction identifiers, so keep it
   private. It is an untrusted comparison record, not an authenticated backup.
   Authentication proves native custody can be read now; only a recovery on the
   destination checks the actual offline record. Never photograph the words.
2. **New phone:** install ZUULI and open the same screen. Enter the expected
   metadata and compare its network, ZIP32 account indices, birthdays and
   deterministic verification addresses with the trusted offline record. Consent
   opens native phrase entry. The library validates every expected address from
   the phrase before creating any wallet. Unsupported network/version, duplicate
   indices, malformed metadata, wrong phrases and unsupported account authority
   fail closed. Nonempty BIP39 passphrases and viewing-key-only/imported-key
   accounts without HD derivation are unsupported. The reviewed shipping custody
   and send callers require primary ZIP32 account zero; wallets without it
   refuse before import. Additional sparse HD accounts retain their exact indices.
   Import sorts by index to keep account zero primary even if the comparison
   record was reordered. Limits are 100 accounts and
   5,000 distinct nonexpired history identifiers per wallet. Larger inventories
   refuse, never truncate. The UI bounds metadata to 256 KiB.
3. **Restored app data:** if the wallet database is usable but native custody is
   missing, select that identity and recover custody in place. Account/address/
   birthday/history metadata must already match. The operation never clears the
   original database or pending-payment records. Android preserves the original
   encrypted seed record before an explicit replacement and never deletes or
   exports its Keystore key. A permanently invalidated Keystore key can still
   refuse replacement; retain that installation and use a clean destination.
   iOS reuses an identical authenticated native record or adds a missing record;
   it refuses to overwrite a different, corrupt or unreadable Keychain record.
   Preserve that record and use a clean destination.
   Before classifying orphaned custody, startup reinstates an exact protected
   publication journal when a published manifest rename was lost. Corrupt or
   unbound metadata never authorizes adoption or cleanup. A corrupt/unreadable
   wallet manifest or missing database is preserved and blocks creation/restore
   over that installation. Use the offline backup on a
   separate clean destination; do not clear app data to make the error disappear.
4. **Separate phrases:** repeat for every wallet/seed. “Add a separate identity”
   creates another wallet only after explicit native phrase entry. Existing
   matching seed authority is refused, so an interrupted response/restart/retry
   cannot silently add duplicate identities. Select the already-present wallet
   and recover in place. Account imports use librustzcash `import_account_hd`
   with their actual sparse ZIP32 indices and individual birthday tree states.
   The existing rollback journal, native write/readback, custody-protection step,
   atomic manifest publication and uncertain-durability handling remain in use.
5. **Destination check:** restart ZUULI. Enter the original expected metadata,
   compare each account and address, then authenticate for native verification.
   It derives every listed address, checks exact account/birthday inventory and
   original history inclusion, asks lightwalletd for a fresh tip, checks the
   local hash at that height, and requires fully scanned history, the native
   wallet summary, no scan ranges/transaction-data requests and no pending
   proposal/broadcast. Provider/HTTP/app-backup success is never recovery proof.
   Offline, incomplete scan and zero displayed balance never pass these gates.
   The result is transient and bound to the active wallet; navigation, wallet
   changes and reload discard it. It is not an erase authorization.
6. **External requirements:** on real devices verify restart/update, the recovery
   paper actually used, all balances/history, and an explicitly authorized test
   payment and its confirmed history. Resolve uncertain original payments using
   their existing retry/history workflow, without constructing another payment.
   Keep both installations and recovery records until all requirements have
   been independently checked. This implementation never deletes them.

**Old phone unavailable:** the correct offline phrase AND discovery inventory
are prerequisites for the verified ceremony. Without the phrase nobody here can
recover funds. Without metadata, the existing generic phrase restore can scan
account zero from Sapling activation, but cannot prove discovery of every account;
it must not be advertised as complete migration. Retain all available backups.

Account selection is explicitly ordered by ZIP32 derivation metadata. The backend
`get_account_ids()` query has no ordering contract and can enumerate its UUID
index, so creation order is not a primary-account guarantee. Custody validation,
account/address/balance/history readers and the existing fixed-send/send-all
production callers now agree on the same primary account. UI ordinals remain
separate from the actual ZIP32 indices in recovery metadata; UUIDs are not
portable identities. Ambiguous multi-seed derivations inside one database refuse
rather than selecting a different account's funds; separate seed identities use
separate wallets.

## Backup and custody audit

| Store | Android | iPhone | Recovery meaning |
| --- | --- | --- | --- |
| ZUULI seed | Nonexportable AndroidKeyStore AES-GCM key, user authentication, unlocked-device requirement; encrypted SharedPreferences only | `WhenUnlockedThisDeviceOnly` + user presence; `Synchronizable=false` | Does not migrate as custody; native phrase recovery required |
| ZUULI wallet SQLite, WAL/SHM, `wallets.json`, rollback/cleanup and pending-payment files | All backup and transfer domains excluded | Zcash native setup sets and reads back `isExcludedFromBackup` on app data root | Preserve original state. Missing/corrupt manifests block mutation; missing DBs are not recreated |
| Historical `.seeds` files and legacy Keychain records | Existing read-only recovery/migration support remains, under excluded app data | Existing native migration rules remain; weak legacy records may have different historical accessibility | Phone commands read native custody only and never migrate/delete recovery files |
| e2e2z / ZUULI messaging wrap key | Nonexportable Keystore AES-GCM; StrongBox→TEE→software as reported, no presence requirement for delivery | `AfterFirstUnlockThisDeviceOnly`, `Synchronizable=false`, no presence requirement | Key stays in its originating app and device. #951 lock/reboot/backing proof still OPEN |
| Messaging device/signature/init/queue secrets and credential | Engine seal under that app's `DeviceWrapKey`; Android all domains excluded | Engine store can be included in OS app-data backup outside ZUULI's excluded root, but its device wrap key cannot migrate | A copied seal is not a usable/enrolled device. No cloning or automatic new enrollment/reset |
| Messaging history/local drafts/queue state | Excluded by app backup and device-transfer rules | Local engine store may be copied by OS backup; wallet phrase does not recover its device keys | No supported portable messaging-history restore. Preserve original messaging install; do not overwrite its store |
| Free2Z/ZUULI account tokens, OAuth state, WebView local state | All domains excluded in all three apps | ZUULI native app data excluded; Free2Z WebView session data may be included by OS backup | Account authentication is separate. Sign in again/verify the server session; never infer wallet custody or messaging enrollment |

The three Android hosts already specify `allowBackup=false`, legacy
`fullBackupContent` and Android 12+ `dataExtractionRules`. Both `cloud-backup`
and `device-transfer` exclude root/file/database/sharedpref/external and all four
device-protected domains. The new parsed-XML tests exercise every exclusion and
negative controls, in the required frontend test command. No accessibility class
or hardware backing policy is weakened. OEM compliance (including Smart Switch)
requires physical observation; XML passing does not prove OEM behavior.

Official primary references checked for this change:
[Android backup/transfer rules](https://developer.android.com/identity/data/autobackup),
[Apple device-only Keychain class](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly),
[ZIP 32](https://zips.z.cash/zip-0032).
The dependency API used is the pinned librustzcash source, gitlink
`473543ce227332b8afd82a9edbf655c4bc4d7c50`; no dependency or compiler bump.

## Linked applications

Free2Z content-account authentication and wallet custody are independent. Log in
again on the destination; provider success says nothing about recovered funds.
Seed-derived messaging identity can be re-derived in ZUULI, but e2e2z's random
device identity, seal, credential, MLS state and message history cannot be cloned
by restoring that seed. Re-enroll a new e2e2z device through the existing
nonce-bound intent protocol, native ZUULI approval and verified credential/
directory receipt. Existing caller authentication and capability restrictions
remain unchanged. A restored locked e2e2z store must be preserved, not reset to
make a new enrollment succeed. Review old-device revocation separately; this
screen sends no revocation and makes no service/console changes. Availability
of deployed directory/relay and revocation UI remains governed by the app-suite
status and messaging contracts, not by this wallet recovery screen.

## Evidence and OPEN acceptance

Controlled Rust fixtures compile the shipping library without `cfg(test)` and
exercise real SQLite + ZIP32 import, sparse accounts, different birthdays,
address comparison, restart/reopen, duplicate-import refusal, wrong seed/network, reordered metadata and the primary-account invariant,
corrupt-manifest preservation, and a real received Orchard note/history view.
Browser fixtures test copy and fail-closed behavior only; they cannot verify
native dialogs, custody or funds. No screenshot/trace contains recovery words.
Constructor-level tests also exercise empty/lost manifests with present native
custody, a real protected publication journal and usable multi-account SQLite.
They verify exact identity recovery over two startups without custody reads or
mutations, duplicate identities or lost accounts. Corrupt manifests/journals
and unbound publication metadata preserve their original files and refuse
adoption. The exact local commands and outcomes are recorded in the
implementation handoff.

| Acceptance case | Status / evidence required |
| --- | --- |
| Android→Android, Samsung Smart Switch | **OPEN**: two real supported handsets, exact OS/app builds and sanitized outcomes |
| iPhone→iPhone, Quick Start and backup restore | **OPEN**: real iPhones and signed exact-build evidence |
| Android↔iPhone | Native phrase/ZIP32 path implemented; **OPEN** physical interoperability proof |
| Restored ciphertext without original key | Side-effect-free native metadata classification and actionable startup route implemented; **OPEN** actual restore reproduction |
| Multiple accounts/derivations/birthdays/history | Controlled compiled native fixtures; **OPEN** real devices/funds |
| Actual post-recovery test transaction | **OPEN**, requires separate explicit authorization; none attempted |
| Offline, interruption, restart, upgrade | Controlled startup/reopen/browser refusal coverage; **OPEN** signed-device lifecycle and upgrade cases |
| DeviceWrapKey hardware/accessibility | **OPEN**, #951; neither a Rust fixture nor a simulator proves it |
| Native Swift/Kotlin build/runtime | **OPEN** until supported SDK builds and real native UI execution are recorded |

Record device model, OS version, application version/build, source SHA and signed
artifact hash, migration method, each native check and the precise failure code.
Exclude recovery material, wallet contents, credentials and diagnostic dumps.

## Local implementation validation (2026-11-13)

Source base: `b4e3d79334b6ee56f0796776db6251e821d5dd4a` plus the
implementation commits on top of it. Host: Ubuntu 24.04.4, Rust 1.97.1. No signed mobile
artifact was produced. Neither `xcrun` nor `sdkmanager`/an Android SDK is
available on this host; native Swift/Kotlin compilation and physical execution
remain OPEN. Linux compilation is not mobile compilation evidence.

- The final complete plugin library regression run passed **152 tests**
  against this implementation, including the existing send/retry/unknown-outcome
  and sync-supervisor coverage. The complete final `--all-targets` run also
  passed all **8 restore tests** and the **1 production money-route test**.
  The constructor ordering regression fails with the original orphan-first
  ordering and passes after protected publication recovery runs first.
- Final `cargo test --locked --test phone_recovery --features
  production-route-probe` passed **8 tests**, compiling the production library
  without `cfg(test)`. A fresh file-backed destination reimports the seed,
  rescans retained controlled blocks and recovers the expected history and
  **90,000 fixture zatoshis**. It also exercises the shipping `WalletState`
  account, incomplete-sync snapshot and history readers. The funded DSL is
  regtest; its native-reader copy uses library-encoded testnet UFVK HRPs, so it
  is reader evidence, not real-chain interoperability proof. Native inventory without a manifest, orphaned
  recovery files, missing databases and corrupt manifests all block an empty
  replacement and preserve the originals. A native-storage fixture proves that
  repeated relinking neither overwrites nor deletes existing recovery material.
- The compiler-bound `send_production_routes` integration test also passed:
  the controlled wallet has an additional account whose nil UUID forces raw
  backend enumeration ahead of account zero. The exact existing stateful
  fixed-send/send-all/transaction-creation callers still select the correct
  funded primary, and persisted/retry transaction bytes remain exactly equal.
  No private adapter body or expected source-identity digest was changed.
- Final plugin `cargo clippy --locked --all-targets --features
  production-route-probe -- -D warnings` and default `cargo build --locked`
  passed. All native Cargo commands used `-j2`, `CARGO_INCREMENTAL=0`,
  `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_TEST_DEBUG=0` where applicable,
  `--config 'profile.dev.package."*".opt-level=0'`, and
  `--config profile.dev.build-override.opt-level=0`. The default production
  feature graph was compiled separately from the test-feature graph. No
  dependency, lockfile or feature changes were made.
- Rust formatting passed for all **9 wallet crates**, with a final plugin
  `cargo fmt --check`. Toolchain, namespace and both compatibility/Actions
  policy live checks passed. The compatibility self-test killed **114**
  mutants; the Actions-policy self-test passed. Their expected source identities,
  3-lock/11-package inventory and native send adapters were not weakened.
- Frontend production and test typechecks passed. The complete Vitest run
  passed **1,008 tests**, with **5 existing skips**; the later locale/identity
  scope passed **129 tests**. The final production build and fresh-WASM bundle
  verification passed.
- The complete project-boundary check passed, including all **3 constrained
  frontend builds** and the declared shared-package ownership checks. Native
  sensitive-display, WebView-authority and surface-capability guards passed;
  their final Node boundary suite passed **144 tests**.
- Parsed Android manifest/backup rules passed all **7** tests in the existing
  required media-permission test file. The canonical package scripts remain
  unchanged. All four store-listing test files passed, **87 tests**, with
  `node --test --test-concurrency=1` to bound temporary disk use. Earlier parallel
  attempts encountered ENOSPC and are not counted as passing validation.
- The full browser run produced **94 passes / 9 failures** during resource
  pressure. The final single-worker rerun of `phone-migration.pw.ts`,
  `touch-targets.pw.ts` and `viewport.pw.ts` passed **all 17 cases**, resolving
  the 8 touch/page-load timeouts and proving responsive phone instructions in
  English, Spanish and French. A later focused phone run passed **5 cases**,
  including missing-key startup, wallet switching, localized error guidance and
  320-pixel touch/wrapping behavior. The initial About build-info copy test
  received `Source commit: Unavailable in this build` because the implementation
  was uncommitted. Its contract requires a clean committed source identity; the
  final committed-HEAD browser result is recorded in the PR validation. No
  assertion or CI waiver was added.

The existing required frontend job discovers `tests/*.pw.ts`; the phone cases
need no separate shard registration. The required `rust_plugin` and `rust_native_tests` jobs use
`--all-targets --features production-route-probe` and discover the new integration
test target; the shipping build keeps its default feature graph. No required job was waived or removed.

A copied, locked e2e2z seal has no supported in-place migration or re-enrollment
path here. Preserve it, and use the existing enrollment ceremony on a clean
messaging installation. No automatic revocation, seal reset, message-history
recovery or old-device deletion is implemented or implied.
