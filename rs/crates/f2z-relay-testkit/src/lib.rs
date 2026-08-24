//! **FakeRelay** — a spec-conforming free2z relay you can break on purpose, so
//! that a client can be built and tested before `f2z-relay` exists.
//!
//! ```no_run
//! # async fn example() -> Result<(), Box<dyn core::error::Error>> {
//! use f2z_relay_proto::key::SigningKey;
//! use f2z_relay_testkit::fake::FakeRelay;
//!
//! let relay = FakeRelay::with_defaults()?;
//! let mut bob = relay.client().await?;              // in-process, no sockets
//! let bob_key = SigningKey::from_seed(&[1u8; 32]);
//! let queue = bob.create_queue(&bob_key, 0, 0, None).await?;
//!
//! let mut alice = relay.client().await?;
//! let alice_key = SigningKey::from_seed(&[2u8; 32]);
//! alice.bind_send(&alice_key, queue.send_addr).await?;
//! alice.append(&alice_key, queue.send_addr, b"ciphertext").await?;
//!
//! let read = bob.read(&bob_key, queue.recv_addr, 0, 0, 0).await?;
//! // …durable local write happens HERE — WIRE.md §8.4's MUST — and only then:
//! bob.ack(&bob_key, queue.recv_addr, 0).await?;
//! # Ok(())
//! # }
//! ```
//!
//! # What this crate is for
//!
//! [`docs/e2ee/WIRE.md`] specifies a relay that does not exist yet, and
//! [`docs/e2ee/CLIENT-CONTRACT.md`] describes clients that have to be built
//! against it now. This crate is the thing in between: a relay that implements
//! §2 through §13 faithfully, runs in a test process, and can be *told to
//! misbehave*.
//!
//! It reuses rather than reimplements. [`f2z_codec`] owns the canonical
//! encoding, the framing and re-encode equality (§3.3); [`f2z_relay_proto`]
//! owns the verification order of §5.1, the anti-replay of §5.5, the queue and
//! acknowledgement rules of §7 and §8, and the capability document of §11. The
//! part decided here is what those crates deliberately leave to a server: the
//! connection lifecycle, the in-flight window, which code answers which
//! refusal, when a push is emitted, and the anti-abuse layering of §13.
//!
//! # The three things worth knowing before you use it
//!
//! **1. It serves both an in-process pipe and a real socket, and they are the
//! same relay.** [`fake::FakeRelay::connect`] gives a
//! [`tokio::io::duplex`]-backed transport for tests that run in milliseconds;
//! [`fake::FakeRelay::listen_loopback`] serves `ws://127.0.0.1:0` for the
//! framing, ordering and reconnection bugs an in-memory pipe physically cannot
//! expose. Both go through [`connection::drive`] and [`engine::Relay`], and
//! `tests/conformance.rs` runs the whole vector suite against both and compares
//! the verdicts — because "they share an implementation" is worth nothing as a
//! claim and everything as a check.
//!
//! **2. Faults are the point.** Under delete-on-ack the failure paths are where
//! data loss lives. A client that handles `APPEND` and `READ` correctly and
//! mishandles a dropped `ACK` response loses messages in production and passes
//! every test that only ever sees a healthy relay. [`faults`] can drop a
//! response, delay one, reorder two, close mid-stream, refuse a command with
//! any §10 code, stall a response so §4.3's window fills, expire a TTL, hit a
//! quota, enter global backpressure, and publish the capability document of
//! [#586].
//!
//! **3. Relaxations are not faults, and are off.** A fault makes the relay
//! behave *worse* than the specification allows, in ways a real relay or a real
//! network can. A [`config::Relaxations`] makes it **accept** something a
//! conforming relay would reject — which is the single most dangerous thing a
//! test double can do, because it teaches a client to write code that works in
//! tests and fails against the real thing. Each one is opt-in, each is named
//! after the rule it suspends, and [`config::Relaxations::any`] lets a harness
//! assert that a run used none.
//!
//! # The conformance suite
//!
//! [`vectors`] is a set of `(input, expected output)` cases driven through the
//! ordinary client API against an [`fake::Endpoint`]. Three targets exist:
//! in-process, this crate's WebSocket listener, and — later, unchanged —
//! `f2z-relay` itself as a [`fake::WebSocketEndpoint`] with a URL. Vectors that
//! need to break the relay declare [`vectors::Needs::Faults`] or
//! [`vectors::Needs::Clock`] and report **skipped** against a target that
//! cannot be told to misbehave, never passed.
//!
//! # What this crate is not
//!
//! **Not a relay.** `f2z-fakerelay` serves `ws://` rather than `wss://` (§2.1),
//! derives queue addresses from a seed so vectors replay (§7.1 requires them to
//! be unpredictable), and keeps everything in memory (§8.4's
//! `durability_mode: memory`). All three are published in the signed capability
//! document it serves, and a conforming client refuses it without an explicit
//! per-relay opt-in. See [`rng`] and the `f2z-fakerelay` binary docs.
//!
//! **Not the client.** [`client::Client`] is the smallest thing that can drive
//! every command of §6 correctly, so a vector is a statement about the relay
//! rather than about a test's ability to build a frame. ZUULI's engine and the
//! WASM web client are the clients, and neither links this.
//!
//! **Native only.** This crate opens sockets, spawns tasks and reads a clock.
//! It is deliberately absent from the `wasm32` job that
//! [`f2z_codec`] and [`f2z_relay_proto`] must pass: [ADR 0001] requires one
//! Rust core shared by ZUULI and the browser, and a test harness must not be
//! able to leak into it.
//!
//! [`docs/e2ee/WIRE.md`]: https://github.com/free2z/zuu/blob/main/docs/e2ee/WIRE.md
//! [`docs/e2ee/CLIENT-CONTRACT.md`]: https://github.com/free2z/zuu/blob/main/docs/e2ee/CLIENT-CONTRACT.md
//! [ADR 0001]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0001-platform-priority.md
//! [#586]: https://github.com/free2z/zuu/issues/586

#![forbid(unsafe_code)]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects
    )
)]

pub mod client;
pub mod clock;
pub mod config;
pub mod connection;
pub mod engine;
pub mod error;
pub mod fake;
pub mod faults;
pub mod outbound;
pub mod rng;
pub mod state;
pub mod transport;
pub mod vectors;
pub mod websocket;

pub use client::{Client, ClientConfig};
pub use config::{Relaxations, RelayConfig};
pub use error::{Result, TestkitError};
pub use fake::{Endpoint, FakeRelay, InProcessEndpoint, WebSocketEndpoint};
pub use faults::{Effect, Fault, FaultInjector, PolicyFaults, Trigger};
pub use vectors::{Report, Status, Vector};

/// The protocol version this harness speaks, restated from [`f2z_codec`].
pub const PROTOCOL_VERSION: u16 = f2z_codec::PROTOCOL_VERSION;
