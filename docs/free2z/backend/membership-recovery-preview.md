# Historical membership recovery preparation

`scripts/free2z/membership_recovery_preview.py` prepares a read-only review of
explicit historical renewal job IDs. It does not grant access, change recurring
consent, debit or credit accounts, retry jobs, or schedule renewals. It has no
apply option and is outside the deployed Django package.

The application and Procrastinate tables alone cannot establish the exact cause
of a historical failure. Job rows retain selectors, status, attempts, scheduling
and queue locks; event rows retain event type and time. Neither table records
the original SQLSTATE, primary diagnostic, locked actors, recurring consent,
cycle boundary, or transfer rollback evidence. A failed renewal, high current
balance, or matching timestamp therefore cannot prove a receiving-cap refusal.

Original evidence may be preserved separately. A reviewed external evidence and
decision adapter must authenticate its provenance and bind the relevant job and
attempt, subscription, actors and account epochs, exact receiving-side SQLSTATE
`23514` / `usage_daily_funding_limit` diagnostic, original term and recurring
ceiling, and rollback evidence. This preview does not ingest external evidence
or treat a caller-supplied hash or diagnostic as verified provenance.

## Prepare and revalidate

Use Python 3.12 and the backend dependencies described in
[the backend README](../../../py/free2z/README.md). Set `PYTHONPATH=py/free2z`,
explicitly select the reviewed `DJANGO_SETTINGS_MODULE`, and configure the
intended database. Use an isolated synthetic database for development; test
settings are unsuitable for an operational database. Keep generated manifests
outside the public checkout: they contain account IDs and membership history.
The IDs below are synthetic examples.

```sh
umask 077
: "${RECOVERY_REVIEW_DIR:?Select a private directory outside the checkout}"
python scripts/free2z/membership_recovery_preview.py --job-id 101 --job-id 102 \
  > "$RECOVERY_REVIEW_DIR/preview.json"
python scripts/free2z/membership_recovery_preview.py \
  --revalidate "$RECOVERY_REVIEW_DIR/preview.json" \
  > "$RECOVERY_REVIEW_DIR/revalidated.json"
```

Each invocation selects at most 50 explicit positive job IDs in one PostgreSQL
repeatable-read, read-only transaction. Each statement has a five-second timeout;
the tool checks a 30-second elapsed budget between rows. Manifest input is capped
at 1 MiB and job argument reads at 4096 bytes. Arbitrary task payloads are not
included in output. A preview inside an existing transaction is refused.
Startup uses process-private temporary heartbeat paths so inherited worker
settings cannot clear another process's liveness or draining markers.

The output reports missing or unsuitable jobs, missing memberships, inactive
actors, cancellation, current price above the recurring ceiling, active
entitlement, changed or unavailable cycle identity, pending/running renewals,
and observed later charges, payment events, or continuations. The transfer
check conservatively reports any later membership transfer from the fan;
additional evidence is needed to attribute that payment to a particular term.
These checks start at the oldest retained event for the selected job, so a
purchase before its final failed attempt is included. Retained events do not
establish the original refusal boundary or prove complete historical coverage.
Absence of a reported conflict does not establish historical eligibility.

The sorted job IDs define a stable `cohort_id`. Current observations define a
`decision_id`; revalidation reads the same selectors again and reports changed
rows and stale decisions. SHA-256 fingerprints detect content changes; they are
not signatures, authenticated evidence, or permission to restore access.
`can_apply` is always false, and the original refusal is always `unverified`.
A successful exit means the report was produced, not that recovery is eligible.

The before/after receipt covers this tool's same read-only database snapshot.
It records no mutations and identical snapshot fingerprints. Other transactions
may commit concurrently, so even a fresh unchanged preview cannot authorize a
later write without transactional revalidation.

## Remaining recovery contract

[Issue #1485](https://github.com/free2z/zuu/issues/1485) requires a separate
reviewed writer that consumes verified external evidence and a decision manifest,
locks and revalidates current membership/actors/consent, rejects intervening
purchases and entitlements, and records an idempotent zero-charge restoration
with before/after receipts. The ordinary interval is `SUBSCRIPTION_PERIOD`, also
reported as `ordinary_period_seconds`; this tool chooses no restoration anchor
and invents no replacement interval. The writer must preserve charged
timestamps and consent, create no catch-up debt or transfer, and prevent an
immediate ordinary paid renewal or duplicate chain. Replaying a failed billing
job or editing expiry through model save signals is not that procedure.

No account exemption or real-account allowlist is provided by this tool.
