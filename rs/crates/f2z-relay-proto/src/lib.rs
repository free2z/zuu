//! The free2z relay protocol, above the wire format and below the socket.
//!
//! This crate implements the parts of [`docs/e2ee/WIRE.md`] that a relay and a
//! client must agree on *exactly* and that neither can own: the signing
//! transcript's signature (§5), anti-replay (§5.5), the queue lifecycle and
//! acknowledgement arithmetic (§7, §8), the capability document (§11), and the
//! typed pairing of a request with its response (§4.3, §6). It sits on
//! [`f2z_codec`], which owns the canonical encoding, the framing and the
//! transcript's *bytes*.
//!
//! Both sides link it, and that is the design rather than a convenience. Every
//! rule below is one where a relay and a client disagreeing means either lost
//! ciphertext or a signature that verifies where it should not:
//!
//! - **[`command`]** — building a signed command and verifying one, in §5.1's
//!   exact order, with the relay's own `relay_id` and `channel_binding`.
//! - **[`replay`]** — the timestamp window and the fail-closed seen-set.
//! - **[`queue`]** — bind-once, cumulative-monotone-idempotent `ACK`, and the
//!   rule that makes pre-acking impossible.
//! - **[`capabilities`]** — the signed policy document, what makes it valid,
//!   and what makes a client refuse the relay that published it.
//! - **[`hello`]** — proof of possession, and the session that hands out the
//!   only transcript builder in the crate.
//! - **[`inflight`]** — §4.3's bounded, out-of-order window, with a typed
//!   ticket so a response cannot be decoded as the wrong command's.
//!
//! # What it deliberately does not do
//!
//! No I/O, no sockets, no TLS, no async runtime, no filesystem, **no clock and
//! no randomness**. Every function that needs the time takes it as an argument
//! and every function that needs a nonce is given one. That is what lets the
//! same code run in a relay and in a browser: it is `no_std` + `alloc`, it
//! carries `#![forbid(unsafe_code)]`, and CI builds it for
//! `wasm32-unknown-unknown` on every change, because [ADR 0001] requires one
//! Rust core shared by ZUULI and the web client and a crate that cannot reach
//! the browser breaks that.
//!
//! It also performs no application I/O or durable storage. Its state machines
//! and [`SeenSet`] do hold bounded, process-local protocol bookkeeping. Message
//! bodies, addresses, quotas, challenge issuance, sharing a replay authority
//! across workers, and durable replay persistence are relay state; this crate
//! holds the rules those states must obey.
//!
//! # A connection, end to end
//!
//! ```
//! use f2z_codec::commands::{AppendRequest, HelloRequest};
//! use f2z_codec::padding::PaddingBuckets;
//! use f2z_codec::types::{Challenge, ChannelBinding, Nonce, Payload, QueueAddress};
//! use f2z_relay_proto::capabilities::{self, ChannelBindingMode, ClientPolicy, TransportSecurity};
//! use f2z_relay_proto::command::{CommandVerifier, SignedCommand, ops};
//! use f2z_relay_proto::hello::{RelayAnnouncement, hello_response, verify_hello_response};
//! use f2z_relay_proto::key::SigningKey;
//! use f2z_relay_proto::queue::{QueueKind, QueueState};
//! use f2z_relay_proto::replay::{SeenSet, TimestampWindow};
//!
//! # fn main() -> Result<(), Box<dyn core::error::Error>> {
//! let now = 1_800_000_000_000;
//! // The relay's long-term identity, and this TLS session's exporter (§5.3).
//! let relay_identity = SigningKey::from_seed(&[1u8; 32]);
//! let binding = ChannelBinding::new([2u8; 32]);
//!
//! // The client offers a version range and a nonce; the relay answers with a
//! // proof of possession over this session's binding and that nonce.
//! let offer = HelloRequest { min_version: 1, max_version: 1, client_nonce: Challenge::new([3u8; 32]) };
//! let published = capabilities::defaults(&relay_identity.public_key(), now)?;
//! let hello = hello_response(
//!     &relay_identity,
//!     &RelayAnnouncement {
//!         protocol_version: 1,
//!         relay_time_ms: now,
//!         channel_binding_mode: ChannelBindingMode::TlsExporter,
//!         transport_security: TransportSecurity::Tls,
//!         capabilities_digest: capabilities::digest(&published)?,
//!     },
//!     &binding,
//!     &offer.client_nonce,
//! )?;
//!
//! // The client verifies the proof before signing anything. A session is the
//! // only way to obtain a transcript builder.
//! let session = verify_hello_response(&hello, &offer, &binding, None, &ClientPolicy::default())?;
//! capabilities::check_digest(&published, &session.capabilities_digest())?;
//!
//! // A signed APPEND, padded to a published bucket (§9).
//! let send_key = SigningKey::from_seed(&[4u8; 32]);
//! let signed = SignedCommand::<ops::Append>::create(
//!     session.transcripts(),
//!     1,
//!     QueueAddress::new([5u8; 32]),
//!     session.relay_time_after(20),
//!     Nonce::new([6u8; 16]),
//!     &send_key,
//!     &AppendRequest { payload: Payload::new(vec![0u8; 1024])? },
//! )?;
//!
//! // And the relay verifies it, in §5.1's order, against its own values.
//! let mut verifier = CommandVerifier::new(
//!     session.transcripts().clone(),
//!     TimestampWindow::default(),
//!     SeenSet::new(240_000, 65_536),
//!     PaddingBuckets::default(),
//! );
//! let mut queue = QueueState::create(QueueKind::Standard, send_key.public_key());
//! queue.bind_send(&send_key.public_key())?;
//! let request = signed.request()?;
//! let verified = verifier.verify_authorized::<ops::Append, _>(now, 1, &request, |candidate| {
//!     queue.authorize_send(&candidate.signer_key())
//! })?;
//! assert_eq!(verified.signer_key(), send_key.public_key());
//!
//! // The same frame a second time is a replay, whatever it was the first time.
//! assert!(verifier.verify_authorized::<ops::Append, _>(now, 1, &request, |candidate| {
//!     queue.authorize_send(&candidate.signer_key())
//! }).is_err());
//! # Ok(())
//! # }
//! ```
//!
//! [`docs/e2ee/WIRE.md`]: https://github.com/free2z/zuu/blob/main/docs/e2ee/WIRE.md
//! [ADR 0001]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0001-platform-priority.md

#![no_std]
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

extern crate alloc;

pub mod capabilities;
pub mod command;
pub mod error;
pub mod hello;
pub mod inflight;
pub mod key;
pub mod queue;
pub mod replay;

pub use command::{CommandVerifier, RelayCommand, SignedCommand, Verified};
pub use error::{ProtoError, Refusal};
pub use hello::RelaySession;
pub use inflight::{InFlight, Ticket};
pub use key::{SigningKey, VerifyingKey};
pub use queue::{QueueKind, QueueState};
pub use replay::{SeenSet, TimestampWindow};

/// The protocol version this crate speaks, restated from [`f2z_codec`] so a
/// caller does not have to reach past this layer for it. `WIRE.md` §3.5.
pub const PROTOCOL_VERSION: u16 = f2z_codec::PROTOCOL_VERSION;
