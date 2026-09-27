# f2z-ai — the AI gateway

**Status:** v1 design, decisions recorded ahead of implementation
(2026-09-26) · **Refs:** [#1047](https://github.com/free2z/zuu/issues/1047)

`f2z-ai` is the service behind `https://ai.free2z.cash`. It takes a
unified chat request from any app a user has authorized, reserves the
worst-case price in 2Z, streams the provider's answer back, and settles the
call from the provider's reported usage. Its public contract is in
[`docs/sdk/spec`](../sdk/spec/chat-api.md); this directory records **why**
it is built the way it is, so that the reasoning survives the people who
had it.

## Decisions

| ADR | Decision |
|---|---|
| [0001](./adr/0001-rust-gateway.md) | **The gateway is Rust** — one async process holds tens of thousands of streams; the metering path has no garbage collector and no interpreter between a token and a settlement |
| [0002](./adr/0002-hold-functions-single-balance-authority.md) | **The ledger's hold functions are the single balance authority** — one atomic hold in the database, no cached balance anywhere, and a token is never authoritative for a balance |
| [0003](./adr/0003-unified-api-before-passthrough.md) | **A unified API ships before any provider passthrough** — every priceable thing is priced before it can be called; passthrough is a later, allowlisted addition |
| [0004](./adr/0004-zuu-namespace-layout.md) | **The namespace** — where each crate and package lives in this repository, what is published, under which licence |

ADRs follow the format of [`docs/e2ee/decisions`](../e2ee/decisions/0001-platform-priority.md):
context, decision, consequences, alternatives rejected. A decision is
changed by a new ADR that supersedes it, never by editing the old one.

## The operational contract, in brief

The parts of the gateway's behaviour that a client or an operator can
observe and that the specification depends on. Numbers here are the v1
values; the specification cites them.

| Property | Value | Where it matters |
|---|---|---|
| Overhead before the first upstream byte | p50 < 8 ms, p99 < 25 ms | The gateway adds at most two database round trips (a read-only inquire to size the output clamp, then the hold) and nothing else to the hot path |
| Provider connect timeout | 5 s | `503 unavailable` |
| First-byte timeout | per model, published in `/v1/models` | `504 provider_timeout` |
| Idle timeout | 60 s without provider output | `error provider_timeout` |
| Hard limit per call | 300 s | `error provider_timeout` |
| Hold TTL | 300 s from the last extension; extended every 60 s while streaming | [metering.md](../sdk/spec/metering.md) §5.6 |
| Retries to the provider | Only before the gateway commits — before the provider's first content event, which is when `meta` is sent — within a small budget, behind a circuit breaker. Headers and `: ping` comments already sent to the client do not count as commitment | A client never sees a retry; `fallback` is the client-visible form of the same rule |
| Concurrency | 4 open streams per user, counted from hold to settlement (a drained, disconnected call still counts) | `429 concurrency_limit` |
| Delivery buffer | 256 KiB of undelivered events per stream; the upstream is read at provider speed regardless of the client. Worst case at 10k streams: 2.5 GiB, budgeted in the load test | `error delivery_aborted`; [ADR 0001](./adr/0001-rust-gateway.md) |
| Delivery stall | 30 s without delivery progress to a connected client is a disconnect — for delivery only; the upstream read is unaffected | [chat-api.md](../sdk/spec/chat-api.md) §2.4 |
| Body limits | 4 MiB without images, 20 MiB with | `413 payload_too_large` |
| Keep-alive | `: ping` every 15 s | SSE clients ignore it |
| Draining | A gateway instance that is shutting down stops accepting new calls and lets open streams finish for up to 300 s | A rolling deploy never cuts a stream; across it every call is settled at most once and released or settled exactly once |
| Catalogue | Signed by the platform, polled every 30 s; the gateway **refuses to start** without a verified catalogue | `503 catalog_unavailable` |
| Revocation | Account epoch and grant generation checked per call; **fails closed** when the state is unknown | `503 unavailable` |
| Logs | Never prompts, never completions. Per-app debug capture is opt-in, sampled and disclosed at consent | The trust model in [`docs/sdk`](../sdk/README.md) |

## The catalogue contract

The gateway prices nothing it did not read from a **signed catalogue**
published by the platform. The parts that make it a contract between two
teams rather than a file:

| Property | Rule |
|---|---|
| Schema | `f2z-ai-proto::catalog::Catalog`: `schema` (the crate understands exactly one value), `version`, `issued_at` and `expires_at` (Unix seconds), `rate_card_version` (passed to every hold — [metering.md](../sdk/spec/metering.md) §3 — so the ledger settles with the same numbers the gateway estimated with; a version the ledger does not hold refuses the hold), `platform_margin_bps`, `disabled_providers`, and `models[]` — each with `id`, `provider`, `provider_model_id`, `api_style`, `prices` (nano-USD per million tokens for the four token buckets; nano-USD per unit for images and tool calls), `min_charge_2z` (≥ 1), `safety_factor_bps` (≥ 10,000), `context_window`, `max_output_tokens`, `ttfb_timeout_ms`, `enabled`. The public projection is `GET /v1/models` |
| Strictness | `prices` denies unknown fields: **a new price dimension is a schema bump**, not an extra key, because a gateway that silently ignored a price it did not know would under-charge every call on that model. An unknown `api_style` or usage source deserialises to an `Unknown` variant and the model is not callable |
| Signature | Ed25519 over `"free2z/ai-catalog/v1" ‖ canonical_json(payload)` — the label is domain separation; canonical JSON is RFC 8785 restricted to integers ≤ 2⁵³ − 1 with no floats, so the payload may be served with any whitespace or member order. The signature is detached, 64 bytes as lower-case hex, with the `key_id` it was made under; the gateway holds a set of trusted keys (rotation is two keys at once) as configuration it starts with, never fetched from where the catalogue is. Verification is strict (non-canonical encodings refused), a payload with a duplicate member is refused before verification, and the typed catalogue is deserialised from the same parsed tree the signature covered |
| Version | `version` is an integer that only increases; a running gateway never replaces a verified catalogue with a lower version, so a replayed old catalogue cannot reinstate old prices while it runs. The gateway is stateless, so across a restart the floor is `expires_at`: a superseded catalogue can be replayed to a fresh process only while it is unexpired, which makes the platform's validity window the maximum price-rollback exposure and the reason it is kept short. Every hold records the `rate_card_version` it was priced under |
| Freshness | The gateway polls every 30 s and **checks `expires_at` at every hold**, not only at poll time, so a call one second after expiry is refused whichever implementation serves it. A catalogue past its `expires_at` is refused by the verifier itself; new calls then get `503 catalog_unavailable`, and open streams settle under the rate card their hold recorded. **v1 defaults (tunable):** `expires_at = issued_at + 72 h`; the platform re-signs and republishes every **24 h** whether or not anything changed; an alert fires when the live catalogue has **less than 48 h** left — that is, when one scheduled re-sign has already been missed — leaving two days to fix the publisher before the gateway refuses new calls |
| Start-up | No verified, unexpired catalogue means the process does not report ready |
| Rollback | A price correction is a new version; there is no "previous version" mechanism, because a hold already priced under a version settles under it |

## What the gateway never does

- Never fetches a client-supplied URL (images are inline bytes).
- Never runs a tool; tool calls are relayed to the client.
- Never lets a request set a provider header (`anthropic-beta`,
  organisation headers and the like are not forwardable).
- Never holds a balance of its own; every hold and settle is the ledger's.
- Never trusts a JWT for a balance: the ledger re-checks epoch, grant and cap.
- Never aborts a provider request because the client went away: once the
  upstream request is sent it is read to completion (within `out_cap` and
  the hard limit) so that the usage the provider reports is what settles
  ([metering.md](../sdk/spec/metering.md) §5.3).
- Never re-counts tokens the provider already counted; settlement is from
  provider-reported usage, and an estimate is labelled as such.
