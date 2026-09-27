# Buying 2Z — card, in-app purchase, Zcash

**Status:** v1 contract · **Part of:** [f2z-sdk v1](../README.md) ·
**Refs:** [#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048)

An app lets a user buy 2Z without ever handling a payment itself. The app
creates a **purchase intent** on the account API, opens the surface the
rail returns (a hosted checkout page, the platform's store sheet, or a
Zcash payment URI), and polls the intent until it is `credited`. The
platform does the verifying and the crediting; the app never sees a card
number, a store account or a Zcash key.

**Third-party apps sell 2Z by card and by Zcash in v1.** The in-app
purchase rails (§4) exist only in Free2Z's own apps: a store pays the
proceeds of an in-app product to the account that lists the app, so a
third-party listing would put the payment and the credit in different
hands, and the platform does not operate that arrangement in v1. A
third-party app on iOS or Android opens the card or Zcash surface exactly
as on desktop. **Before any third-party iOS submission, the app-store
rules on digital goods bought outside in-app purchase must be revisited
against that app's own category and jurisdiction**; this contract does not
settle that question.

2Z bought this way are platform credits ([README](../README.md)); a
purchase buys usage, and the amount of 2Z a given price buys depends on
the rail, because store fees are deducted before crediting.

## 1. Common contract

| Item | Rule |
|---|---|
| Base URL | `https://free2z.cash/api/sdk/v1` |
| Authentication | `Authorization: Bearer <access_token>` with `aud` containing `f2z-api`. Reading a balance needs `balance:read`. `purchase:create` covers creating a purchase, submitting its receipt, **reading the intents this app created** (`GET /purchases/{id}`) and reading `GET /purchases/packs` |
| Idempotency | `POST /purchases` **requires** an `Idempotency-Key` header (1–128 ASCII characters, scoped to (app, user), valid 24 h). A replay returns the original intent; a replay with a different body is `409 idempotency_conflict`. Without the header: `400 invalid_request` |
| Amounts | Whole 2Z in `_2z` fields (quantities, packs, limits); milli-2Z in `_milli_2z` fields (balances, credited amounts) — [README](../README.md#units-on-the-wire) |
| Prices | Minor units of the currency (`amount_minor`, ISO 4217 `currency`): `499` and `USD` is $4.99 |
| Errors | The envelope and codes in [errors.md](./errors.md) §6 |

### 1.1 `GET /balance`

```json
{
  "available_milli_2z": 41500,
  "held_milli_2z": 2000,
  "balance_milli_2z": 43500,
  "debt_milli_2z": 0,
  "as_of": "2026-09-26T21:04:14Z"
}
```

`available = balance − held`. `held` is the sum of open AI-call holds
([metering.md](./metering.md) §3) and is normally `0` when nothing is
streaming. `debt_milli_2z` is what the account owes after a reversal took
back 2Z that had already been spent (§3.1): while it is non-zero,
`available_milli_2z` is `0`, every spend is refused with
`403 account_in_debt`, and the next credit repays the debt before anything
reaches the balance. It is always present, never negative, and never
folded into `balance_milli_2z` — an app shows it as its own line. Apps
show `available`. Requires `balance:read`.

### 1.2 The purchase intent

```json
{
  "id": "0f6e3b2a-7c1d-4e8f-9a0b-1c2d3e4f5a6b",
  "rail": "card",
  "status": "pending",
  "quantity_2z": 500,
  "price": { "currency": "USD", "amount_minor": 500 },
  "pricing_version": "2026-09-01",
  "created_at": "2026-09-26T21:10:00Z",
  "expires_at": "2026-09-26T21:40:00Z",
  "credited_at": null,
  "credited_milli_2z": null,
  "rail_data": { "...": "rail-specific, §3–§5" }
}
```

| `status` | Meaning | Terminal |
|---|---|---|
| `created` | The intent exists; no payment surface has been opened yet (only briefly observable) | no |
| `pending` | Waiting for the user to pay | no |
| `paid` | Payment observed, not yet credited (Zcash: seen but under-confirmed) | no |
| `credited` | 2Z are on the balance: `credited_milli_2z` and `credited_at` set | yes |
| `expired` | `expires_at` passed without payment | yes |
| `failed` | The payment failed or was cancelled by the user | yes |
| `refunded`, `partially_refunded` | After crediting, the payment was refunded in full or in part; the 2Z were taken back pro rata (§6) | `refunded` yes; `partially_refunded` no |
| `disputed` | After crediting, the payment is under dispute; the 2Z were taken back and the account is frozen while it is open | no |
| `clawed_back` | After crediting, the store revoked the purchase; the 2Z were taken back | yes |

Transitions: `created → pending → paid → credited`, and from any
non-terminal state to `expired` or `failed`. `expired → paid` is allowed
on every rail: a Zcash payment after the quote (§5.3), a card
confirmation that arrives late, and an IAP receipt submitted after the
intent's 24 hours (§4.4). The post-credit states follow `credited` and
**may follow each other**: `partially_refunded → refunded`,
`partially_refunded → disputed`, `disputed → credited` (dispute won, 2Z
re-credited), `disputed → refunded` (dispute lost).

**Reversals are a net position, not a log.** An intent carries one
**line** per payment that credited it (one store transaction, one card
charge, one on-chain output — §4, §5). For each line the platform keeps
the processor's or store's *current* view: `refunded_minor` (cumulative,
as the processor reports it) and `disputed_minor` (the amount under an
open or lost dispute; `0` once a dispute is won). The 2Z taken back from
the user for a line is always recomputed as
`floor(credited_milli_2z × min(amount_minor, refunded_minor + disputed_minor) / amount_minor)`
— never more than the line credited, however the processor overlaps a
refund and a dispute on the same payment — and the ledger is moved by the
**difference** between that number and what was previously taken back,
which may be negative (a re-credit). Two rules make "set, don't add"
safe against ordering: every processor event is applied only if it is
**newer than the last event applied to that line** (by the processor's
own event sequence or timestamp), and on any event that arrives out of
order, or names a value below the one already held, the platform
**re-reads the processor's current state** for the charge and sets the
line from that rather than from the event. A notification delivered
twice, out of order, or replayed after a won dispute therefore changes
nothing; and a partial refund followed by a won dispute restores exactly
the dispute's share.

### 1.3 Polling

`GET /purchases/{id}` returns the intent. Clients poll with backoff —
2 s, 4 s, 8 s, then every 15 s — until a state that is terminal *for the
client*: `credited`, `failed`, or `expired` **with nothing seen**. A
`paid` intent is polled past `expires_at` until it settles (a Zcash
payment seen just before the quote expired still needs its
confirmations). The response carries `Retry-After` as a hint. A
`credited` intent's `credited_milli_2z` may differ from `quantity_2z` on the
Zcash rail (§5.4).

Late success after the client stopped polling — a card confirmation
that arrives after the client gave up, a Zcash payment sent after the
quote expired — is still credited on the server. An app therefore
re-reads `GET /balance` when it comes to the foreground, and may re-read
an `expired` intent it still displays; it does not poll one indefinitely.

The `hello-ai` reference app polls; a push channel is not part of v1.

## 2. `POST /purchases`

```json
{
  "rail": "card",
  "quantity_2z": 500,
  "platform": "desktop",
  "return_url": "http://127.0.0.1:49153/purchase-done"
}
```

| Field | Rules |
|---|---|
| `rail` | `card` or `zcash` for every app; `apple_iap` and `google_iap` only from Free2Z's own apps (§4), otherwise `400 rail_unavailable` |
| `quantity_2z` | Whole 2Z. **Card:** any amount from **100** ($1.00) to **10,000**. **IAP:** must equal a pack in `GET /purchases/packs` (§4.1). **Zcash:** any amount from **100** to **1,000,000** |
| `platform` | `desktop`, `ios`, `android`, `web`. Decides which surface the rail returns, and `apple_iap` / `google_iap` are refused off their platform with `400 rail_unavailable` |
| `return_url` | Card only. Where the hosted checkout sends the browser afterwards. Must be one of the app's registered redirect URIs or a loopback URI; the platform appends `?purchase_id=…&status=…` |

The response is the intent (§1.2) with `rail_data` filled for the rail.
The rail sections below give each `rail_data`.

Pricing is the platform's: **the app cannot set a price**. The `price`
for a quantity comes from the platform's published price list
(`GET /purchases/packs` for every rail's packs and the card rail's rate),
versioned by `pricing_version`; an intent locks the version it was created
under until `expires_at`.

## 3. Card

Card payments run on the payment processor's hosted surfaces. The app
never touches card data and is outside PCI scope.

`rail_data` for `platform: desktop`, `ios`, `android` — and for `web` when
the app prefers a hosted page:

```json
{ "checkout_url": "https://checkout.processor.example/c/pay/cs_live_…" }
```

The app opens `checkout_url` in the **system browser** (desktop: the default
browser; iOS/Android: `SFSafariViewController` / Custom Tabs, or the
system browser). Apple Pay, Google Pay and the processor's one-click wallet
are offered on that page where available. When the user finishes, the page
redirects to `return_url`; the app then polls the intent. **The redirect is
a convenience, not the signal**: the platform credits from the processor's
webhook, and a user who closes the browser before the redirect still gets
credited; the poll sees it.

`rail_data` for `platform: web` when the app requests an embedded form
(`"embed": true` in the request):

```json
{ "client_secret": "cs_live_…_secret_…", "publishable_key": "pk_live_…" }
```

for the processor's embedded payment element. Which processor and which
element is stated in the D2 guide; the contract here is that the app
receives what the element needs and nothing that could charge a card on
its own.

Timeouts: a card intent expires **30 minutes** after creation.

### 3.1 Refunds and disputes

If the processor refunds a charge, the platform takes the corresponding 2Z
back pro rata (`refunded` / `partially_refunded`). The reversal debits
what is available; if that does not cover it, the account carries the
difference as **debt** — reported as `debt_milli_2z` by `GET /balance`
(§1.1), repaid by the next credits before anything else, and refused with
`403 account_in_debt` on every spend until then. 2Z under an open AI-call
hold are not taken by a reversal — the hold settles normally and any
remainder is then subject to the debt. A chargeback (`disputed`) takes the
2Z back and freezes the account while the dispute is open; a dispute the
platform wins re-credits. An app sees these as intent states and as
`403 account_frozen` or `403 account_in_debt` on spending.

**Developer markup is not reversed automatically in v1.** A refund or
chargeback moves the user's 2Z as above and leaves the developer's
credit where it is: credits are fungible, and every automatic rule for
attributing a reversal to past markup that was reviewed for v1 was
either unsound or exploitable. What v1 does instead:

- **Markup is gated on manual approval of a value.** An app earns at most
  `approved_markup_bps` ([oidc.md](./oidc.md) §2), whatever `markup_bps`
  it asks for; an unapproved app is priced as if its markup were `0`,
  and the platform can lower or withdraw the approval, which takes effect
  on everyone's next hold ([metering.md](./metering.md) §2.2). The
  approval is the platform's chance to know who it is crediting, and the
  withdrawal is its first response to abuse.
- **Earnings are recorded per (user, developer)** — how much markup each
  developer earned from each user, and when — so that an administrative
  clawback under the developer terms is possible when a pattern of
  reversals shows abuse. It is a manual decision, not a ledger rule.
- **Earnings are 2Z credits only** ([metering.md](./metering.md) §2.3),
  which bounds the exposure: a clawed-back credit was never cash.
- **An authorized clawback is an ordinary reversal on the developer's
  account.** It debits what is available; whatever it cannot cover
  becomes the developer's debt on the same terms as a user's (§1.1,
  §3.1) — spending is refused with `403 account_in_debt` and the next
  credits repay it first — and it never touches the developer's open
  holds, which settle normally. Spending earnings early therefore does
  not put them beyond reach.

Automatic reversal is a **v2** item. The review of the v1 candidates
left the design constraints for it: the ratio's numerator and
denominator must be measured at the **same scope** — either the user's
**global** consumption (net of user-to-user transfers) against a global
unrecovered amount, with the result then apportioned to developers by
their share of that consumption, or both attributed to the one developer
— never a per-developer denominator under a global numerator, which
over-claws every developer the user spent little with; the denominator
is **consumption**, not lifetime purchases, because unspent credits
inflate purchases and nothing was earned on them; contributions must be
computed **per reversal event** with a fixed split at that event, never
re-derived from a running balance; the target must be **clamped to what
was earned** and can never go negative or over-claw a won dispute; and a
**developer credit earned from consumption the reversed purchase did
not fund must not be clawed** — the attribution has to follow the
credits, not the app.

## 4. In-app purchase — StoreKit 2 and Play Billing, as equals

**First-party only in v1.** These rails are used by Free2Z's own apps
(the store product belongs to Free2Z's own listing, and the store pays
Free2Z); a third-party app's `POST /purchases` with an IAP rail is
`400 rail_unavailable`. They are specified here because the SDK
implements them for those apps and because a third party reading this
contract should know exactly what its users do *not* have.

Both stores are supported on the same terms: the same intent, the same
packs concept, the same receipt endpoint, the same test matrix. Neither
lags the other. The receipt endpoint verifies every receipt against the
platform's own store identity (its bundle id / package name); a receipt
from any other listing is `422 receipt_invalid` with `reason: "app"`.

### 4.1 Packs

IAP sells **fixed packs**, because the stores require pre-registered
products. `GET /purchases/packs` (requires `purchase:create`, §1):

```json
{
  "pricing_version": "2026-09-01",
  "card": { "milli_2z_per_minor_unit": { "USD": 1000 }, "min_2z": 100, "max_2z": 10000 },
  "apple_iap": [
    { "product_id": "cash.free2z.iap.v1.0499", "quantity_2z": 349, "display_price": "$4.99" },
    { "product_id": "cash.free2z.iap.v1.0999", "quantity_2z": 699, "display_price": "$9.99" }
  ],
  "google_iap": [
    { "product_id": "iap_v1_0499", "quantity_2z": 349, "display_price": "$4.99" },
    { "product_id": "iap_v1_0999", "quantity_2z": 699, "display_price": "$9.99" }
  ],
  "zcash": { "min_2z": 100, "quote_ttl_s": 1800 }
}
```

A pack yields **fewer 2Z per unit of price than a card purchase**, because
the store's commission is deducted before crediting: the platform sets
each pack's 2Z from the pack's minimum net proceeds across the store's
regions after commission. The worked case: a $4.99 pack whose net proceeds
after a 30 % commission are $3.493 yields `floor(3.493 / 0.01) = floor(349.3)
= 349` 2Z — the floor is taken once, on the 2Z, never on the dollars —
against 499 2Z for $4.99 by card. The number is in the `packs` response;
an app shows what the response says and never computes it. Product ids
are versioned; a new pricing version adds products rather than changing
an existing one's 2Z.

### 4.2 Apple — StoreKit 2

1. `POST /purchases` with `rail: apple_iap`, `platform: ios`, and
   `quantity_2z` equal to a pack. `rail_data`:

   ```json
   { "product_id": "cash.free2z.iap.v1.0499", "app_account_token": "0f6e3b2a-7c1d-4e8f-9a0b-1c2d3e4f5a6b" }
   ```

   `app_account_token` **is the intent id**. The app passes it as
   `Product.PurchaseOption.appAccountToken` so that the store transaction
   is bound to this intent and this user.
2. The app performs the StoreKit 2 purchase of `product_id` (a consumable).
3. The app submits the signed transaction:

   ```http
   POST /purchases/{id}/receipt
   { "store": "apple", "signed_transaction": "<JWS from Transaction.jwsRepresentation>" }
   ```

   The platform verifies the JWS chain against Apple's root certificate
   and then checks, in this order, that: the `bundleId` equals the
   platform's own bundle id; the `environment` is `Production` (a `Sandbox`
   transaction is accepted only for an intent created by a registered
   test account, and credits a sandbox-flagged balance that cannot be
   spent in production); the `productId` equals the intent's; the
   `type` is a consumable; there is no `revocationDate`; and the
   `appAccountToken` equals the intent id. Each failure is
   `422 receipt_invalid` with its `reason`. Then it credits — keyed on the
   transaction's `transactionId`, so the same transaction can never credit
   twice — and returns the intent as `credited`. Then — and only then —
   the app calls `Transaction.finish()`.

   Resubmitting the same transaction for the same intent answers `200`
   with the intent (`credited`) again; that is how an app whose first
   response was lost learns it may finish. A transaction the platform
   never saw stays unfinished and is re-delivered by StoreKit on the next
   launch; the app submits it against the intent whose id is its
   `appAccountToken`. `409 receipt_already_used` is reserved for a
   transaction that credited a **different** intent. A **second, distinct**
   transaction carrying the same `appAccountToken` (an app that reused an
   intent id for two purchases) is credited as a second **line** on the
   same intent — the store took the payment, so refusing it would strand a
   paid purchase — and each line reverses independently (§1.2). An app
   SHOULD create one intent per purchase regardless.
4. Refunds and revocations arrive from Apple's server notifications and
   move the intent to `refunded` or `clawed_back` (§6).

### 4.3 Google — Play Billing

1. `POST /purchases` with `rail: google_iap`, `platform: android`.
   `rail_data`:

   ```json
   { "product_id": "iap_v1_0499", "obfuscated_account_id": "0f6e3b2a-7c1d-4e8f-9a0b-1c2d3e4f5a6b" }
   ```

   The app passes `obfuscated_account_id` (the intent id) as
   `setObfuscatedAccountId` on the billing flow.
2. The app launches the Play Billing flow for `product_id` (a consumable
   in-app product).
3. The app submits the purchase token:

   ```http
   POST /purchases/{id}/receipt
   { "store": "google", "purchase_token": "<Purchase.getPurchaseToken()>" }
   ```

   The platform verifies the purchase with Google's API against the
   platform's own package name and checks the product id and obfuscated
   account id. A purchase Google marks as a **test** purchase
   (`purchaseType` = test, from a licence-tester account) is treated
   exactly as Apple's `Sandbox`: accepted only for an intent created by a
   registered test account, crediting a sandbox-flagged balance that
   cannot be spent in production, `422 receipt_invalid` with
   `reason: "environment"` otherwise. Then:

   - `purchaseState` **pending** (the user chose a deferred payment
     method): nothing is credited. The endpoint answers `202` with the
     intent still `pending` and `rail_data.store_state: "pending"`; the
     platform completes it from Google's real-time notification when the
     payment lands, or the app resubmits later. An intent with a pending
     store purchase is polled like any `pending` intent.
   - `purchaseState` **purchased**: the platform credits — keyed on the
     `orderId`, so the same purchase can never credit twice — and then
     **consumes** the purchase server-side. The credit and the obligation
     to consume are recorded together, and the consume is retried by the
     platform until Google acknowledges it, independently of any further
     request from the app; a crash between crediting and consuming cannot
     leave a purchase unconsumed for Play to refund.

   The app does **not** call `consumeAsync` itself. Resubmitting the same
   purchase token for the same intent answers `200` with the intent
   (`credited`) — and re-attempts the consume if it is still owed;
   `409 receipt_already_used` is reserved for a token that credited a
   different intent. A purchase that was not consumed is re-delivered by
   Play on the next launch, and the app submits it against the intent
   whose id is its obfuscated account id. A second, distinct purchase
   bound to the same intent id becomes a second line on the intent,
   exactly as for Apple.
4. Refunds and voided purchases arrive from Google's real-time developer
   notifications and the voided-purchases feed and move the intent to
   `refunded` or `clawed_back`.

### 4.4 Receipt endpoint, both stores

`POST /purchases/{id}/receipt` requires `purchase:create`, the same user
and app as the intent, and an intent in any state but `failed` — a
reversal state does not refuse a receipt, because a second paid
transaction bound to the intent (§4.2) or a lost first response must
still be able to complete; a new transaction becomes a new line, and
resubmitting a reversed line's transaction answers `200` with the intent
as it is. Answers: `200` with the intent (`credited` — including on
resubmission), `202` with the intent (`pending`, Google deferred
payment), `422 receipt_invalid`, `409 receipt_already_used` (another
intent), `409 intent_not_pending` (the intent is `failed`),
`503 store_unavailable` (retryable). An IAP
intent expires **24 hours** after creation for the purpose of the app's
UI; a verifying receipt for an expired intent is still credited, because
the store already took the payment.

## 5. Zcash

A Zcash purchase is a payment to a **per-purchase address**. Every intent
gets its own unified address, so the platform matches a payment by *where
it arrived*, not by a memo; the user need not type anything.

### 5.1 Create

`POST /purchases` with `rail: zcash` and, in this example,
`quantity_2z: 5000` (5,000 2Z). `rail_data`:

```json
{
  "address": "u1…",
  "amount_zat": 100000000,
  "zip321_uri": "zcash:u1…?amount=1.0&message=Free2Z%202Z%20purchase",
  "rate": { "zec_per_2z": "0.00020000", "locked_until": "2026-09-26T21:40:00Z" },
  "confirmations_required": 3,
  "min_credit_2z": 1
}
```

| Field | Meaning |
|---|---|
| `address` | A fresh unified address for this intent only. Sending to it twice credits twice (§5.4) |
| `amount_zat` | The exact amount in zatoshi at the locked rate |
| `zip321_uri` | A [ZIP 321](https://zips.z.cash/zip-0321) payment request. The SDK renders it as a QR and as an "open in wallet" link |
| `rate.locked_until` | The quote lock, **30 minutes** from creation |
| `confirmations_required` | `3` |

### 5.2 Pay

The user pays from any Zcash wallet. The platform observes incoming
payments with a viewing key — it can see the payment, and holds no key that
could spend from the address.

### 5.3 States

- An output to the address seen in a block, or in the mempool, at fewer
  than 3 confirmations → `paid`, with `rail_data.confirmations` counting
  up (mempool = 0).
- 3 confirmations → `credited`.
- Nothing seen by `expires_at` (the quote lock, 30 minutes) → `expired`.
  **A payment that arrives after expiry is still credited** (§5.4); the
  intent moves from `expired` back to `paid` then `credited`.
- **Reorganisation.** An output that was credited at 3 confirmations
  and then disappears from the chain is **not** taken back from the
  user; the loss is the platform's, and three confirmations is the depth
  chosen to make it rare. An output that was `paid` (under 3
  confirmations) and disappears returns the intent to its previous state.
  If the same output is later re-mined it is the same payment — a
  payment's identity is its transaction id and output position, and that
  identity never credits twice, across rescans or reorganisations.

### 5.4 Amount rules

Each output to the address is valued separately, **at the moment the
platform first observes it** (mempool or block, whichever is first), and
credited when it reaches 3 confirmations:

| Case | Credited |
|---|---|
| Exact | `quantity_2z` |
| Over- or underpayment | Pro rata at the locked rate, rounded **down** to a whole milli-2Z: `credited_milli_2z = floor(received_zat × quantity_2z × 1000 / amount_zat)` (the `× 1000` converts the whole-2Z quantity to milli-2Z before the one floor) |
| First observed after `locked_until` | At the **better for the platform** of the locked rate and the rate current at first observation: `min(locked, current)` 2Z per ZEC, pro rata as above |
| Several outputs to the same address | Each is a separate line valued at its own first observation; the intent's `credited_milli_2z` is their sum, and `rail_data.payments[]` lists them |
| An output below `min_credit_2z` (1 2Z) | Held on the intent, uncredited, and **aggregated**: once the sum of uncredited outputs on the intent reaches 1 2Z they are credited together at their individual rates. Until then `rail_data.below_minimum_zat` shows the running total |

The rate itself comes from the platform's exchange-rate aggregation and
includes a spread; it is quoted, not negotiated, and the intent shows it.

## 6. What an app can rely on

- **Crediting is idempotent per store transaction / on-chain output.** No
  payment credits twice, however many times a receipt is submitted, a
  notification is delivered, or a poll runs.
- **The balance is the truth.** After `credited`, `GET /balance` reflects
  it. An app should re-read the balance rather than add `credited_milli_2z`
  locally.
- **Post-credit reversals are visible.** `refunded`,
  `partially_refunded`, `disputed` and `clawed_back` appear on the intent
  and on the balance; an app that caches balances must expect them to go
  down.
- **The app never sets a price** and never holds a payment credential.
- **iOS and Android are symmetric.** Any behaviour available on one store
  rail is available on the other; a difference is a defect. For a
  third-party app that symmetry is card and Zcash on both.
