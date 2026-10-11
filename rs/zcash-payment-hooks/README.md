# Zcash Payment Hooks

**Shielded payment → durable event → your code.** A receive-only Rust library
and Unix daemon that runs beside [Zakura](https://zakura.com/). Give it a Unified
Full Viewing Key, point it at node RPC, and subscribe with an executable. Each
invocation receives one JSON payment event on stdin.

```text
Zakura RPC ── full blocks ──► viewing-key decryption
                                      │
                            private SQLite journal
                                      │
                          confirmed / observed / revoked
                            ┌─────────┴─────────┐
                            ▼                   ▼
                       your hook A         your hook B
                       JSON on stdin       independent retries
```

The executable is **`zcash-paymentd`**; the Rust library is **`zcash_paymentd`**.
This is an independent Cargo project. It does not link any wallet or messaging
application in this repository; no submodules are needed to build it.

## What it does

- Decrypts external incoming **Sapling, Orchard and Ironwood** notes using
  established [librustzcash](https://github.com/zcash/librustzcash) libraries.
- Retains the exact recipient, integer zatoshis, and complete 512-byte
  [shielded memo](https://zips.z.cash/zip-0302). Memos stay opaque to the core.
- Tracks confirmation depth, reorganizations and re-mining with stable payment
  identities and versioned events.
- Persists events and per-consumer acknowledgements in SQLite; failed hooks
  retry without stopping the scanner or another consumer.
- Runs literal executable arguments, with a timeout and an empty environment.

It does **not** spend, compute spendable balances, parse your business memo,
issue application credits, serve HTTP webhooks, or deliver mobile notifications.
Your hook can implement those application integrations. Transparent/Sprout
payments and mempool observation are unsupported. A mined observation is not
confirmation.

## Try it locally

Build from the repository root using its shared Rust toolchain:

```sh
cargo test --locked --manifest-path rs/zcash-payment-hooks/Cargo.toml
cargo build --locked --release --manifest-path rs/zcash-payment-hooks/Cargo.toml
```

Choose a private directory owned by the daemon user. Put your **UFVK**, never a
seed or spending key, in `receiver.ufvk` with mode `0600`. Copy
[`paymentd.example.toml`](paymentd.example.toml) to your configuration path and
replace every illustrative path and height. Set the correct network and the
real receiving birthday. `automation_start_height` is inclusive: scanning older
history records receipts but does not execute hooks.

```sh
./rs/zcash-payment-hooks/target/release/zcash-paymentd --config /absolute/paymentd.toml run
./rs/zcash-payment-hooks/target/release/zcash-paymentd --config /absolute/paymentd.toml status
```

Start with **zero consumers** and inspect the scanner before connecting a hook.
Zakura must retain all required blocks and expose `getblockchaininfo`,
`getblockhash`, `getblockheader`, and `getblock(hash, 0)`. Cookie authentication is
optional; if configured, its private file must be owned by the daemon user and
is reloaded on each request. RPC is loopback HTTP or HTTPS; redirects and ambient
proxies are disabled.

> **A pruned node cannot supply discarded history.**
> Your birthday and saved scan cursor must remain inside its retained range.
> Missing history stops scanning; the daemon never silently skips ahead. Use an
> archive backend for historical recovery. There is no automatic public-provider
> fallback.

A node validates consensus but cannot decrypt your shielded receipts without
viewing authority. This daemon supplies that small receiving layer. Full blocks
contain ciphertext and memo together, so the observer needs no spending wallet,
commitment-tree witnesses or lightwalletd synchronization database.

The chain source uses JSON-RPC. Zakura's [shared ecosystem direction](https://zakura.com/announcements/zakura-common/)
separates node and wallet libraries and anticipates new synchronization services.
The `Chain` observation-source boundary returns decrypted payments and separates
transport and decryption from the journal and hooks. Zakura exposes a
[native indexer gRPC contract](https://github.com/zakura-core/zakura/blob/v1.6.0/crates/zakura-rpc/proto/indexer.proto),
including tip, non-finalized-state and finalized-range streams. This daemon does
not consume that API. An indexer or PIR-based observation source needs its own
scanner, privacy and reorganization acceptance work; this release implements
neither backend. Viewing keys stay in the private receiving process. Payment-event
integrations can use a replacement chain source without changing business hooks.

## Attach a hook

The [example hook](examples/record_event.py) only records event identities in its
own SQLite database. It is a harmless demonstration, **not a financial adapter**.
After validating the observation-only run, add an absolute executable and literal
arguments to your configuration:

```toml
[[consumers]]
id = "record-events-v1"
argv = ["/usr/bin/python3", "/absolute/record_event.py", "/absolute/private/hook.sqlite"]
timeout_seconds = 30
observe_unconfirmed = false
```

Stop the daemon before changing consumers. For an existing observation-only
journal, run `enqueue-missing` while stopped to register and queue the existing
eligible lifecycle work, inspect its bounded proof, then restart. A new journal
registers configured consumers when opened. Repeating `enqueue-missing` preserves
existing acknowledgements; it does not invent a payment or reset retry state.

The core passes one schema-version-1 JSON event followed by a newline on stdin.
**Exit zero acknowledges that event; any other exit or timeout retries it.** The
working directory is `/`, environment variables are cleared, and stdout/stderr
are discarded. Use absolute paths and configure your own private diagnostics.
There is no shell interpolation: a memo cannot become executable arguments.

> **Delivery is at least once.**
> A hook can commit its effect and crash before the daemon records its ACK.
> Commit an idempotency key and your effect together using `event_id`. A hook
> that returns success before committing durable work can lose that work.

Each consumer has a serial FIFO queue and an independent worker. Retry backoff
starts at two seconds and is capped at 1,024 seconds. A failing head blocks later
work for **that consumer**. A handler should durably record malformed or
unrecognized requests for review and return success when that is its terminal
policy; the core cannot decide your business rules. Default consumers receive
confirmed and applicable revoked events. `observe_unconfirmed = true` also
receives mined `payment.observed` events, suitable for evidence capture, not
irreversible financial effects.

Hook process groups are killed on timeout or cancellation. This is cleanup, not
a sandbox: hooks are trusted operator code with the daemon user's authority.
A hook that deliberately creates another session can escape a process group;
use an appropriate supervisor/cgroup boundary for production isolation.

## Contract and operating limits

See the [event/API contract](../../docs/zcash-payment-hooks/CONTRACT.md) for fields,
revision rules, proof commands and the library interface. One state directory
binds one UFVK, network, birthday, automation floor and confirmation policy.
Use a separate daemon instance for each receiving profile.

Keep the journal private and back it up with SQLite's online backup facilities
or after stopping writers. Restore and verify it before enabling side effects;
a viewing key alone does not restore acknowledgements or your application's
idempotency records. Events are retained; this version has no automatic retention
or compaction policy. Bounded delivery inventory and consumer-handoff checks support
10,000 relevant receipts, 50,000 events and 64 MiB of decoded inventory. Monitor
those counts and plan capacity work before reaching the limits.

Positive payment hooks run after a fresh canonical scan catches up. The node's
required `headers` and `estimatedheight` fields must stay within the configured
lag of its loaded block tip; we also check the tip timestamp and supported
network-upgrade branch. Released Zakura omits `initialblockdownload`, so its
absence is not synchronization evidence. These checks describe the node's view,
not an independent global chain oracle.

Already-recorded revocations remain deliverable while scanning is unavailable.
They can pass an unrelated paused positive event, preserve order and retry
backoff among revocations, and leave that positive event's ACK/retry state
untouched. A reorg explicitly cancels only the superseded positive events for
that payment. Once scanner readiness returns, normal queue order resumes.
Application proof checks can require a fresh node: delivering a correction
does not guarantee that an external verifier or hook can act during an outage.
Full-block trial decryption costs scale with chain traffic; benchmark your
history and hardware.

## Maturity and contribution

This is early operator software, **not an audited wallet or a production-readiness
guarantee**. Generic tests cover encrypted notes, full-transaction/block parsing,
exact memos/amounts/receivers, reorgs, confirmation depth, durable retry/restart,
consumer handoff, receiver coverage, RPC freshness and hook cleanup. Crypto
fixtures deliberately have invalid authorization proofs/signatures/PoW: they test
observation, not chain-valid transaction submission. Automated tests do not prove
your live node's retained range, backup recovery or application accounting.

Near-term work should stay small: live-backend acceptance evidence, measured scan
throughput, bounded retention/compaction, and a well-tested lifecycle contract.
HTTP delivery can be an external hook; arbitrary application financial policy
belongs outside this package. `recipient_hex` supports address-based routing
independent of memos. The application must create and back up its invoice intent
mappings.

Licensed under [MIT](LICENSE-MIT) **or** [Apache-2.0](LICENSE-APACHE), at your choice.
CI checks this independent dependency graph against the shared Rust services
advisory, license and source policy; it does not inherit the wallet policy.
Dependencies retain their respective licenses. This package's license is independent of
other ZUU projects. No crates.io release or security audit is claimed.
