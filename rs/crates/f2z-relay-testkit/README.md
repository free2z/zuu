# `f2z-relay-testkit` — the FakeRelay

A spec-conforming free2z relay you can break on purpose, so a client can be
built and tested **before `f2z-relay` exists**.

It implements [`docs/e2ee/WIRE.md`](../../../docs/e2ee/WIRE.md) v1 §2 through
§13 on top of `f2z-codec` (canonical encoding, framing, re-encode equality) and
`f2z-relay-proto` (the signing transcript, anti-replay, queue and ACK rules, the
capability document). Nothing in those two crates is reimplemented here — a
conformance fake that held a second opinion about the protocol would be worse
than none.

## One command, one endpoint

```sh
cargo run -p f2z-relay-testkit --bin f2z-fakerelay
# → ws://127.0.0.1:9944/relay/v1
```

or

```sh
cd rs/deploy && docker compose -f docker-compose.dev.yml up
```

## In a test

```rust,no_run
use f2z_relay_proto::key::SigningKey;
use f2z_relay_testkit::fake::FakeRelay;

# async fn example() -> Result<(), Box<dyn core::error::Error>> {
let relay = FakeRelay::with_defaults()?;
let mut bob = relay.client().await?;                      // in-process, no sockets
let bob_key = SigningKey::from_seed(&[1u8; 32]);
let queue = bob.create_queue(&bob_key, 0, 0, None).await?;

let mut alice = relay.client().await?;
let alice_key = SigningKey::from_seed(&[2u8; 32]);
alice.bind_send(&alice_key, queue.send_addr).await?;
alice.append(&alice_key, queue.send_addr, b"ciphertext").await?;

let read = bob.read(&bob_key, queue.recv_addr, 0, 0, 0).await?;
// …the durable local write happens HERE — WIRE.md §8.4's MUST — and only then:
bob.ack(&bob_key, queue.recv_addr, 0).await?;
# Ok(())
# }
```

Over a real socket instead, which is where framing and ordering bugs actually
appear:

```rust,no_run
# async fn example() -> Result<(), Box<dyn core::error::Error>> {
# use f2z_relay_testkit::{fake::FakeRelay, client::Client, websocket};
let relay = FakeRelay::with_defaults()?;
let server = relay.listen_loopback().await?;              // ws://127.0.0.1:0
let transport = websocket::connect(&server.url()).await?;
let mut client = Client::connect(transport, relay.client_config()).await?;
# Ok(())
# }
```

## Breaking it on purpose

Under delete-on-ack the failure paths are where data loss lives. A client that
gets `APPEND` and `READ` right and gets a **dropped `ACK` response** wrong will
lose messages in production and pass every test that only ever sees a healthy
relay.

```rust,no_run
# use std::time::Duration;
# use f2z_codec::{ErrorCode, commands::Command};
# use f2z_relay_testkit::faults::{Effect, Fault, PolicyFaults, Trigger};
# fn example(relay: &f2z_relay_testkit::fake::FakeRelay) {
// The command runs; its answer never arrives. WIRE.md §2.5: unknown status.
relay.faults().arm(Fault::once(Trigger::Command(Command::Ack), Effect::Drop));

// §4.3: "a relay MAY complete a cheap PING before an expensive READ … and will"
relay.faults().arm(Fault::once(Trigger::Command(Command::Read), Effect::Reorder));

// §10: every code, including the ones a healthy relay never emits.
relay.faults().arm(Fault::once(
    Trigger::Command(Command::Append),
    Effect::Refuse(ErrorCode::Backpressure),
));

// §7.7: expire a seven-day TTL now. §13.1: hit a quota. §5.5 + #586: publish a
// capability document a conforming client must refuse.
relay.faults().set_policy(PolicyFaults {
    expire_messages_after: Some(Duration::ZERO),
    max_queue_messages: Some(1),
    unsound_antireplay_window: true,
    ..PolicyFaults::default()
});
# }
```

Faults make the relay behave **worse** than the specification allows, in ways a
real relay or a real network can. They are not the same as
`config::Relaxations`, which make it **accept** something a conforming relay
would reject — the single most dangerous thing a test double can do. Every
relaxation is opt-in, off by default, and named after the rule it suspends.

