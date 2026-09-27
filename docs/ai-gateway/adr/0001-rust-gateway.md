# ADR 0001 — The AI gateway is a Rust service

**Status:** Accepted (owner, 2026-09-26) · **Refs:**
[#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048)

## Context

Metered AI on the platform today runs inside the synchronous web tier: a
request holds a worker for the whole duration of the provider's stream,
so concurrency is bounded by the number of workers rather than by the
network. Output tokens are re-counted with a general-purpose tokeniser
instead of taken from the provider's reported usage, so the charge is an
approximation of what was billed. There is no streaming to browsers at
all.

The v1 platform needs the opposite profile: **ten thousand concurrent
streams** per deployment as the design point, at most two database round
trips on the hot path, settlement from the provider's numbers, and drain
behaviour that lets a rolling deploy finish every open stream without
double-settling or losing one.

The gateway is also the component with the least tolerance for the
usual runtime hazards. It sits between a bearer token and a ledger
operation that moves 2Z; a pause, an unbounded queue, or a type confusion
between milli-2Z and whole 2Z in that path is a balance bug, not a
performance bug.

## Decision

`f2z-ai` is written in **Rust**, as an async service on `tokio` with
`axum`/`hyper` for HTTP, a pooled HTTP/2 client per provider, and a
database driver that speaks to the ledger through the narrow function
contract of [ADR 0002](./0002-hold-functions-single-balance-authority.md).
It lives at `rs/crates/f2z-ai` in this repository ([ADR 0004](./0004-zuu-namespace-layout.md)),
beside the relay and directory services that already run there, and it is
built, attested and digest-pinned by the same image pipeline.

The wire types — request, events, catalogue, error codes — and the pricing
function are **not** in the service crate. They are `f2z-ai-proto`, a
dependency-light MIT crate that the SDK shares, so that the service and
the client cannot disagree on a field or on a rounding rule.

The gateway is stateless. Every piece of state that matters (holds,
balances, grants, revocation) lives in the ledger or the identity
provider; a gateway instance can be killed at any moment and the contract
of [metering.md](../../sdk/spec/metering.md) §5.6 holds.

## Consequences

- **One process, many streams.** Each stream is a task, not a thread or a
  worker; memory per idle stream is measured in tens of kilobytes, and the
  load harness in `f2z-ai-testkit` proves the 10k-stream point against a
  mock provider before every release.
- **Client backpressure never reaches the provider.** The upstream is
  read at provider speed, always: the gateway never lets a client's read
  rate throttle its own read of the provider, because a throttled
  upstream read runs into the idle timeout or the 300 s limit, the
  provider stream is cut before its usage frame, and the call falls back
  to an estimate that cannot see reasoning tokens — an under-charge that
  a trickle-reading client, or simply a slow mobile link, would produce
  by accident. Undelivered output is buffered **per stream**, bounded at
  **256 KiB** of event payload (about 64k tokens of text — more than most
  `out_cap`s, and the output is already paid for by the hold). If a
  stream's buffer fills, **delivery** is terminated — an `error` event
  with `delivery_aborted` if the client is still connected — but the
  upstream read continues to the usage frame and the call settles on
  provider usage ([metering.md](../../sdk/spec/metering.md) §5.3). A
  client that disconnects is the same case with no delivery at all: the
  provider call is never aborted once its request has been sent. The
  memory implication is stated so it is budgeted rather than discovered:
  at the 10k-stream design point the worst case is 10k × 256 KiB = 2.5 GiB
  of buffered output, reached only if every client stalls at once; a
  healthy stream's buffer is near empty, and the load test measures the
  buffered total under a deliberately stalled client population.
- **Settlement never runs on the request future.** A guard hands the call
  to a detached settler task on completion, cancellation or error, so a
  client going away cannot prevent a settle, and a settle cannot delay the
  next request.
- **The amount types are types.** The integer formula of
  [metering.md](../../sdk/spec/metering.md) §2 has no floating-point path
  in `f2z-ai-proto`, and every field carries its unit in its name. The
  crate today uses plain `u64` for nano-USD and milli-2Z (only basis
  points have a wrapper), so the compiler does not yet refuse to add
  them; distinct newtypes are crate v0.x follow-up: #1052, and until they
  land the unit-named fields and the parity fixtures are the guard.
- **Two stacks in the platform.** The identity provider, the ledger and
  the purchase rails stay in the platform's existing web stack; the
  gateway is the one Rust service in the metering path. The cost is two
  toolchains for anyone working across the boundary, and it is paid
  deliberately: the boundary is the ledger's operation contract and a
  signed JSON catalogue, both of which are contracts with fixtures rather
  than shared code.
- **The catalogue is data, not code.** Model prices, limits and
  capabilities are published by the platform as a signed document and
  polled; adding a model or changing a price never requires a gateway
  release, and a gateway with no verified catalogue refuses to price
  anything rather than guess.

## Alternatives rejected

- **An async server in the existing web tier's language.** It would
  remove the worker-per-stream ceiling but keep a garbage-collected
  interpreter with per-object overhead in the hottest path in the
  platform, keep the ledger call inside the same process as unrelated web
  traffic, and keep the current tokeniser-based accounting unless
  rewritten anyway. The rewrite cost is the same; the ceiling is lower.
- **Go.** A credible choice for the concurrency profile. Rejected because
  this repository already builds, lints, audits and ships Rust services
  with a proven gate (`rs/`), because the SDK core is Rust for the Tauri
  plugin and keychain work regardless, and because sharing the wire and
  pricing crate between gateway and SDK requires one language.
- **A managed API gateway or proxy product in front of providers.** None
  of them knows what a 2Z is. Holding, clamping output to what is
  affordable, and settling from usage against a spend cap are the product;
  a proxy that cannot do them would still need this service behind it.
- **Node.js.** Streams well, but the metering path would live in a language
  with one numeric type, and the platform has no existing Node service
  gate to inherit.
