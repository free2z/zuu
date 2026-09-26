# ADR 0003 — A unified API ships before any provider passthrough

**Status:** Accepted (owner, 2026-09-26) · **Refs:**
[#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048)

## Context

Developers integrating an AI gateway often ask for the provider's own
API shape — "just let me send an Anthropic Messages request" — because
their existing code speaks it and because native APIs expose features
first. A metered gateway has a problem with that request that a plain
proxy does not: **it can only charge for what it can price.** A native
request can ask for a server-side tool, a hosted file search, a batch
mode, a beta header or a new content type that the platform's catalogue
has no price for, and the platform then either eats the cost, guesses, or
refuses after the fact — none of which is a contract a third party can
build on.

There is a second cost. Every provider's native format has its own
streaming grammar, its own usage semantics (which tokens are cached,
which are reasoning, which are billed), and its own error shapes. An SDK
that exposes three of them exposes three of everything, and an app that
switches models switches parsers.

## Decision

**v1 exposes one unified chat API**, `POST /v1/chat` with the SSE grammar
of [chat-api.md](../../sdk/spec/chat-api.md), over every provider. Its
request schema is the intersection the platform can price and meter
today — messages with text and inline image parts, function tools that
the client executes, an output cap, a temperature, and streaming — and
its usage event is one shape whatever the provider reported.

Native passthrough endpoints (`/v1/native/<provider>/…`) are a **later
addition**, and when they ship they are:

- **allowlisted per field**: a native request is parsed, and any field or
  header the gateway does not know is refused, not forwarded;
- **priced or refused**: a server-side tool or feature is available only
  once the catalogue prices it, and a request for an unpriced one is a
  `400`, never a best-effort charge;
- **metered identically**: hold → stream → settle with the same ledger
  contract, the same rounding, the same `usage.source`.

Passthrough never becomes the primary surface: the SDKs target the
unified API, and the reference app uses only it.

## Consequences

- **Every call is priceable before it is made.** The hold in
  [metering.md](../../sdk/spec/metering.md) §4 can be computed from the
  request alone, because the request cannot contain anything the
  catalogue does not price.
- **One parser per SDK.** The Rust SDK, the Tauri plugin and the
  TypeScript client each implement the SSE grammar once; adding a
  provider to the platform changes nothing in a shipped app.
- **Some provider features are unavailable at first.** Provider-hosted
  tools, structured-output modes, audio, file inputs and provider-specific
  sampling controls are not in v1. The path to each is a catalogue price
  plus an addition to the unified schema — or, for the long tail, the
  allowlisted passthrough — and not a hole in the metering.
- **The gateway owns the mapping.** Translating the unified request to
  each provider's format, and each provider's stream and usage back to
  the unified events, is gateway code with provider-specific tests
  against recorded fixtures. That is the work the decision moves from
  every app into one place.
- **Tool execution stays on the client.** The gateway relays tool calls
  and never runs one; a request cannot make the platform fetch a URL,
  execute code, or read a file on the user's behalf. That is a security
  property as much as a pricing one.

## Alternatives rejected

- **Passthrough first, unified later.** Fastest to demo, and the metering
  would have to be either incomplete or hostile (refusing requests after
  parsing them for unpriced features) from day one, with three grammars
  in every SDK. The unified API would then be a second product to
  maintain rather than the product.
- **Passthrough only, with a "you pay whatever it costs" clause.** Not
  compatible with a hold: the worst case of an arbitrary native request is
  unbounded. Not compatible with the promise to the user that a call costs
  at most what `meta.hold_m2z` says.
- **A unified API that is the union of every provider's features.** A
  schema nobody can implement completely, whose fields silently do
  nothing on most models. The intersection is smaller and honest; growth
  is by explicit, priced additions.
