# Zcash node/wallet stack for free2z on `caliente`

This doc captures the ~2026 zcashd deprecation migration for the free2z payment
listener. Skip to [Current stack](#current-stack-zakura--sidecar-zcashd) for
what's actually running today; the rest is context.

## The problem

`zcashd` was retired mid-2026. Our production instance on `caliente` died at
its baked-in deprecation height on **2025-11-12 06:22 UTC (block 3,132,000)**
with the `wallet.dat` intact at sha256 `2193c85387…fd69b0`. The three cron
pollers (`sweep_balance`, `credit_pages_unified`, `credit_creators`) all
stopped receiving payments because they poll a JSON-RPC on `127.0.0.1:8232`
that had nothing behind it.

## What we tried

1. **Rehab zcashd 6.12.3.** Failed twice:
   1. `Chain supply tracking fields are missing; restart with -reindex` on
      startup. Recoverable with `-reindex-chainstate`.
   2. `Assertion 'pindexFork != nullptr' failed` during wallet load after
      partial reindex — wallet/chain divergence. Node crashlooped ~125 times.
2. **Zebra 6.0.0 + Zallet 0.1.0-beta.1 (zaino variant).** Migrated the pristine
   `wallet.dat` via `zallet migrate-zcashd-wallet --no-scan`; wallet.db built
   with 1 account (`Legacy`, UUID `c4ccf83e-2cb3-4c02-8603-b41925817cb7`),
   102 transparent + 1 sapling key. But **Zallet beta.1 has a bug** where all
   account-scoped JSON-RPC methods (`z_listaccounts`, `z_getbalanceforaccount`,
   `z_gettotalbalance`, `z_sendmany`) hang indefinitely; only `getwalletinfo`
   (stubbed with `WARN: TODO: Implement getwalletinfo`), `help`, `rpc.discover`
   and `validateaddress` responded. Workaround: `ZalletClient` in
   `zallet_client.py` reads `wallet.db` directly via SQLite for the read-only
   pollers. `sweep_balance` was blocked because spending requires the
   still-broken `z_sendmany`.
3. **Zakura 1.0.0 + sidecar zcashd 6.20.0 (this doc's current answer).**
   Zakura is a Zebra fork from Valar Group, released 2026-07-15. Its
   `zcashd-compat` mode runs a modified `zcashd` build ([valargroup/zcashd])
   as a P2P sidecar that only peers with Zakura. The sidecar retains the
   full zcashd wallet + RPC surface (deprecation halt disabled). We loaded
   our pristine `wallet.dat` into the sidecar and got `Keys: 102`,
   `ZKeys: 1`, `mapWallet.size() = 511`, `init message: Done loading` — the
   full wallet history came right back. Our existing zcashd-native Python
   code works unchanged.

## Current stack (Zakura + sidecar zcashd)

```
Zcash network ─P2P (8233)─▶ Zakura ◀─P2P, container-local─ sidecar zcashd
                            (front)                        (holds wallet.dat + RPC)
                                                                    ▲
                                                                    │ JSON-RPC 127.0.0.1:8232
                                                                    │ (foobarbaz / <password>)
                                                                    │
                              free2z cron pollers (Django management commands)
                              via python-slickrpc, hits `127.0.0.1:8232`
```

- **Docker image**: `zakuracore/zakura:zcashd-compat-1.0.0` (supervised
  variant — one container runs both Zakura and the sidecar zcashd).
- **Systemd unit**: none, but the container has `--restart unless-stopped`.
  Docker service auto-starts on boot; container auto-starts with it.
- **Volumes**: `/var/lib/zakura-sandbox/zakura-cache` (Zakura RocksDB state,
  pruned snapshot), `/var/lib/zakura-sandbox/zcashd-datadir` (sidecar zcashd
  chain + wallet), `/var/lib/zakura-sandbox/zakurad.toml` (config).
- **Ports**: host `127.0.0.1:8232` → container `0.0.0.0:8232` (sidecar
  zcashd RPC); host `0.0.0.0:8233` → container `0.0.0.0:8233` (Zakura P2P
  — required for inbound peers, otherwise our node is pure leech).
  Container-internal only: `127.0.0.1:18232` (Zakura's own RPC, used by
  Zakura for internal handoff, not exposed).
- **Snapshot**: Zakura state seeded from Valar Group's pruned snapshot
  (~11 GB, 10k blocks retention). Snapshot verified by SHA256.
- **Sidecar zcashd wallet**: `/var/lib/zakura-sandbox/zcashd-datadir/wallet.dat`
  is a copy of the pristine backup, sha256 `2193c85387…fd69b0`.

## The routing switch

`zcashrpc.client.Client` selects the implementation with `ZCASHRPC_CLIENT`.
It defaults to the original zcashd `Proxy`, so pollers hit `127.0.0.1:8232` —
the sidecar zcashd. The old `ZCASH_BACKEND=zallet` flag remains a compatibility
alias when the new selector is absent.

`ZalletClient` in `zallet_client.py` stays checked in; it is dormant unless
someone selects `ZCASHRPC_CLIENT=zallet` (or uses the old alias). Keeping it means we can pivot back
to Zebra+Zallet quickly if Zakura or the sidecar ever breaks.

## Layout on disk

```
/var/lib/zakura-sandbox/            <- Zakura+sidecar zcashd home
  zakura-cache/                     <-   Zakura RocksDB state (pruned, ~14GB grown)
  zcashd-datadir/                   <-   sidecar zcashd datadir
    wallet.dat                      <-     the migrated pristine wallet
    blocks/, chainstate/, ...       <-     sidecar zcashd's chain (grows to ~250GB)
  zakurad.toml                      <-   Zakura config with [zcashd_compat] enabled

/var/lib/zcash/                     <- LEGACY / ROLLBACK (Zebra+Zallet)
  zebra/cache/                      <-   ~258 GB, keep for rollback insurance
  zallet/wallet.db                  <-   ~200 MB, keep for rollback insurance
  <systemd units stopped+disabled but files intact>

/home/sa_.../wallet-backups/        <- pristine wallet.dat archives, DO NOT DELETE
  wallet.dat.bak.20260510-164729    <-   sha256 2193c853...fd69b0
  wallet.dat.postcrash.20260510-...  <-  forensic copy from failed zcashd rehab
```

## Cron (paused during sidecar zcashd sync)

The 3 lines in `ext_skylar_saveland_gmail_com`'s crontab are prefixed with
`# PAUSED_ZAKURA_CUTOVER` while the sidecar syncs. To resume once sidecar
zcashd is at chain tip (`getblockchaininfo` shows
`initial_block_download_complete: true`), remove the prefix:

```sh
sudo crontab -l -u ext_skylar_saveland_gmail_com | \
    sed 's/^# PAUSED_ZAKURA_CUTOVER //' | \
    sudo crontab -u ext_skylar_saveland_gmail_com -
```

Each line already carries `ZCASH_USER=foobarbaz ZCASH_PASSWORD="..."` — those
credentials match the sidecar zcashd RPC auth in `zakurad.toml`, so pollers
authenticate cleanly.

## Trust story

The sidecar zcashd is a modified fork ([valargroup/zcashd]) that disables
the upstream end-of-service halt. This means the sidecar keeps running past
consensus versions that would normally have shut it down. **Consensus safety
comes from Zakura**, which is the real node facing the P2P network — Zakura
fully validates every block before handing it over to the sidecar. The
sidecar is effectively a wallet-only appendage: no P2P listen, no DNS seeding,
no miner RPCs.

Risk profile for our payment-listener use:
- We only need the sidecar to accurately report incoming shielded receipts —
  which is a decrypt-and-parse operation on blocks Zakura already validated.
- Even a compromised sidecar can't spend our funds without our RPC auth or
  produce false receipts (the notes were still crypto-verified by Zakura).
- Worst case if Zakura misbehaves: we'd credit accounts for a bogus fork
  transaction. Mitigation: Zakura is a Zebra fork with pruning + snapshot
  changes; consensus code is essentially unchanged.

## Rollback

If Zakura or the sidecar breaks, revert to Zebra 6.0.0 + Zallet:
```sh
# 1) Stop Zakura
sudo docker stop zakura
# 2) Bring Zebra + Zallet back up
sudo systemctl enable --now zebrad zallet
# 3) Flip cron env — pollers use the SQLite-backed ZalletClient again
sudo crontab -l -u ext_skylar_saveland_gmail_com | \
    sed 's|^# PAUSED_ZAKURA_CUTOVER \(\* \* \* \* \*\)|\1 ZCASHRPC_CLIENT=zallet ZALLET_PORT=28232|' | \
    sudo crontab -u ext_skylar_saveland_gmail_com -
```
Zebra state and Zallet wallet.db are intact in `/var/lib/zcash/`.

## Follow-ups for future maintenance

1. **NU6.3 "Ironwood" activates 2026-07-28 at block 3,428,143**. Verify Zakura
   + sidecar handle it (both claim readiness). If sidecar zcashd stalls at
   the activation height, `docker restart zakura` and check
   `zakurad start --unsafe-low-specs` still applies.
2. **Delete legacy `/var/lib/zcash/zebra/cache/`** (~258 GB) after 2 weeks
   of stable Zakura operation. Frees disk.
3. **File Zallet bug** for the account-RPC hang against `zcash/wallet`.
   Verify against `main` and beta.2 when released. If fixed, we can retire
   both `ZalletClient` and this Zakura pivot in favor of the "official"
   ECC path.
4. **`ZalletClient` (SQLite reads)**: keep as dormant fallback until we're
   confident Zakura is stable long-term.
5. **Docs**: worth capturing a short "operational cheatsheet" (start/stop,
   check sync, RPC probes) — could live in this file or a sibling.

[valargroup/zcashd]: https://github.com/valargroup/zcashd
