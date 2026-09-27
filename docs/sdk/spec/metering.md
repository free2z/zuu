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
| Provider token prices | nano-USD per **million** tokens (`_nusd_per_mtok`); per-image and per-tool-call prices in nano-USD per unit | integer, in the signed catalogue |
| Whole amounts of 2Z | **2Z** (`_2z`) | integer: charges, holds, minimum charges, caps |
| Fractional amounts of 2Z | **milli-2Z** (`m2Z`, 10⁻³ 2Z, `_milli_2z`) | integer: balances, remaining cap, collected and shortfall amounts, the splits |
| Published rates | milli-2Z per million tokens (`_milli_2z_per_mtok`) or per unit (`_milli_2z`) | integer |
| Margin, markup, safety factor | basis points (bps, 10,000 = 100 %) | integer |

Anchors: **1 2Z = $0.01 = 10,000,000 nUSD**, so **1 m2Z = 10,000 nUSD**.
Every computation is exact integer arithmetic; there are no floats anywhere
in the metering path, and the 2Z amount is rounded at exactly one point (§2.2).

Widths: every 2Z amount on the wire fits in a signed 64-bit integer and
is at most `2⁵³ − 1`, so a JavaScript client reads it exactly; an
implementation MUST refuse (not truncate) a value outside that range. The
intermediate `N` of §2.2 needs more than 64 bits for large calls (a $100
cost with margin and markup is `10¹¹ × 10⁴ × 10⁴ = 10¹⁹`) and MUST be
computed in 128-bit or arbitrary-precision arithmetic — overflow is a
refusal, never a wrap. `f2z-ai-proto::pricing` does exactly this and is
the reference: its `fixtures/pricing/*.json` are the shared parity fixtures
every implementation is tested against.

## 2. The formula

### 2.1 Metering: usage → cost

Pricing is two steps: **meter** the usage to a cost in whole nano-USD,
then **price** that integer (§2.2). The provider cost of a call is the sum
over the usage the provider reported, each multiplied by that model's
catalogue price, rounded **up** to a whole nano-USD:

```
cost_nusd = ceil( ( input_tokens        × input_nusd_per_mtok
                  + cached_input_tokens × cached_input_nusd_per_mtok
                  + cache_write_tokens  × cache_write_nusd_per_mtok
                  + output_tokens       × output_nusd_per_mtok        (output includes reasoning)
                  ) / 10⁶
                + images     × image_nusd
                + tool_calls × tool_call_nusd )
```

Token prices are per million tokens because that is how providers publish
them and because a per-token price in nano-USD cannot represent
$0.0375 / M (37.5 nUSD). The sum is exact in 10⁻⁶ nUSD and is divided
once. Rounding up to whole nano-USD is a property of the unit, not a
second rounding of the price: **`cost_nusd` is the one integer that
crosses from the gateway to the ledger**, so an estimate computed on a
device and the settlement computed by the ledger start from the same
number and cannot disagree at a boundary (`f2z-ai-proto::metered_cost_nusd`
and its `fixtures/pricing/from_usage.json` pin this).

Provider prices live in the signed catalogue the gateway loads; clients
never see them — `/v1/models` publishes the *marked-up* rates of §2.4.

### 2.2 Price

With `m` = the platform margin in bps and `b` = the app's markup in bps.
Neither is a property of a request. `m` comes from the rate card the hold
was taken under (**2000 bps, 20 %, at v1 launch**; a platform parameter
that changes only with a new rate card). **`b` is the markup the user
consented to** — recorded on the grant at consent ([oidc.md](./oidc.md)
§5) — never the registration's current value: an app that raises its
markup gets the new value only from users who have re-consented, and every
hold snapshots the `(rate_card_version, b)` it was priced with, so a
change during a stream cannot move that stream's settlement.

```
p = cost × (1 + m/10000)                     the platform price
d = p × b/10000                              the developer's markup
total = max(min_charge_2z, ceil(p + d))      rounded ONCE, at the total, to a whole 2Z
```

In exact integers, with `N = cost_nusd × (10000 + m) × (10000 + b)`:

```
charged_2z  = max(min_charge_2z, ceil(N / 10¹⁵))     the wire field, whole 2Z
total_milli = charged_2z × 1000                       the same amount in milli-2Z, for the splits
```

(`10¹⁵ = 10⁴ × 10⁴ × 10⁷`: the two bps denominators and nUSD-per-2Z.)

There is no rounding of per-token prices, of `p`, or of `d` on the way to
`charged_2z`. **A per-token price that would round to zero in some unit
does not exist here** because nothing in 2Z is rounded until the total.
`min_charge_2z` is the model's, from the catalogue, snapshotted on the
hold with the rates (§3); it is **never below 1**, so every call that
reaches a provider costs at least one 2Z, and a catalogue naming a smaller
minimum is refused as invalid.

### 2.3 Splits

The charge is divided three ways, in milli-2Z, and the three parts sum to
the charge exactly:

```
provider_milli  = ceil(cost_nusd / 10⁴)                            what the call cost
developer_milli = floor(cost_nusd × (10000 + m) × b / 10¹²)        the markup, credited to the developer
platform_milli  = total_milli − provider_milli − developer_milli    the rest, including the round-up
```

Properties, each pinned by a test in every implementation:

- `platform_milli ≥ 0` for every cost and every `m, b ≥ 0`. (The proof: the
  round-up is at least `p + d`, which is at least `cost + d`; the provider
  part exceeds cost by less than 1 m2Z; the developer part does not exceed
  `d`; and the result is an integer.)
- `total_milli × 10⁴ ≥ cost_nusd` — **a call is never priced below
  cost**, before margin. (Whether the price is *collected* is §5.5; whether
  the cost is *known* is §5.4.)
- `developer_milli` never exceeds `d`: the developer is never credited the
  round-up surplus, which belongs to the platform.
- Rounding happens once: `total_milli` computed from the sum equals
  `total_milli` computed from the parts — there is no path where components
  are rounded and then added.

**When less than the charge is collected** (a shortfall, §5.5), the splits
are computed on the amount collected, and the loss falls on the platform
first, then the developer, never the provider part — the provider's cost is
real whatever was collected:

```
provider_milli  = ceil(cost_nusd / 10⁴)                                 unchanged
developer_milli = min(floor(d), max(0, collected_milli_2z − provider_milli))
platform_milli  = collected_milli_2z − provider_milli − developer_milli          may be negative: the platform's loss
```

The `platform_milli ≥ 0` property holds only when `collected_milli_2z =
total_milli`; a shortfall is the one case where it does not, and the call
record says so.

The developer's `developer_milli` is credited to the developer's own Free2Z
account **as 2Z platform credits, and nothing else in v1**: there is no
cash-out, and the credit is spendable exactly as any other 2Z. It is also
reversible: when a purchase whose 2Z paid for the call is refunded or
charged back, the developer credit is clawed back pro rata, and a
developer account that cannot cover it carries debt on the same terms as
a user's ([purchase.md](./purchase.md) §3.1). Anything beyond that is
governed by the developer terms, not this contract.

### 2.4 What `/v1/models` publishes

Every price in `/v1/models` ([chat-api.md](./chat-api.md) §5) is the
provider price with margin and the calling app's markup already applied:

```
published_milli_2z_per_mtok = ceil(provider_usd_per_mtok × 100 × 1000 × (1 + m/10000) × (1 + b/10000))
```

The published rate is an integer, rounded **up** to the milli-2Z per
million tokens; the ledger and the gateway price from the exact provider
rates, not from the published integers. A client's own estimate —
`max(min_charge_2z, ceil(Σ usage × published rate / 10⁶ / 1000))` —
equals the ledger's charge or differs from it by **exactly one 2Z at a
rounding boundary**, in either direction: the client rounds the rates up,
the ledger rounds the metered cost up to whole nano-USD (§2.1), and each
can be the one that crosses a whole-2Z line. It is an approximation, not
a bound. `POST /v1/chat/estimate` and `meta.hold_2z` are the authoritative
numbers; a client shows its own arithmetic only as "about".

