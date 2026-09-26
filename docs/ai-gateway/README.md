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
| [0001](./adr/0001-rust-gateway.md) | **The gateway is Rust** — one async process holds tens of thousands of streams; the money path has no garbage collector and no interpreter between a token and a settlement |
| [0002](./adr/0002-hold-functions-single-balance-authority.md) | **The ledger's hold functions are the single balance authority** — one atomic hold in the database, no cached balance anywhere, and a token is never authoritative for money |
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
| Overhead before the first upstream byte | p50 < 8 ms, p99 < 25 ms | The gateway adds one database round trip (the hold) and nothing else to the hot path |
| Provider connect timeout | 5 s | `503 provider_unavailable` |
| First-byte timeout | per model, published in `/v1/models` | `504 provider_timeout` |
| Idle timeout | 60 s without provider output | `error stream_timeout` |
| Hard limit per call | 300 s | `error stream_timeout` |
| Hold TTL | 300 s from the last extension; extended every 60 s while streaming | [metering.md](../sdk/spec/metering.md) §5.6 |
| Retries to the provider | Only before the first byte reaches the client, within a small budget, behind a circuit breaker | A client never sees a retry; `fallback` is the client-visible form |
| Concurrency | 4 open streams per user | `429 concurrency_exceeded` |
| Body limits | 4 MiB without images, 20 MiB with | `413 payload_too_large` |
| Keep-alive | `: ping` every 15 s | SSE clients ignore it |
| Draining | A gateway instance that is shutting down stops accepting new calls and lets open streams finish for up to 300 s | A rolling deploy never cuts a stream; a call is settled exactly once across it |
| Catalogue | Signed by the platform, polled every 30 s; the gateway **refuses to start** without a verified catalogue | `503 catalogue_unavailable` |
| Revocation | Account epoch and grant generation checked per call; **fails closed** when the state is unknown | `503 revocation_check_unavailable` |
| Logs | Never prompts, never completions. Per-app debug capture is opt-in, sampled and disclosed at consent | The trust model in [`docs/sdk`](../sdk/README.md) |

## The catalogue contract

The gateway prices nothing it did not read from a **signed catalogue**
published by the platform. The parts that make it a contract between two
teams rather than a file:

| Property | Rule |
|---|---|
| Schema | Defined in `f2z-ai-proto` (models, per-model prices in nano-USD per token or per unit, limits, capabilities, `min_charge_2z`, the platform margin in bps, `catalogue_version`, `issued_at`, `expires_at`) and generated into the D3 reference. The public projection is `GET /v1/models` |
| Signature | Ed25519 over the canonical (RFC 8785) JSON of the document, in a detached header field; the verifying public key is configuration the gateway starts with, never fetched from the same place as the catalogue |
| Version | `catalogue_version` is a string that sorts lexicographically by issue order; the gateway never replaces a verified catalogue with an older version, and every hold records the version it was priced under |
| Freshness | The gateway polls every 30 s. A catalogue past its `expires_at` (the platform issues them with a 15-minute validity, so a stalled publisher is noticed within a quarter of an hour) is **not** used for new holds: new calls get `503 catalogue_unavailable`; open streams settle under the version their hold recorded |
| Start-up | No verified, unexpired catalogue means the process does not report ready |
| Rollback | A price correction is a new version; there is no "previous version" mechanism, because a hold already priced under a version settles under it |

## What the gateway never does

- Never fetches a client-supplied URL (images are inline bytes).
- Never runs a tool; tool calls are relayed to the client.
- Never lets a request set a provider header (`anthropic-beta`,
  organisation headers and the like are not forwardable).
- Never holds a balance of its own; every hold and settle is the ledger's.
- Never trusts a JWT for money: the ledger re-checks epoch, grant and cap.
- Never re-counts tokens the provider already counted; settlement is from
  provider-reported usage, and an estimate is labelled as such.
