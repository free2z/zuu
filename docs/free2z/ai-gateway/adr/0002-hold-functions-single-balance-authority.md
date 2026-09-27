# ADR 0002 — The ledger's hold functions are the single balance authority

**Status:** Accepted (owner, 2026-09-26) · **Refs:**
[#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048)

## Context

An AI call reserves 2Z before it starts and charges when it ends. The
question is **who is allowed to say "yes, this user can spend N"** — and
the answer decides whether the platform can ever charge twice, charge a
revoked app, exceed a cap the user set, or let a balance go negative.

Three components could plausibly answer: the gateway (which has the
token), a cache (which is fast), or the ledger database (which has the
balance). Only one of them can be right when they disagree.

The gateway sees a five-minute JWT. Between issue and use the user may
have revoked the app, the account may have had a security event, another
call may have spent the balance, or a cap may have been lowered. A cache
sees a copy of the balance, and a copy is wrong exactly when it matters:
during the burst of parallel calls that races it.

## Decision

**The ledger's hold functions, executed inside the ledger's own
database, are the only authority on whether 2Z can be reserved or
charged.** Nothing else — not the gateway, not a cache, not a token — is
consulted for that decision, and nothing else holds a balance.

The contract is five operations, specified for the gateway in
[metering.md](../../sdk/spec/metering.md) §3: a read-only **inquire**,
then **hold**, **extend**, **settle**, **release** (plus a periodic
**expire** that the platform runs). Each mutating one is **one atomic
operation**: the hold checks that the account is not frozen, that the
grant is live (the account epoch and grant generation the token carries
are passed in and compared with the current values), that the available
balance covers the amount and that the grant's cap for the period covers
it — and reserves the amount, recording the pricing snapshot the
settlement will use — as a single conditional update. There is no
read-then-write, so there is no window in which two calls both see enough
balance and both proceed. **inquire** exists only so the gateway can size
the output clamp; its answer is advisory and the hold decides.

A hold has one state at a time — open, settled, released, expired — and
the first terminal transition wins. A settle that arrives after a release
or an expiry charges nothing and says so; a release after a settle
changes nothing. Extensions set an absolute reservation target rather
than adding to it, so a retried extension is harmless.

Settlement is **idempotent per hold** and **computes the charge inside
the ledger** from the versioned rate card and the usage the gateway
passes. The gateway hands over provider cost and usage; it does not hand
over a price. The single rounding of
[metering.md](../../sdk/spec/metering.md) §2.2 therefore happens in
exactly one place, and the estimate the gateway and SDK compute with
`f2z-ai-proto::price_2z()` is checked against it by shared fixtures, not
trusted.

Settlement **never fails for lack of balance**. When actual usage exceeds
the hold, the ledger takes what is available and records the remainder as
a shortfall the platform writes off; a user's balance never goes negative
because of an AI call, and the gateway is never left holding a completed
call it cannot account for.

The gateway's access to the ledger is **those operations and nothing
else** — it cannot read or write a balance by any other path, and that
is enforced where the ledger lives, not by convention in the gateway's
code.

## Consequences

- **Balances are safe even when the token is stale.** The JWT's `aep` and
  `agen` give fast rejection at the edge; the hold re-checks both. A
  revocation that has not yet propagated to the gateway costs at most one
  hold attempt that the ledger refuses.
- **The hot path has at most two database round trips** — a read-only
  inquire to size the output clamp, then the hold — and the budget for
  them is the whole of the gateway's latency budget for metering: hold p99
  ≤ 10 ms in the database, settle p99 ≤ 15 ms, and neither sits on the
  request's critical path after the first byte.
- **Contention is per user, never global.** A hold contends only with
  that user's other holds; the platform's, the provider's and every
  developer's side of a settlement are recorded asynchronously, so a
  popular app's developer account never becomes a point of contention
  that slows its own users.
- **No second balance exists to drift.** There is no in-memory or cached
  balance in the gateway to reconcile, invalidate or explain. The
  `balance_hint_milli_2z` a client receives is a *hint* read at settlement,
  named as such, and the balance endpoint is authoritative.
- **A gateway restart cannot double-charge or lose a call.** Holds are
  keyed on the call's idempotency; settlement on the hold; an unsettled
  hold expires and releases. The invariant "every call reaches exactly
  one terminal disposition and is settled at most once, including across
  a rolling deploy" is a load-test assertion, not a hope — and a
  gateway-kill test expects the killed calls to be *released*, not
  settled.
- **The ledger's function signatures are a public contract**, versioned
  with the platform and pinned by fixtures in `f2z-ai-testkit`. Changing
  them is a coordinated change with the gateway, not an internal
  refactor.
- **Latency floor.** Every call pays a database round trip before its
  first byte. That is the price of correctness here, and it is bounded
  by the budget above; a design that avoided it would have to answer the
  question in the Context with something other than the ledger.

## Alternatives rejected

- **A web-tier RPC ("ask the account service whether the user can
  spend").** An extra hop and a second process on the hot path of every
  AI call, with the web tier's capacity — sized for page loads — becoming
  the gateway's ceiling. The check would still have to end in the same
  atomic database operation; the hop adds latency and a failure mode and
  removes nothing.
- **A hot balance in a cache, reconciled to the ledger.** Fast, and a
  second source of truth. Every race between the cache and the ledger is
  a case where the platform either refused a spendable call or accepted
  an unaffordable one; the reconciliation code to detect and repair that
  is larger than the hold functions and less certain. Caches remain in
  the design for what they are good at — rate limits, revocation
  propagation — and never for balance.
- **Let the gateway decide from the JWT and settle later.** Simplest and
  fastest; and it is the design that charges a revoked app, exceeds a
  cap, and takes a balance negative under parallel calls. Rejected
  outright.
- **Charge up front for the maximum and refund the difference in a second
  transaction.** Equivalent to a hold in effect but visible to the user
  as two movements, and a lost second transaction is a silent overcharge.
  A hold that expires is a safer failure than a refund that does not
  arrive.
