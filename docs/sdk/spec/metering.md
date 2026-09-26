# Metering — hold, stream, settle

**Status:** v1 contract · **Part of:** [f2z-sdk v1](../README.md) ·
**Refs:** [#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048),
[#1049](https://github.com/free2z/zuu/issues/1049) (`price_2z()`)

Every AI call is paid for in 2Z with **cost-plus** pricing: the provider's
cost, plus the platform margin, plus the app's markup, **rounded up once to
a whole 2Z at the total**, and never below a per-model minimum. This
document is the contract for how that number is computed, when it is
reserved, when it is charged, and what happens in every failure case. The
same formula is implemented three times — in the ledger, in the gateway's
estimate, and in `f2z-ai-proto::price_2z()` for SDKs — and shared fixtures
prove the three agree to the milli-2Z.

## 1. Units

| Quantity | Unit | Representation |
|---|---|---|
| Provider cost | **nano-USD** (`nUSD`, 10⁻⁹ USD) | integer, internal — never on the public wire |
| Amounts of 2Z | **milli-2Z** (`m2Z`, 10⁻³ 2Z) | integer, every `_m2z` field |
| Rates | milli-2Z per million tokens (`_m2z_per_mtok`) or per unit (`_m2z_each`) | integer |
| Margin and markup | basis points (bps, 1/100 of a percent) | integer |

Anchors: **1 2Z = $0.01 = 10,000,000 nUSD**, so **1 m2Z = 10,000 nUSD**.
Every computation is exact integer arithmetic; there are no floats anywhere
in the money path, and rounding happens at exactly one point (§2.2).

## 2. The formula

### 2.1 Cost

The provider cost of a call is the sum over the usage the provider
reported, each multiplied by that model's catalogue price for it:

```
cost_nusd = input_tokens        × in_nusd_per_tok
          + cached_input_tokens × cached_nusd_per_tok
          + cache_write_tokens  × cache_write_nusd_per_tok
          + output_tokens       × out_nusd_per_tok        (output includes reasoning)
          + images              × image_nusd_each
          + tool_calls          × tool_call_nusd_each
```

Provider prices live in the signed catalogue the gateway loads; clients
never see them — `/v1/models` publishes the *marked-up* prices of §2.4.

### 2.2 Price

With `m` = the platform margin in bps and `b` = the app's markup in bps
(both properties of the catalogue and the registration, never of a
request):

```
p = cost × (1 + m/10000)                     the platform price
d = p × b/10000                              the developer's markup
charged_2z = max(min_charge_2z, ceil(p + d)) rounded ONCE, at the total, to a whole 2Z
```

In exact integers, with `N = cost_nusd × (10000 + m) × (10000 + b)`:

```
charged_m2z = 1000 × max(min_charge_2z, ceil(N / 10¹⁵))
```

(`10¹⁵ = 10⁴ × 10⁴ × 10⁷`: the two bps denominators and nUSD-per-2Z.)

There is no rounding of the input estimate, of per-token prices, of `p`, or
of `d` on the way to `charged_m2z`. **A per-token price that would round
to zero in some unit does not exist here** because nothing is rounded until
the total.

### 2.3 Splits

The charge is divided three ways, in milli-2Z, and the three parts sum to
the charge exactly:

```
provider_m2z  = ceil(cost_nusd / 10⁴)                            what the call cost
developer_m2z = floor(cost_nusd × (10000 + m) × b / 10¹²)        the markup, credited to the developer
platform_m2z  = charged_m2z − provider_m2z − developer_m2z       the rest, including the round-up
```

Properties, each pinned by a test in every implementation:

- `platform_m2z ≥ 0` for every cost and every `m, b ≥ 0`. (The proof: the
  round-up is at least `p + d`, which is at least `cost + d`; the provider
  part exceeds cost by less than 1 m2Z; the developer part does not exceed
  `d`; and the result is an integer.)
- `charged_m2z × $0.01 / 1000 ≥ provider cost` — **a call is never sold
  below cost**, before margin.
- `developer_m2z` never exceeds `d`: the developer is never credited the
  round-up surplus, which belongs to the platform.
- Rounding happens once: `charged_m2z` computed from the sum equals
  `charged_m2z` computed from the parts — there is no path where components
  are rounded and then added.

The developer's `developer_m2z` is credited to the developer's own Free2Z
account, as 2Z. Anything beyond that credit is governed by the developer
terms, not this contract.

### 2.4 What `/v1/models` publishes

Every price in `/v1/models` ([chat-api.md](./chat-api.md) §5) is the
provider price with margin and the calling app's markup already applied:

```
published_m2z_per_mtok = provider_usd_per_mtok × 100 × 1000 × (1 + m/10000) × (1 + b/10000)
```

so that a client's own estimate is `Σ usage × published rate`, rounded up
once to a whole 2Z, and agrees with the ledger.

## 3. The lifecycle

```
   client          gateway                       ledger              provider
     │  POST /v1/chat  │                            │                    │
     │────────────────▶│ estimate input, clamp out  │                    │
     │                 │ hold(worst case) ─────────▶│ reserve or refuse  │
     │                 │◀───────────────────────────│ held / insufficient│
     │  meta           │ request ──────────────────────────────────────▶ │
     │◀────────────────│                            │                    │
     │  delta…         │◀───────────────────────────────────────────────│
     │◀────────────────│ (extend hold every 60 s)   │                    │
     │  usage          │◀─ usage ───────────────────────────────────────│
     │                 │ settle(usage) ────────────▶│ charge, release    │
     │  done           │◀───────────────────────────│ charged, balance   │
     │◀────────────────│                            │                    │
```

Three ledger operations carry the whole contract. They are the **only**
way 2Z move for an AI call, and the ledger is the only authority on whether
they may ([ADR 0002](../../ai-gateway/adr/0002-hold-functions-single-balance-authority.md)).

| Operation | Effect | Answers |
|---|---|---|
| **hold**(user, app, `amount_m2z`, idempotency key, ttl) | Atomically: check the account is not frozen, the grant is live (epoch and generation current), `available ≥ amount`, and `cap_remaining ≥ amount`; then reserve `amount`. All or nothing, in one operation; there is no window in which the balance was checked but not yet reserved | `held` (with `hold_id`, `available_m2z`, `expires_at`), `replayed` (same key → same hold), `insufficient`, `cap_exceeded`, `frozen`, `too_many_holds` (more than 16 open holds on one account) |
| **extend**(`hold_id`, `add_m2z`, ttl) | Push the expiry out and, optionally, reserve more. The gateway extends every **60 s** during a stream, and reserves more when the stream's output has consumed **80 %** of what the hold was computed for. An extension that cannot be afforded leaves the hold as it was — the stream continues and may end in a write-off (§5.5) | as **hold** |
| **settle**(`hold_id`, `cost_nusd`, catalogue version, usage) | Compute `charged_m2z` by §2 from `cost_nusd` and the versioned rates, charge it, release the rest of the hold, credit the splits, record the call. **Idempotent** per `hold_id`: a second settle returns the first result and moves nothing. **Never fails** for lack of balance (§5.5) | `charged_m2z`, `shortfall_m2z`, `balance_m2z` |
| **release**(`hold_id`) | Release the whole hold; nothing charged. Idempotent | — |

Two invariants a user can observe:

- **Exactly one settlement per call.** Settling is keyed on the hold, and
  the hold on the (app, user, idempotency key) of the call. A retried
  settle, a gateway restart mid-stream, or a rolling deploy cannot charge
  twice, and cannot skip: an unsettled hold **expires** (§5.6).
- **The hold is the ceiling** (except §5.5): `charged_m2z ≤ hold_m2z` after
  extensions, and `charged_m2z + released_m2z = hold_m2z`.

## 4. The hold amount and the output clamp

Before the provider is called, the gateway computes the **worst case**:

```
input_est   = tokenise(messages) × safety_factor      (exact tokeniser ⇒ factor 1.0)
out_cap     = min(max_output_tokens, context_window − input_est, affordable)
hold_m2z    = price(input_est, out_cap, images, tool_budget)    by §2, rounded up
```

`tool_budget` is `min(len(tools), 8)` tool calls when the catalogue prices
them per call, else 0. Cache prices are not part of the hold (a cache hit
only makes a call cheaper).

**`affordable`** is the largest `out` such that
`price(input_est, out, …) ≤ min(available_m2z, cap_remaining_m2z)`. The
price is monotonic in `out`, so this is a bounded search. When even
`out = 1` — or the model's `min_charge_m2z` — does not fit, the call is
refused: `402 insufficient_balance` when the balance is the binding limit,
`403 cap_exceeded` when the cap is. `POST /v1/chat/estimate` reports the
same numbers without holding.

`cap_remaining_m2z = spend_cap_m2z − charged_this_period − held_now`: open
holds count against the cap while they are open, and released amounts
return to it.

A clamped `out_cap` is reported in `meta.max_output_tokens` so the app can
tell the user why a long answer stopped early, and `finish_reason: length`
marks the stop.

## 5. Every edge case, and what is charged

| # | Case | Charged | `usage.source` | Call `status` |
|---|---|---|---|---|
| 5.1 | Normal completion | `price(usage)` from provider usage | `provider` | `settled` |
| 5.2 | Provider error **before** any output | **0** — hold released | — | `released` |
| 5.2 | Provider error **after** output began | `price(usage)` if the provider reported usage on the failed stream, else §5.4 | `provider` / `estimated` | `settled_partial` |
| 5.3 | Client disconnects mid-stream | The gateway aborts the provider request at once. Charged `price(usage)` for what was generated, from reported usage if the provider sends it on abort, else §5.4 | `provider` / `estimated` | `settled_partial` |
| 5.4 | Provider reports **no usage** | Estimated: `input_est` (the hold's estimate) and `tokenise(streamed text) × 1.1` for output. Capped at the hold | `estimated` | as above |
| 5.5 | Actual **exceeds** the hold | Settle does not fail. The excess is taken from what is available; whatever cannot be taken is recorded as `shortfall_m2z` and **written off** — the user is never taken below zero and never put in debt by an AI call. The gateway alerts on every non-zero shortfall; the write-off is the platform's cost of a bad estimate, not the user's | `provider` | `settled`, `shortfall_m2z > 0` |
| 5.6 | Gateway dies mid-stream (no settle) | The hold expires **300 s** after its last extension and is released by a sweeper. If the provider had generated output, the platform pays for it; the user is charged nothing, because nothing was recorded. `GET /v1/calls/{id}` shows `released` with `error.code = "stream_interrupted"` | — | `released` |
| 5.7 | `fallback` used | The hold is released and re-taken at the fallback model's price before the second attempt; `meta` carries the model used. One charge | `provider` | `settled` |
| 5.8 | Idempotent replay of a finished call | **0** — the original result is returned | — | unchanged |
| 5.9 | Cap or balance exhausted **during** a stream | Nothing stops the stream: `out_cap` was sized so the hold fits. (Only a bad estimate reaches §5.5.) | — | — |
| 5.10 | Grant revoked **during** a stream | The stream completes and settles against the hold that was taken while the grant was live; the next call is refused | `provider` | `settled` |

The rule that generates the table: **the user pays for what was produced,
never for what was not, and never more than was reserved unless the
platform's own estimate was wrong — in which case the platform eats the
difference.**

## 6. Worked examples

All examples use the defaults `min_charge_2z = 1`. `m` is the platform
margin; it is a platform parameter that is not part of this contract and
may change with the catalogue version — the point of the examples is the
arithmetic, so each states the `m` it assumes.

### 6.1 The round-up, alone

Provider cost **$0.021** (`21,000,000 nUSD`), `m = 0`, `b = 0`:

```
p = 0.021 × 100 = 2.1 2Z      d = 0      p + d = 2.1 → ceil → 3 2Z
N = 21,000,000 × 10000 × 10000 = 2.1 × 10¹⁵   ceil(N / 10¹⁵) = ceil(2.1) = 3
charged_m2z  = 3000
provider_m2z = ceil(21,000,000 / 10⁴) = 2100
developer_m2z = 0
platform_m2z = 3000 − 2100 − 0 = 900
```

**$0.021 → 3 2Z.** With no margin at all, the round-up alone keeps the
call above cost: the platform keeps 0.9 2Z of a 3 2Z charge.

### 6.2 Margin

Same cost, `m = 5000` (50 %), `b = 0`:

```
p = 2.1 × 1.5 = 3.15 2Z       ceil → 4 2Z
N = 21,000,000 × 15000 × 10000 = 3.15 × 10¹⁵ → 4
charged_m2z = 4000   provider_m2z = 2100   developer_m2z = 0   platform_m2z = 1900
```

### 6.3 Margin and developer markup

Same cost, `m = 5000`, app markup `b = 2000` (20 %):

```
p = 3.15 2Z      d = 3.15 × 0.20 = 0.63 2Z      p + d = 3.78 → ceil → 4 2Z
N = 21,000,000 × 15000 × 12000 = 3.78 × 10¹⁵ → 4
charged_m2z   = 4000
provider_m2z  = 2100
developer_m2z = floor(21,000,000 × 15000 × 2000 / 10¹²) = floor(630) = 630
platform_m2z  = 4000 − 2100 − 630 = 1270
```

The user pays the same 4 2Z as in 6.2 — the markup fitted inside the
round-up this time — and 0.63 2Z of it is now the developer's rather than
the platform's. That is the general shape: **markup is paid out of the
price, and the user's charge only moves when `p + d` crosses a whole 2Z.**

### 6.4 A tiny call meets the minimum charge

Cost **$0.0004** (`400,000 nUSD`), `m = 5000`, `b = 2000`:

```
p = 0.04 × 1.5 = 0.06 2Z    d = 0.012    p + d = 0.072 → ceil → 1, and max(1, 1) = 1 2Z
charged_m2z   = 1000
provider_m2z  = ceil(400,000 / 10⁴) = 40
developer_m2z = floor(400,000 × 15000 × 2000 / 10¹²) = floor(12) = 12
platform_m2z  = 1000 − 40 − 12 = 948
```

Every call costs at least 1 2Z. An app that makes many tiny calls pays 1
2Z each; batching them into one call is cheaper for its users.

### 6.5 A token-priced call, end to end

Model: input $2.50 / Mtok, output $10.00 / Mtok (so `in = 2,500 nUSD/tok`,
`out = 10,000 nUSD/tok`). `m = 5000`, `b = 2000`. Published rates are
therefore `input_m2z_per_mtok = 2.50 × 100,000 × 1.5 × 1.2 = 450,000` and
`output_m2z_per_mtok = 1,800,000`.

**Hold.** Input estimate 1,200 tokens, `max_output_tokens = 800`:

```
worst-case cost = 1200 × 2,500 + 800 × 10,000 = 3,000,000 + 8,000,000 = 11,000,000 nUSD
N = 11,000,000 × 15000 × 12000 = 1.98 × 10¹⁵ → ceil(1.98) = 2 → hold_m2z = 2000
(client-side check: 1200 × 450,000/10⁶ + 800 × 1,800,000/10⁶ = 540 + 1440 = 1980 m2Z → 2000 ✓)
```

**Settle.** Provider reports 1,187 input and 342 output tokens:

```
cost_nusd = 1187 × 2,500 + 342 × 10,000 = 2,967,500 + 3,420,000 = 6,387,500
N = 6,387,500 × 15000 × 12000 = 1.14975 × 10¹⁵ → ceil(1.14975) = 2 → charged_m2z = 2000
provider_m2z  = ceil(6,387,500 / 10⁴) = ceil(638.75) = 639
developer_m2z = floor(6,387,500 × 15000 × 2000 / 10¹²) = floor(191.625) = 191
platform_m2z  = 2000 − 639 − 191 = 1170
released_m2z  = 2000 − 2000 = 0
```

(With `b = 0` the same call is `N = 0.958125 × 10¹⁵ → 1 2Z`: that is the
stream shown in [chat-api.md](./chat-api.md) §3.8, whose published rates
are 375,000 and 1,500,000.)

### 6.6 A long call

Cost **$0.30**, `m = 5000`, `b = 2500` (25 %):

```
p = 30 × 1.5 = 45 2Z    d = 11.25    p + d = 56.25 → 57 2Z
charged_m2z = 57000   provider_m2z = 30000   developer_m2z = 11250   platform_m2z = 15750
```

### 6.7 A write-off

Hold 2,000 m2Z; the provider reports usage whose price is 3,000 m2Z; the
user's available balance at settlement is 400 m2Z:

```
charged_m2z  = 3000 (the price is the price)
taken        = 2000 (the hold) + 400 (all that was available) = 2400
shortfall_m2z = 600 → written off; the user's balance is 0, not −600
```

The call record shows `charged_m2z: 3000, shortfall_m2z: 600`; the
splits are computed on the full 3,000 and the platform's part absorbs the
600.

## 7. What the SDK may promise a user

- **"This will cost at most N 2Z"** — from `/v1/chat/estimate` or `meta.hold_m2z`,
  true except in the write-off case, which never costs the user more than
  their balance.
- **"This cost N 2Z"** — `done.charged_m2z`, final when received.
- **"You have about N 2Z left"** — `done.balance_hint_m2z`, a hint; the
  balance endpoint is authoritative.
- **Never** "N tokens cost N 2Z" as a fixed rate: the per-call round-up and
  the minimum charge mean the effective rate depends on the call.