## The conformance suite

`vectors::suite()` is a set of `(input, expected output)` cases driven through
the ordinary client API against an `Endpoint`. Three targets:

```rust,no_run
# use std::sync::Arc;
# use f2z_relay_testkit::{fake::{Endpoint, FakeRelay, WebSocketEndpoint}, vectors};
# async fn example() -> Result<(), Box<dyn core::error::Error>> {
let relay = FakeRelay::with_defaults()?;

// 1. in-process
let report = vectors::run(Arc::new(relay.in_process_endpoint())).await;

// 2. this crate's own ws:// listener
let server = relay.listen_loopback().await?;
let report = vectors::run(Arc::new(relay.websocket_endpoint(&server))).await;

// 3. the real relay, later, with this file unchanged
let report = vectors::run(Arc::new(WebSocketEndpoint::new(
    "wss://relay.example/relay/v1",
)))
.await;
println!("{}", report.summary());
# Ok(())
# }
```

A vector that needs to break the relay declares `Needs::Faults` or
`Needs::Clock` and reports **skipped** against a target with no such handle —
never passed. `tests/conformance.rs` additionally runs the suite against the
in-process and WebSocket transports and asserts the verdicts are identical,
which is what makes "both transports run the same implementation" a check
rather than a claim.

## `f2z-fakerelay` is not a relay

Three properties make deploying it a security incident rather than a mistake,
and all three are published in the signed capability document it serves:

| Property | What `WIRE.md` requires | Why it is this way |
|---|---|---|
| Queue addresses are **predictable** | §7.1: from the relay's own CSPRNG, unpredictable so they cannot be squatted | A conformance vector that produced different addresses each run would not be a vector |
| Serves **`ws://`** | §2.1: `wss://` only | No certificate, no trust decision; taken honestly as §2.3's `--insecure-listen` case, published as `transport_security: none` and `channel_binding_mode: none` |
| **Nothing is durable** | §8.4 publishes `durability_mode`; this is `memory` | It is a `BTreeMap` that dies with the process |

§2.3's binding rule is enforced, not printed: a non-loopback bind is refused
unless `--insecure-listen` is typed, and typing it prints the three obligations
§2.3 attaches to the override.

A conforming client **refuses** this relay unless it opts in per relay:

```rust,no_run
# use f2z_relay_proto::capabilities::ClientPolicy;
let policy = ClientPolicy { allow_insecure_transport: true, ..ClientPolicy::default() };
```

That refusal is §2.3 obligation 3 working as designed. A client author should
see it fail before they see it pass.

## Known gaps

- **The `.well-known` capability document of §11.2 is not served.** The document
  is available over the protocol (`GET_CAPABILITIES`) and its digest is
  comparable against `HELLO` (`capabilities::check_digest`), but the plain-HTTPS
  JSON representation is not. Serving it would mean adding an HTTP parser beside
  the WebSocket one, which is the second parser §2.2 argues against, for an
  affordance aimed at humans rather than at clients. A client's "fetch the
  well-known copy and compare digests" path therefore cannot be exercised
  against this harness.
- **`queue_creation_mode: token` is not implemented.** §13.1 defines it as an
  operator-issued bearer credential and gives it no protocol shape in v1;
  configuring it is refused at construction rather than faked.
- **`channel_binding_mode: tls-exporter` is not reachable here.** A `FakeRelay`
  always serves `ws://`, and `capabilities::validate` requires
  `transport_security: none` to pair with `channel_binding_mode: none` (§2.3
  obligation 2), so no channel-binding value this harness could publish makes
  a startable relay. (An earlier `ChannelBindingSource::Simulated` tried to
  fake the pairing with a constant instead of a real TLS exporter; #740 found
  it could never construct a valid `FakeRelay` and removed it.) Exercise
  `tls-exporter` against the real relay instead.

## Licence

MIT, like `f2z-codec` and `f2z-relay-proto`, and for the same reason: client
test suites link it. The AGPL-3.0 boundary starts at the real server binaries,
and this is not one — it stores nothing, is refused a non-loopback bind, and
exists to be linked into other people's tests.
