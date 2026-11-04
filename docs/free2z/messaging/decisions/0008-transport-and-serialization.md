# ADR 0008 — Transport and canonical serialization: WebSocket over TLS, `tls_codec`, and mandatory re-encode equality

**Status:** Accepted (Phase 1 specification, 2026-08-23) ·
**Refs:** [#545](https://github.com/free2z/zuu/issues/545),
[#305](https://github.com/free2z/zuu/issues/305) ·
**Specifies:** [`../WIRE.md` §2](../WIRE.md#2-transport),
[§3](../WIRE.md#3-serialization), [§4](../WIRE.md#4-framing)

> **Invented here.** The merged Phase 0 documents named relay *capabilities*
> (`APPEND` / `READ` / `ACK` / `DELETE`) in prose and specified neither a
> transport, a framing, nor a serialization. Nothing below should be read as
> having already been decided.

## Context

The relay is a public, unauthenticated network listener: anyone on the internet
may connect and send bytes to it before any signature has been checked. Its
attack surface is, overwhelmingly, its parser.

Three constraints bound the choice.

1. **[ADR 0001](./0001-platform-priority.md) requires the WASM web client to
   speak the same protocol as ZUULI**, from one Rust crypto core, so that there
   is no second implementation to diverge. A browser can open a WebSocket and
   nothing else.
2. **[ADR 0005](./0005-federation.md) makes concurrent connections, not
   bandwidth, the cost driver**, and requires the relay to be sustainable on a
   ~$5/month VPS run by a volunteer. Framing efficiency is not where that budget
   is won or lost.
3. **Commands are signed** ([`../WIRE.md` §5](../WIRE.md#5-the-signing-transcript)),
   so the encoding is not merely a transport detail — it is the thing signatures
   cover. Any encoding with more than one representation of a value is an
   invitation to a parse-versus-verify divergence.

## Decision

**Transport: WebSocket over TLS 1.3, and no second transport.** `wss://` only,
path `/relay/v1`, subprotocol `free2z-relay.v1`. The relay refuses to bind a
non-loopback address without TLS unless explicitly overridden, and the override is
published in the capability document. The relay sends a WebSocket Ping every ~25
seconds.

**Serialization: the TLS presentation language (`tls_codec`).**

**Framing: one binary WebSocket frame carries exactly one request, response or
push.** Text frames are a fatal error. Requests are pipelined within a bounded
in-flight window and responses may complete out of order, correlated by a
client-chosen `request_id`.

**And the rule that makes the serialization choice load-bearing: every received
frame MUST be decoded, re-encoded, and byte-compared against the input, with all
hashing and signing performed over the re-encoded bytes. A mismatch is a fatal
error.**

## Consequences

- **One parser on the unauthenticated path.** A second transport would be a
  second parser and a second fuzz target, for a client population that cannot use
  it (browsers) and a cost model that does not need it.
- **No parse-versus-verify gap.** Re-encode equality means there is exactly one
  byte string a given value can be; the signature covers that byte string; any
  encoding that is not it is rejected before any state changes. The class of bug
  this removes — a decoder more permissive than its encoder, so that two parties
  disagree about what a signature covered while both believe they verified it —
  is one of the most reliably exploitable in signed protocols.
- **The rule compensates for implementation slack, not format ambiguity**, and
  should be described that way. The TLS presentation language is already
  unambiguous; decoders are not. The cost is one extra encode per frame,
  negligible beside a signature verification.
- **No "ignore unknown fields" extensibility.** Re-encode equality forbids it.
  Adding a field means a new command code or a new protocol version. This is a
  real ergonomic cost — evolving the protocol is more ceremonious than it would
  be with a self-describing format — and it is accepted, because silent tolerance
  of unknown bytes is how a signature ends up covering something the verifier
  never looked at.
- **The keepalive is load-bearing in production.** A relay behind a proxy whose
  idle timeout is below the ping interval tears down every long-lived
  subscription on a timer and sees a reconnect storm that looks like an attack.
  Operators MUST set any front-end idle timeout to at least 3× the ping interval.
  Server-side ping is chosen because the browser WebSocket API cannot send a Ping
  frame — a client-driven keepalive would be a second mechanism used by only one
  of the two clients.
- **`transport_security: "none"` is published, not hidden.** The insecure-listen
  override exists because sidecar TLS termination and container-local development
  are real. Making it a field of a signed capability document means using it is an
  act with evidence, and clients refuse such relays by default.
- **Error responses carry a code and nothing else** — no free-text message. A
  free-text field on an unauthenticated path is a covert channel out of the
  relay, a fingerprinting surface, and a place where implementations leak
  internal state by accident.
- **Out-of-order responses require correlation state in the client**, which is
  slightly more work than a lock-step protocol, and buys the ability to fetch,
  acknowledge and append concurrently on one connection without head-of-line
  blocking.

## Alternatives rejected

- **CBOR ([RFC 8949](https://datatracker.ietf.org/doc/html/rfc8949)).** Rejected.
  CBOR has many encodings of the same value — definite and indefinite lengths,
  non-minimal integer widths, map key ordering, duplicate keys, tags — and its
  canonical form is a *profile*: a rule an implementation must remember to apply
  and that a decoder will happily let it skip. We would be adding a serializer
  whose default behaviour is unsafe for our use, plus a second decoder in the
  WASM bundle and in the audit scope, to gain self-description we do not want.
  The relay is a fixed command set, not an extensible document format.
- **A hand-rolled binary codec.** Rejected on the plainest grounds available: it
  would be a new parser, written by us, on the unauthenticated path, and the only
  component of the relay with no prior review anywhere. `tls_codec` is not
  formally verified either, but it is exercised by every MLS implementation built
  on it, including ours.
- **Protocol Buffers / FlatBuffers.** Rejected: same canonicality problem as CBOR
  (field ordering, unknown-field preservation, default-vs-absent), plus a code
  generator and a schema toolchain in the build.
- **JSON.** Rejected on canonicality (number representation, key ordering,
  string escaping), on size, and because signing over JSON requires a
  canonicalization scheme whose failure modes are well documented and numerous.
- **Adding QUIC, raw TCP, or an HTTP long-poll fallback.** Rejected: a transport
  the browser client cannot use is a transport that breaks ADR 0001's
  one-implementation property, and each is another parser on the front door.
- **Skipping re-encode equality and signing the received bytes directly.**
  Rejected. It appears equivalent and is not: it makes the *signature* agree with
  the received bytes while leaving the *application state* derived from whatever
  the permissive decoder produced, which is the divergence with the sharp edge.
- **TLS 1.2 support.** Rejected: the channel binding
  ([ADR 0010](./0010-signing-transcript-and-ack-semantics.md)) is the TLS 1.3
  exporter, and there is no defined binding for this protocol below 1.3.
