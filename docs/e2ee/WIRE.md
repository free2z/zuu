# free2z E2EE — Relay wire protocol, version 1

**Status:** Phase 1 specification. Nothing described here is implemented.
**Refs:** [#305](https://github.com/free2z/zuu/issues/305) (epic),
[#545](https://github.com/free2z/zuu/issues/545) (this document),
[#131](https://github.com/free2z/zuu/issues/131).
**Companion:** [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`THREAT-MODEL.md`](./THREAT-MODEL.md), [`KT.md`](./KT.md),
[`decisions/`](./decisions/).
**Decides:** [ADR 0008](./decisions/0008-transport-and-serialization.md),
[0009](./decisions/0009-queue-addressing-and-binding.md),
[0010](./decisions/0010-signing-transcript-and-ack-semantics.md),
[0011](./decisions/0011-first-contact-contact-queues.md),
[0012](./decisions/0012-anti-abuse-v1.md),
[0014](./decisions/0014-directory-key-rotation.md).

This document is written to be read by a third-party security auditor and by an
independent implementer. It fixes the wire encodings that
[`ARCHITECTURE.md`](./ARCHITECTURE.md) deliberately left as *proposed*
placeholders. Where a property does not hold it is stated as not holding. Where
something remains undecided it is listed in §16 and in
[`ARCHITECTURE.md` §13](./ARCHITECTURE.md#13-open-questions), not answered by
invention.

**Almost everything in this document is invented here.** The merged Phase 0 docs
named capabilities (`APPEND` / `READ` / `ACK` / `DELETE`) in prose and nothing
more: no grammar, no serialization, no anti-replay construction, no queue
lifecycle, no first-contact path, no quotas. Each significant choice below is
recorded in an ADR with the alternatives that were rejected and why. Nothing here
should be read as "the merged docs already said this."

---

## 1. Scope

### 1.1 What this document fixes

The relay protocol: transport, framing, canonical serialization, the full command
set with request and response shapes, the signing transcript, anti-replay, queue
lifecycle, ACK semantics, TTLs, padding enforcement, stable error codes, the
capability document, first contact, and anti-abuse v1.

### 1.2 What it deliberately does not fix

**The key-transparency log construction is not in this document.**
`SignedTreeHead` format, epoch cadence, inclusion- and consistency-proof
encodings, the full `DirectoryEntry` structure and the witness-cosignature message
format belong in a companion document. When this document was written they were
blocked on spike [#544](https://github.com/free2z/zuu/issues/544) and the ADR
numbering skipped 0013 so that the gap was visible rather than silent. **That
spike closed on 2026-08-23**, and they are now specified in
[`KT.md`](./KT.md) with [ADR 0013](./decisions/0013-key-transparency-log.md).

Two places below depend on that design and say so at the point of use:

- §12.2 — a contact endpoint is a field of a directory entry. Its structure is
  now [`KT.md` §4.1](./KT.md#41-structure).
- §12.5 — MLS `KeyPackage` publication, last-resort key packages and their
  exhaustion behaviour are directory design, not relay design, and are **still
  open**: `KT.md` deliberately does not answer them
  ([`KT.md` §12](./KT.md#12-what-this-document-leaves-open)).

[ADR 0014](./decisions/0014-directory-key-rotation.md) settles directory *key
rotation* only, and is written so that it can be implemented on whatever log
construction #544 selects.

### 1.3 Conventions

- **MUST / MUST NOT / SHOULD / MAY** are used in the RFC 2119 sense.
- All integers are unsigned and **big-endian** (network byte order).
- `H(label, x)` means `BLAKE2b-256(label || x)` where `label` is the exact ASCII
  bytes shown, with no separator and no terminator — the idiom already used for
  `msg_id` in [`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering).
- **The label set MUST be prefix-free.** No label used with `H` — in this
  document, in [`KT.md`](./KT.md), or in any later document that uses `H` — may
  be a proper prefix of any other such label. The rule extends to labels
  concatenated the same way without `H`, such as the §5.2 signing prefix
  `"free2z/relay/v1/hello"`, and to the first-field `label` constants of the
  signed structures, because those constants and these arguments are drawn from
  one namespace and a future construction will reuse one for the other.

  This is the precondition of the construction, not a naming preference. With no
  separator, if label `A` is a proper prefix of label `B` — so that
  `B == A || s` for some nonempty `s` — then

  ```
  H(A, s || y) = BLAKE2b-256(A || s || y) = BLAKE2b-256(B || y) = H(B, y)
  ```

  bit for bit, and the two domains are not separated for any `A`-domain message
  beginning with `s`.

  The requirement is on the **union** of every document's labels, never on each
  document's set separately: a set that is internally prefix-free says nothing
  about its neighbours, and that scoping mistake is how
  [#602](https://github.com/free2z/zuu/issues/602) put `free2z/kt/v1/sth` and a
  label extending it into the same namespace. `scripts/check-hash-domain-labels.mjs`
  asserts the property mechanically over every label in the repository on every
  pull request, from the always-running `rs / changes` job, and its verdict is
  re-checked inside the required `rs / gate` context. **Adding a label means
  running that check**; a label that has not been through it is a label nobody
  has checked against the rest of the namespace.
- Structures are written in the **TLS presentation language**
  ([RFC 8446 §3](https://datatracker.ietf.org/doc/html/rfc8446#section-3)); see §3.
- "The relay" is the server. "The client" is a ZUULI or WASM device
  ([ADR 0001](./decisions/0001-platform-priority.md)).
- A **fatal** error means: send the response, then close the WebSocket
  connection. A non-fatal error means: send the response, keep the connection.

---

## 2. Transport

### 2.1 WebSocket over TLS, and nothing else

A relay listens for **WebSocket connections over TLS 1.3** and offers no other
transport.

| Parameter | Value |
|---|---|
| Scheme | `wss://` only |
| Path | `/relay/v1` |
| Subprotocol | `Sec-WebSocket-Protocol: free2z-relay.v1` |
| TLS | **1.3 minimum.** A relay MUST NOT negotiate TLS 1.2 or below. |
| ALPN | `h1` or `h2` as the WebSocket upgrade requires; not otherwise constrained |

The subprotocol header is mandatory in both directions. A relay that does not
echo `free2z-relay.v1` MUST be treated by the client as not speaking this
protocol, and the client MUST close rather than guess.

TLS 1.3 is a floor rather than a preference because the channel binding in §5.3
is the TLS 1.3 exporter (RFC 8446 §7.5); there is no defined binding for this
protocol over TLS 1.2.

### 2.2 Why exactly one transport

Because [ADR 0001](./decisions/0001-platform-priority.md) requires the WASM web
client to speak *the same protocol* as ZUULI, and a browser can only open a
WebSocket. Any second transport — QUIC, a raw TCP framing, an HTTP long-poll
fallback — would be a transport that only the native client could use, and the
one thing ADR 0001 buys is that there is no second code path to diverge.

The security argument is separate and stronger: **a second transport is a second
parser and a second fuzz target.** The relay is an unauthenticated network
listener that anyone on the internet may speak to before any signature is
checked. Its attack surface is its parser. Halving the number of parsers is worth
more than any efficiency a second transport could deliver, and the efficiency
claim is weak anyway — the cost driver is concurrent connections, not framing
overhead ([ADR 0005](./decisions/0005-federation.md)).

See [ADR 0008](./decisions/0008-transport-and-serialization.md).

### 2.3 Listener rules, and the insecure override

A relay **MUST refuse to bind a non-loopback address without TLS.** This is a
startup check, not a warning: the process exits.

An operator may override it with an explicit flag (`--insecure-listen`, or the
equivalent configuration key). Local development on a container network, and
deployments that terminate TLS in a sidecar on the same host, are real cases and
we do not pretend otherwise. The override carries three obligations:

1. The relay MUST set `transport_security: "none"` in its capability document
   (§11). The override is not a private operational detail; it is published.
2. The relay MUST set `channel_binding_mode: "none"` (§5.3), because there is no
   TLS session from which to export.
3. Clients MUST refuse such a relay by default and MUST require an explicit,
   per-relay user opt-in to connect. The UI must state that message ciphertext is
   protected by MLS but that connection metadata, queue addresses and commands
   travel in the clear.

A relay that lies about `transport_security` is a relay that is lying in its
signed capability document; the point of publishing it is that lying becomes an
act with evidence rather than an omission.

### 2.4 Keepalive

**The relay sends a WebSocket Ping every 25 seconds** on every open connection
and closes the connection after two consecutive missed Pongs (~75 s). The
interval is published as `ws_ping_interval_seconds`.

This is load-bearing rather than cosmetic. A relay is almost always deployed
behind a load balancer or reverse proxy with a backend idle timeout, and a
subscribed client on a quiet queue sends nothing for hours. If the proxy's idle
timeout is below the ping interval, every long-lived subscription is torn down on
a timer, every client reconnects, and the relay sees a reconnect storm that looks
like an attack and behaves like one.

- Operators **MUST** set any front-end idle timeout to at least **3×** the ping
  interval.
- Server-side ping is chosen over client-side deliberately: the browser
  WebSocket API cannot send a Ping frame at all, so a client-driven keepalive
  would have to be an application-level message, which means a second mechanism
  that only one of the two clients uses. Same reasoning as §2.2.
- Clients MUST respond to Ping with Pong (browsers do this in the runtime) and
  SHOULD additionally treat 90 s of total silence as a dead connection.

### 2.5 Connection lifecycle

1. TLS 1.3 handshake, subprotocol negotiation.
2. The client sends `HELLO` (§6.1). It MUST be the first frame. A relay that
   receives any other frame first responds `ERR_UNSUPPORTED_VERSION` and closes.
3. The client verifies the relay's identity proof (§6.1) and, if it holds an
   expected `relay_id` from an in-band advert (§7.2), compares it. A mismatch is
   fatal and MUST be surfaced, not retried against.
4. Commands, pipelined, in any order (§4).
5. Close. Either side may close at any time; an in-flight command whose response
   was not received has **unknown** status and MUST be retried under the retry
   rules in §8.3 and §7.3.

A relay MUST cap the time between TCP accept and a valid `HELLO`
(`handshake_timeout_ms`, default 10 000) and close on expiry.

---

## 3. Serialization

### 3.1 The choice: `tls_codec`

Every frame body is encoded with the **TLS presentation language** of
[RFC 8446 §3](https://datatracker.ietf.org/doc/html/rfc8446#section-3), as
implemented by the `tls_codec` crate.

Three reasons, in the order that decided it:

1. **It is canonical by construction, because no encoding options exist.** There
   is no indefinite-length form, no map, no key ordering question, no duplicate
   key, no tag, no float, no "shortest form" rule to enforce. A value of a given
   type has exactly one encoding. Canonicalization is not a rule the
   implementation has to remember to apply; it is the absence of any alternative.
   This matters here more than usual because we sign over encoded bytes (§5).
2. **It is already in the client's dependency graph.** OpenMLS is built on
   `tls_codec` — RFC 9420 is itself written in the TLS presentation language. The
   crypto core already contains this decoder, already ships it to WASM, and
   already has it in whatever audit scope the core has. Adding CBOR would add a
   second serializer to the WASM bundle and to the audit.
3. **An auditor reading an MLS system reads TLS presentation syntax without
   translation.** The reviewer who is checking our framing against RFC 9420 is
   already fluent in this notation. Presenting the relay protocol in a different
   notation costs the reviewer a translation step on every structure, for no gain.

### 3.2 Why not CBOR, and why not a hand-rolled codec

**CBOR** ([RFC 8949](https://datatracker.ietf.org/doc/html/rfc8949)) is the
obvious alternative and it was rejected. CBOR has *many* encodings of the same
value: definite and indefinite lengths, non-minimal integer widths, map key
ordering, duplicate keys, and tags. It has a canonical profile
([deterministically encoded CBOR](https://datatracker.ietf.org/doc/html/rfc8949#section-4.2)),
which is precisely the problem — a canonical *profile* is a rule that an
implementation must apply correctly and that a decoder will happily let you skip.
Every "canonical CBOR" bug in the wild is a decoder that accepted a
non-conforming encoding and a verifier that then signed or compared the wrong
bytes. We would be adding a serializer whose *default* behaviour is unsafe for
our use, in order to gain self-description we do not want. The relay is not an
extensible document format; it is a fixed command set.

**A hand-rolled codec** was rejected on the plainest grounds available: it is a
new parser, written by us, on the unauthenticated path, and it would be the only
component of the relay with no prior review anywhere. `tls_codec` is not
formally verified either, but it is exercised by every MLS implementation that
uses it.

### 3.3 The re-encode-equality rule — mandatory

On every received frame, in both directions, the receiver MUST:

1. **Decode** the bytes into the typed structure.
2. **Re-encode** that structure with the same codec.
3. **Byte-compare** the re-encoding against the received bytes.
4. Use the **re-encoded** bytes — never the received bytes — as the input to any
   hash or signature operation (§5).

**A mismatch at step 3 is a fatal `ERR_MALFORMED`.** No retry, no partial
acceptance, no "we understood what you meant": send the error and close the
connection.

This is the single rule that closes the parse-versus-verify gap. The class of bug
it eliminates is the one where a decoder is more permissive than the encoder —
trailing bytes after the last field, an over-wide length prefix, a vector whose
declared length exceeds its contents, an unknown-variant byte silently mapped to
a default. In such a system two parties can disagree about what a signature
covered while both believe they verified it. With re-encode equality there is
exactly one byte string that a given value can be, the signature covers that byte
string, and any encoding that is not it is rejected before any state changes.

Note honestly what this rule is and is not. The TLS presentation language is
already unambiguous, so re-encode equality is **not** compensating for format
ambiguity — it is compensating for *implementation slack* in decoders, which is
where the bugs actually are. It costs one extra encode per frame, which is
negligible against a signature verification, and it converts a whole class of
subtle divergence into an immediate, loud, testable failure.

### 3.4 Notation

```
uint8, uint16, uint32, uint64      fixed-width, big-endian
opaque x[n]                        fixed-length byte string
opaque x<0..2^k-1>                 variable-length, k-bit length prefix
struct { ... } Name;               fixed field order, no padding
enum { a(1), b(2), (255) } Name;   explicit width from the maximum
```

Byte strings that appear in URLs, adverts or human-readable documents are written
**base64url without padding**. On the wire they are raw bytes.

### 3.5 Versioning

`protocol_version` is a `uint16`. Version 1 is `0x0001`.

- A relay MUST reject a request whose command code it does not know with
  `ERR_UNKNOWN_COMMAND` (non-fatal).
- A relay MUST NOT skip unknown trailing bytes in a body — §3.3 forbids it.
  **There is no "ignore unknown fields" extensibility in v1.** Adding a field to
  an existing command is a new command code or a new protocol version, and that
  is deliberate: silent tolerance of unknown bytes is how a signature ends up
  covering something the verifier did not look at.
- Version negotiation happens once, in `HELLO`, and applies to the whole
  connection.

---

## 4. Framing

### 4.1 One frame, one message

**One binary WebSocket frame carries exactly one request, one response, or one
push.** There is no in-frame batching and no message that spans frames. A
WebSocket implementation's own fragmentation is transparent and irrelevant here;
what matters is that one *message* is one protocol unit.

```
enum { request(1), response(2), push(3), (255) } FrameKind;

struct {
    FrameKind kind;
    uint32    request_id;
    select (RelayFrame.kind) {
        case request:  Request;
        case response: Response;
        case push:     Push;
    } payload;
} RelayFrame;

struct {
    uint16      command;
    CommandAuth auth;
    opaque      body<0..2^24-1>;
} Request;

struct {
    uint16 status;                  /* 0 = ok; otherwise an error code from §10 */
    opaque body<0..2^24-1>;         /* MUST be empty when status != 0 */
} Response;

struct {
    uint16 event;
    opaque body<0..2^24-1>;
} Push;
```

**Error responses carry a code and nothing else.** There is no human-readable
message field, deliberately: a free-text field on an unauthenticated path is a
covert channel out of the relay, a fingerprinting surface, and a place where
implementations leak internal state by accident. Diagnostics belong in the
operator's own logs.

`max_frame_bytes` is published (default 1 MiB). A frame exceeding it is
`ERR_MALFORMED`, fatal — the relay MUST NOT buffer the remainder to produce a
tidy error.

### 4.2 Text frames are rejected

A WebSocket **text** frame is a fatal `ERR_FRAME_TYPE`, and the connection closes
with WebSocket status 1003 (unsupported data). The relay MUST NOT attempt to
decode it, MUST NOT attempt UTF-8 validation beyond what the WebSocket layer
already did, and MUST NOT treat it as an accidental binary frame.

This is a one-line rule with a real purpose: it removes any path by which a
browser-side bug, a proxy that transcodes, or an attacker's crafted intermediary
can present the same bytes through two different framings.

### 4.3 Request ids, pipelining and the in-flight window

- `request_id` is chosen by the client, is a nonzero `uint32`, and MUST be unique
  among that connection's currently in-flight requests. It MAY be reused after
  its response has been received.
- Push frames use `request_id = 0`.
- **Responses may arrive out of order.** A client MUST correlate by
  `request_id` and MUST NOT assume ordering. A relay MAY complete a cheap `PING`
  before an expensive `READ` issued earlier, and will.
- **A bounded in-flight window.** `max_inflight` is published (default 32).
  Issuing a request while `max_inflight` are outstanding is a fatal
  `ERR_TOO_MANY_INFLIGHT`. The bound exists so that a single connection cannot
  make the relay allocate unbounded per-request state before any quota check has
  run — it is an anti-abuse control (§13.1) as much as a flow-control one.
- A duplicate `request_id` among in-flight requests is a fatal `ERR_MALFORMED`.

Out-of-order responses plus a bounded window is the smallest design that lets a
client fetch, acknowledge and append concurrently on one connection without
head-of-line blocking, and without giving the relay an unbounded queue.

### 4.4 Pushes

A push is unsolicited and unacknowledged at the framing layer. Push events are
listed in §6.4. A client that has not subscribed receives no pushes; a client
that has subscribed and cannot keep up is subject to §13.1's backpressure rules,
not to unbounded server-side buffering.

---

## 5. The signing transcript

### 5.1 Construction

Every **signed** command carries a `SignedAuth` and is authenticated by an
Ed25519 signature over a `CommandTranscript`. The transcript is a fixed-shape
structure, encoded with `tls_codec` (§3) and signed directly — Ed25519 is not
prehashed and the transcript is small.

```
struct {
    uint8 present;                       /* 0 = unsigned command, 1 = signed */
    select (CommandAuth.present) {
        case 0: struct {};
        case 1: SignedAuth;
    } auth;
} CommandAuth;

struct {
    opaque address[32];        /* the queue address acted on; zeros where none */
    opaque signer_key[32];     /* Ed25519 public key claimed to authorize this */
    uint64 timestamp_ms;       /* client clock, milliseconds since Unix epoch  */
    opaque nonce[16];          /* client CSPRNG, fresh per command             */
    opaque signature[64];      /* Ed25519 over CommandTranscript               */
} SignedAuth;

struct {
    opaque label<0..255>;      /* exactly "free2z/relay/v1/cmd"                */
    uint16 protocol_version;
    opaque relay_id[32];       /* §5.2                                         */
    opaque channel_binding[32];/* §5.3                                         */
    uint16 command;
    uint32 request_id;
    opaque address[32];
    opaque signer_key[32];
    uint64 timestamp_ms;
    opaque nonce[16];
    opaque body_hash[32];      /* H("free2z/relay/v1/body", body)              */
} CommandTranscript;
```

`body_hash` is computed over the **re-encoded** body bytes per §3.3. Carrying a
hash rather than the body keeps the transcript fixed-length and keeps the
signature independent of body size.

Verification order at the relay, and it matters:

1. Decode and re-encode-compare the frame (§3.3). Fail → `ERR_MALFORMED`, fatal.
2. Check `timestamp_ms` against the window (§5.5). Fail → `ERR_STALE_TIMESTAMP`.
3. Check `(signer_key, nonce)` against the seen-set (§5.5). Fail → `ERR_REPLAY`.
4. Reconstruct `CommandTranscript` from the relay's own `relay_id`, its own
   computed `channel_binding`, and the frame's fields. Verify the signature.
   Fail → `ERR_BAD_SIGNATURE`.
5. Look up the address and check that `signer_key` is the key registered for it.
   Fail → `ERR_NO_ACCESS` (§10 — the same code as "no such queue").
6. Apply quota and policy. Then, and only then, mutate state.

Steps 2 and 3 precede signature verification because they are cheap and they are
the flood-resistant filters; step 5 follows verification so that an unsigned
guess cannot probe the address space.

### 5.2 Relay identity binding — the attack it closes

```
relay_id = H("free2z/relay/v1/relay-id", relay_identity_pk)
```

where `relay_identity_pk` is the relay's long-term Ed25519 public key. It is
published in the capability document, returned in `HELLO`, and **included in
every signed command's transcript.**

Without it there is a live attack, not a theoretical one.
[ADR 0005](./decisions/0005-federation.md) has a device publishing its queue
addresses on *k* relays and senders sending to all *k*. Suppose relay A and
relay B both host queues for the same pair. A signed `APPEND` sent to A is a
self-contained, valid, signed message. Relay A takes that frame verbatim and
submits it to relay B. Nothing in the frame says which relay it was for, so B
verifies the signature happily and applies it. The same holds for `ACK`, and
`ACK` is worse: relay A replays the recipient's cumulative `ACK` to relay B and
**B deletes ciphertext the recipient never received from B.** That is silent,
permanent message loss caused by one relay against another, using only bytes the
victim itself signed.

Binding the transcript to `relay_id` makes a signature valid at exactly one
relay. A frame replayed elsewhere fails at step 4.

Two consequences follow, and both are requirements:

- **The relay MUST prove possession of the identity key**, otherwise any relay
  could simply claim another's `relay_id` and the binding would be decoration.
  The `HELLO` response carries
  `relay_proof = Sign(relay_identity_sk, "free2z/relay/v1/hello" || channel_binding || client_nonce)`,
  and the client MUST verify it before sending any signed command.
- **The client must know which `relay_id` to expect.** It does: a queue advert
  (§7.2) travels inside the MLS group and carries `(relay_url, relay_id,
  send_addr)` together, authenticated by the peer. A relay substituted at the DNS
  or TLS layer presents a different `relay_id`, the client compares, and the
  mismatch is fatal. This is the same shape as the WebRTC fingerprint rule in
  [`ARCHITECTURE.md` §10](./ARCHITECTURE.md#10-p2p-webrtc--an-optimization-not-a-dependency):
  the identifying material comes from inside the authenticated channel, never
  from the infrastructure being authenticated.

### 5.3 TLS exporter channel binding — with the caveat stated

```
channel_binding = TLS-Exporter("EXPORTER-free2z-relay-v1", "", 32)
```

per [RFC 8446 §7.5](https://datatracker.ietf.org/doc/html/rfc8446#section-7.5)
(exporters; see also [RFC 5705](https://datatracker.ietf.org/doc/html/rfc5705)).
Both ends compute it from their own TLS state; it is never transmitted. The relay
recomputes it and reconstructs the transcript with its own value, so a signature
made on a different TLS session simply fails to verify.

This binds a signed command to the exact TLS session it was issued on. Combined
with §5.2 it means a captured frame is useless anywhere except the connection it
was captured from — and on that connection, §5.5 catches it.

**The honest caveat: a relay behind a TLS-terminating proxy cannot compute it.**
If TLS is terminated at a load balancer, a CDN, or an ingress controller, the
relay process has no TLS session and no exporter. This is a common and legitimate
deployment. There is no fix at this layer: proposals to have the proxy forward
the exporter value exist, none is standardized, and trusting a proxy-supplied
value would defeat the point.

Therefore:

- Such a relay MUST set `channel_binding_mode: "none"` in its capability
  document and MUST use **32 zero bytes** in the transcript.
- A client MAY refuse such a relay outright, and the reference client SHOULD make
  this a user-visible setting with a strict mode that refuses.
- **In `none` mode the restart argument of §5.5 does not hold**, so the relay
  MUST either persist its seen-set across restarts or declare
  `antireplay_persistence: "volatile"` and accept a replay window equal to the
  timestamp window across a restart. This is spelled out in §5.5 rather than
  buried, because it is the concrete cost of the mode.

### 5.4 What the transcript deliberately does not cover

- **Relative ordering of commands.** Two `APPEND`s on one connection can be
  reordered by anything in the path, and nothing in the transcript prevents it.
  Message ordering is not a relay property in this design; it is
  [`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)'s
  hash-linked DAG, precisely so that ordering survives a hostile relay. Stated
  here so nobody looks for it in the wrong layer.
- **The relay's response.** Responses are unsigned. A relay can lie about a
  response and no signature detects it. This is deliberate: every response that
  matters end-to-end is verified by other means (a `READ` result is MLS
  ciphertext that authenticates itself; a claimed deletion is unverifiable in any
  case per
  [`THREAT-MODEL.md` §4.5](./THREAT-MODEL.md#45-server-side-deletion-is-auditable-not-verifiable)),
  and signing responses would buy an audit trail against an adversary who can
  simply refuse to answer.
- **Anything about the sender's identity.** `signer_key` is a per-queue Ed25519
  key with no link to a handle, an account, or an identity key — by construction
  ([ADR 0004](./decisions/0004-metadata-ambition.md)).

### 5.5 Anti-replay: a bounded window plus a seen-set

Two mechanisms, together:

1. **Timestamp window.** `timestamp_ms` MUST be within `±clock_skew_ms` of the
   relay's clock. Default `120000` (±2 minutes), published. Outside the window →
   `ERR_STALE_TIMESTAMP`. Clients with an unreliable clock learn the relay's time
   from `HELLO` and `GET_CHALLENGE` and apply the offset locally; they MUST NOT
   set their system clock from it.
2. **Seen-set.** The relay keeps the set of `(signer_key, nonce)` pairs observed
   within the window and rejects a repeat with `ERR_REPLAY`. `nonce` is 16 bytes
   from the client's CSPRNG, fresh per command; the birthday bound is 2^64 per
   key, which is not reachable inside a two-minute window at any rate a relay
   would serve. `antireplay_window_ms` MUST be at least `2 × clock_skew_ms`, and
   an entry MUST remain live through the instant at which that retention period
   ends. Both boundaries matter: the timestamp window is inclusive, so a frame
   first accepted at `timestamp_ms - clock_skew_ms` remains valid at
   `timestamp_ms + clock_skew_ms`. A half-open seen-set would forget it at that
   same instant when the two published windows are equal.

**The seen-set is fail-closed.** It is bounded (`antireplay_seen_max`, published)
and when the bound is reached the relay returns `ERR_BACKPRESSURE` and refuses new
signed commands until entries age out. It MUST NOT evict live entries to make
room: an eviction policy that discards unexpired entries silently reopens the
replay window at exactly the moment the relay is under load, which is exactly when
an attacker would arrange to be.

**Why the seen-set deliberately need not survive a restart.** A restart destroys
every TLS session. Every command signed before the restart carries a
`channel_binding` derived from a session that no longer exists, so it cannot
verify against any new session — the channel binding has already invalidated the
entire pre-restart corpus. Persisting the seen-set would add a durability
obligation and a write on the hot path to re-derive a property the transcript
already provides. So it lives in memory, and that is a decision rather than an
oversight.

**The exception, stated:** in `channel_binding_mode: "none"` (§5.3) that argument
does not hold, because the binding is a constant. Such a relay MUST persist the
seen-set or declare `antireplay_persistence: "volatile"` and accept that a
restart reopens a replay window of `clock_skew_ms` for any frame an adversary
captured. Clients read that field and may refuse.

### 5.6 The residual, stated

Within the window, on the same TLS session, a party that can observe the frames
can replay them. That party is the relay itself, or a TLS-terminating proxy in
front of it — i.e. the operator, who by
[`THREAT-MODEL.md` §3.3](./THREAT-MODEL.md#33-compromised-relay-operator-third-party-or-ours)
already has full control of its own storage. What the operator gains from a replay
is bounded by what the commands do:

| Replayed command | Effect of the replay |
|---|---|
| `APPEND` | A duplicate ciphertext in the queue. Deduplicated end-to-end by `msg_id` ([`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)). Costs quota. |
| `ACK` | No-op. ACK is cumulative, monotone and idempotent (§8). |
| `READ` | No-op; reads do not mutate. Reveals nothing the operator does not hold. |
| `DELETE_QUEUE` | No-op after the first. |
| `CREATE_QUEUE` | A second queue, at the operator's own expense, with addresses only the operator learns. |
| `BIND_SEND` | No-op after the first (§7.3). |

So the residual is "duplicate or no-op, at the operator's expense, against an
adversary who could already refuse service." That is acceptable. It is **not**
zero, and the reason it is acceptable is the bound, not the absence.

---

## 6. Command set

Codes are `uint16` and are **stable forever** — see §10 for the same rule applied
to error codes.

| Code | Command | Auth | Address in transcript |
|---|---|---|---|
| `0x0001` | `HELLO` | none | — |
| `0x0002` | `GET_CAPABILITIES` | none | — |
| `0x0003` | `GET_CHALLENGE` | none | — |
| `0x0004` | `PING` | none | — |
| `0x0010` | `CREATE_QUEUE` | recv key | zeros |
| `0x0011` | `SUBSCRIBE` | recv key | `recv_addr` |
| `0x0012` | `UNSUBSCRIBE` | recv key | `recv_addr` |
| `0x0013` | `READ` | recv key | `recv_addr` |
| `0x0014` | `ACK` | recv key | `recv_addr` |
| `0x0015` | `DELETE_QUEUE` | recv key | `recv_addr` |
| `0x0020` | `BIND_SEND` | send key | `send_addr` |
| `0x0021` | `APPEND` | send key | `send_addr` |
| `0x0030` | `CREATE_CONTACT_QUEUE` | recv key | zeros |
| `0x0031` | `CONTACT_APPEND` | none (PoW) | — |

### 6.1 Unsigned commands

#### `HELLO` — `0x0001`

```
struct {
    uint16 min_version;
    uint16 max_version;
    opaque client_nonce[32];
} HelloRequest;

struct {
    uint16 protocol_version;          /* the version selected for this connection */
    opaque relay_identity_pk[32];
    opaque relay_id[32];              /* MUST equal H("free2z/relay/v1/relay-id", relay_identity_pk) */
    opaque relay_proof[64];           /* §5.2 */
    uint64 relay_time_ms;
    uint8  channel_binding_mode;      /* 0 = none, 1 = tls-exporter */
    uint8  transport_security;        /* 0 = none, 1 = tls */
    opaque capabilities_digest[32];   /* §11 */
} HelloResponse;
```

MUST be the first frame. If no version in `[min_version, max_version]` is
supported → `ERR_UNSUPPORTED_VERSION`, fatal. The client MUST verify
`relay_proof`, MUST recompute `relay_id` from `relay_identity_pk`, and MUST
compare `relay_id` against any value it obtained from an in-band advert (§7.2).

#### `GET_CAPABILITIES` — `0x0002`

Empty request. The response is the `Capabilities` structure of §11.1, plus the
relay's signature over it. `capabilities_digest` in `HelloResponse` is
`H("free2z/relay/v1/caps", tls_codec(Capabilities))`, so a client can detect a
policy change mid-connection without refetching.

#### `GET_CHALLENGE` — `0x0003`

```
enum { clock(0), queue_create(1), contact_append(2), (255) } ChallengePurpose;

struct {
    ChallengePurpose purpose;
    opaque scope<0..255>;    /* for contact_append: the target contact_addr */
} ChallengeRequest;

struct {
    uint64    relay_time_ms;
    opaque    challenge[32];
    uint64    expires_at_ms;
    PowParams pow;           /* §13.1; zeroed when no PoW is required */
} ChallengeResponse;
```

Three jobs, and each is a real reason for the command to exist:

1. It gives a client with an unreliable clock the relay's current time, so it can
   place `timestamp_ms` inside the window without guessing.
2. It issues a **single-use, expiring** `challenge` that a proof-of-work stamp
   must be computed over (§13.1). Because the challenge comes from the relay and
   is consumed on use, stamps cannot be precomputed in bulk before an attack, and
   a stamp cannot be replayed.
3. It publishes the *current* PoW parameters, so an operator raising difficulty
   under load takes effect immediately rather than at the next capability fetch.

Challenge issuance is itself rate-limited per source (§13.1), or it becomes the
cheapest way to make the relay do work.

#### `PING` — `0x0004`

Empty request, empty response. An application-level liveness probe, distinct from
the WebSocket Ping of §2.4 (which the browser client cannot send). Rate-limited
like everything else.

### 6.2 Commands signed by the receive-side queue key

#### `CREATE_QUEUE` — `0x0010`

```
struct {
    opaque    recv_key[32];           /* Ed25519 public key authorizing the recv side */
    uint32    req_message_ttl_seconds;
    uint32    req_idle_ttl_seconds;
    uint16    flags;                  /* reserved; MUST be 0 in v1 */
    PowStamp  stamp;                  /* §13.1; empty when queue_creation_mode = open */
} CreateQueueRequest;

struct {
    opaque recv_addr[32];
    opaque send_addr[32];
    uint32 message_ttl_seconds;       /* granted, after clamping (§7.7) */
    uint32 idle_ttl_seconds;          /* granted, after clamping (§7.7) */
    uint64 created_at_ms;
} CreateQueueResponse;
```

The transcript's `address` field is 32 zero bytes (no address exists yet) and
`signer_key` MUST equal `recv_key`, so the request is self-authenticating: it
proves possession of the key that the new queue will be bound to.

**Both addresses are generated by the relay from its own CSPRNG** (§7.1).

#### `SUBSCRIBE` — `0x0011` / `UNSUBSCRIBE` — `0x0012`

Empty bodies. `SUBSCRIBE` registers the connection to receive `MSG` pushes (§6.4)
for `recv_addr` and returns the current `next_index` so the client can decide
whether to `READ` first. A subscription is scoped to the connection and dies with
it.

```
struct {
    uint64 next_index;   /* the index the next appended message will receive */
    uint64 pending;      /* messages present and not yet acked */
} SubscribeResponse;
```

`pending` is disclosed to the **reader** only. The reader is the recipient; it is
about to learn this by reading. No equivalent is ever disclosed to a sender
(§6.3).

#### `READ` — `0x0013`

```
struct {
    uint64 from_index;
    uint16 max_messages;
    uint32 max_bytes;
} ReadRequest;

struct {
    uint64  index;
    uint64  received_at_ms;
    opaque  payload<0..2^24-1>;
} QueuedMessage;

struct {
    QueuedMessage messages<0..2^24-1>;
    uint8         has_more;
} ReadResponse;
```

`READ` never mutates. Messages remain until acknowledged (§8) or until a TTL
expires (§7.7). `from_index` below the current acked watermark returns from the
watermark; the relay MUST NOT resurrect deleted messages and MUST NOT error, so
that a client recovering from a crash can simply ask for everything it might have
missed.

#### `ACK` — `0x0014`

```
struct {
    uint64 up_to_index;      /* inclusive, cumulative */
} AckRequest;

struct {
    uint64 next_index;
    uint64 pending;
} AckResponse;
```

Semantics are §8. In summary: cumulative, monotone, idempotent, and never
selective. `up_to_index` beyond the highest appended index is `ERR_ACK_TOO_HIGH`.

#### `DELETE_QUEUE` — `0x0015`

Empty request, empty response. Deletes the queue, both addresses, and every
message it holds, acknowledged or not. Irreversible. The relay MUST subsequently
answer both addresses with `ERR_NO_ACCESS` — the same code an address that never
existed gets (§10).

The sender, if any, learns nothing except that its next `APPEND` fails with
`ERR_UNAVAILABLE` (§6.3). Telling the peer that a queue was retired is the
application's job, in-band, and is a `queue_advert` that names a replacement
(§7.5).

### 6.3 Commands signed by the send-side queue key

#### `BIND_SEND` — `0x0020`

```
struct {
    opaque send_key[32];     /* Ed25519 public key that will authorize APPEND */
} BindSendRequest;
```

**Empty response.** Not "empty for now" — empty by rule, for the reason in §6.3's
closing paragraph.

Binding is **once-only and irreversible** (§7.3). A second `BIND_SEND` on the
same address, with any key including the same key, is `ERR_ALREADY_BOUND`.

#### `APPEND` — `0x0021`

```
struct {
    opaque payload<0..2^24-1>;   /* length MUST be exactly one of the padding sizes (§9) */
} AppendRequest;
```

**The response body is empty. It carries no index, no queue depth, no timestamp
and no queue state of any kind.**

This is a requirement, not an omission.
[`ARCHITECTURE.md` §6.2](./ARCHITECTURE.md#62-queues) states that *"a sender
learns nothing about what is queued or whether it was taken."* An index would
tell the sender how many messages the queue has ever held; a depth would tell it
whether the recipient has read; a server timestamp would give it a clock to
correlate against. Each of those converts the send capability into a weak read
capability, which is precisely the escalation the two-address split exists to
prevent.

**The same rule governs errors, and this is easy to get wrong.** If "queue full"
and "no such queue" returned different codes, a bound sender could learn the
queue's state by filling it. Therefore **every send-side refusal that would
distinguish queue state collapses to the single code `ERR_UNAVAILABLE`**: absent
queue, deleted queue, expired queue, queue at its message cap, queue at its byte
cap, relay in global backpressure. See §10.

Two honest consequences:

- **A sender cannot back off intelligently.** `ERR_UNAVAILABLE` does not say
  whether to retry in a second or never. The rule is: retry with exponential
  backoff up to `send_retry_max` attempts, then surface to the application layer,
  which asks the peer in-band for a fresh advert. Delivery latency in the
  failure case is worse than it would be with informative errors. That is the
  price and we are paying it deliberately.
- **§6.2's claim is exactly true for successful appends and approximately true
  for refusals.** A sender that keeps appending until it is refused has learned
  that the queue is at capacity — one bit about queue state. The bit is cheap for
  the sender to obtain and is bounded (the caps are published, so a sender that
  counts its own successful appends can compute the same thing), but it is not
  nothing, and the merged text's "learns nothing" should be read with this
  qualification.

### 6.4 Server pushes

| Event | Code | Body | Meaning |
|---|---|---|---|
| `MSG` | `0x0080` | `opaque recv_addr[32]; QueuedMessage msg;` | A message arrived on a subscribed queue. |
| `QUEUE_EVENT` | `0x0081` | `opaque recv_addr[32]; uint8 reason;` | `1` = deleted, `2` = idle-expired, `3` = messages TTL-expired, `4` = quota reached. |
| `NOTICE` | `0x0082` | `uint8 kind; uint64 at_ms;` | `1` = draining (stop sending), `2` = shutdown at `at_ms`, `3` = capability document changed. |

`MSG` pushes go **only** to the receive side, only on an active subscription.
There is no push to a sender, ever — a push to a sender would be a channel that
tells it something about queue state, which §6.3 forbids.

`NOTICE(3)` lets a client re-fetch capabilities without polling, which matters
because §9 and §13 both depend on the client's picture of policy being current.

### 6.5 Contact-queue commands

`CREATE_CONTACT_QUEUE` (`0x0030`) and `CONTACT_APPEND` (`0x0031`) are specified
in §12, where the design they serve is explained.

---

## 7. Queue lifecycle

### 7.1 Creation, and why the relay picks the addresses

**The recipient creates the queue.** The recipient is the party that will store
the quota, hold the read capability, and pay for the space; nobody else can
usefully create it.

**The relay generates both addresses from its own CSPRNG.** 32 uniformly random
bytes each, independent of one another and of any key.

Client-chosen addresses were rejected, for two reasons:

1. **Squatting.** If a client names its own address, an adversary can create
   queues at addresses it predicts a victim will want — for example addresses
   derived from an exporter whose inputs it can guess, or simply a large sweep of
   the space — so that the victim's `CREATE_QUEUE` fails or, worse, succeeds
   against an existing attacker-controlled record. Relay-generated addresses make
   the question unaskable.
2. **Collisions.** Two independent clients deriving addresses from their own key
   material will eventually collide, and a collision between two unrelated
   conversations at a relay is a cross-conversation delivery bug with no clean
   recovery. A single CSPRNG at the relay can simply retry on collision, which it
   will never have to do at 32 bytes.

The cost is a round trip: the address is not known until the relay answers. §7.5
explains why that is affordable.

See [ADR 0009](./decisions/0009-queue-addressing-and-binding.md).

### 7.2 The send address is advertised in-band, never through the server

After creation the recipient holds `recv_addr` and `send_addr`. It keeps
`recv_addr` and gives `send_addr` to exactly one peer, in a `queue_advert`
application message **inside the MLS group**
([`ARCHITECTURE.md` §6.2](./ARCHITECTURE.md#62-queues)) — confidential,
authenticated, attributable, and never seen by any relay.

```
queue_advert = {
  type:        "free2z/queue-advert/v1",
  endpoints:   [ { relay_url, relay_id, send_addr }, ... ],   // one per relay, ADR 0005's k
  valid_from_epoch: uint64,
  replaces:    [ send_addr, ... ],       // addresses this advert retires
}
```

`relay_id` travels with the address because §5.2 needs it: it is what lets the
sender detect that it is talking to a different relay than the one the recipient
chose.

A relay never sees a `queue_advert`; it sees an opaque MLS `PrivateMessage` like
every other payload.

### 7.3 `BIND_SEND` — once-only and irreversible

The send side of a fresh queue is **unbound**: no key authorizes `APPEND` yet.
The peer that received the advert generates a fresh Ed25519 `QueueKey`, and calls
`BIND_SEND` once. From that instant, `APPEND` on that address requires a
signature by that key, forever.

**Binding is once-only and irreversible.** There is no rebind, no unbind, no
"reset by the recv key". A queue whose send side is bound to the wrong key is
dead and must be replaced by a new queue (§7.5).

The alternative — letting the recv-side key rebind — was rejected because it
turns the recv key into a control over the send side, and the recv key is the
one that lives on the recipient's device with the ability to drain the queue. We
would be adding a second capability to the strongest key in the system, in order
to recover from a failure that has a clean, cheap alternative: make a new queue.

### 7.4 The consequence, said plainly

**A relay operator who reads `send_addr` out of its own database and calls
`BIND_SEND` first steals the write capability.** The legitimate sender then gets
`ERR_ALREADY_BOUND`, and the operator can append whatever it likes to the
recipient's queue.

The client rule is therefore: **`ERR_ALREADY_BOUND` on a first bind attempt for
an address that arrived in a fresh `queue_advert` is a loud, non-dismissible
failure.** Not a retry, not a warning toast, not a log line. The conversation is
marked as compromised at the transport layer, the queue is abandoned, and the
user is told that the relay it names behaved incorrectly.

**This does not prevent the theft of the write capability. It makes it noisy.**
The operator gets the capability; what it does not get is silence. That is the
entire property, and it should be read as exactly that much and no more:

- The operator cannot **read** the queue — `send_addr` authorizes `APPEND` only,
  and the recv key is not derivable from it
  ([`ARCHITECTURE.md` §6.2](./ARCHITECTURE.md#62-queues)).
- Anything the operator appends fails MLS authentication at the recipient, so it
  is garbage, not forgery
  ([`THREAT-MODEL.md` §3.3](./THREAT-MODEL.md#33-compromised-relay-operator-third-party-or-ours)).
- What the operator gains is the ability to **deny** the legitimate sender its
  queue, and to fill the recipient's quota. Both are denial of service, which the
  operator already had by simply refusing to serve.
- What the design buys is that the denial is **attributable to a specific relay
  at a specific moment**, rather than presenting as flaky delivery.

An operator willing to be caught can do this. Nothing here stops it. The relevant
comparison is not "secure versus insecure" but "detected versus undetected", and
the same comparison governs
[`THREAT-MODEL.md` §4.5](./THREAT-MODEL.md#45-server-side-deletion-is-auditable-not-verifiable).

A partial narrowing that was considered and **not** adopted in v1: requiring the
recipient to pre-commit to the sender's key at creation time
(`CREATE_QUEUE{expected_send_key}`), which would close the race entirely. It was
rejected because the recipient does not know the sender's fresh queue key at
creation time — learning it would need an extra in-band round trip *before* the
advert, turning a one-message advert into a three-message handshake for every
queue and every rotation. It is the right answer if the race ever proves to
matter in practice, and it is recorded here so the option is on the record rather
than rediscovered later.

### 7.5 Rotation needs no new command

Queue rotation is: **create a new queue, advertise it in-band, delete the old
one.** There is no `ROTATE` command and there should not be one.

```
1. Recipient: CREATE_QUEUE           → (recv_addr', send_addr')
2. Recipient: queue_advert{ send_addr', replaces: [send_addr] }   (inside MLS)
3. Sender:    BIND_SEND on send_addr' with a fresh key
4. Sender:    APPEND to send_addr' from valid_from_epoch onward
5. Recipient: drains recv_addr, then DELETE_QUEUE on recv_addr
```

The schedule is the `free2z/queue/v1` exporter of
[`ARCHITECTURE.md` §5.4](./ARCHITECTURE.md#54-exporter-derived-application-secrets),
with context `peer_leaf_index`, so both sides know a rotation is due at the same
moment without negotiating it.

**A narrowing of §5.4 that must be stated.** `ARCHITECTURE.md` §5.4's table says
the queue exporter *"derives the next queue addresses without a round trip."*
Under §7.1 that is no longer accurate, and the docs should not be read as though
it were. What the exporter derives is the **rotation schedule and the next queue
signing keys**:

```
rot = MLS-Exporter("free2z/queue/v1", peer_leaf_index || rotation_counter, 64)
      → (next_recv_queue_key_seed, next_send_queue_key_seed)
```

The **addresses still come from the relay**, and the new `send_addr` still has to
reach the peer in an advert. So rotation costs one relay round trip and one
in-band message that the pair was not otherwise sending. That is the price of
refusing client-chosen addresses (§7.1), it is small — one message per rotation
period, against a conversation that is exchanging messages anyway — and it is
recorded here rather than left as a contradiction between two documents. The
tracking note is in
[`ARCHITECTURE.md` §5.4](./ARCHITECTURE.md#54-exporter-derived-application-secrets).

Overlap: the old queue MUST remain readable until the recipient has drained it.
The sender switches at `valid_from_epoch`; the recipient deletes only after the
old queue is empty and acknowledged. A message in flight during the switch lands
in the old queue and is read from it.

### 7.6 Deletion

`DELETE_QUEUE` removes the queue and its contents unconditionally. A relay MUST
NOT retain a tombstone that distinguishes "deleted" from "never existed" in any
externally observable way (§10).

### 7.7 TTLs

Two independent timers. Both are per-queue, both are requested at creation, both
are clamped by relay policy, and both granted values are returned in
`CreateQueueResponse` so the client knows what it actually got.

| Timer | Field | Default | Ceiling | Resets on |
|---|---|---|---|---|
| Message TTL | `message_ttl_seconds` | 604 800 (7 days) | **2 592 000 (30 days)** | — (per message, from append) |
| Queue idle TTL | `idle_ttl_seconds` | 7 776 000 (90 days) | 31 536 000 (365 days) | any successful `APPEND`, `READ`, `ACK`, `SUBSCRIBE` |

**Message TTL** is the ceiling from
[`ARCHITECTURE.md` §6.3](./ARCHITECTURE.md#63-what-delivered-means): undelivered
ciphertext is dropped after it, and the sender learns only from the continued
absence of a receipt. A relay MUST NOT grant more than 30 days. The 7-day default
is chosen because a device that has been offline for a week has stale MLS state
anyway and will be repairing gaps (§7 of the architecture) rather than draining a
month-old queue; a client that wants longer asks and the relay clamps.

**Queue idle TTL is new here.** The merged docs specify nothing of the kind, and
without it the queue table grows without bound: every abandoned device, every
uninstalled client, every rotation whose `DELETE_QUEUE` never arrived leaves a
row that no timer ever removes, and messages TTL out while the row itself is
immortal. A relay's storage cost is then unbounded in *queues* even though it is
bounded in *ciphertext*, which quietly defeats
[ADR 0005](./decisions/0005-federation.md)'s "$5/month VPS" economics.

The failure mode is real and must be stated: **a user whose device is offline
longer than the idle TTL loses their queues.** Their peers' adverts become dead
addresses, `APPEND` starts returning `ERR_UNAVAILABLE`, and the pair must
re-establish — via a contact queue (§12) if no live queue remains in either
direction. Ninety days is chosen to be far longer than any plausible holiday and
far shorter than "forever". It is a policy value, published, and an operator
serving a population of intermittently-connected users should raise it.

Expiry of either timer is silent to the sender and surfaces to a subscribed
reader as `QUEUE_EVENT` (§6.4).

---

## 8. ACK semantics

### 8.1 Cumulative and monotone, never selective

`ACK{up_to_index}` acknowledges **every** message with index ≤ `up_to_index`. The
relay deletes them and advances the queue's acked watermark.

- **Monotone.** An `ACK` whose `up_to_index` is below the current watermark is
  accepted and is a no-op. The watermark never moves backwards.
- **Never selective.** There is no "ack message 7 but not 5". Selective
  acknowledgement would require the relay to hold a per-message state bitmap,
  which is per-queue state proportional to the queue rather than a single
  integer, and it would let a reader hold a message indefinitely while
  acknowledging later ones — a shape with no legitimate use and an obvious abuse.
  A reader that cannot process message 5 must not acknowledge 7.

### 8.2 Acking beyond the highest appended index is an error

`up_to_index` greater than the highest index the relay has ever appended to that
queue is `ERR_ACK_TOO_HIGH`, and the watermark does not move.

The reason is specific and it is not tidiness. Without this rule a reader could
**pre-ack** — set the watermark to a very large value — after which every future
`APPEND` is deleted the instant it lands, while the sender continues to receive
successful (empty) `APPEND` responses because §6.3 forbids telling it anything.
A device could black-hole its own queue silently and indefinitely, and the only
symptom anywhere in the system would be the absence of `device-delivered`
receipts, which is indistinguishable from the recipient being offline
([`THREAT-MODEL.md` §4.4](./THREAT-MODEL.md#44-tail-truncation-is-not-detectable-by-hash-links)).
The rule costs one comparison and removes the possibility.

### 8.3 Idempotent, so retries are safe

Replaying or retrying an `ACK` is a no-op by §8.1's monotonicity. This is what
makes the connection-loss case tractable: a client that sent an `ACK` and never
saw the response simply sends it again after reconnecting. It does not need to
know whether the first one arrived, and it must not try to find out by reading —
the messages may legitimately be gone.

The same is *not* true of `APPEND`, which is not idempotent at the relay: a
retried `APPEND` after an unknown outcome produces a duplicate. That is by design
and it is why deduplication lives end-to-end, at `msg_id`
([`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)).
Duplicate-tolerant delivery plus idempotent acknowledgement is the combination
that survives [#131](https://github.com/free2z/zuu/issues/131)'s core observation
that a dropped connection tells you nothing about what arrived.

### 8.4 Where this sits in the four delivery states

[`ARCHITECTURE.md` §6.3](./ARCHITECTURE.md#63-what-delivered-means) defines four
states and warns that conflating them is how delete-on-ack loses messages. This
document implements exactly one of them:

| State | Implemented by |
|---|---|
| `accepted` | An `APPEND` that returned status 0. Says nothing about the recipient — §6.3 makes sure of it. |
| `queue-delivered` | **`ACK` in this document.** The relay deletes at this instant. |
| `device-delivered` | An MLS `DeliveryReceipt` inside the group. Not a relay concept; the relay never sees one. |
| `delivered` | Computed by the sender from receipts across the recipient's whole device set. Not a relay concept. |

**And the rule that everything depends on, restated because it belongs next to
the wire format:**

> **A device MUST NOT send `ACK` before its durable local write has completed.**

ACK-on-read plus a crash equals permanent message loss, because the relay has
already deleted the only copy. This is a MUST in the client, it is the single
most safety-critical rule in the delivery layer
([ADR 0002](./decisions/0002-multi-device.md)), and the wire protocol cannot
enforce it — the relay has no way to know whether a write completed. It is stated
here so that an implementer reading only this document still meets it.

A relay's own durability is the mirror image and is published as
`durability_mode` (§11.1): `fsync-per-append` means an `APPEND` that returned 0
survives a crash; `batched` and `memory` mean it may not. No end-to-end contract
breaks in the weaker modes, because `accepted` never promised anything — but a
client SHOULD prefer durable relays and the value is published so it can.

---

## 9. Padding enforcement

A payload's length MUST be **exactly** one of the sizes in the relay's published
`padding_sizes`. Any other length is `ERR_BAD_SIZE`, non-fatal.

Payloads larger than the largest bucket are chunked client-side into
`max_chunk_bytes` units (default 64 KiB) and appended as separate messages, per
[`ARCHITECTURE.md` §6.5](./ARCHITECTURE.md#65-padding). This leaks the chunk
count, and therefore the approximate length of anything larger than one bucket.
That is inherent in chunking and is not new here; it is noted so it is not
mistaken for a property the padding provides.

**The size set lives in the capability document, not in the protocol.** This is
deliberate. [`ARCHITECTURE.md` §13-F](./ARCHITECTURE.md#13-open-questions) records
that the bucket sizes are placeholders chosen for arithmetic convenience and need
a traffic study. When that study lands, an operator should change a configuration
value and restart — not coordinate a flag day across a federation to bump a
protocol version. Putting the set in a versioned protocol structure would make
the eventual measured answer maximally expensive to adopt, which is a good way to
guarantee it never gets adopted.

**But the relay's list is a filter, not the source of truth.** The security
property comes from the *client* padding to its own configured bucket set before
the ciphertext ever leaves the device. The relay's rejection is a backstop against
a sloppy client and against a malicious client trying to use length as a covert
channel to a colluding relay ([ADR 0004](./decisions/0004-metadata-ambition.md)).
It follows that:

- A client MUST pad to its **own** set and MUST refuse a relay whose published
  set is not a superset of the sizes the client will emit.
- A client SHOULD refuse a relay whose published set is implausibly fine-grained
  (v1 rule of thumb: more than 16 entries, or a spacing below 512 bytes between
  adjacent buckets), because such a set is indistinguishable from an attempt to
  let a colluding client leak length through size.
- A relay that publishes a coarse set and a client that pads to a fine set simply
  fails at `ERR_BAD_SIZE`, loudly, which is the correct direction for the failure
  to point.

---

## 10. Error codes

`uint16`. **Stable forever: a code's meaning is never changed and a retired code
is never reused.** The same rule the architecture applies to open-question letters
applies here, and for the same reason — a client in the field, a log archive, and
a bug report from two years ago must all still mean the same thing.

| Code | Name | Fatal | Meaning |
|---:|---|:---:|---|
| 0 | — | | Success. Reserved; never an error. |
| 1 | `ERR_MALFORMED` | ● | Decode failure, re-encode mismatch (§3.3), oversize frame, duplicate in-flight `request_id`. |
| 2 | `ERR_UNSUPPORTED_VERSION` | ● | No common protocol version, or a frame before `HELLO`. |
| 3 | `ERR_FRAME_TYPE` | ● | A text WebSocket frame (§4.2). |
| 4 | `ERR_TOO_MANY_INFLIGHT` | ● | `max_inflight` exceeded (§4.3). |
| 5 | `ERR_UNKNOWN_COMMAND` | | Unknown command code. |
| 6 | `ERR_BAD_SIGNATURE` | | Signature verification failed (§5.1 step 4). |
| 7 | `ERR_STALE_TIMESTAMP` | | Outside `clock_skew_ms` (§5.5). |
| 8 | `ERR_REPLAY` | | `(signer_key, nonce)` already seen (§5.5). |
| 9 | `ERR_CHANNEL_BINDING` | | Reserved for a future binding-mode mismatch; unused in v1. |
| 10 | `ERR_NO_ACCESS` | | **Either** the address does not exist **or** it exists and `signer_key` does not authorize it. See below. |
| 11 | `ERR_ALREADY_BOUND` | | `BIND_SEND` on an already-bound send address (§7.3). |
| 12 | `ERR_BAD_SIZE` | | Payload length not in `padding_sizes` (§9). |
| 13 | `ERR_ACK_TOO_HIGH` | | `up_to_index` above the highest appended index (§8.2). |
| 14 | `ERR_QUOTA` | | A recv-side quota was exceeded (queue count, creation rate). |
| 15 | `ERR_UNAVAILABLE` | | **Send side only.** Absent, deleted, expired, full-by-messages, full-by-bytes, or relay backpressure — collapsed into one code (§6.3). |
| 16 | `ERR_POW_REQUIRED` | | A stamp is required and was absent (§13.1). |
| 17 | `ERR_POW_INVALID` | | Stamp invalid, expired, for the wrong challenge, or already consumed. |
| 18 | `ERR_BACKPRESSURE` | | Global resource limit; retry later (§13.1). Also the seen-set bound (§5.5). |
| 19 | `ERR_RATE_LIMITED` | | Per-connection or per-source rate limit. |
| 20 | `ERR_NOT_PERMITTED` | | The command is not valid for this queue kind — e.g. `BIND_SEND` on a contact queue (§12.2). |
| 21 | `ERR_INTERNAL` | | Relay fault. Carries no detail, ever. |

### The existence-oracle rule

**"No such queue" and "exists, but your key does not authorize it" MUST return
the same code (10).** If they differ, the relay is an oracle for the existence of
queue addresses: an attacker sweeping the address space learns which 32-byte
values are live queues, which is exactly the information the opaque addressing of
[ADR 0004](./decisions/0004-metadata-ambition.md) exists to withhold. A 32-byte
space is not sweepable by brute force, but an oracle is also useful against
addresses obtained by other means — a leaked log line, a partially-observed
advert, a database from a decommissioned relay — and there is no reason to
provide it.

**And the honest limit: this is not constant time, and we do not claim it is.**
The two paths do different amounts of work. The absent path is an index miss. The
present-but-unauthorized path is an index hit — touching storage, possibly a
cache line, possibly a disk page — followed by a key comparison and a signature
verification. A patient attacker measuring response latency across many probes
can distinguish them statistically.

What a relay MUST do is narrow it, not claim to close it:

- On the absent path, perform a **dummy Ed25519 verification against a fixed
  key** so that the dominant CPU cost is present in both paths.
- Compare keys with a constant-time comparison.
- Do not short-circuit before the dummy work.

What remains after that is storage-layer behaviour — cache residency, page
faults, index depth — which is not equalizable without a design that keeps every
lookup uniform, and that is a much larger change than v1 warrants. **The residual
timing side channel is real and is stated here rather than papered over.**

---

## 11. The capability document

### 11.1 What an operator publishes

A relay's entire externally-relevant policy, in one signed structure. It is the
document a client reads to decide whether to use a relay at all, and the document
a human reads to decide whether to trust its operator.

```
struct {
    uint16   protocol_versions<1..255>;

    /* identity */
    opaque   relay_identity_pk[32];
    opaque   relay_id[32];

    /* transport */
    uint8    transport_security;          /* 0 = none (override, §2.3), 1 = tls */
    uint8    channel_binding_mode;        /* 0 = none, 1 = tls-exporter */
    uint32   max_frame_bytes;
    uint16   max_inflight;
    uint16   ws_ping_interval_seconds;
    uint32   handshake_timeout_ms;

    /* anti-replay */
    uint32   clock_skew_ms;
    uint32   antireplay_window_ms;
    uint8    antireplay_persistence;      /* 0 = volatile, 1 = durable (§5.3, §5.5) */

    /* padding */
    uint32   padding_sizes<1..2^16-1>;    /* ascending, §9 */
    uint32   max_chunk_bytes;

    /* queues */
    uint32   min_message_ttl_seconds;
    uint32   max_message_ttl_seconds;     /* MUST be <= 2592000 */
    uint32   default_message_ttl_seconds;
    uint32   min_idle_ttl_seconds;
    uint32   max_idle_ttl_seconds;
    uint32   default_idle_ttl_seconds;
    uint32   max_queue_messages;
    uint64   max_queue_bytes;

    /* anti-abuse */
    uint8    queue_creation_mode;         /* 0 = open, 1 = pow, 2 = token (§13.1) */
    PowParams queue_creation_pow;
    uint8    contact_queues_enabled;
    uint32   contact_max_pending;
    uint64   contact_max_bytes;
    PowParams contact_append_pow;
    uint8    per_source_limits;           /* 0 = off, 1 = on (§13.3) */
    uint8    durability_mode;             /* 0 = memory, 1 = batched, 2 = fsync-per-append */

    /* operator — human-readable, and the point of the document */
    opaque   operator_name<0..255>;
    opaque   operator_contact<0..255>;    /* how to reach a human */
    opaque   operator_abuse_contact<0..255>;
    opaque   operator_jurisdiction<0..255>;  /* where the operator and hardware sit */
    opaque   operator_policy_url<0..255>;

    /* provenance */
    opaque   source_repo_url<0..255>;
    opaque   source_commit<0..255>;
    opaque   build_digest<0..255>;        /* reproducible-build digest of the running binary */

    uint64   published_at_ms;
} Capabilities;

struct {
    Capabilities capabilities;
    opaque       signature[64];   /* Ed25519 by relay_identity_pk over tls_codec(capabilities) */
} SignedCapabilities;
```

Note what the last two blocks are for. `operator_jurisdiction` and the contact
fields are not decoration: a user choosing among *k* relays
([ADR 0005](./decisions/0005-federation.md)) is making a jurisdictional choice
whether or not anyone tells them so, and publishing where the hardware sits is the
minimum that makes that choice informed. `source_commit` and `build_digest` are
what turn "open source and self-hostable" into something a third party can check
— they are the difference between an auditable claim and an unverifiable one
([`THREAT-MODEL.md` §4.5](./THREAT-MODEL.md#45-server-side-deletion-is-auditable-not-verifiable)).

### 11.2 Served two ways, on purpose

1. **Over the protocol**, via `GET_CAPABILITIES` (§6.1). Canonical `tls_codec`
   bytes, signed. This is what the client parses.
2. **Over plain HTTPS**, at
   `GET https://<host>/.well-known/free2z-relay/v1/capabilities`, as JSON, with
   the same values, the same signature (base64url), and the same
   `capabilities_digest`.

The second exists so that **a human can read a relay's policy before connecting**
— and so can a journalist, a researcher, or a client author comparing relays. It
needs no client, no WebSocket and no protocol knowledge. It also makes policy
publicly diffable over time: a relay that quietly shortens its TTLs, turns on
per-source limits, or changes jurisdiction is doing so at a URL anyone can poll,
which converts a silent policy change into an observable one.

Honest note: **nothing forces the two representations to agree except the
operator.** A relay could serve one policy to humans and another to clients. What
makes that costly is that both are signed by the same key and both carry the same
digest field, so a client that fetches the well-known document and compares
digests detects the divergence. Clients SHOULD do this on first use of a relay and
MUST refuse on mismatch.

### 11.3 What a client does with it

On first use of a relay, and on `NOTICE(3)`:

1. Fetch, verify the signature against the `relay_identity_pk` proven in `HELLO`.
2. Refuse if `transport_security = none` without explicit user opt-in (§2.3).
3. Refuse if `channel_binding_mode = none` and the user's policy is strict
   (§5.3).
4. Refuse if `padding_sizes` is not a superset of what this client emits, or is
   implausibly fine-grained (§9).
5. Refuse if `max_message_ttl_seconds > 2592000` — the relay is claiming a policy
   the architecture forbids.
6. Record `queue_creation_mode`, quotas and PoW parameters for §13.
7. Surface operator name, jurisdiction and contact in the relay-picker UI.

---

## 12. First contact

### 12.1 The gap — and it is a real one in the merged design

[`ARCHITECTURE.md` §6.2](./ARCHITECTURE.md#62-queues) says queue addresses are
established *"inside the MLS group — a member advertises its `QueueSendAddr` set
to peers in an authenticated application message, never via the server."*

That is correct and it is circular. **There is no path for the `Welcome` that
creates the group in the first place.** Alice cannot advertise a queue to Bob
inside a group that does not exist, and she cannot send Bob the `Welcome` that
would create it, because Bob has no queue that Alice is allowed to write to. As
merged, two people who have never spoken can never begin.

This section closes that hole. It is invented here in full; see
[ADR 0011](./decisions/0011-first-contact-contact-queues.md).

### 12.2 The contact queue

A **contact queue** is a distinctly-flavoured queue, created with
`CREATE_CONTACT_QUEUE` (`0x0030`), whose shape differs from an ordinary queue in
exactly four ways:

1. **Its send side is never bound.** `BIND_SEND` on a contact address returns
   `ERR_NOT_PERMITTED`, always, for everyone. There is no key that authorizes
   writing to it, which means there is no key that can be stolen, squatted (§7.4)
   or lost.
2. **It accepts unsigned appends**, via `CONTACT_APPEND` (`0x0031`), from anyone
   who presents a valid proof-of-work stamp.
3. **Its address is published**, in the owner's directory entry, rather than
   advertised in-band. It is a public address by design — the one address in the
   system that is meant to be looked up.
4. **It is hard-capped** (§12.3), because point 2 means the whole internet may
   write to it.

```
struct {
    opaque    recv_key[32];
    uint32    req_message_ttl_seconds;
    uint32    req_idle_ttl_seconds;
    PowStamp  stamp;
} CreateContactQueueRequest;

struct {
    opaque recv_addr[32];
    opaque contact_addr[32];      /* the published address; never bindable */
    uint32 message_ttl_seconds;
    uint32 idle_ttl_seconds;
    uint32 max_pending;           /* granted cap */
    uint64 max_bytes;             /* granted cap */
} CreateContactQueueResponse;

struct {
    opaque    contact_addr[32];
    opaque    payload<0..2^24-1>;   /* length MUST be in padding_sizes (§9) */
    PowStamp  stamp;                /* over a relay-issued challenge (§6.1) */
} ContactAppendRequest;
```

`CONTACT_APPEND`'s response is **empty**, for the same reason `APPEND`'s is
(§6.3): a stranger writing to Bob's contact queue must learn nothing about how
full it is or whether Bob has read it. Refusals collapse to `ERR_UNAVAILABLE` on
the same rule.

Reading, acknowledging and deleting a contact queue use the ordinary recv-side
commands, signed by `recv_key`. Its receive side is a perfectly normal queue.

The **published address** lives in the owner's directory entry:

```
contact_endpoints: [ { relay_url, relay_id, contact_addr }, ... ]
```

The full `DirectoryEntry` structure is now
[`KT.md` §4.1](./KT.md#41-structure), which carries this as a
`ContactEndpoint<0..2^16-1>` covered by the entry's authorization signature.
This document specifies only that the field exists, what it contains, and
that it is covered by whatever signature the entry carries — a contact endpoint
that is not authenticated by the directory is a server-supplied address, which is
the MITM of [#133](https://github.com/free2z/zuu/issues/133) reintroduced at the
point of first contact.

### 12.3 The caps, because anyone can write

A relay MUST enforce all four, and MUST publish all four:

| Cap | Field | Default | What it stops |
|---|---|---|---|
| Pending messages | `contact_max_pending` | 64 | Unbounded growth from one flood. |
| Total bytes | `contact_max_bytes` | 256 KiB | Large-payload amplification. |
| Per-source rate | `per_source_limits` | on | Trivial single-host flooding. |
| Proof of work | `contact_append_pow` | required | Cheap bulk sending. |

The stamp MUST be computed over a **relay-issued, single-use, expiring
challenge** obtained from `GET_CHALLENGE(purpose = contact_append, scope =
contact_addr)`. Binding the stamp to the target address and to a relay-issued
challenge means stamps cannot be precomputed at leisure before a campaign, cannot
be reused, and cannot be computed for one victim and spent on another.

Stamp construction (§13.1) is a leading-zero-bit search over BLAKE2b, chosen so
that **verification is a single hash** — the relay's own cost under flood is the
thing that must stay near zero.

### 12.4 The honest limits

**Proof of work taxes phones far more than it taxes rented GPUs.** This is the
central weakness and it is not fixable by tuning. A leading-zero-bit search is
precisely the workload that commodity parallel hardware accelerates best; the
ratio between a rented GPU-hour and a mid-range phone's battery-constrained
budget is orders of magnitude. Any difficulty high enough to meaningfully cost an
attacker is a difficulty that makes a cheap Android device sit there heating up
before it can say hello. We have chosen a difficulty that is a nuisance to
attackers and tolerable to phones, which means it is *only* a nuisance. A
memory-hard function (Argon2id and relatives) would narrow the hardware gap, and
it was rejected for v1 because it multiplies the *relay's* verification cost by
the same factor that it raises the attacker's — the wrong trade at the moment of
a flood, when the relay is the resource under pressure. The calibration is
unresolved and is recorded as
[`ARCHITECTURE.md` §13-N](./ARCHITECTURE.md#13-open-questions).

**Disk exhaustion by mass queue creation is made expensive, not closed.** Nothing
here prevents an adversary with real resources from creating a very large number
of legitimate-looking queues, each with a valid stamp, from a large number of
sources. The caps bound what any *one* queue costs; they do not bound how many
queues exist. §13.1's global backpressure is what keeps the relay alive under
that, and its effect is to degrade service for everyone rather than to identify
the attacker — because identifying the attacker requires exactly the identity the
relay deliberately does not have.
[`ARCHITECTURE.md` §13-I](./ARCHITECTURE.md#13-open-questions)'s anonymous
credentials — prove you paid for capacity without revealing who you are — are the
real answer, and they remain deferred and unspecified.

**A contact queue can be filled to deny first contact.** An attacker willing to
pay `contact_max_pending` stamps can keep Bob's contact queue full, so that
nobody new can reach him until he drains it. Existing conversations are entirely
unaffected (they use ordinary queues), and Bob's client drains aggressively, but
during a sustained flood Bob is unreachable to strangers. His remedy is to create
a new contact queue and republish his directory entry — which costs a directory
epoch, so it is slow. This is a real, unmitigated denial of service against
first contact and it should be read as one.

**Unsigned appends are unauthenticated by construction.** The filter is
cryptographic and it happens at Bob's device, not at the relay: a payload that is
not a `Welcome` addressed to one of Bob's published `KeyPackage`s fails to
decrypt and is discarded. Junk costs Bob bandwidth and a stamp costs the attacker
work; well-formed unwanted contact requests are a moderation problem and are
surfaced to Bob as requests, not as messages.

### 12.5 The full handshake, end to end

Alice has never spoken to Bob. She knows `@bob`.

```
1.  Alice → directory:  resolve "@bob"
                        → identity key, device credentials, KeyPackages,
                          contact_endpoints [ {relay_url, relay_id, contact_addr} ]
                        with an inclusion proof, verified against a cosigned root
                        (ARCHITECTURE.md §9.2, §9.3)

2.  Alice (local):      build the MLS group, produce Welcome addressed to Bob's
                        KeyPackage; pad to a bucket in padding_sizes

3.  Alice → relay:      HELLO; verify relay_proof; compare relay_id against the
                        value in Bob's directory entry
4.  Alice → relay:      GET_CHALLENGE(contact_append, scope = contact_addr)
5.  Alice (local):      compute PowStamp over the challenge
6.  Alice → relay:      CONTACT_APPEND{contact_addr, payload, stamp}   → empty OK

7.  Bob   → relay:      SUBSCRIBE / READ on his contact queue's recv_addr (signed)
8.  Bob   (local):      durable write, then ACK  ← the §8.4 MUST
9.  Bob   (local):      process Welcome; join the group; show Alice as a contact
                        request in the UI, not as a message

10. Bob   → relay:      CREATE_QUEUE  → (recv_addr_B, send_addr_B)
11. Bob   → Alice:      queue_advert{ send_addr_B, ... }        INSIDE the MLS group
12. Alice → relay:      BIND_SEND on send_addr_B with a fresh key
13. Alice → relay:      CREATE_QUEUE  → (recv_addr_A, send_addr_A)
14. Alice → Bob:        queue_advert{ send_addr_A, ... }        INSIDE the MLS group
15. Bob   → relay:      BIND_SEND on send_addr_A with a fresh key

    From here the contact queue plays no further part for this pair.
```

Three properties of this flow are worth stating explicitly:

- **The contact queue is used exactly once per pair**, for one message, in one
  direction. Everything afterwards is ordinary queues with bound send keys.
- **The relay learns that someone contacted `contact_addr`**, which is a public
  address associated with Bob in a public directory. It does not learn who: the
  append is unsigned and carries no client identity. It does see the source IP,
  as it does for everything ([`THREAT-MODEL.md` §3.3](./THREAT-MODEL.md#33-compromised-relay-operator-third-party-or-ours)).
- **The directory lookup at step 1 reveals interest in `@bob`** — the accepted,
  documented limit of
  [`THREAT-MODEL.md` §4.1](./THREAT-MODEL.md#41-directory-lookup-reveals-interest-in-a-handle).
  First contact is exactly the moment that limit applies, and this flow does not
  worsen it.

**Dependency, flagged rather than invented:** step 1 assumes Bob has published
MLS `KeyPackage`s that Alice can fetch, and step 2 assumes one is available and
unexpired. KeyPackage publication, last-resort key packages, exhaustion behaviour
and rate limiting on fetches are **directory design**, deferred with `KT.md` and
ADR 0013 (§1.2). This document does not specify them and must not be read as
having done so.

---

## 13. Anti-abuse v1

See [ADR 0012](./decisions/0012-anti-abuse-v1.md).

### 13.1 The layers

**Layer 1 — connection limits.** Maximum concurrent connections per source
address; maximum new connections per second per source; `handshake_timeout_ms`
(§2.5); `max_frame_bytes` (§4.1); `max_inflight` (§4.3); a per-connection command
rate limit yielding `ERR_RATE_LIMITED`. All cheap, all applied before any
signature verification.

**Layer 2 — per-queue quotas.** `max_queue_messages`, `max_queue_bytes`, and an
append rate limit, all per queue. Exceeding any of them on the send side is
`ERR_UNAVAILABLE` (§6.3), never a distinguishable code.

**Layer 3 — queue-creation control.** Creating a queue is the only command that
allocates durable state out of nothing, so it is the one that needs a gate.
`queue_creation_mode` is one of:

- `open` — no gate. Appropriate only for a private relay on a closed network.
- `pow` — **the default.** `CREATE_QUEUE` and `CREATE_CONTACT_QUEUE` require a
  `PowStamp` over a relay-issued challenge.
- `token` — an operator-issued bearer token. Honest note: **a token is an
  identifier.** It lets the operator link every queue created with it, which
  reintroduces exactly the linkability that opaque per-pair addresses exist to
  remove ([ADR 0004](./decisions/0004-metadata-ambition.md)). Token mode is
  supported because a closed deployment may legitimately want it, it MUST be
  declared in the capability document, and clients SHOULD prefer `pow` relays and
  SHOULD say in the UI what a token-gated relay can correlate.

```
struct {
    uint8  algorithm;        /* 1 = blake2b-leading-zero-bits; no other value in v1 */
    uint8  difficulty_bits;
    uint32 challenge_ttl_ms;
} PowParams;

struct {
    opaque challenge[32];    /* from GET_CHALLENGE; single-use, expiring */
    opaque salt[16];
    uint64 counter;
} PowStamp;
```

A stamp is valid iff
`H("free2z/relay/v1/pow", challenge || salt || counter)` has at least
`difficulty_bits` leading zero bits, the challenge is unconsumed and unexpired,
and (for `contact_append`) the challenge was issued for that `contact_addr`.
Verification is one hash; the relay marks the challenge consumed. The choice of a
verify-cheap, GPU-friendly function and its consequences are argued in §12.4.

**Layer 4 — global backpressure.** The relay tracks storage and memory against
published high-water marks. On crossing them it refuses work in this order:

1. `CREATE_QUEUE` / `CREATE_CONTACT_QUEUE` → `ERR_BACKPRESSURE`
2. `APPEND` / `CONTACT_APPEND` → `ERR_UNAVAILABLE`
3. New connections → refused at accept

`READ`, `ACK` and `DELETE_QUEUE` are **never** refused for backpressure. They are
the operations that make the relay smaller, and refusing them under load is a
deadlock.

### 13.2 Never delete un-acked messages to make room

**Under no circumstance does a relay delete an unacknowledged message to free
space.** Not the oldest, not the largest, not from the fullest queue. When it runs
out of room it **refuses new writes**.

The reason is the other half of delete-on-ack. The entire contract is: the relay
holds ciphertext until the reader durably writes it and acknowledges, then
deletes. A sender that received `accepted` has been told the relay took custody;
if the relay may later discard that message to make room, then `accepted` means
nothing at all and the recipient's `ACK` is not the only thing that removes data.
The system would then be losing messages by a mechanism that
[`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)'s
DAG detects only when a *later* message arrives to dangle a parent — i.e. the
tail-truncation blind spot of
[`THREAT-MODEL.md` §4.4](./THREAT-MODEL.md#44-tail-truncation-is-not-detectable-by-hash-links),
reached by ordinary operation rather than by attack.

Refusing a write is loud, immediate, and lands on the party that can do something
about it. Silently dropping an accepted message is quiet, delayed, and lands on
someone who cannot. **Refusal is the correct failure mode**, and a relay that is
persistently refusing is a relay that needs a bigger disk or fewer users — which
is exactly the signal an operator should receive.

The one deletion that is not a refusal is TTL expiry (§7.7), which is
announced in advance in the capability document, bounded by the architecture's
30-day ceiling, and visible to a subscribed reader as `QUEUE_EVENT`.

### 13.3 What is not closed

- **Distributed queue-creation flooding with valid stamps.** An adversary with
  many sources and real compute creates many legitimate queues. Every stamp is
  valid, every queue is well-formed, and the relay has no basis on which to
  distinguish them from users — because the basis would be identity, which it
  deliberately does not have. Backpressure keeps it alive by degrading service
  for everyone. This is not solved; §13-I's anonymous credentials are the
  intended answer and are deferred.
- **An abusive but legitimately bound sender.** Once `BIND_SEND` has succeeded,
  the relay cannot tell wanted traffic from unwanted traffic — the payload is
  opaque ciphertext and that is the point. The remedy is entirely client-side and
  in-band: the recipient stops acknowledging, deletes the queue (§6.2), and does
  not advertise a replacement to that peer. That is correct, and it is slower and
  clumsier than a block button on a server that could see who was talking. We
  chose the metadata property; this is part of its cost.
- **Per-source limits harm exactly the users who most need the system.** A Tor
  exit node, a CGNAT block, a university NAT and a shared VPN egress all present
  as one source address carrying many legitimate users. Per-source limits will
  throttle them. There is **no good answer** without an identity the relay
  deliberately lacks: allowlisting Tor exits removes the limit for the population
  most able to rotate addresses, and rate-limiting by anything more granular than
  an address requires knowing something about the client. Operators SHOULD publish
  whether per-source limits are on (`per_source_limits`) so that a user behind
  shared egress can choose a relay that does not use them, and that is the whole
  of the mitigation.

---

## 14. Handle charset for messaging — blocking pre-check, resolved

[`ARCHITECTURE.md` §9](./ARCHITECTURE.md#9-identity-directory-key-transparency-and-federation)
makes the `@handle → identity key` mapping the foundation everything else rests
on: encrypting perfectly to the wrong key is not security. A charset that admits
homographs and mixed scripts puts an impersonation attack *below* the
cryptography, where no amount of key transparency helps — `@аlice` with a
Cyrillic а is a different handle with a different, perfectly valid, perfectly
audited key.

### 14.1 Proposed rule

```
messaging_handle = /^[a-z0-9_]{1,30}$/     ASCII only, NFC (trivially satisfied)
```

Compared as bytes. **No normalization is performed at comparison time** — a
handle either matches the pattern exactly or it is not a handle. That is the
point: a normalization function is itself the attack surface (which forms fold to
which? is `ﬁ` `fi`? is `ı` `i`?), and a charset with no case and a single
script makes an entire class of homograph and mixed-script impersonation **not
exist** rather than be defended against.

**An entire class, not every class.** `[a-z0-9_]` is not free of confusable
pairs: it contains `1`/`l` and `0`/`o`, which are indistinguishable in most UI
sans-serif faces. What the restriction removes is the **cross-script** class —
there is no `а`-for-`a` substitution to make when there is only one script —
and that is the whole of what is claimed for it, here or anywhere in this set.
Same-script ASCII lookalikes remain, are not defended against by anything in this
document, and are a rendering and verification obligation on the client
([`THREAT-MODEL.md` §4.10](./THREAT-MODEL.md#410-the-platform-username-space-contains-homographs-messaging-handles-do-not),
[`CLIENT-CONTRACT.md` §11.3](./CLIENT-CONTRACT.md#113-the-handle-charset-and-accounts-that-cannot-have-a-handle)).

### 14.2 Checked against free2z's real username rules — measured

**This was checked before being written down**, and the answer is that real
usernames are considerably broader. The first revision of §14 flagged three
things it could not settle from this repository — which username validator is
attached (flagged here in §14.2), and whether case-insensitive uniqueness is a
database property and how many existing accounts the rule excludes (both flagged
in §14.3). **All three have since been measured**: the model and its migration
history were read out of band, and the counts were run against the production
database on **2026-08-23**. The findings below are facts, not conditionals.

**On what this section reports.** No username or other user-identifying value
appears here, and neither do free2z's absolute user metrics: this is a public
repository, and account totals are business data rather than protocol data.
Findings are given as **proportions and categories** — which is the form the
design decision actually rests on, since what matters is *what fraction* of
existing accounts the rule excludes, not how many accounts exist. The precise
figures behind every proportion below are recorded in the deployment repository.

> **Re-stamped 2026-08-23.** §14.2 and §14.3 were first published stamped
> `2026-08-24` — the UTC date of a commit whose own local timestamp is
> 2026-08-23. Nothing here was measured or written on the 24th, and a measurement
> dated after the commit that carries it invites exactly the wrong reading in a
> document whose corrections are only worth anything because they are dated. The
> stamps in this section, in
> [`THREAT-MODEL.md` §4.10](./THREAT-MODEL.md#410-the-platform-username-space-contains-homographs-messaging-handles-do-not),
> [`ARCHITECTURE.md` §13-O](./ARCHITECTURE.md#13-open-questions) and
> [`CLIENT-CONTRACT.md` §11.3](./CLIENT-CONTRACT.md#113-the-handle-charset-and-accounts-that-cannot-have-a-handle)
> were corrected to the local date under
> [#575](https://github.com/free2z/zuu/issues/575), and **no figure changed**.
> The convention — local date, matching the commit — is now written down in
> [`README.md`](./README.md#status) so it stops recurring.

| Source | Finding |
|---|---|
| `py/dj/free2z/openapi/f2z.yaml` — `Registration`, `CreatorDetail`, `CreatorList`, `CommentAuthor` | `username` is `type: string`, **`pattern: ^[\w.@+-]+$`**, **`maxLength: 150`**, described as *"Letters, digits and @/./+/-/_ only."* This is Django's `AbstractUser.username` contract. |
| `py/dj/free2z/settings.py:29` | `AUTH_USER_MODEL = 'g12f.Creator'`. The `Creator` model itself is not present in this repository — only serializers and views are — so the validator cannot be read *here*. **Determined out of band, 2026-08-23:** `Creator(AbstractUser)` does **not** override `username`; the initial migration records the field as `max_length=150, unique=True, validators=[django.contrib.auth.validators.UnicodeUsernameValidator()]`. **The Unicode validator is the one in use.** |
| `py/dj/apps/g12f/serializers/creator.py` | Uniqueness is enforced **case-insensitively at the application layer only** (`Creator.objects.filter(username__iexact=...)`, in `RegistrationSerializer.validate_username` and `CreatorProfileUpdateSerializer.validate_username`). `FORBIDDEN_USERNAMES` additionally reserves route-shadowing names. **Determined out of band, 2026-08-23:** nothing backs this in the database — see the correction in §14.3. |
| `py/dj/apps/g12f/views/creator.py` | Reads are `username__iexact` (`lookup_field = "username__iexact"`; `get_object_or_404(Creator, username__iexact=...)`). |
| `ts/svelte/free2z/src/routes/[username]/+page.svelte` | Handles are rendered verbatim as `@{creator.username}` and URL-encoded into paths. The front end applies **no** narrower rule. |
| `ts/svelte/free2z/src/routes/[username]/dashboard/billing/+page.server.ts` | Contains `USERNAME_PATTERN = /^[a-zA-Z0-9_]{1,64}$/`, but this validates a subscription-target parameter in one dashboard action — it is not the registration rule, and it is already **narrower than what registration accepts**, so accounts with `.`/`@`/`+`/`-` in their name cannot use that page today. |
| Production database, 2026-08-23 | The eligibility proportions below. |

Two things follow, and the second is the one that matters most:

1. **The published contract is broader than `[a-z0-9_]{1,30}` on every axis**:
   uppercase is allowed, `.` `@` `+` `-` are allowed, and the length limit is 150
   rather than 30.
2. **Non-ASCII usernames are legal on free2z today, and accounts with one exist
   in production.** `\w` in Python's `re` is Unicode-aware on `str` unless
   `re.ASCII` is set, and
   `UnicodeUsernameValidator` — confirmed above as the validator actually
   attached — leaves it Unicode-aware. Cyrillic, Greek, full-width Latin and
   mixed-script usernames are accepted at registration, and a small number of
   accounts carry one today — the number is small but it is **not zero**, which
   is the only part of it that matters.
   **The platform's handle space already contains the homograph attack surface.**
   This is stated in the present tense on purpose: it is a finding about the
   existing product, not a conditional about messaging. `@аlice` with a Cyrillic
   а and `@alice` with a Latin a are two different, equally valid, equally
   registerable free2z accounts right now.

#### Eligibility, measured on production 2026-08-23

Eligibility is evaluated as `lowercase(username) matches /^[a-z0-9_]{1,30}$/`
(§14.3).

| Of all existing accounts | Share |
|---|---:|
| Eligible after case-folding | **~90%** |
| **Ineligible** | **~10%** |

Which properties the population carries — these overlap, and each share is of
**all existing accounts**, not of the ineligible subset:

| Property | Prevalence | Disqualifying? |
|---|---|---|
| Contains an uppercase letter | A little over half of all accounts | **No** — folded by the mapping |
| Contains `.`, `@`, `+` or `-` | Just under a tenth of all accounts — **the dominant cause of ineligibility** | Yes |
| Contains a non-ASCII character | A very small share of all accounts — small, and **not zero** | Yes |
| Longer than 30 characters | Vanishingly rare | Yes |

The three disqualifying properties overlap in only a single account, so their
shares are effectively additive and the punctuation rule is the dominant term —
by a wide margin, but **not the whole** of the exclusion: the non-ASCII and
over-length shares are each tiny and neither of them is zero. Uppercase is by
far the most common deviation from the messaging charset and it costs nobody a
handle, which is the entire reason the mapping folds case — but see §14.3,
where the *argument* originally given for folding case turns out to be false.

**These are not abandoned rows.** **Every ineligible account has logged in at
least once**, and all but one are **currently active**. Every account the rule
excludes belongs to a real person who has used the product — which is the finding
that turns this from a data-cleanup question into a product one.

### 14.3 The decision, and the cost accepted

**Messaging handles use the restricted charset.** A platform username is eligible
for a messaging handle iff:

```
lowercase(username) matches /^[a-z0-9_]{1,30}$/
```

The lowercase mapping is included deliberately: because platform uniqueness is
already enforced case-insensitively, folding case **cannot** introduce a
collision between two distinct existing accounts — so uppercase costs nobody
their handle and there is no reason to exclude it. — **This argument is false as
written; see the correction below.**

**Caveat, and it must be checked before this is relied on:** that argument holds
only if case-insensitive uniqueness actually holds *in the database*. It is
enforced in the two serializers reachable from this repository, but the `Creator`
model is not here, so whether a database-level constraint backs it — and whether
any account predates the check, or was created through admin, a data migration or
a social-login path that bypasses the serializer — **cannot be established from
this repository and must be settled with a query.** Any colliding pair must be
resolved by hand before the mapping ships.

> **Correction (2026-08-23) — the case-folding argument above is false, and the
> property it rests on does not hold.** The two paragraphs above are left
> standing rather than edited away, so an auditor can see exactly what was
> claimed and what replaced it. The claim was that folding case *"cannot
> introduce a collision between two distinct existing accounts"* **because**
> platform uniqueness is already enforced case-insensitively. The caveat was
> right to flag it and the query has now been run. It settles the question the
> other way.
>
> **Case-insensitive uniqueness is not a database property.** The `username`
> column carries a plain, case-**sensitive** `unique=True` and nothing else: no
> migration adds a `Lower("username")` functional index, no `UniqueConstraint`,
> no `citext` column. The case-insensitive check exists **only** in
> `RegistrationSerializer.validate_username` and
> `CreatorProfileUpdateSerializer.validate_username`. It is therefore an
> application convention, not an invariant — any path that does not pass through
> those two serializers (the admin, a data migration, a management command, a
> social-login flow) can create a case-variant duplicate, and the database will
> accept it.
>
> **And it has.** Measured on production 2026-08-23: **case-variant duplicate
> accounts exist today, in more than one group.** The count is small and is
> recorded in the deployment repository rather than here; the count is not the
> finding. **The existence is the finding**, because a single colliding pair is
> enough to make the claim above false. Folding case *does* collide two distinct
> existing accounts.
>
> **What survives and what does not.** The *decision* is unchanged: messaging
> handles use the restricted charset and eligibility is evaluated on the
> lowercased username. Uppercase on its own still disqualifies nobody — a little
> over half of all accounts carry an uppercase letter and none is excluded for
> that reason (§14.2). What does not survive is the claim that the mapping is
> free. It is not: **every account in those collision groups must be resolved by
> hand before the mapping ships**, because within each group two distinct
> accounts map to one messaging handle and the directory would otherwise have to
> pick a winner — in the one mapping whose integrity the whole system rests on.
> The clean end state is a database-level `UniqueConstraint(Lower("username"))`,
> so that the property the serializers already assume is actually enforced where
> it can be relied on. That constraint and the resolution of the colliding
> accounts are tracked in the deployment repository; they are backend work and
> are not specified here.

**Accepted product cost, stated plainly.** Existing accounts whose username
contains `.`, `@`, `+` or `-`, contains any non-ASCII character, or exceeds 30
characters after lowercasing are **not eligible for a messaging handle in v1**.
Those users can use free2z exactly as they do today; they cannot be discovered by
handle in the messenger until they have a compliant handle.

**How large is that population? Measured 2026-08-23: approximately 10% of
existing accounts.** The first revision of this section said the number "MUST be
measured before the rule ships, because it is the difference between a rounding
error and a migration project." **The share alone does not settle that question,
and this document does not settle it.** Which of the two it is depends on the
absolute count rather than the proportion: one account in ten of a user base of a
few thousand is an afternoon of hand resolution, and one account in ten of a user
base of a few million is a programme of work. The absolute count is business data
and is deliberately not published here; it is recorded in the deployment
repository, and whoever plans the work has to read it there.

What the share *does* settle is the part the design turns on. This is **about
one account in ten**, not a fringe, and **every ineligible account has logged in
at least once, with all but one still active** — they are real users, not
abandoned rows (§14.2). That is enough to force a *product* decision: exclude
that ~10% from messaging discovery in v1, or serve them with the separate opt-in
messaging handle deferred in §14.4. That decision is not made here, so
[`ARCHITECTURE.md` §13-O](./ARCHITECTURE.md#13-open-questions) **stays open** —
its measurement sub-questions are closed, its policy sub-question is not.

> **Correction (2026-08-23) — the "neither a rounding error nor a migration
> project" answer is withdrawn.** The first published version of the paragraph
> above answered the rounding-error-or-migration-project question with *"The
> answer is neither, and that is the awkward result."* What supported that answer
> was a clause naming ~10% **of a small user base**, and that clause went away in
> the same change that redacted absolute counts to proportions. The redaction was
> right — this is a public repository and account totals are business data —
> but it removed the evidence and left the conclusion standing. A bare proportion
> cannot distinguish a rounding error from a migration project, so the conclusion
> is withdrawn rather than re-derived from a number this repository should not
> carry. The *product* consequence is unchanged and is what the share supports on
> its own.

### 14.4 Alternatives rejected

- **Accept the platform charset as-is.** Rejected. It admits mixed-script
  impersonation into the one mapping whose integrity the entire system depends on
  (§9 of the architecture), and it does so at the exact point — first contact —
  where the user has the least context to notice.
- **Normalize aggressively** (strip dots, fold confusables, NFKC). Rejected on
  two grounds: normalization creates collisions between existing distinct
  accounts, which is a data-loss migration; and a confusable-folding function is
  precisely the homograph attack surface we set out to remove, relocated into our
  own code.
- **A separate, opt-in messaging handle decoupled from the platform username.**
  Not rejected — **deferred.** It is the cleanest answer for the excluded
  population and it is directory design: it needs a second namespace, a claim
  protocol, and a rule for what happens when the two diverge. It touches
  [`ARCHITECTURE.md` §13-K](./ARCHITECTURE.md#13-open-questions) (handle rename
  and transfer) and belongs with `KT.md`.
- **Allow up to 150 characters.** Rejected as a UI and verification concern
  rather than a security one: handles appear in safety-number confirmations and
  in contact-request UI, where a 150-character string is unreadable and therefore
  unverifiable by a human.

---

## 15. Clean-room posture toward SimpleX — blocking pre-check, resolved

[`ARCHITECTURE.md` §6](./ARCHITECTURE.md#6-delivery-service) adopts SimpleX's
SMP *protocol design* and flags the licensing question as
[§13-E](./ARCHITECTURE.md#13-open-questions): *"verify SimpleX's server licensing
**before** anyone reads their server source."*

**The check was performed on 2026-08-23**, by an agent working on
[#545](https://github.com/free2z/zuu/issues/545), **using published repository
metadata only** — GitHub's REST repository endpoint (`GET /repos/{owner}/{repo}`),
whose `license` field GitHub derives from the repository's licence file, and the
repository contents-listing endpoint for top-level directory names. **No source
file from that project was fetched, opened or read**, and no source file from that
project has been read by anyone on this project.

**Result:**

| Repository | Reported licence |
|---|---|
| `simplex-chat/simplexmq` — *"a reference implementation of the SimpleX Messaging Protocol"*, i.e. the server | **AGPL-3.0** (`license.spdx_id: "AGPL-3.0"`) |
| `simplex-chat/simplex-chat` — the client applications | **AGPL-3.0** |

**Confidence: high, with a stated boundary.** GitHub's `license` field is a
machine-readable statement derived from the project's own licence file. That is
sufficient to establish the operative fact — *the server implementation is
copyleft, therefore nobody on this project reads it* — and it is **not** a legal
opinion. If we ever need to do more than avoid the code (link against it, vendor
anything from it, or distribute anything derived from it), we obtain actual legal
advice rather than relying on a metadata field.

**A nuance we record rather than gloss.** The published protocol documents live
in the **same repository** as the source: the top-level listing of
`simplex-chat/simplexmq` contains both `src/` and `protocol/`, and
`protocol/simplex-messaging.md` is the document rendered at
[simplex.chat/docs/simplex.html](https://simplex.chat/docs/simplex.html) that
`ARCHITECTURE.md` §3 cites. So "reading the public protocol document" means
reading a document inside an AGPL-licensed repository. Copyright subsists in the
*expression* of that document, not in the protocol it describes; an independent
implementation written from the specification, copying neither its prose nor any
source file, is clean. We state that as our posture, not as advice, so that a
reviewer can challenge it rather than discover it.

**The binding rule, recorded here because a rule nobody can find is not a rule:**

1. **Nobody on this project reads `simplexmq` source.** Not to check a detail, not
   to resolve an ambiguity, not "just to see how they did it".
2. The design in [`ARCHITECTURE.md` §6](./ARCHITECTURE.md#6-delivery-service) and
   in this document derives **solely** from the public protocol description and
   from our own reasoning about the problem.
3. Where this document differs from SMP, it says so. Where it resembles SMP, it
   resembles it because the same problem has the same shape — unidirectional
   queues with split capabilities is the natural answer to "deliver without
   identifiers", not a borrowed one.
4. If an implementer finds themselves wanting to look at their code, the correct
   action is to write down the question they cannot answer from the specification
   and raise it, so the gap gets fixed in *our* specification.

This closes [`ARCHITECTURE.md` §13-E](./ARCHITECTURE.md#131-closed).

---

## 16. What this document leaves open

Deliberately, and listed rather than invented:

- **The key-transparency log construction** — `SignedTreeHead`, epoch cadence,
  proof encodings, the full `DirectoryEntry`, witness-cosignature format. **No
  longer open**: [#544](https://github.com/free2z/zuu/issues/544) closed on
  2026-08-23 and it landed as [`KT.md`](./KT.md) with
  [ADR 0013](./decisions/0013-key-transparency-log.md) (§1.2). Kept in this list
  rather than deleted, so a reader arriving via an old citation finds the answer
  instead of a hole.
- **MLS `KeyPackage` publication and exhaustion** (§12.5) — directory design, and
  still open after `KT.md`, which says so explicitly.
- **Padding bucket sizes** — [§13-F](./ARCHITECTURE.md#13-open-questions).
  This document deliberately puts the set in configuration so the measured answer
  is cheap to adopt (§9).
- **Relay redundancy factor *k*** — [§13-G](./ARCHITECTURE.md#13-open-questions).
  The protocol supports any *k*; the default is not chosen here.
- **Anonymous credentials for quota** —
  [§13-I](./ARCHITECTURE.md#13-open-questions). The real answer to §13.3's first
  bullet, and still unspecified.
- **Push notifications** — [§13-H](./ARCHITECTURE.md#13-open-questions). This
  protocol assumes a held WebSocket. It does not define a push-notification
  address or an offline-wake path, because we still have no position on the
  metadata cost of one.
- **Proof-of-work function and calibration** —
  [§13-N](./ARCHITECTURE.md#13-open-questions), opened by §12.4.
- **Messaging-handle eligibility for existing accounts** —
  [§13-O](./ARCHITECTURE.md#13-open-questions), opened by §14.3. **Measured
  2026-08-23 and still open**: the measurement is in (approximately 10% of
  existing accounts are ineligible, and all of them are real users), so the
  measurement sub-question is closed; whether those users are simply excluded
  from messaging discovery in v1 or given a separate opt-in messaging handle is a
  product decision nobody has made.

---

## 17. References

[RFC 8446 — TLS 1.3](https://datatracker.ietf.org/doc/html/rfc8446) (§3
presentation language, §7.5 exporters) ·
[RFC 5705 — TLS keying material exporters](https://datatracker.ietf.org/doc/html/rfc5705) ·
[RFC 6455 — The WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455) ·
[RFC 9420 — MLS](https://datatracker.ietf.org/doc/html/rfc9420) ·
[RFC 8949 — CBOR](https://datatracker.ietf.org/doc/html/rfc8949) ·
[RFC 8615 — well-known URIs](https://datatracker.ietf.org/doc/html/rfc8615) ·
[SimpleX SMP protocol documentation](https://simplex.chat/docs/simplex.html)
(read as documentation only — §15)
