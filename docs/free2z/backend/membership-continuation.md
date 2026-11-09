# Creator membership continuation after funding refusal

A recurring membership that is otherwise eligible receives its ordinary term
without payment when the receiving creator's funding admission refuses the
renewal. The member keeps access. Neither account receives a debit or credit,
and the complimentary term creates no amount owed or later catch-up charge.

`g12f.renew_subscription` attempts the normal transfer under its subscription
and actor row locks. Only PostgreSQL SQLSTATE `23514` with the exact primary
diagnostic `usage_daily_funding_limit` selects continuation, after the transfer
savepoint has rolled back. A displayed balance does not select this outcome.
Sender insufficient funds, cancellation, inactive actors, a price above the
authorized recurring ceiling, and unrelated database failures retain their
ordinary handling.

The transaction inserts one `SubscriptionContinuation` audit and advances
`expires` by `SUBSCRIPTION_PERIOD`, the same interval used for paid membership
extensions. The audit records the old expiry, new expiry, refusal reason,
refused price, existing recurring ceiling, and observation time. Its unique
subscription/old-expiry constraint identifies the consumed cycle. It is an
entitlement record, not a ledger transfer or a bill. `last_charged_at` and
`max_price` retain their existing values.

The expiry update bypasses model save signals. After commit, the ordinary
committed-row scheduler checks that the subscription exists and recurring
consent is positive, then enqueues the next renewal at the new expiry minus
`RENEWAL_LEAD`. The usual cycle queue lock prevents duplicate pending jobs.
Overlapping executions serialize on the subscription lock and re-read its
expiry. A cancellation prevents subsequent renewal; it does not remove access
already granted. At the next normal renewal boundary, the current price,
recurring ceiling, sender funds, and receiving admission are evaluated again.
An eligible payment buys only that next term.

## Historical terminal refusals

The recurring task does not recover expired subscriptions or overwrite a newer
purchase. The [read-only recovery preview](membership-recovery-preview.md)
prepares current-state manifests and reports evidence requirements without
granting access. A separate bounded recovery workflow is required for historical
terminal refusals, as specified in [issue #1485](https://github.com/free2z/zuu/issues/1485).
It must provide a dry run and transactionally revalidate the original refusal,
actors, subscription, cancellation, intervening purchases, and current
entitlement before granting the established ordinary interval. Conflicts must
be reported. Editing an expired row's `expires` through an admin/save path is
not a recovery procedure: it can arm a charge-bearing renewal immediately.

## Internal and test accounts

This continuation rule uses the same receiving admission guard for every
account. This implementation provides no account allowlist or funding-limit
exemption setting. Test fixtures activate the economic policy only in an
isolated test database and use synthetic accounts. Any separate operator
configuration for internal accounts needs its own reviewed contract; real
account identifiers and rollout evidence belong outside public source.
