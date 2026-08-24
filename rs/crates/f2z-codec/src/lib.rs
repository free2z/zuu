//! Canonical encoding for the free2z relay wire protocol, version 1.
//!
//! This crate implements the encoding layer of [`docs/e2ee/WIRE.md`], and only
//! that layer. It holds the `tls_codec` wrappers for every wire structure the
//! specification defines, the domain-separated signing-transcript builder of
//! §5, the newtypes for queue addresses, payloads and keys, and the
//! padding-bucket validator of §9.
//!
//! It is a separate crate for three reasons, each of which is a property this
//! crate is required to keep and each of which has a test:
//!
//! 1. **Re-encode equality (§3.3/§4).** Every received frame is decoded,
//!    re-encoded and byte-compared, and the *re-encoded* bytes — never the
//!    received ones — are what a signature covers. Implemented once, here, in
//!    [`canonical::decode_canonical`], so no other crate can reintroduce a
//!    parse-versus-verify gap.
//! 2. **Redacting `Debug`.** Addresses, payloads and keys never render their
//!    bytes. `--log-level trace` must not become a ciphertext archive.
//! 3. **It compiles for `wasm32-unknown-unknown`.** `no_std` + `alloc`, no I/O,
//!    no async runtime. [ADR 0001] requires one Rust core shared by ZUULI and
//!    the web client; a crate that cannot reach the browser breaks that.
//!
//! # What this crate deliberately does not do
//!
//! No signing, no verification, no key generation, no randomness, no clocks, no
//! sockets, no storage, and no policy. It builds the exact byte strings that
//! those layers sign, verify and send, and it says whether a received byte
//! string is canonical. Everything else belongs above it.
//!
//! # The shape of a receive
//!
//! ```
//! use f2z_codec::canonical::{Canonical, decode_canonical};
//! use f2z_codec::commands::{AppendRequest, Command};
//! use f2z_codec::frame::{CommandAuth, FramePayload, RelayFrame, Request};
//! use f2z_codec::padding::PaddingBuckets;
//! use f2z_codec::types::Payload;
//! use f2z_codec::{CodecError, ErrorCode};
//!
//! # fn main() -> Result<(), Box<dyn core::error::Error>> {
//! let buckets = PaddingBuckets::default();
//! let body = AppendRequest { payload: Payload::new(vec![0u8; 1024])? };
//! let wire = RelayFrame::request(
//!     1,
//!     Request::new(Command::Append.code(), CommandAuth::Unsigned, body.encode_canonical()?)?,
//! )
//! .encode_canonical()?;
//!
//! // §3.3 on the frame. The re-encoded bytes are what a signature would cover.
//! let frame = decode_canonical::<RelayFrame>(&wire)?;
//! frame.value().validate()?;
//! let FramePayload::Request(request) = &frame.value().payload else { unreachable!() };
//!
//! // §3.3 again on the body, then §9 on its length.
//! let request_body = decode_canonical::<AppendRequest>(request.body())?;
//! buckets.validate_payload(&request_body.value().payload)?;
//!
//! // A trailing byte anywhere is a fatal ERR_MALFORMED, before any state changes.
//! let mut tampered = wire.clone();
//! tampered.push(0);
//! assert_eq!(
//!     decode_canonical::<RelayFrame>(&tampered).unwrap_err().error_code(),
//!     ErrorCode::Malformed,
//! );
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

pub mod canonical;
pub mod commands;
pub mod error;
pub mod frame;
pub mod hash;
pub mod padding;
pub mod pow;
pub mod transcript;
pub mod types;
pub mod vec;

pub use canonical::{Canonical, decode_canonical};
pub use error::{CodecError, ErrorCode};
pub use frame::{CommandAuth, FrameKind, Push, RelayFrame, Request, Response, SignedAuth};
pub use padding::PaddingBuckets;
pub use transcript::CommandTranscript;
pub use types::{
    Body, Challenge, ChannelBinding, Digest, Nonce, Payload, PublicKey, QueueAddress, RelayId,
    Salt, ShortBytes, Signature,
};

/// The protocol version this crate encodes. `WIRE.md` §3.5: version 1 is
/// `0x0001`, and version negotiation happens once, in `HELLO`.
pub const PROTOCOL_VERSION: u16 = 0x0001;

/// The largest queue-message TTL any relay may claim, in seconds.
///
/// `WIRE.md` §11.3 step 5: a client refuses a relay whose
/// `max_message_ttl_seconds` exceeds this, because the relay is claiming a
/// policy the architecture (30-day ceiling) forbids.
pub const MAX_MESSAGE_TTL_SECONDS: u32 = 2_592_000;