## 3. The lifecycle

```
   client          gateway                       ledger              provider
     │  POST /v1/chat  │                            │                    │
     │────────────────▶│ inquire ──────────────────▶│ available, cap     │
     │                 │ estimate input, clamp out  │                    │
     │                 │ hold(worst case) ─────────▶│ reserve or refuse  │
     │  200 + pings    │◀───────────────────────────│ held / refused     │
     │◀────────────────│ request ──────────────────────────────────────▶ │
     │  meta           │◀─ first content ───────────────────────────────│
     │◀────────────────│                            │                    │
     │  delta…         │◀───────────────────────────────────────────────│
     │◀────────────────│ (extend hold every 60 s)   │                    │
     │  usage          │◀─ usage ───────────────────────────────────────│
     │                 │ settle(usage) ────────────▶│ charge, release    │
     │  done           │◀───────────────────────────│ charged, balance   │
     │◀────────────────│                            │                    │
```

Five ledger operations carry the whole contract. They are the **only**
way 2Z move for an AI call, and the ledger is the only authority on whether
they may ([ADR 0002](../../ai-gateway/adr/0002-hold-functions-single-balance-authority.md)).
The gateway never reads or writes a balance by any other path.

| Operation | Effect | Answers |
|---|---|---|
| **inquire**(user, app) | Read-only: what a hold could reserve right now. Used to compute the output clamp (§4) and by `/v1/chat/estimate`. Not a reservation: the numbers can change before the hold | `available_milli_2z`, `cap_remaining_milli_2z` (`null` when uncapped), `debt_milli_2z`, `open_holds`, `frozen` |
| **hold**(user, app, `amount_2z`, `hold_key`, `aep`, `agen`, `model_id`, `rate_card_version`, `catalog_version`, `markup_bps`, ttl) | Atomically: check the account is not frozen; the grant is live **and** the token's `aep` and `agen` equal the account's and the grant's current values; `available_milli_2z ≥ amount_2z × 1000`; and `cap_remaining_milli_2z ≥ amount_2z × 1000`; then reserve `amount_2z` and record the **pricing snapshot** the settlement will use: the rates and platform margin of `rate_card_version` (the rate card the ledger holds; the catalogue names it, and `catalog_version` is recorded on the call for reference), the `min_charge_2z` of `model_id` in it, and `markup_bps`. All or nothing, in one operation; there is no window in which the balance was checked but not yet reserved. `markup_bps` MUST equal the grant's consented markup | `held` (with `hold_id`, `available_milli_2z`, `cap_remaining_milli_2z`, `expires_at`), `replayed` (same `hold_key` → the same hold, whatever its state, with that state named), `in_debt` (checked before the balance, so debt is never reported as an ordinary shortage), `insufficient_balance`, `cap_exceeded`, `frozen`, `revoked` (epoch or generation stale), `markup_mismatch`, `unknown_rate_card`, `too_many_holds` (16 open holds is the limit; a seventeenth is refused) |
| **extend**(`hold_id`, `reserve_to_2z`, ttl) | Push the expiry out and, when `reserve_to_2z` exceeds the current reservation, reserve the difference. The target is **absolute** and **recomputed, never accumulated**: `reserve_to_2z = price(input_est at the dearest input rate, out_cap, images, observed_tool_calls + tool_budget)` — the §4 hold formula with the tool allowance re-based on the tool calls the stream has actually emitted — so a retried extension whose first response was lost reserves nothing twice, and two gateways computing it for the same stream state get the same number. The target is **recomputed from the current `observed_tool_calls` at every extend**, and an extend is issued at two moments only: every **60 s** of streaming, and immediately when a `tool_call` event arrives. So after one observed tool call the target is the price with `1 + 8` tool calls and the reservation rises at that event, not later; a stream with no tool calls extends every 60 s with an unchanged target (an expiry push). An extension that cannot be afforded (or exceeds the cap) leaves the reservation as it was and still pushes the expiry — the stream continues and may end in a write-off (§5.5) | `held` (with the reservation now in force), `insufficient_balance`, `cap_exceeded`, `not_open` (with `state` ∈ `settled`, `released`, `expired`) |
| **settle**(`hold_id`, `cost_nusd`, usage) | Compute `charged_2z` by §2 from `cost_nusd` and the hold's pricing snapshot, charge it, release the rest of the hold, credit the splits, record the call. **Idempotent** per `hold_id`: a second settle returns the first result and moves nothing. **Never fails** for lack of balance (§5.5) | `settled` (`charged_2z`, `collected_milli_2z`, `shortfall_milli_2z`, `available_milli_2z`, `cap_remaining_milli_2z`, `receipt_id`), or `not_open` (with `state` ∈ `released`, `expired`) — nothing is charged then, and the provider's cost is the platform's (§5.6) |
| **release**(`hold_id`) | Release the whole hold; nothing charged. Idempotent | `released` (whether by this call or an earlier one), `expired`, or `settled` when a settle won — the settlement stands |

