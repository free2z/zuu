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
- **`Payment::new`** — returns `Result<Self, zip321::PaymentError>` (changed from `Option`), takes `Option<Zatoshis>` for amount. Six args: `(recipient, amount, memo, label, message, other_params)`. Use `.map_err(...)?`, not `.ok_or(...)?`.
- **`propose_transfer`** — takes **9** args and has phantom `CommitmentTreeErrT`. Use turbofish: `propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(...)`. The last two args are `spend_policy: &input_selection::SpendPolicy` (use `SpendPolicy::default()` to preserve fully-shielded behavior) and `proposed_version: Option<TxVersion>` (use `None` to let target height decide).
- **`create_proposed_transactions`** — takes **8** args and has phantom `InputsErrT` + `ChangeErrT`. Use `std::convert::Infallible` for both. The 8th arg is `expiry_height: Option<BlockHeight>` (use `None` to keep the builder-derived expiry). The transaction version is now carried on the proposal itself (`proposal.proposed_version()`), not passed here.
- **Ironwood (NU6.3) is a third shielded pool, not a cargo feature.** There is no `ironwood` feature flag; the pool is unconditional in `zcash_protocol` (`ShieldedPool::Ironwood`) and its sync/tree/note plumbing in `zcash_client_backend`/`zcash_client_sqlite` is gated behind the existing **`orchard`** feature (Ironwood reuses `MerkleHashOrchard`). Because we enable `orchard`, we get Ironwood.
- **`AccountBalance` has THREE shielded pools** — `sapling_balance()`, `orchard_balance()`, `ironwood_balance()`. Any code summing shielded value MUST include Ironwood; after NU6.3 activation Orchard becomes spend-only and new shielded value accrues to Ironwood.
- **`AccountBalance` transparent split** — `unshielded()` is deprecated; use `unshielded_regular_balance()` + `unshielded_coinbase_balance()` (or `unshielded_balance()` for the sum).
- **Change pool selection is automatic post-Ironwood.** `SingleOutputChangeStrategy::new(..., ShieldedPool::Orchard, ...)` is still correct: `fees::common::select_change_pool` redirects change to Ironwood when the Orchard turnstile forbids value re-entering Orchard.
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

## Sync driver (`src/wallet/sync.rs`)

We **do not** use `zcash_client_backend::sync::run()`. Upstream documents it as a
reference implementation (no progress reporting, no interruption, no enhancement,
no parallelism), and it unconditionally calls `update_subtree_roots()` with
`start_index: 0` on **every** invocation. Driving it from a 30s poll loop meant a
fully caught-up wallet re-downloaded and re-inserted every subtree root — measured
at **1129 Sapling + 767 Orchard = 1896 roots every 30 seconds**. That is why
"catch up 2 blocks" took minutes.

`sync.rs` now drives the flow itself, modelled on
`z/zcash/zcash-devtool/src/commands/wallet/sync.rs`:

```
update_chain_tip → reorg-while-idle check → refresh_subtree_roots (incremental)
  → loop { suggest_scan_ranges → clamp to BATCH_SIZE → download_blocks
           → download_chain_state → scan_cached_blocks → delete cached batch
           → emit progress → enhance_transactions }
```

Key points:

- **Subtree roots are incremental.** `WalletSummary::next_{sapling,orchard,ironwood}_subtree_index()`
  gives the first index the wallet still needs; it is passed as
  `GetSubtreeRootsArg::start_index` *and* as the `start_index` argument to
  `put_*_subtree_roots`. A caught-up wallet transfers **zero** roots.
- **Cadence:** refreshed at startup, whenever `suggest_scan_ranges()` is non-empty
  (so the shards covering what we are about to scan are always present), and
  otherwise at most every `SUBTREE_ROOT_REFRESH_INTERVAL` (15 min). A shard is
  2^16 note commitments — on mainnet a new one completes on the order of days, so
  15 min is ~2 orders of magnitude tighter than needed.
  `refresh_subtree_roots_if_stale()` is the hook for witness-dependent ops (sends).
- **Pool-agnostic:** `fetch_subtree_roots::<H>()` is generic over the Merkle hash
  type, inferred from the `put_*_subtree_roots` call site — so neither `sapling`
  nor `orchard` needs to be a direct dependency of this crate, and adding a pool
  is a three-line call. Sapling, Orchard **and Ironwood** are all handled.
- **Ironwood failure policy — nothing latches on a network error.** Sapling/Orchard
  fetch errors fail the pass (surfaced + endpoint rotation). Ironwood errors are
  swallowed instead, because a pre-activation lightwalletd may legitimately reject
  `ShieldedProtocol::Ironwood` and that must not wedge sync. To keep that from
  silently degrading a session: it takes `IRONWOOD_MAX_CONSECUTIVE_FAILURES` (3)
  consecutive failures to *suspend* the pool, the suspension expires after
  `IRONWOOD_RETRY_BACKOFF` (30 min), any success resets it, endpoint rotation
  clears it, and every step logs at `warn!`. The only true latch is
  `ironwood_backend_tracks`, set from a purely local observation (we fed the
  wallet roots and `next_ironwood_subtree_index()` did not advance ⇒ the backend
  uses the no-op default impl). `zcash_client_sqlite` **does** override
  `put_ironwood_subtree_roots`, so that branch is inert belt-and-braces for us.
- **Adaptive poll:** `SYNC_POLL_INTERVAL_MIN` (2s) right after a pass that scanned
  blocks, doubling up to `SYNC_POLL_INTERVAL_MAX` (30s) once idle.
- **Reorgs:** a `ChainError::Scan` continuity error rewinds to
  `err.at_height() - REORG_REWIND_MARGIN` (10), falling back to `at_height - 2`
  when the requested height has no commitment-tree checkpoint, and re-applies the
  chain tip afterwards. A tip that is *below* our max scanned height with a
  *different* block hash is also treated as a reorg (a bare height comparison
  would ratchet the wallet backwards whenever we hit a lagging server).
- **Block cache:** still `MemBlockCache` — `FsBlockDb` is behind librustzcash's
  `unstable` feature and `BlockDb` has no write API. Memory is bounded by the
  driver: one `BATCH_SIZE` (2500) batch is held, then deleted right after scanning.
- **Preserved behavior:** issue #180 birthday/`block_max_scanned` handling,
  endpoint rotation after `MAX_CONSECUTIVE_FAILURES`, `last_sync_error`
  surface/clear semantics, `syncing`-flag cancellation, the `zcash://sync-progress`
  event shape, and `enhance_transactions` memo retrieval.

Follow-up candidates (deliberately **not** in scope): librustzcash's
`sync-decryptor` feature (parallel trial decryption), and a persistent block cache
once a non-`unstable` writable block source exists.

## Concurrency rules

- **`state.db`** (`Arc<Mutex>`) — the write DB. The sync driver takes it only for
  short local operations (`update_chain_tip`, `scan_cached_blocks`,
  `put_*_subtree_roots`, `truncate_to_height`) and **never** across network I/O:
  block/root/tree-state streaming all happens with no lock held. **Never hold this
  lock in UI command handlers** — use `state.read_db` instead.
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
