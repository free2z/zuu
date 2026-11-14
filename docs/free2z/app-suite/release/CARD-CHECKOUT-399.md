# Free2Z card checkout: exact charge and receipt acceptance

Refs [#399](https://github.com/free2z/zuu/issues/399),
[#904](https://github.com/free2z/zuu/issues/904),
[#461](https://github.com/free2z/zuu/issues/461),
[#1307](https://github.com/free2z/zuu/issues/1307).

## Scope and audited source

The public Django implementation is
[`ztripe/views.py`](../../../../py/free2z/dj/apps/ztripe/views.py),
[`fulfillment.py`](../../../../py/free2z/dj/apps/ztripe/fulfillment.py), and
[`pricing/constants.py`](../../../../py/free2z/dj/apps/pricing/constants.py).
Current pricing is **card-v3**: face value plus max(50 cents, 10% rounded up).
2,000 2Z costs 2,200 USD cents; 1 and 2 2Z cost 51 and 52 cents. The reported
5% plus $1 formula belongs to historical card-v1 transactions. New receipts
must never use its inverse.

The account billing page already reviews the durable Session quote before
redirecting. Free2Z's native `/fund` route is still a placeholder; its backend
supports only a web return, and must not request ZUULI's return mode. SDK apps
continue using account `/buy-2z` under #1307. Card/membership ownership belongs
to the content app under #904. This change hardens the **existing legacy ZUULI
card consumer** while it remains mounted; it does not extract that consumer,
add a native return rail, change SDK purchase limits, or add a wallet permission.

## Locally verifiable contract

The native consumer first saves an account-bound retry identity, then requests
the existing checkout endpoint with `Idempotency-Key` and `expected_actor_id`.
The optional header preserves old callers. It opts the native request into
validation of the actual provider Session's amount, currency, account/mode,
metadata, owner, payment state, expiry and Session URL binding. The response
adds `expires_at` and an authenticated `status_token` for the original intent.

The existing idempotency table retains `stripe-checkout` receipts permanently;
the cleanup command's finite-horizon scopes exclude it. A competing or dead
worker cannot take over an unfinished request. Before any provider write the
retry receipt records the exact durable CheckoutIntent ID. A response lost in
transit is replayed with the original Session and quote. An interrupted worker
with no completed response stays fenced for support review; retry does not
create a replacement Session or silently move a charge to another order.
Replay also rechecks the original terms against the durable intent and current
provider identity. An expired receipt correlation token can be renewed without
changing the original quote expiry or authorizing another payment.

The native review shows the returned charged cents, including fees, and exact
quantity before opening the external browser. It re-reads the original
instruction before opening; account changes, changed terms, mismatched Session
URLs and expired quotes fail closed. Double activation, restart, changed
selection and opener failure retain the original identity. A definite designed
native preflight refusal persists the web return terms for that same key before
any fallback provider write; confirmation and restart replay those exact terms. There is no
client-side inverse or purchase increment of the balance.

The original payment receipt can be checked independently of any browser/deep
link return. Its signed token binds the authenticated owner to the durable
intent. Status reports credit only for a matching transaction **and proven
original ledger issuance** using the existing issuance adapter. A historical
nominal transaction row alone stays processing. The session refresh fences state publication using the initiating token and
account generation plus caller lifetime. A late response after an account
switch, A → B → A transition or unmount cannot replace the active account or
publish a purchase toast. The already-verified original receipt remains true.
Custom schemes, HTTPS returns,
query strings, cancellation and expiry never settle money. Only verified
provider events and the existing ledger paths do that.

Tests: `test_native_card_quote.py`, the existing signed-webhook contract matrix
in `test_checkout_money_integrity.py`, `test_native_checkout_return.py`,
`pricing/tests/test_math.py` (every quantity 1..1,000,000), native
`card-purchase.test.ts`, and Chromium `card-purchase.pw.ts`. Provider boundaries
are synthetic. These are implementation evidence, **not provider acceptance**.

## Historical measurement and repair

Run the existing `reconcile_stripe_fulfillment` with a read-only database role
and the operator-recorded pre-rollout `--legacy-before` timestamp. Its default
is read-only. Preserve its coverage and expected-versus-credited findings for
review. Do not derive a cutoff from today's date, infer a card-v3 quantity with
the historical inverse, or interpret nominal transaction amounts as ledger
issuance. Existing synthetic tests cover legacy under-credit, over-credit,
impossible amounts, unknown post-cutoff rows, mismatched evidence and refusal
of unsafe repair.

`--repair` deliberately refuses: old transaction rows do not preserve signed
currency/account evidence. That refusal remains. Actual historical customer
measurement is **OPEN** because no production dataset or provider evidence was
supplied. Any affected transaction needs separately reviewed provider evidence,
original ledger allocation, and an authorized adjustment procedure with a
per-original-payment idempotency key and atomic journal/audit write. No real
customer compensation is authorized or performed by this change. A dry run is
not evidence that historical balances have been repaired.

## Live acceptance remains OPEN

Keep #399 open until an authorized signed-in staging purchase records:

1. The reviewed quantity, pricing version and total cents beside Pay with card.
2. The same original CheckoutIntent, Session and PaymentIntent at the provider,
   with the same account, currency and paid amount.
3. Verified provider event, exact transaction quantity, original ledger issuance
   (including any debt repayment), purchase event and authenticated balance.
4. Cancel, delayed webhook, duplicate delivery, restart, opener failure and
   expired-quote recovery without a second charge or a false credit message.
5. The historical drift report and disposition of every finding.

Signed-device checkout/return proof and provider/privacy-host credentials are
not available in this local validation. No live charge, provider payment write,
or production adjustment was attempted. Those operations need separate
explicit authorization. Association declarations and local source/tests do not
close this acceptance item.
