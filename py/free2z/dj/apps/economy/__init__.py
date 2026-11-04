"""Two-bucket economic foundation.

Usage remains the existing m2Z ledger. CreatorPayable is a separate, strictly
nonnegative USD contractual liability with immutable journal history. Refund
recovery exceeding an owed balance is refused and requires a separately
classified recovery claim; it must never be shown as negative earnings.

Production policy activation is deliberately blocked by the initial migration.
Product/gateway admission, funding, delivery and canonical-agreement adapters
must be independently reviewed and deployed before a later migration installs
a cutover capability. No schedules, contracts or screenings are fabricated or
seeded as effective. Staff must verify and bind a stable legal payee before
actual user acceptance. Received/gifted usage never creates a payable.

PurchaserDay initially aggregates one authenticated purchaser principal across
recipients/apps/devices. It is NOT universal real-person identity resolution;
linked payment/purchaser provenance and monitoring are an integration gate.
SDK/PPV event allocations under an accepted schedule can include a platform
subsidy: compensation must not be suppressed merely because credits were
promotional. The delivery evidence records allocation and any subsidy basis.

FundingReservation resolution preserves externally captured funds when limits
refuse fulfillment, including during a writer fence or account inactivation.
Resolution never issues hidden excess credits. Existing valid legacy rights
are classified separately; usage_snapshot_m2z is evidence, not a USD award.

Payment signing admission requires an outermost durable transaction; provider
I/O starts only after it returns. Approved screening refresh appends reviewed
observations before signing while original approval evidence stays immutable.
Unsupported withholding and creator-paid network fees refuse signing without
erasing debt. Migration DDL has transaction-local 5s lock/60s statement limits
before its first schema operation, so contention aborts instead of queuing the
live ledger indefinitely; deployment must retry after resolving the blocker.
"""
