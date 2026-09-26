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

2Z bought this way are platform credits ([README](../README.md)); a
purchase buys usage, and the amount of 2Z a given price buys depends on
the rail, because store fees are deducted before crediting.

## 1. Common contract

| Item | Rule |
|---|---|
| Base URL | `https://free2z.cash/api/sdk/v1` |
| Authentication | `Authorization: Bearer <access_token>` with `aud` containing `f2z-api`. Reading a balance needs `balance:read`; creating or completing a purchase needs `purchase:create` |
| Idempotency | `POST /purchases` **requires** an `Idempotency-Key` header (1–128 ASCII characters, scoped to (app, user), valid 24 h). A replay returns the original intent; a replay with a different body is `409 idempotency_conflict`. Without the header: `400 invalid_request` |
| Amounts | Milli-2Z integers (`_m2z`). Purchase quantities are whole 2Z, so multiples of `1000` |
| Prices | Minor units of the currency (`amount_minor`, ISO 4217 `currency`): `499` and `USD` is $4.99 |
| Errors | The envelope and codes in [errors.md](./errors.md) §6 |

### 1.1 `GET /balance`

```json
{
  "available_m2z": 41500,
  "held_m2z": 2000,
  "balance_m2z": 43500,
  "as_of": "2026-09-26T21:04:14Z"
}
```

`available = balance − held`. `held` is the sum of open AI-call holds
([metering.md](./metering.md) §3) and is normally `0` when nothing is
streaming. Apps show `available`. Requires `balance:read`.

### 1.2 The purchase intent

```json
{
  "id": "0f6e3b2a-7c1d-4e8f-9a0b-1c2d3e4f5a6b",
  "rail": "card",
  "status": "pending",
  "quantity_m2z": 500000,
  "price": { "currency": "USD", "amount_minor": 500 },
  "pricing_version": "2026-09-01",
  "created_at": "2026-09-26T21:10:00Z",
  "expires_at": "2026-09-26T21:40:00Z",
  "credited_at": null,
  "credited_m2z": null,
  "rail_data": { "...": "rail-specific, §3–§5" }
}
```

| `status` | Meaning | Terminal |
|---|---|---|
| `created` | The intent exists; no payment surface has been opened yet (only briefly observable) | no |
| `pending` | Waiting for the user to pay | no |
| `paid` | Payment observed, not yet credited (Zcash: seen but under-confirmed) | no |
| `credited` | 2Z are on the balance: `credited_m2z` and `credited_at` set | yes |
| `expired` | `expires_at` passed without payment | yes |
| `failed` | The payment failed or was cancelled by the user | yes |
| `refunded`, `partially_refunded` | After crediting, the payment was refunded; the 2Z were taken back pro rata (see §6) | yes |
| `disputed` | After crediting, the payment is under dispute; the 2Z were taken back and the account is frozen while it is open | no |
| `clawed_back` | After crediting, the store revoked the purchase; the 2Z were taken back | yes |

Transitions: `created → pending → paid → credited`, and from any
non-terminal state to `expired` or `failed`. The post-credit states only
follow `credited`.

### 1.3 Polling

`GET /purchases/{id}` returns the intent. Clients poll with backoff —
2 s, 4 s, 8 s, then every 15 s — until a terminal state or `expires_at`.
The response carries `Retry-After` as a hint. A `credited` intent's
`credited_m2z` may differ from `quantity_m2z` on the Zcash rail (§5.4).

The `hello-ai` reference app polls; a push channel is not part of v1.

## 2. `POST /purchases`

```json
{
  "rail": "card",
  "quantity_m2z": 500000,
  "platform": "desktop",
  "return_url": "http://127.0.0.1:49153/purchase-done"
}
```

| Field | Rules |
|---|---|
| `rail` | `card`, `apple_iap`, `google_iap`, `zcash` |
| `quantity_m2z` | Whole 2Z. **Card:** any amount from **100,000** (100 2Z, $1.00) to **10,000,000** (10,000 2Z). **IAP:** must equal a pack in `GET /purchases/packs` (§4.1). **Zcash:** any amount from **100,000** |
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
{ "checkout_url": "https://checkout.example-processor.com/c/pay/cs_live_…" }
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
back pro rata (`refunded` / `partially_refunded`). If the user's balance
no longer covers it, the account carries the difference as a debt that
future credits repay first, and the account cannot spend until then. A
chargeback (`disputed`) takes the 2Z back and freezes the account while
the dispute is open; a dispute the platform wins re-credits. An app sees
these as intent states and as `403 account_frozen` on spending.

## 4. In-app purchase — StoreKit 2 and Play Billing, as equals

Both stores are supported on the same terms: the same intent, the same
packs concept, the same receipt endpoint, the same test matrix. Neither
lags the other.

### 4.1 Packs

IAP sells **fixed packs**, because the stores require pre-registered
products. `GET /purchases/packs` (no scope beyond a valid token):