A hold is in exactly one state — `open`, `settled`, `released`, `expired`
— and the **first terminal transition wins**: a settle after a release or
expiry charges nothing; a release after a settle changes nothing; an
extend on anything but `open` is refused. Every answer names the state
the hold is in, so a caller that lost a response learns what happened
rather than guessing. `receipt_id` is the settlement's own id — the thing
a user's statement line points at — distinct from `call_id`, and it exists
only once a settle has happened. The answers are ledger-side names; how
each reaches a client is fixed in [errors.md](./errors.md):
`insufficient_balance`, `cap_exceeded`, `too_many_holds`, `frozen`
(`403 account_frozen`) and `in_debt` (`403 account_in_debt`) as their own
codes, `revoked` as `401 token_revoked`,
and `markup_mismatch` / `unknown_rate_card` — which can only mean the
gateway and the ledger disagree about configuration — as `500 internal`
with `details.reason`. The codes the crate does not carry yet are crate
v0.x follow-up: #1052.

`hold_key` is `(call_id, attempt)`. The `call_id` is minted by the
gateway per call (a UUIDv7, unique by construction), so a hold key can
never collide across calls — including when an app reuses an
`Idempotency-Key` after its 24-hour window, which mints a *new* `call_id`.
The `Idempotency-Key` → `call_id` mapping is the gateway's, kept for the
24 hours of [chat-api.md](./chat-api.md) §2.5; the ledger never sees the
request key. Hold replay (`replayed`) is therefore only ever a gateway
retrying its own `hold` for the same attempt after a lost response. A
call has attempt `1`; each `fallback` model tried (§5.7) is the next
attempt with its own hold, and the call record links them all. One call
therefore has at most `1 + len(fallback)` holds and at most one
settlement — an attempt's hold is released before the next is taken, and
a settle on a released one answers `not_open`.

Two invariants a user can observe:

- **At most one settlement per call, and exactly one terminal
  disposition.** Settling is keyed on the hold, and the hold on the call's
  `hold_key`. A retried settle, a gateway restart mid-stream, or a rolling
  deploy cannot charge twice; and a call cannot be left neither settled nor
  released, because an unsettled hold **expires** (§5.6). "Every call
  settled exactly once" is shorthand for "every call that produced output
  under a live gateway is settled exactly once, and every other call is
  released exactly once".
- **The hold is the ceiling** (except §5.5): `charged_2z ≤ hold_2z` after
  extensions, and `charged_2z + released_2z = hold_2z`. `meta.hold_2z` is
  the initial reservation and `done.hold_2z` the final one; they differ
  only when an extension raised the reservation for usage the initial
  estimate did not cover (tool calls beyond the budget, provider framing)
  — never for more output tokens than `out_cap`, which the initial hold
  already covers. A client that wants a ceiling it can show before the
  first byte shows `meta.hold_2z` as "about".

## 4. The hold amount and the output clamp

Before the provider is called, the gateway computes the **worst case**:

