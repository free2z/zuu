# Free2Z sweep policy and payment diagnostics

`py/free2z/zcashrpc/sweep_policy.py` contains validation and read-only wallet
queries. `verify_payment.py` locates a payment across the wallet, credit adapter,
purchase memo, recipient and credit receipt. Neither module signs, broadcasts,
issues credits or modifies a database.

Run the synthetic tests from the repository root:

```sh
PYTHONPATH=py/free2z python3 -m unittest \
  zcashrpc.test_sweep_policy zcashrpc.test_verify_payment
```

The tests use the Python standard library and temporary SQLite files. They need
no wallet daemon, service credentials or network connection.

## Sweep policy contract

All integer amounts are zatoshis, with 100,000,000 zatoshis per ZEC. Inputs must
be integers in `0..2**64-1`; booleans, floats and numeric strings are rejected.
`zec_to_zats` accepts decimal display text with exactly eight fractional digits,
optional whitespace and an alphabetic ticker. It never rounds.

- `json_u64` reads one top-level field from a complete JSON object and rejects
  duplicate keys, including duplicates in nested objects.
- `shielded_spendable` sums Sapling, Orchard and Ironwood spendable amounts.
  Transparent outputs require a separate shielding operation.
- `sweep_value` applies an explicit threshold, reserve and maximum. `next_reserve`
  computes the next bounded reserve after an unsuccessful proposal attempt.
- `validate_proposal` requires exactly one step, one payment, one indexed
  recipient and one fee. The recipient must equal the supplied destination and
  pass its supplied bech32m prefix/checksum. The fee must fit the supplied reserve.
  A checksum is not receiver validation. The devtool must interpret the receiver
  and the caller must independently establish the correct destination.
- `spend_rows` requires the spend tables for all four pools. Missing tables are
  errors. `tx_fee_zats` queries both display and internal transaction ID byte
  order. Missing, invalid or ambiguous fee evidence returns `None`.

`classify_send` describes evidence; it does not authorize another send:

| Send status | Wallet spend rows | Result |
| --- | --- | --- |
| Success | Increased; fee within reserve | `confirmed` |
| Success | Increased; fee unreadable | `fee-unverified` |
| Success | Increased; fee above reserve | `fee-breach` |
| Failure | Unchanged | `failed-no-spend` |
| Either | Unreadable or decreased | `unresolved` |
| Success | Unchanged | `unresolved` |
| Failure | Increased | `unresolved` |

These inferences require a wallet implementation that commits transaction/spend
rows before broadcast, and a controller that serializes all spenders against an
unchanged wallet. Counts cannot attribute a concurrent writer's transaction.
Balance changes cannot establish whether a send occurred because deposits can
arrive concurrently. A successful send's fee may differ from its proposal: a
send can select its own inputs after confirmation.

Deployment controllers own destination pins, keys, account selection, scan/tip
checks, locks, deadlines, confirming-proposal ordering, durable in-flight
markers, fee-breach latches and retry policy. They must preserve an unresolved
marker and must durably establish a fee-breach latch before clearing that marker.
The public helpers do not implement those controls.

## Payment diagnostics

The command uses the canonical `zcashrpc.wallet_sqlite_client` package. It does
not discover an infrastructure checkout or load a Python adapter by file path.
Supply all wallet selection settings explicitly:

```sh
PYTHONPATH=py/free2z python3 -m zcashrpc.verify_payment \
  --wallet-db /absolute/path/to/data.sqlite \
  --wallet-account 5 --min-confirmations 3 \
  --username fixture-user --no-db
```

The account, confirmation depth and username above are examples. Use the settings
of the credit adapter being diagnosed. `--txid` selects a lowercase 32-byte hex
transaction ID in display order. `--amount` accepts an exact nonnegative amount
in ZEC representable as whole zatoshis. A username selects notes only when
neither a transaction ID nor an amount is supplied; otherwise it checks the
selected purchase memos and requires every selected purchase recipient to match.

For recipient and credit checks, replace `--no-db` with
`--database-service SERVICE_NAME`. The command requires `psycopg2` and the
operator's explicit libpq service configuration. It opens a read-only PostgreSQL
session. Credentials belong in the operator's configuration, never in public
source or command examples. Diagnostic output includes payment IDs and usernames;
it is private operational evidence.

Library callers can pass an adapter and an explicit query boundary to
`diagnose`. `Database(connection)` issues SELECTs and leaves ownership of a
borrowed connection with the caller, who must configure it read-only.
`canonical_client` temporarily sets the environment used by the adapter's
constructor and restores it; this convenience function is for a single-threaded
CLI. Its narrow adapter subclass opens SQLite through the encoded read-only
connection helper. Concurrent applications should supply an already configured adapter.

Exit codes are `0` for all evaluated stages passing, `1` for any failed stage,
and `2` for an incomplete result without a failure. `--no-db` therefore returns
`2`, including when the wallet, adapter and memo checks pass. Notes held for
confirmations are inconclusive. A backfilled receipt, mismatched recipient or
mismatched amount fails credit verification. The recorded quantity must equal
amount times rate, rounded half-even to the credit column's 0.001 precision.
This arithmetic check does not audit ledger balance conservation. A legacy processing marker with
purchase events is inconclusive because those events cannot be linked to that
transaction. No diagnostic result is an instruction to replay a payment or
manually issue credit.

## Extraction compatibility

Valid decimal displays, one-payment proposals, txid byte order and established
receipt/replay outcomes retain their units and meaning. The public interfaces
intentionally reject or qualify ambiguous input that permissive shell or older
diagnostic parsing could accept:

- JSON must be complete, unique-keyed and contain an actual bounded integer;
  parsing a digit prefix from malformed JSON is forbidden.
- Decimal displays cannot contain numeric suffixes, trailing punctuation or
  overflow. Diagnostic selectors cannot round fractions of a zatoshi.
- Additional step/payment headers invalidate a proposal even when a separate
  header declares one step/payment.
- Decreasing spend-row counts are unresolved; they do not prove a safe retry.
- Multiple transaction rows matching opposite byte orders leave the fee
  unverified; no arbitrary row is selected.
- Pending notes without receipts are inconclusive even when a credit database
  is supplied. An unrelated pool's pending note cannot explain an absent note.
- An explicit username must match every selected purchase memo, including
  multi-output transactions and amount selections spanning multiple recipients.
- Incorrect credit quantities fail; missing quantities or rates are inconclusive.
- A credit receipt without an amount is inconclusive; its identity alone cannot
  prove which payment was credited. Invalid recipient types fail memo checking.
- Wallet paths are encoded as file URIs and opened read-only, so `?` and `#`
  in a filename cannot change SQLite connection options. Discovered table names
  are SQL-quoted before querying.

Adopting these helpers in a deployment controller requires review and tests of
that controller's private safety controls. Unit tests establish portable policy
behavior, not the correctness of a live send or deployment.
