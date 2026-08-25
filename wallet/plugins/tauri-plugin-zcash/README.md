# tauri-plugin-zcash

Tauri v2 plugin that wraps [librustzcash](https://github.com/zcash/librustzcash) to provide full Zcash wallet operations — create/restore wallets, sync with the chain, send shielded transactions, manage keys — all exposed as async Tauri commands for a React frontend.

## Architecture

### WalletState singleton

The plugin manages a `WalletState` struct (in `wallet/mod.rs`) with:

- **Dual DB connections** — a write-locked `db` (used by sync and send, behind `Arc<Mutex>`) and a read-only `read_db` (used by UI queries, never blocks on sync).
- **In-memory seed** — `SecretVec<u8>` kept in `Arc<Mutex>`, loaded lazily from native custody only when an explicit signing or key-access action needs it.
- **Sync control** — `syncing: Arc<RwLock<bool>>` flag + `sync_handle` for cancellation.
- **Pending send state** — an in-memory proposal plus per-wallet durable exact-transaction recovery for ambiguous broadcasts.
- **Manifest** — multi-wallet manifest (`wallets.json`) tracking all wallet DBs.
- **Cleanup journal** — fsynced `wallet-cleanup.json` authority for idempotent
  orphan cleanup after deletion or failed create/restore transitions. If a
  published wallet's manifest rename is lost after an inconclusive directory
  fsync, startup restores the exact generation from this journal instead of
  deleting its database or custody. Filesystem stages run before DB open;
  native custody stages run asynchronously after plugin setup.

### Key design decisions

- All commands are `#[tauri::command] async fn` running on the Tokio runtime.
- Path dependencies on a forked librustzcash at `z/zcash/librustzcash` (not crates.io).
- rustls (ring provider) is installed at plugin init for all TLS connections.
- Serde models use `camelCase` to match JavaScript conventions.

## Module map

| File | Description |
|------|-------------|
| `src/lib.rs` | Plugin init, registers wallet commands, installs rustls crypto provider |
| `src/commands.rs` | All Tauri command handlers — wallet CRUD, sync, send, keys, addresses |
| `src/models.rs` | Serde models for command args and return types (all `#[serde(rename_all = "camelCase")]`) |
| `src/error.rs` | `Error` enum with thiserror, serializes to string for frontend consumption |
| `src/desktop.rs` | Desktop platform init — creates `Zcash<R>` struct, resolves app data dir, initializes `WalletState` |
| `src/mobile.rs` | Mobile platform init (same pattern as desktop, conditionally compiled) |
| `src/wallet/mod.rs` | `WalletState` struct, `WalletDatabase` and `WalletProposal` type aliases |
| `src/wallet/send.rs` | Propose/execute send flow, Sapling parameter management and download |
| `src/wallet/sync.rs` | Background sync task with 30s polling, emits `zcash://sync-progress` events |
| `src/wallet/keychain.rs` | Fail-closed native seed custody plus UFVK-validated, one-way migration of legacy records |
| `src/wallet/manifest.rs` | Multi-wallet JSON manifest (`wallets.json`), legacy migration from single-wallet layout |
| `src/wallet/cleanup.rs` | Durable, generation-bound retry journal for DB sidecars and native/legacy custody cleanup |
| `src/wallet/accounts.rs` | Account creation and listing |
| `src/wallet/keys.rs` | BIP-39 mnemonic generation, seed derivation, USK derivation |
| `src/wallet/storage.rs` | SQLite connection management, WAL mode, schema migrations |
| `src/wallet/client.rs` | lightwalletd gRPC connection via tonic |
| `src/wallet/cache.rs` | In-memory `BTreeMap` block cache for the sync engine |
| `src/wallet/history.rs` | Transaction history queries |

## Command reference

All commands are invoked from TypeScript as `invoke("plugin:zcash|command_name", { args: {...} })`.

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `create_wallet` | `CreateWalletArgs { name? }` | `WalletCreated { walletId, birthdayHeight }` | Generate a fixed 24-word wallet into native custody without returning its mnemonic to the renderer; unknown legacy arguments fail closed |
| `restore_wallet` | `RestoreWalletArgs { seedPhrase, birthdayHeight?, name? }` | `WalletRestored { success, walletId }` | Restore a wallet and return the exact atomically published manifest identity |
| `get_wallet_status` | — | `WalletStatus` | Check if wallet is initialized, has seed, synced height, active wallet info |
| `retry_wallet_cleanup` | — | `WalletCleanupStatus` | Explicitly retry pending orphan cleanup and return diagnostics |
| `get_seed_phrase` | `SensitiveSeedArgs { token }` | `String` | Authenticate and retrieve the seed only while the exact display lease is held |
| `get_backup_seed_phrase` | `SensitiveBackupSeedArgs { walletId, token }` | `String` | Retrieve a pending backup only while the exact display lease is held |
| `begin_sensitive_display` | — | `SensitiveDisplayLease` | Acquire an exact display lease before a backup reveal; mobile platforms apply their documented capture controls |
| `begin_sensitive_entry` | `BeginSensitiveEntryArgs { purpose }` | `SensitiveDisplayLease` | Acquire a purpose-bound display lease before an approved mnemonic-entry field becomes editable |
| `end_sensitive_display` | `EndSensitiveDisplayArgs { token, purpose }` | `()` | Release only the matching token and purpose lease |
| `get_viewing_key` | `AccountIdArgs { accountIndex }` | `String` | Get encoded UFVK for an account |
| `get_spending_key` | `AccountIdArgs { accountIndex }` | `SpendingKeyStatus` | Verify spending authority (does NOT expose raw key) |
| `list_wallets` | — | `Vec<WalletInfo>` | List all wallets in the manifest |
| `switch_wallet` | `SwitchWalletArgs { walletId }` | `()` | Stop sync, swap DB connections, load seed for new wallet |
| `rename_wallet` | `RenameWalletArgs { walletId, name }` | `()` | Rename a wallet in the manifest |
| `delete_wallet` | `DeleteWalletArgs { walletId }` | `()` | Delete wallet (DB file + keychain + manifest entry), cannot delete last wallet |
| `unlock_wallet` | `UnlockWalletArgs { seedPhrase, walletId? }` | `()` | Verify seed matches UFVK, store in keychain, set seed in memory |
| `create_account` | — | `AccountInfo` | Create a new account in the active wallet |
| `list_accounts` | — | `Vec<AccountInfo>` | List all accounts in the active wallet |
| `get_account_balance` | `AccountIdArgs { accountIndex }` | `AccountBalance` | Get shielded balance (total, spendable, change pending, value pending) |
| `get_unified_address` | `AccountIdArgs { accountIndex }` | `String` | Get encoded unified address for an account |
| `start_sync` | — | `()` | Start background sync task (30s polling loop) |
| `stop_sync` | — | `()` | Stop background sync, abort task, wait for cancellation |
| `get_sync_status` | — | `SyncStatus` | Get current sync progress (height, chain tip, percentage) |
| `ensure_sapling_params` | — | `SaplingParamsStatus` | Download Sapling proving parameters if not cached |
| `propose_send` | `ProposeSendArgs { to, amount, memo? }` | `SendProposal` | Create a send proposal with ZIP-317 fee calculation |
| `propose_send_all` | `ProposeSendAllArgs { to, memo? }` | `SendProposal` | Create a send-all proposal (max amount minus fee, with retry convergence) |
| `execute_send` | `ExecuteSendArgs { proposalId, reviewDigest, confirmationToken }` | `ExecuteSendResult` | Consume the exact reviewed proposal once, prove/sign, persist exact bytes, broadcast, and return accepted/rejected/unknown status |
| `discard_send_proposal` | `DiscardSendProposalArgs { proposalId, reviewDigest, confirmationToken }` | `()` | Discard only the exact reviewed proposal identified by all three native credentials |
| `get_pending_send` | — | `PendingSendStatus?` | Recover an unresolved broadcast after a remount, restart, or wallet switch |
| `retry_pending_send` | — | `ExecuteSendResult` | Query and rebroadcast the exact persisted transaction; never signs a replacement |
| `discard_unrecoverable_send` | `DiscardUnrecoverableSendArgs { proposalId, confirmation }` | `()` | After explicit wallet-history review, discard only a valid interrupted-creation intent with no transaction bytes |
| `get_transaction_history` | `TransactionHistoryArgs { accountIndex, offset?, limit? }` | `Vec<TransactionEntry>` | Query transaction history with pagination |
| `set_lightwalletd_url` | `SetLightwalletdUrlArgs { url }` | `()` | Change the lightwalletd endpoint |
| `parse_payment_uri` | `ParsePaymentUriArgs { uri }` | `PaymentRequest` | Parse one ZIP-321 payment and validate its recipient against the active network |
| `validate_address` | `ValidateAddressArgs { address }` | `AddressValidation` | Validate the active network and a receiver this wallet can pay |

## Send flow

Sending ZEC follows a propose-then-execute pattern:

1. **`ensure_sapling_params`** — Downloads ~50MB of Sapling proving parameters if not already cached. Required before any send.
2. **`propose_send`** or **`propose_send_all`** — Creates a transaction proposal using `GreedyInputSelector` and `SingleOutputChangeStrategy` with ZIP-317 fees. Native state atomically caches the executable proposal alongside an immutable canonical review. The response contains that review, its versioned digest, and a one-use opaque confirmation token; the token is stored native-side only as a hash.
3. **`execute_send`** — Requires the matching `proposal_id`, `review_digest`, and `confirmation_token`, consumes that authorization before seed custody is loaded, then creates the transaction with `create_proposed_transactions`, serializes it, persists an exact recovery record, and broadcasts via lightwalletd gRPC. A mismatch leaves the current proposal intact; once a matching confirmation is consumed, execution cannot be replayed. `discard_send_proposal` follows the same exact-match rule when the renderer abandons a review.
4. **Resolve ambiguity** — `accepted` and definite `rejected` responses are explicit. Timeouts and transport failures set a durable ambiguity flag, return `unknown`, block replacement proposals, and survive process restart. `retry_pending_send` first queries the txid, then rebroadcasts only the persisted raw bytes. A later rejection cannot downgrade an actually ambiguous attempt. Once the wallet is fully scanned beyond the transaction expiry height and lightwalletd reports the txid absent, the record resolves to rejected and new sends are safe.
5. **Interrupted-creation escape hatch** — A fail-closed intent is durable before proving/signing begins. If a crash leaves that valid intent without transaction bytes, the UI requires the operator to inspect wallet history and explicitly confirm before `discard_unrecoverable_send` unlocks sends. Unreadable or corrupt journals remain fail-closed because they may still contain recoverable transaction evidence. A recovery record with complete transaction bytes can never use this manual path: if its wallet DB row is missing, the exact raw bytes remain locked for retry until the DB is restored or the network accepts them.

The `propose_send_all` command uses an iterative approach (up to 3 retries) to converge on the maximum sendable amount after ZIP-317 fee deduction.

Sapling parameter verification/download runs on the blocking pool and is serialized so concurrent UI requests cannot race the same files. lightwalletd connection and RPC operations have bounded timeouts.

TEX recipients are rejected for now because ZIP 320 can produce an ordered two-transaction proposal. Supporting TEX safely requires durable ordered-batch recovery; accepting it through the single-transaction broadcaster could submit only half of the proposal.

The current send UI supports exactly one ZIP-321 payment. Native parsing rejects empty or multi-payment requests instead of selecting one payment, rejects recipients for another configured network, and rejects Unified Addresses that contain no Orchard-family, Sapling, or transparent receiver understood by this build. ZIP-321 text and empty memos are supported; opaque memo formats are rejected rather than rewritten. The proposal boundary repeats recipient validation before building a native proposal, so renderer or IPC callers cannot bypass these checks.

## Security model

### Native seed custody

- **iOS:** Keychain, `WhenUnlockedThisDeviceOnly`, non-synchronizable, with user presence.
- **Android:** non-exportable AndroidKeyStore AES-256 key, device authentication, and randomized AES-GCM ciphertext in app-private, backup-excluded preferences.
- **macOS:** data-protection Keychain with user presence and `ThisDeviceOnly`; ad-hoc development builds may fall back to the native login Keychain when the protected store is unavailable.
- **Linux:** persistent Secret Service storage. Access follows the user's desktop collection-lock policy and may not prompt while that collection is unlocked.
- **Windows:** Windows Credential Manager. Access follows the signed-in user's credential-vault policy and does not promise a per-read presence prompt.

There is no encrypted-file fallback for new writes. Historical `.seeds/*.enc` and old keyring records are read-only migration inputs. Migration occurs only after native storage reports `NotFound`, validates the seed-derived UFVK, writes and reads back the native record, and deletes the legacy record last. Every other native error fails closed.

### Durable destructive transitions

Wallet deletion writes and fsyncs a cleanup tombstone before removing the
manifest entry. Create and restore do the same before creating a database or
native seed record, then cancel the tombstone only after their manifest entry
is durably reachable. Cleanup advances one idempotent stage at a time across
the SQLite database, WAL, SHM, legacy file custody, legacy keyring custody, and
native custody; every successful boundary is persisted before the next stage.

Startup retries the journal before opening database handles. The explicit
`retry_wallet_cleanup` command runs the same worker under the wallet-transition
lock, and `WalletStatus.cleanup` surfaces pending stages and errors. Each entry
binds wallet UUID, `created_at` generation, and database filename. An exact
active generation cancels a stale rollback tombstone, while any reintroduced
UUID or reused database filename with a different generation blocks cleanup.
Uncertain manifest directory durability is resolved only after restart against
the manifest that actually survived, never by an unsafe same-process guess.

### Key safety

- The raw spending key is **never exposed** to the frontend. `get_spending_key` only returns a boolean `available` status.
- On `unlock_wallet`, the provided seed phrase is verified against the stored UFVK before being accepted.
- The seed is held in `SecretVec<u8>` (from the `secrecy` crate) in memory.

## Building

```bash
# Check (fast, no linking)
cargo +1.97.1 check --locked --all-targets --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml

# Run the plugin's wallet/send and lifecycle regression tests
cargo +1.97.1 test --locked --all-targets --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml

# Build
cargo build --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml

# Build via Tauri (includes frontend)
cd wallet/zuuli && npm run tauri build
```

- **Rust edition**: 2024
- **MSRV**: 1.97
- **librustzcash**: path deps at `z/zcash/librustzcash` (forked)

## Known gotchas

These are hard-won lessons from working with the librustzcash API:

- **`BirthdayError` has no `Debug` or `Display` impl** — you must pattern-match on `HeightInvalid` and `Decode` variants (see `format_birthday_error` in `commands.rs`).
- **`ConfirmationsPolicy`** lives at `data_api::wallet::ConfirmationsPolicy` — use `::default()`.
- **`OvkPolicy`** is at `zcash_client_backend::wallet::OvkPolicy` (NOT `data_api::wallet`).
- **`SingleOutputChangeStrategy::new`** takes 4 args: `(fee_rule, Option<MemoBytes>, ShieldedProtocol, DustOutputPolicy)`.
- **`Payment::new`** returns `Result<Self, zip321::PaymentError>` and takes `Option<Zatoshis>` for amount.
- **`propose_transfer`** has a phantom `CommitmentTreeErrT` type param — use turbofish with `zcash_client_sqlite::wallet::commitment_tree::Error`.
- **`create_proposed_transactions`** has phantom `InputsErrT` + `ChangeErrT` — use `std::convert::Infallible` for both.
- **`Memo::from_str`** needs `use std::str::FromStr;` in scope.
- **Default lightwalletd**: `https://zec.rocks:443` (the old `mainnet.lightwalletd.com:9067` is deprecated).