```json
{
  "pricing_version": "2026-09-01",
  "card": { "m2z_per_minor_unit": { "USD": 1000 }, "min_m2z": 100000, "max_m2z": 10000000 },
  "apple_iap": [
    { "product_id": "cash.free2z.iap.v1.0499", "quantity_m2z": 349000, "display_price": "$4.99" },
    { "product_id": "cash.free2z.iap.v1.0999", "quantity_m2z": 699000, "display_price": "$9.99" }
  ],
  "google_iap": [
    { "product_id": "iap_v1_0499", "quantity_m2z": 349000, "display_price": "$4.99" },
    { "product_id": "iap_v1_0999", "quantity_m2z": 699000, "display_price": "$9.99" }
  ],
  "zcash": { "min_m2z": 100000, "quote_ttl_s": 1800 }
}
```

A pack yields **fewer 2Z per unit of price than a card purchase**, because
the store's commission is deducted before crediting: the platform sets
each pack's 2Z from the pack's minimum net proceeds across the store's
regions after commission. The worked case: a $4.99 pack whose net proceeds
after a 30 % commission are $3.49 yields `floor(3.49 / 0.01) = 349` 2Z
(`349000` m2Z), against 499 2Z for $4.99 by card. The number is in the
`packs` response; an app shows what the response says and never computes
it. Product ids are versioned; a new pricing version adds products rather
than changing an existing one's 2Z.

### 4.2 Apple — StoreKit 2

1. `POST /purchases` with `rail: apple_iap`, `platform: ios`, and
   `quantity_m2z` equal to a pack. `rail_data`:

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

   The platform verifies the JWS against Apple's root, checks the product
   id and that the transaction's `appAccountToken` equals the intent id,
   credits, and returns the intent as `credited`. Then — and only then —
   the app calls `Transaction.finish()`. A transaction the platform never
   saw stays unfinished and is re-delivered by StoreKit on the next launch;
   submitting it again is idempotent (`receipt_already_used` if it was in
   fact credited, with `details.purchase_id`).
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

   The platform verifies the purchase with Google's API, checks the product
   id and obfuscated account id, credits, and **consumes** the purchase
   server-side. The app does **not** call `consumeAsync` itself; a purchase
   that was not consumed is re-delivered by Play, and resubmitting is
   idempotent exactly as for Apple.
4. Refunds and voided purchases arrive from Google's real-time developer
   notifications and the voided-purchases feed and move the intent to
   `refunded` or `clawed_back`.

### 4.4 Receipt endpoint, both stores

`POST /purchases/{id}/receipt` requires `purchase:create`, the same user
and app as the intent, and an intent in `pending` (or `paid`, for a
retry). Answers: the intent (`credited`), `422 receipt_invalid`,
`409 receipt_already_used`, `409 intent_not_pending`,
`503 store_unavailable` (retryable). An IAP intent expires **24 hours**
after creation; a receipt for an expired intent is still accepted if it
verifies, because the store already took the money.

## 5. Zcash

A Zcash purchase is a payment to a **per-purchase address**. Every intent
gets its own unified address, so the platform matches a payment by *where
it arrived*, not by a memo; the user need not type anything.

### 5.1 Create

`POST /purchases` with `rail: zcash`. `rail_data`:

```json
{
  "address": "u1…",
  "amount_zat": 100000000,
  "zip321_uri": "zcash:u1…?amount=1.0&message=Free2Z%202Z%20purchase",
  "rate": { "zec_per_2z": "0.00020000", "locked_until": "2026-09-26T21:40:00Z" },
  "confirmations_required": 3,
  "min_credit_m2z": 1000
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

- Payment seen in the mempool or at fewer than 3 confirmations → `paid`,
  with `rail_data.confirmations` counting up.
- 3 confirmations → `credited`.
- Nothing seen by `expires_at` (the quote lock, 30 minutes) → `expired`.
  **A payment that arrives after expiry is still credited** (§5.4); the
  intent moves from `expired` back to `paid` then `credited`.

### 5.4 Amount rules

| Case | Credited |
|---|---|
| Exact | `quantity_m2z` |
| Over- or underpayment | Pro rata at the locked rate, rounded **down** to a whole milli-2Z: `credited_m2z = floor(received_zat / amount_zat × quantity_m2z)` |
| Late (after `locked_until`) | At the **better for the platform** of the locked rate and the current rate: `min(locked, current)` 2Z per ZEC |
| Below `min_credit_m2z` (1 2Z) | Not credited; the intent shows `paid` with `rail_data.below_minimum: true` and the platform's support process handles it |
| A second payment to the same address | Credited as a second line on the same intent at the current rate |

The rate itself comes from the platform's exchange-rate aggregation and
includes a spread; it is quoted, not negotiated, and the intent shows it.

## 6. What an app can rely on

- **Crediting is idempotent per store transaction / on-chain output.** No
  payment credits twice, however many times a receipt is submitted or a
  poll runs.
- **The balance is the truth.** After `credited`, `GET /balance` reflects
  it. An app should re-read the balance rather than add `credited_m2z`
  locally.
- **Post-credit reversals are visible.** `refunded`,
  `partially_refunded`, `disputed` and `clawed_back` appear on the intent
  and on the balance; an app that caches balances must expect them to go
  down.
- **The app never sets a price** and never holds a payment credential.
- **iOS and Android are symmetric.** Any behaviour available on one store
  rail is available on the other; a difference is a defect.
