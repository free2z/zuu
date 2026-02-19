# tauri-plugin-zcash

Tauri v2 plugin that wraps [librustzcash](https://github.com/zcash/librustzcash) to provide full Zcash wallet operations — create/restore wallets, sync with the chain, send shielded transactions, manage keys — all exposed as async Tauri commands for a React frontend.

## Architecture

### WalletState singleton

The plugin manages a `WalletState` struct (in `wallet/mod.rs`) with:

- **Dual DB connections** — a write-locked `db` (used by sync and send, behind `Arc<Mutex>`) and a read-only `read_db` (used by UI queries, never blocks on sync).
- **In-memory seed** — `SecretVec<u8>` kept in `Arc<Mutex>`, loaded from keychain on startup or unlock.
- **Sync control** — `syncing: Arc<RwLock<bool>>` flag + `sync_handle` for cancellation.
- **Pending proposal** — cached `(id, Proposal)` for the propose-then-execute send flow.
- **Manifest** — multi-wallet manifest (`wallets.json`) tracking all wallet DBs.

### Key design decisions

- All commands are `#[tauri::command] async fn` running on the Tokio runtime.
- Path dependencies on a forked librustzcash at `z/zcash/librustzcash` (not crates.io).
- rustls (ring provider) is installed at plugin init for all TLS connections.
- Serde models use `camelCase` to match JavaScript conventions.

## Module map

| File | Description |
|------|-------------|
| `src/lib.rs` | Plugin init, registers all 25 commands, installs rustls crypto provider |
| `src/commands.rs` | All Tauri command handlers — wallet CRUD, sync, send, keys, addresses |
| `src/models.rs` | Serde models for command args and return types (all `#[serde(rename_all = "camelCase")]`) |
| `src/error.rs` | `Error` enum with thiserror, serializes to string for frontend consumption |
| `src/desktop.rs` | Desktop platform init — creates `Zcash<R>` struct, resolves app data dir, initializes `WalletState` |
| `src/mobile.rs` | Mobile platform init (same pattern as desktop, conditionally compiled) |
| `src/wallet/mod.rs` | `WalletState` struct, `WalletDatabase` and `WalletProposal` type aliases |
| `src/wallet/send.rs` | Propose/execute send flow, Sapling parameter management and download |
| `src/wallet/sync.rs` | Background sync task with 30s polling, emits `zcash://sync-progress` events |
| `src/wallet/keychain.rs` | Tiered seed storage: macOS Keychain (biometric) > encrypted file (ChaCha20-Poly1305) > legacy keyring |
| `src/wallet/manifest.rs` | Multi-wallet JSON manifest (`wallets.json`), legacy migration from single-wallet layout |
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
| `create_wallet` | `CreateWalletArgs { mnemonicWordCount?, name? }` | `WalletCreated` | Generate new wallet with BIP-39 mnemonic, fetch birthday from chain tip |
| `restore_wallet` | `RestoreWalletArgs { seedPhrase, birthdayHeight?, name? }` | `{ success: true }` | Restore wallet from existing seed phrase |
| `get_wallet_status` | — | `WalletStatus` | Check if wallet is initialized, has seed, synced height, active wallet info |
| `get_seed_phrase` | — | `String` | Retrieve seed phrase from secure storage (keychain/encrypted file) |
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
| `execute_send` | `ExecuteSendArgs { proposalId }` | `String` (txid) | Execute a previously-proposed send — prove, sign, broadcast |
| `get_transaction_history` | `TransactionHistoryArgs { accountIndex, offset?, limit? }` | `Vec<TransactionEntry>` | Query transaction history with pagination |
| `set_lightwalletd_url` | `SetLightwalletdUrlArgs { url }` | `()` | Change the lightwalletd endpoint |
| `parse_payment_uri` | `ParsePaymentUriArgs { uri }` | `PaymentRequest` | Parse a ZIP-321 payment URI |
| `validate_address` | `ValidateAddressArgs { address }` | `AddressValidation` | Validate a Zcash address (unified, sapling, transparent, tex) |

## Send flow

Sending ZEC follows a propose-then-execute pattern:

1. **`ensure_sapling_params`** — Downloads ~50MB of Sapling proving parameters if not already cached. Required before any send.
2. **`propose_send`** or **`propose_send_all`** — Creates a transaction proposal using `GreedyInputSelector` and `SingleOutputChangeStrategy` with ZIP-317 fees. The proposal is cached in `pending_proposal`. Returns the calculated fee and total.
3. **`execute_send`** — Takes the `proposal_id`, derives the USK from the in-memory seed, creates the transaction with `create_proposed_transactions`, serializes it, and broadcasts via lightwalletd gRPC.

The `propose_send_all` command uses an iterative approach (up to 3 retries) to converge on the maximum sendable amount after ZIP-317 fee deduction.

## Security model

### Seed storage (3-tier fallback)

1. **macOS Keychain** (preferred) — Uses `security-framework` with `USER_PRESENCE` access control for Touch ID/biometric. Falls back to basic login keychain if not code-signed.
2. **Encrypted file** — ChaCha20-Poly1305 encryption with a random 32-byte salt, stored in `$DATA_DIR/.seeds/`. Files are `chmod 600` on Unix.
3. **Legacy keyring** (read-only migration) — Reads from old `keyring` crate storage and migrates to tiers 1+2.

### Key safety

- The raw spending key is **never exposed** to the frontend. `get_spending_key` only returns a boolean `available` status.
- On `unlock_wallet`, the provided seed phrase is verified against the stored UFVK before being accepted.
- The seed is held in `SecretVec<u8>` (from the `secrecy` crate) in memory.

## Building

```bash
# Check (fast, no linking)
cargo check --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml

# Build
cargo build --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml

# Build via Tauri (includes frontend)
cd wallet/zuuli && npm run tauri build
```

- **Rust edition**: 2024
- **MSRV**: 1.85.1
- **librustzcash**: path deps at `z/zcash/librustzcash` (forked)

## Known gotchas

These are hard-won lessons from working with the librustzcash API:

- **`BirthdayError` has no `Debug` or `Display` impl** — you must pattern-match on `HeightInvalid` and `Decode` variants (see `format_birthday_error` in `commands.rs`).
- **`ConfirmationsPolicy`** lives at `data_api::wallet::ConfirmationsPolicy` — use `::default()`.
- **`OvkPolicy`** is at `zcash_client_backend::wallet::OvkPolicy` (NOT `data_api::wallet`).
- **`SingleOutputChangeStrategy::new`** takes 4 args: `(fee_rule, Option<MemoBytes>, ShieldedProtocol, DustOutputPolicy)`.
- **`Payment::new`** returns `Option<Self>` and takes `Option<Zatoshis>` for amount.
- **`propose_transfer`** has a phantom `CommitmentTreeErrT` type param — use turbofish with `zcash_client_sqlite::wallet::commitment_tree::Error`.
- **`create_proposed_transactions`** has phantom `InputsErrT` + `ChangeErrT` — use `std::convert::Infallible` for both.
- **`Memo::from_str`** needs `use std::str::FromStr;` in scope.
- **Default lightwalletd**: `https://zec.rocks:443` (the old `mainnet.lightwalletd.com:9067` is deprecated).