```
input_est   = ceil(tokenise(messages + tools + provider framing) × safety_factor_bps / 10⁴)   (exact tokeniser ⇒ 10,000 bps)
out_cap     = min(max_output_tokens, context_window − input_est, affordable)
hold_2z     = price(input_est at the dearest input rate, out_cap, images, tool_budget)        by §2.1 then §2.2
```

Every token count in this section is an integer: a scaled count is
rounded **up** (`f2z-ai-proto::apply_safety_factor`), so an estimate can
only err on the side of the hold.

What the estimate covers, so that no implementation leaves a predictable
part of the bill out of the hold:

- `tokenise(…)` counts the messages **and** the serialised tool
  definitions **and** the per-message framing the provider adds; image
  parts are counted at the model's documented tokens-per-image when the
  model bills images as tokens.
- **The dearest input rate** applies: when the model has a cache-write
  price above its input price, the hold prices every input token at the
  cache-write rate (the worst case is that the whole prompt is written to
  cache). Cache *reads* are never part of the hold; a cache hit only makes
  a call cheaper. The usage buckets are disjoint: `input_tokens` excludes
  both `cached_input_tokens` and `cache_write_tokens`.
- `out_cap` bounds the model's **total** generated tokens, reasoning
  included, and `max_output_tokens` is passed to the provider as that
  total.
- `tool_budget` is `8` tool calls when the catalogue prices tool calls
  per call (`tool_call_nusd > 0`), else 0. This is **not** a bound: a model
  may call the same function more than eight times in one turn. It is an
  allowance the platform accepts the risk on — a per-call tool price is
  rare, and an over-run reaches §5.5 rather than the user's balance.

**`affordable`** is the largest `out` such that
`price(input_est, out, …) × 1000 ≤ min(available_milli_2z, cap_remaining_milli_2z)`
— the price is whole 2Z, the balance and cap are milli-2Z, and the
comparison is made in milli-2Z — both read by **inquire** (§3). The price is monotonic in `out`, so this is a
bounded search. When even `out = 1` — or the model's `min_charge_2z` —
does not fit, the call is refused: `402 insufficient_balance` when the
balance is the binding limit, `403 cap_exceeded` when the cap is.
`POST /v1/chat/estimate` reports the same numbers without holding.

`cap_remaining_milli_2z = spend_cap_2z × 1000 − collected_this_period − held_now`:
open holds count against the cap while they are open, released amounts
return to it, and what counts as spent is what was **collected**
(`collected_milli_2z`, §5.5), never a charge that was written off.
**A hold, and everything settled under it, belongs to the period in which
the hold was taken**, so a stream that crosses midnight settles against
the period it started in, and the excess collection of §5.5 is bounded by
*that* period's remaining allowance, not the new one's. Spending history
is per grant and survives re-authorization: changing the cap or its
period never resets what was already spent — the new cap is compared with
the same history, windowed by the new period — so repeated re-consent
cannot manufacture allowance. **Lowering a cap below what is already
held** does not touch the open holds: they were reserved under the old
cap and settle up to their reservation; the lowered cap only makes
`cap_remaining` zero (never negative) for new holds and for §5.5 excess.

A clamped `out_cap` is reported in `meta.max_output_tokens` so the app can
tell the user why a long answer stopped early, and `finish_reason: length`
marks the stop.

## 5. Every edge case, and what is charged

