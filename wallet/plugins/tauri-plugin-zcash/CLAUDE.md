# tauri-plugin-zcash — Agent instructions

## Build commands

```bash
# Quick type check (no linking — fast)
cargo check --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml

# Full build
cargo build --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml

# Full app build (frontend + backend)
cd wallet/zuuli && npm run tauri dev
```

Rust edition 2024, MSRV 1.85.1. All librustzcash deps are path deps at `z/zcash/librustzcash`.

## Type aliases

Defined in `src/wallet/mod.rs`:

```rust
pub type WalletDatabase =
    zcash_client_sqlite::WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

pub type WalletProposal = zcash_client_backend::proposal::Proposal<
    zcash_primitives::transaction::fees::zip317::FeeRule,
    zcash_client_sqlite::ReceivedNoteId,
>;
```

## librustzcash API gotchas

- **`BirthdayError`** — has NO `Debug` or `Display` impl. Must pattern-match variants: `BirthdayError::HeightInvalid(e)` and `BirthdayError::Decode(e)`.
- **`ConfirmationsPolicy`** — at `zcash_client_backend::data_api::wallet::ConfirmationsPolicy`, use `::default()`.
- **`OvkPolicy`** — at `zcash_client_backend::wallet::OvkPolicy` (NOT `data_api::wallet`).
- **`SingleOutputChangeStrategy::new`** — 4 args: `(FeeRule, Option<MemoBytes>, ShieldedProtocol, DustOutputPolicy)`.
- **`Payment::new`** — returns `Option<Self>`, takes `Option<Zatoshis>` for amount. Six args: `(recipient, amount, memo, label, message, other_params)`.
- **`propose_transfer`** — has phantom `CommitmentTreeErrT`. Use turbofish: `propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(...)`.
- **`create_proposed_transactions`** — has phantom `InputsErrT` + `ChangeErrT`. Use `std::convert::Infallible` for both.
- **`Memo::from_str`** — needs `use std::str::FromStr;` in scope.
- **Default lightwalletd** — `https://zec.rocks:443` (mainnet.lightwalletd.com:9067 is deprecated).

## Adding a new command

Checklist:

1. **Implement logic** in the appropriate `src/wallet/*.rs` module.
2. **Add command handler** in `src/commands.rs` — annotate with `#[command]`, make it `pub(crate) async fn`, take `AppHandle<R>` and an args struct.
3. **Register in `src/lib.rs`** — add `commands::your_command` to the `invoke_handler` list.
4. **Register in `build.rs`** — add `"your_command"` to the `COMMANDS` array.
5. **Add models** in `src/models.rs` — args struct (`Deserialize, camelCase`) and return struct (`Serialize, camelCase`).
6. **Add TypeScript wrapper** in `wallet/zuuli/src/lib/tauri.ts` and matching interface in `wallet/zuuli/src/types/index.ts`.

All four registration points (commands.rs handler, lib.rs invoke_handler, build.rs COMMANDS, models.rs) must be in sync or the build fails.

## Concurrency rules

- **`state.db`** (`Arc<Mutex>`) — the write DB. Held by the sync task during batch processing. **Never hold this lock in UI command handlers** — use `state.read_db` instead.
- **`state.read_db`** (`Arc<Mutex>`) — read-only DB connection for non-blocking UI reads. Safe to lock briefly in any command.
- **Wallet switching** — stops sync (sets `syncing = false` + aborts handle), swaps `read_db` immediately, swaps `db` in a background task (waits for sync to release its lock).
- **Keychain ops** — always run in `tokio::task::spawn_blocking` because macOS Keychain APIs are synchronous and may prompt for biometric.
- **Send flow** — `propose_send` locks `db` briefly, stores proposal in `pending_proposal`. `execute_send` locks `db` + `prover`. Both should only be called when sync is idle or will contend.

## Error handling

- Use `Error` variants from `src/error.rs` — `WalletNotInitialized`, `InvalidMnemonic`, `SyncError`, `SendError`, `DatabaseError`, `NetworkError`, `AddressError`, `KeyError`, `Other`.
- **Never `unwrap()`** on librustzcash results — they produce complex error types. Always `map_err` to an appropriate `Error` variant.
- Errors serialize to plain strings for the frontend (via the custom `Serialize` impl).

## Testing

- **No test suite yet.** `cargo check` is the primary verification method.
- Integration testing requires a running lightwalletd instance and real (or testnet) chain state.
