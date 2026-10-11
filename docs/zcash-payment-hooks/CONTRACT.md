# Payment event contract

[Zcash Payment Hooks](../../rs/zcash-payment-hooks/README.md) delivers JSON events to
trusted executable hooks. The core interprets shielded payment lifecycle, not memo
business instructions. All fields below are **private receiving data**; do not
send events or journals to public logs.

## Schema version 1

| Field | Meaning |
| --- | --- |
| `schema_version` | Integer `1`; reject unsupported versions |
| `journal_sequence` | Monotonic event order within this journal; not a global chain sequence |
| `event_id` | Stable idempotency key for one payment/revision/phase |
| `kind` | `payment.observed`, `payment.confirmed`, or `payment.revoked` |
| `network` | `main` or `test` |
| `block_height`, `block_hash` | Inclusion coordinate associated with this lifecycle event |
| `revision` | Receiving-note lifecycle generation; re-mining or depth loss can advance it |
| `payment.id` | `network:txid:pool:output_index`, stable across re-mining |
| `payment.txid` | Transaction ID |
| `payment.pool` | `sapling`, `orchard`, or `ironwood` |
| `payment.output_index` | Output index within that pool; never match by txid alone |
| `payment.value_zatoshis` | Exact nonnegative integer; 100,000,000 zatoshis = 1 ZEC |
| `payment.recipient_hex` | Exact 43-byte pool receiver, encoded as 86 hex characters |
| `payment.memo_hex` | All 512 memo bytes, encoded as 1,024 hex characters |

A memo is exact opaque ZIP-302 bytes. The ZIP-302 empty memo is a real observed
value, not an absent or not-yet-fetched memo. Decode and validate any application
format yourself. Avoid float arithmetic for money. Each incoming shielded note
is separate, including multiple outputs in a transaction and zero-value notes.
Internal change and outgoing viewing-key recovery are excluded; a payment to
your own external receiver is still incoming.

## Lifecycle and delivery

By default the scanner processes blocks at the configured confirmation depth.
An opted-in observation consumer enables scanning to the canonical tip; mined
observations can then precede confirmations for the same note/revision. Once
observation mode has been enabled, removing that consumer does not roll the scan
cursor backward or manufacture a reorganization.

Reorganizations retain receipts and produce revocations. A lost confirmation
depth can also revoke a previously confirmed revision while its block remains
canonical. Superseded undelivered positive events are cancelled. Re-mining or
reconfirmation produces a newer revision and a distinct event ID; historical
revocations remain meaningful even if the old block later becomes canonical.

Handlers must fence stale revisions as well as deduplicate `event_id`. A revoked
payment does not authorize a fresh credit, and the daemon cannot reverse an
external effect. Choose a refund, hold or incident policy appropriate to your
application. Confirmation depth reduces reorganization risk; it cannot eliminate
it. A canonical proof cannot prevent a fork immediately after the check.

Each consumer has an independently acknowledged queue. With fresh scanner
evidence, delivery follows queue order. Without it, positive work pauses while
already-recorded revocations can pass unrelated positive work. Revocations keep
their own sequence and retry backoff; the bypass does not execute or acknowledge
the paused positive event. Reorg cancellation explicitly marks the superseded
positive events for that payment, not unrelated work. Normal queue order resumes
when scanner readiness returns. Hooks and external proof checks can still fail
when the node is unavailable or stale; a durable correction is retried until the
hook succeeds.

Adding consumers to an existing journal is deliberate operator work: stop
writers, review existing
payments and application idempotency records, run the bounded handoff preview,
then enqueue missing work. Replaying old confirmations into a new application
without checking prior effects can duplicate business actions even though the
core faithfully delivers each event.

## CLI and library

All CLI commands require `--config /absolute/config.toml` before the subcommand.

| Command | Behavior |
| --- | --- |
| `run` | Own the exclusive writer lock, scan and deliver |
| `status` | Read-only scanner/queue/inventory diagnostics |
| `events --after SEQUENCE --limit N` | Print bounded private lifecycle events |
| `payments --after PAYMENT_ID --limit N` | Print bounded active receipts, including history suppressed by the automation floor |
| `verify-address` | Read one address on bounded stdin; prove offline viewing-key coverage without opening state |
| `verify-event EVENT_ID` | Read-only current event/journal/node evidence with a total 20-second deadline |
| `verify-payment PAYMENT_ID` | Read-only canonical receipt proof; creates no lifecycle event |
| `handoff-revocations` | Stopped-writer, bounded read-only preview of eligible unacknowledged revocations |
| `enqueue-missing` | Stopped-writer atomic handoff of missing eligible deliveries; preserves existing ACKs/retries |
| `replay CONSUMER EVENT_ID` | Stopped-writer explicit redelivery of one valid event |

`verify-address` exit zero means the proof was computed. Require
`fully_covered: true`, the expected network/UFVK/address fingerprints, zero unknown
receivers and all required pool matches. Coverage does not establish scanner
freshness or retained history. Transparent-only addresses are unsupported even
though a Unified Address can include a transparent receiver.

Read-only proofs authenticate exact persisted note/event data and viewing scope
against the node's canonical chain and freshness checks. Revocation proofs carry
zero confirmations and authenticate historical loss, not current inclusion.
Do not accept a subprocess exit code alone as payment authorization: match the
returned schema, complete event, expected receiving scope and freshness deadline.
The application must independently authenticate any account, invoice or quote.

For embedding, `chain::Chain` abstracts an observation source that returns decrypted payments; `chain::Zakura` implements
node RPC and full-block decryption. `scanner::scan` advances a `journal::Journal`
and reconciles lifecycle. `delivery::Automation::handle(&Event)` defines the
trusted idempotent effect boundary; `delivery::ExecAutomation` supplies JSON
executable delivery. `Payment`, `Event` and `PaymentRecord` are public typed data.
`Config` validates network, absolute private paths, freshness bounds and consumers.

The daemon is Unix-only. It has no HTTP listener, plugin loader, application
credential store or remote code dispatcher. Preserve the narrow boundary when
building integrations: viewing authority and observation belong here; spending,
accounting, notifications and deployment belong to their owners.