| # | Case | Charged | `usage.source` | Call `status` |
|---|---|---|---|---|
| 5.1 | Normal completion | `price(usage)` from provider usage | `provider` | `settled` |
| 5.2 | Provider error **before** any output | **0** — hold released | — | `released` |
| 5.2 | Provider error **after** output began | `price(usage)` if the provider reported usage on the failed stream, else §5.4 | `provider` / `estimated` | `settled_partial` |
| 5.3 | Client disconnects, stalls, or reads too slowly | The gateway does **not** abort the provider, and **the client's read rate never throttles the upstream read**: the provider is read at its own speed to completion — bounded by the `out_cap` already held and the 300 s hard limit — with undelivered output buffered per stream (256 KiB; [chat-api.md](./chat-api.md) §2.4), and the call settles on the usage the provider reports, exactly as if the client had read everything: `finish_reason: cancelled` on a disconnect, `price(usage)`. The provider bills for the generation whether or not anyone reads it, and only its usage frame carries the reasoning tokens a stream never shows; letting a slow reader stall the upstream into a timeout would trade that known charge for an estimate that cannot see them — the under-charge a slow mobile link would otherwise produce by accident. A disconnect **before `meta`** follows the same rule when the upstream request was already sent; when it was not yet sent, the hold is released and nothing is charged | `provider` | `settled` (`finish_reason: cancelled` on a disconnect) or `released` |
| 5.4 | Provider reports **no usage** — the upstream stream ended, or failed, without a usage frame even after being read to completion | Estimated as a full usage vector: `input_tokens = input_est` (the hold's estimate, all in the uncached bucket; `cached_input_tokens` and `cache_write_tokens` are `0`), `output_tokens = ceil(tokenise(generated text + tool-call arguments) × 11000 / 10⁴)` over everything the provider produced, delivered or not, `images` = the request's image parts, `tool_calls` = the tool calls produced. Reasoning tokens are not streamed and **cannot be estimated**: a reasoning model whose usage frame was lost is under-charged, and that loss is the platform's. This is the one case where "never priced below cost" does not hold, because the cost is unknown; the record says `estimated` so it can be counted | `estimated` | as above |
| 5.5 | Actual **exceeds** the hold | Settle does not fail. The excess is taken from what the user could have reserved under this hold — **the lesser of the available balance and the remaining cap of the hold's period** (§4) — so the cap the user consented to bounds the collection exactly as it bounds a hold. Whatever cannot be taken is recorded as `shortfall_milli_2z` and **written off** — the user is never taken below zero, never past the cap, and never put in debt by an AI call. The gateway alerts on every non-zero shortfall; the write-off is the platform's cost of a bad estimate, not the user's | `provider` | `settled`, `shortfall_milli_2z > 0` |
| 5.6 | Gateway dies mid-stream (no settle) | The hold expires **300 s** after its last extension and is released by a sweeper. If the provider had generated output, the platform pays for it; the user is charged nothing, because nothing was recorded. A settle that arrives after the expiry answers `not_open` and charges nothing; a live gateway that gets that answer (its settler was delayed past expiry) ends the stream with `settlement: "released"` and `charged_2z: 0`. `GET /v1/calls/{id}` shows `released` with `error: {code: "unavailable", message: "hold expired unsettled"}`, written by the sweeper | — | `released` |
| 5.7 | `fallback` used | `fallback` is an **ordered list**, tried in order. For each retry the previous attempt's hold is released and a new hold (the next attempt number) is taken at that model's price — its own `out_cap`, its own snapshot — before the request is sent; a hold that cannot be taken (`insufficient_balance`, `cap_exceeded`, `revoked`) ends the call with that code and nothing charged. `meta` carries the model that finally answered. One charge | `provider` | `settled` |
| 5.8 | Idempotent replay of a finished call | **0** — the call record is returned ([chat-api.md](./chat-api.md) §2.5) | — | unchanged |
| 5.9 | Cap or balance exhausted **during** a stream | Nothing stops the stream: `out_cap` was sized so the hold fits. (Only a bad estimate reaches §5.5.) | — | — |
| 5.10 | Grant revoked **during** a stream | The stream completes and settles against the hold that was taken while the grant was live; the next call is refused | `provider` | `settled` |
| 5.11 | The ledger is **unreachable at settlement** | The settler retries with backoff until the hold's expiry. The terminal event — `done`, or `error` after output — is emitted with `settlement: "pending"` and no `charged_2z` when settlement has not succeeded within **10 s** of the provider finishing; the call is `settling` until the settle lands (`settled` / `settled_partial`) or the hold expires (`released`, the platform pays). A draining instance keeps retrying until its grace period ends; it never emits a charge it did not commit | `provider` | `settling` → `settled` or `released` |

The rule that generates the table: **the user pays for what was produced,
never for what was not, and never more than was reserved unless the
platform's own estimate was wrong — in which case the platform eats the
difference beyond what the user's balance and cap allow.**

## 6. Worked examples

All examples use `min_charge_2z = 1` and, unless stated, the v1 launch
margin `m = 2000` (20 %). `m` is a platform parameter that changes only
with a new rate card — the point of the examples is the arithmetic, so
each states the `m` it assumes.

### 6.1 The round-up, alone

Provider cost **$0.021** (`21,000,000 nUSD`), `m = 0`, `b = 0`:

```
p = 0.021 × 100 = 2.1 2Z      d = 0      p + d = 2.1 → ceil → 3 2Z
N = 21,000,000 × 10000 × 10000 = 2.1 × 10¹⁵   ceil(N / 10¹⁵) = ceil(2.1) = 3
charged_2z  = 3
provider_milli = ceil(21,000,000 / 10⁴) = 2100
developer_milli = 0
platform_milli = 3000 − 2100 − 0 = 900
```

**$0.021 → 3 2Z.** With no margin at all, the round-up alone keeps the
call above cost: the platform keeps 0.9 2Z of a 3 2Z charge.

### 6.2 Margin

Same cost, `m = 2000` (20 %), `b = 0`:

```
p = 2.1 × 1.2 = 2.52 2Z       ceil → 3 2Z
N = 21,000,000 × 12000 × 10000 = 2.52 × 10¹⁵ → 3
charged_2z = 3   provider_milli = 2100   developer_milli = 0   platform_milli = 900
```

The margin fitted inside the round-up: the user pays the same 3 2Z as in
6.1, and the platform's part is the same 0.9 2Z — margin and round-up
surplus are one number, not two.

### 6.3 Margin and developer markup

Same cost, `m = 2000`, app markup `b = 2000` (20 %):

```
p = 2.52 2Z      d = 2.52 × 0.20 = 0.504 2Z      p + d = 3.024 → ceil → 4 2Z
N = 21,000,000 × 12000 × 12000 = 3.024 × 10¹⁵ → 4
charged_2z   = 4
provider_milli  = 2100
developer_milli = floor(21,000,000 × 12000 × 2000 / 10¹²) = floor(504) = 504
platform_milli  = 4000 − 2100 − 504 = 1396
```

This time `p + d` crossed a whole 2Z, so the user pays 4 rather than 3,
0.504 2Z of it is the developer's, and the platform keeps the rest
including the round-up surplus. That is the general shape: **markup is
paid out of the price, and the user's charge only moves when `p + d`
crosses a whole 2Z.**

### 6.4 A tiny call meets the minimum charge

Cost **$0.0004** (`400,000 nUSD`), `m = 2000`, `b = 2000`:

```
p = 0.04 × 1.2 = 0.048 2Z    d = 0.0096    p + d = 0.0576 → ceil → 1, and max(1, 1) = 1 2Z
charged_2z   = 1
provider_milli  = ceil(400,000 / 10⁴) = 40
developer_milli = floor(400,000 × 12000 × 2000 / 10¹²) = floor(9.6) = 9
platform_milli  = 1000 − 40 − 9 = 951
```

Every call costs at least 1 2Z. An app that makes many tiny calls pays 1
2Z each; batching them into one call is cheaper for its users.

### 6.5 A token-priced call, end to end

Model: input $2.50 / Mtok, output $10.00 / Mtok — in the catalogue,
`input_nusd_per_mtok = 2,500,000,000` and `output_nusd_per_mtok =
10,000,000,000`. `m = 2000`, `b = 2000`. Published rates are therefore
`input_milli_2z_per_mtok = 2.50 × 100,000 × 1.2 × 1.2 = 360,000` and
`output_milli_2z_per_mtok = 1,440,000`.

**Hold.** Input estimate 1,200 tokens, `max_output_tokens = 800`:

```
worst-case cost = ceil((1200 × 2,500,000,000 + 800 × 10,000,000,000) / 10⁶)
                = 3,000,000 + 8,000,000 = 11,000,000 nUSD
N = 11,000,000 × 12000 × 12000 = 1.584 × 10¹⁵ → ceil(1.584) = 2 → hold_2z = 2
(client-side check: 1200 × 360,000/10⁶ + 800 × 1,440,000/10⁶ = 432 + 1152 = 1584 m2Z → 2 2Z ✓)
```

**Settle.** Provider reports 1,187 input and 342 output tokens:

```
cost_nusd = ceil((1187 × 2,500,000,000 + 342 × 10,000,000,000) / 10⁶) = 2,967,500 + 3,420,000 = 6,387,500
N = 6,387,500 × 12000 × 12000 = 0.9198 × 10¹⁵ → ceil(0.9198) = 1 → charged_2z = 1, total_milli = 1000
provider_milli  = ceil(6,387,500 / 10⁴) = ceil(638.75) = 639
developer_milli = floor(6,387,500 × 12000 × 2000 / 10¹²) = floor(153.3) = 153
platform_milli  = 1000 − 639 − 153 = 208
released_2z     = 2 − 1 = 1
```

(With `b = 0` the same call is `N = 0.7665 × 10¹⁵ → 1 2Z`: that is the
stream shown in [chat-api.md](./chat-api.md) §3.8, whose published rates
are 300,000 and 1,200,000.)

### 6.6 A long call

Cost **$0.30**, `m = 2000`, `b = 2500` (25 %):

```
p = 30 × 1.2 = 36 2Z    d = 9    p + d = 45 → exactly 45 2Z, nothing to round
charged_2z = 45   provider_milli = 30000   developer_milli = 9000   platform_milli = 6000
```

An exact whole 2Z is not rounded up: `ceil(45) = 45`, and the platform's
part is the margin alone.

### 6.7 A write-off

Hold 2 2Z on a call whose metered cost turns out to be 1,500 m2Z
(`15,000,000 nUSD`), `m = 2000`, `b = 2000`: the price is
`1500 × 1.2 = 1800`, `d = 360`, `p + d = 2160 → 3 2Z`. The user's available
balance at settlement is 400 m2Z and the cap has 10,000 m2Z left:

```
charged_2z    = 3, total_milli = 3000 (the price is the price)
collected     = 2000 (the hold, already reserved) + min(400 available, 10000 cap remaining) = 2400
shortfall_milli_2z = 600 → written off; the user's balance is 0, not −600
provider_milli  = 1500
developer_milli = min(floor(d) = 360, max(0, 2400 − 1500)) = 360
platform_milli  = 2400 − 1500 − 360 = 540
```

The collected amount can never be below the hold, because the hold was
already reserved; the write-off is only ever the part above it. Had the
user's available balance been `0`, `collected` would be `2000`, the
developer's part `min(360, 500) = 360` and the platform's `140`. The
`done` event and the call record both show `charged_2z: 3,
collected_milli_2z: 2400, shortfall_milli_2z: 600`, so a receipt can say
"priced at 3 2Z; 2.4 2Z taken" rather than only the price.

## 7. What the SDK may promise a user

- **"About N 2Z will be held for this"** — from `/v1/chat/estimate` or
  `meta.hold_2z`. Not "at most": an extension can raise the reservation
  for tool calls beyond the allowance, and a bad estimate can collect
  above the hold from what the balance and cap allow (§5.5). The only
  ceilings an SDK may state are the user's own: never more than their
  available balance, never past their cap.
- **"This cost N 2Z"** — `done.charged_2z`, final when received; when
  `done.shortfall_milli_2z` is non-zero the honest line is "priced at N 2Z,
  M taken" from `collected_milli_2z`. When `done.settlement` is `pending`
  the SDK says "settling" and reads `GET /v1/calls/{id}` for the number;
  it never invents one.
- **"You have about N 2Z left"** — `done.balance_hint_milli_2z`, the
  *available* balance as of settlement, a hint; the balance endpoint is
  authoritative.
- **Never** "N tokens cost N 2Z" as a fixed rate: the per-call round-up and
  the minimum charge mean the effective rate depends on the call.
