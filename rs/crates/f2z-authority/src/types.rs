//! The newtypes an assertion is built from, and the charset rule that makes a
//! handle a handle.
//!
//! Fixed-width values follow `f2z-codec`'s `opaque_fixed!` pattern verbatim,
//! **including the trap that pattern exists for**: `tls_codec`'s own byte
//! vectors derive `Debug` and render their contents as a list of decimal
//! integers, so any type that wraps one and derives `Debug` prints every byte
//! it holds the moment somebody logs the structure containing it. A decimal
//! dump is a dump. Every `Debug` below is therefore hand-written, and none of
//! them offers an alternate formatter that renders the bytes — an escape hatch
//! would be found and used.

use alloc::vec::Vec;
use core::fmt;

use f2z_codec::hash::hash;
use tls_codec::{DeserializeBytes, Error as TlsError, SerializeBytes, Size};

use crate::error::AuthorityError;
use crate::labels::{LABEL_AUTHORITY_ID, LABEL_HANDLE_ID};

/// Declare a fixed-width byte newtype with a redacting `Debug` and the three
/// `tls_codec` traits delegated to `[u8; N]`.
///
/// A local copy of `f2z-codec`'s macro rather than a re-export: that one is
/// private to its crate, and the alternative — making it public — would export
/// a macro whose whole job is to be applied carefully, in one place, by
/// somebody who has read why.
macro_rules! opaque_fixed {
    ($(#[$meta:meta])* $name:ident, $len:expr) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name([u8; $len]);

        impl $name {
            #[doc = concat!("The wire width of a `", stringify!($name), "`, in bytes.")]
            pub const LEN: usize = $len;

            #[doc = concat!("Wrap ", stringify!($len), " bytes.")]
            #[must_use]
            pub const fn new(bytes: [u8; $len]) -> Self {
                Self(bytes)
            }

            /// Borrow the bytes.
            #[must_use]
            pub const fn as_bytes(&self) -> &[u8; $len] {
                &self.0
            }

            /// Wrap a slice of exactly the right length.
            ///
            /// # Errors
            ///
            /// [`AuthorityError::Malformed`] if the slice is a different length.
            pub fn from_slice(bytes: &[u8]) -> Result<Self, AuthorityError> {
                let array: [u8; $len] =
                    bytes.try_into().map_err(|_| AuthorityError::Malformed)?;
                Ok(Self(array))
            }
        }

        impl From<[u8; $len]> for $name {
            fn from(bytes: [u8; $len]) -> Self {
                Self(bytes)
            }
        }

        impl AsRef<[u8]> for $name {
            fn as_ref(&self) -> &[u8] {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "(<redacted>)"))
            }
        }

        impl Size for $name {
            fn tls_serialized_len(&self) -> usize {
                $len
            }
        }

        impl SerializeBytes for $name {
            fn tls_serialize(&self) -> Result<Vec<u8>, TlsError> {
                self.0.tls_serialize()
            }
        }

        impl DeserializeBytes for $name {
            fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
                let (array, rest) = <[u8; $len]>::tls_deserialize_bytes(bytes)?;
                Ok((Self(array), rest))
            }
        }
    };
}

opaque_fixed!(
    /// A key id: `authority_id = H("free2z/kt/v1/authority-id", authority_pk)`.
    ///
    /// Derived rather than assigned, so rotation is a set-membership change and
    /// nothing else — see [`AuthoritySet`]. An operator cannot mislabel a key,
    /// because the label *is* the key.
    ///
    /// [`AuthoritySet`]: crate::authority::AuthoritySet
    AuthorityId,
    32
);

opaque_fixed!(
    /// The log this assertion is for (`KT.md` §6.1).
    ///
    /// An assertion naming a different log is refused rather than ignored: an
    /// authority that vouches for `@alice` on one log has said nothing about
    /// `@alice` on another, and treating the field as advisory would make every
    /// log in existence a replay target for every other log's assertions.
    LogId,
    32
);

opaque_fixed!(
    /// `handle_id = H("free2z/kt/v1/handle-id", handle)`.
    HandleId,
    32
);

opaque_fixed!(
    /// The assertion's anti-replay nonce. 16 bytes of issuer CSPRNG.
    AssertionNonce,
    16
);

/// The handle charset: `[a-z0-9_]{1,30}`, ASCII (`WIRE.md` §14.1, `KT.md`
/// §1.3).
pub const HANDLE_MAX_LEN: usize = 30;

/// A messaging handle.
///
/// # The charset is the security property, and normalization is not part of it
///
/// A handle is `[a-z0-9_]{1,30}`, ASCII, **compared as bytes**. `WIRE.md` §14.1
/// is explicit that *no normalization is performed at comparison time*: a
/// handle either matches the pattern exactly or it is not a handle. The reason
/// is that a normalization function is itself the attack surface — which forms
/// fold to which, is `ﬁ` `fi`, is `ı` `i` — and a charset with one script and no
/// case makes the whole cross-script homograph class **not exist** rather than
/// be defended against. So [`Handle::parse`] rejects `Alice`; it does not fold
/// it. Anything in this crate that compared two handles by any rule other than
/// byte equality would be reintroducing exactly what §14.1 removed.
///
/// It removes an entire class, not every class. `1`/`l` and `0`/`o` are in the
/// charset and are indistinguishable in most sans-serif faces; that is a
/// rendering obligation on the client (`THREAT-MODEL.md` §4.10) and nothing
/// here defends against it.
///
/// # There is deliberately no `from_username`
///
/// `WIRE.md` §14.3 evaluates eligibility as
/// `lowercase(username) matches /^[a-z0-9_]{1,30}$/`, and its 2026-08-23
/// correction records that **`lowercase(username)` is not a unique key**: the
/// platform's `username` column carries a plain case-*sensitive* `unique=True`,
/// the case-insensitive check lives only in two serializers, and case-variant
/// duplicate accounts exist in production today. Two distinct accounts can
/// therefore fold to one handle.
///
/// A `Handle::from_username` here would be a function that silently picks a
/// winner in the one mapping the entire system rests on. The mapping is the
/// authority's job — it is precisely the judgement an assertion exists to
/// record — and this crate refuses to guess at it. What it offers is
/// [`Handle::parse`], which answers only "are these bytes a handle".
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Handle(Vec<u8>);

impl Handle {
    /// Whether a byte is in the handle charset.
    #[must_use]
    pub const fn is_handle_byte(byte: u8) -> bool {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
    }

    /// Parse bytes as a handle.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::HandleCharset`] if the bytes are empty, longer than
    /// [`HANDLE_MAX_LEN`], or contain any byte outside `[a-z0-9_]`. Uppercase
    /// ASCII is *outside* the charset and is refused, not folded — see the type
    /// documentation.
    pub fn parse(bytes: &[u8]) -> Result<Self, AuthorityError> {
        if bytes.is_empty() || bytes.len() > HANDLE_MAX_LEN {
            return Err(AuthorityError::HandleCharset);
        }
        if !bytes.iter().copied().all(Self::is_handle_byte) {
            return Err(AuthorityError::HandleCharset);
        }
        Ok(Self(bytes.to_vec()))
    }

    /// The handle bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// The handle as text. Always succeeds: the charset is ASCII.
    #[must_use]
    pub fn as_str(&self) -> &str {
        core::str::from_utf8(&self.0).unwrap_or("")
    }

    /// The length in bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the handle is empty. It never is — [`Handle::parse`] refuses an
    /// empty one — but clippy asks for this beside `len`.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `handle_id = H("free2z/kt/v1/handle-id", handle)`.
    #[must_use]
    pub fn handle_id(&self) -> HandleId {
        HandleId::new(*hash(LABEL_HANDLE_ID, &self.0).as_bytes())
    }
}

/// Redacted, and the choice is worth defending.
///
/// A handle is not secret — it is how `@alice` is discoverable, and the log
/// learns it because it has to answer. What it is, is **linkable**: "who asked
/// about whom" is exactly the interest-in-a-handle metadata `THREAT-MODEL.md`
/// §4.1 bounds rather than removes, and a `--log-level trace` that prints every
/// handle a client resolved hands an operator the social graph the bound was
/// supposed to cost them something. [`Handle::as_str`] exists for the caller
/// who has decided to render one; `Debug` does not decide that for them.
impl fmt::Debug for Handle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Handle(<redacted; {} bytes>)", self.0.len())
    }
}

impl Size for Handle {
    fn tls_serialized_len(&self) -> usize {
        // `opaque handle<1..30>`: a one-byte length prefix.
        self.0.len().saturating_add(1)
    }
}

impl SerializeBytes for Handle {
    fn tls_serialize(&self) -> Result<Vec<u8>, TlsError> {
        let len = u8::try_from(self.0.len()).map_err(|_| TlsError::InvalidVectorLength)?;
        if self.0.is_empty() || self.0.len() > HANDLE_MAX_LEN {
            return Err(TlsError::InvalidVectorLength);
        }
        let mut out = Vec::with_capacity(self.tls_serialized_len());
        out.push(len);
        out.extend_from_slice(&self.0);
        Ok(out)
    }
}

impl DeserializeBytes for Handle {
    /// Decoding enforces the charset, so a non-conforming handle cannot
    /// round-trip through re-encode equality and reach a verification rule as
    /// bytes-that-decoded.
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (&len, rest) = bytes.split_first().ok_or(TlsError::EndOfStream)?;
        let len = usize::from(len);
        if len == 0 || len > HANDLE_MAX_LEN {
            return Err(TlsError::InvalidVectorLength);
        }
        let value = rest.get(..len).ok_or(TlsError::EndOfStream)?;
        let remainder = rest.get(len..).ok_or(TlsError::EndOfStream)?;
        let handle = Handle::parse(value).map_err(|_| {
            TlsError::DecodingError(alloc::string::String::from(
                "handle outside [a-z0-9_]{1,30}",
            ))
        })?;
        Ok((handle, remainder))
    }
}

/// What an assertion is *for* (`bind` or `reset`).
///
/// The two are not interchangeable and the verifier ties each to a position in
/// the handle's entry sequence — see [`crate::authority`]. Splitting them means
/// an assertion issued to hand somebody a fresh handle cannot be re-presented
/// to take over an established one.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
#[repr(u8)]
pub enum Intent {
    /// First binding of this handle to an identity key. Valid only at
    /// `entry_version == 1`.
    Bind = 1,
    /// The platform-reset path of ADR 0014: the account behind the handle
    /// changed hands (or lost its keys) and a new identity key takes over.
    /// Valid only at `entry_version > 1`.
    Reset = 2,
}

impl Intent {
    /// Both intents, in wire order.
    pub const ALL: [Self; 2] = [Self::Bind, Self::Reset];

    /// The wire byte.
    #[must_use]
    pub const fn code(self) -> u8 {
        self as u8
    }

    /// The intent this build knows by that byte, if any.
    #[must_use]
    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Bind),
            2 => Some(Self::Reset),
            _ => None,
        }
    }

    /// A stable name, for logs and error messages.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Bind => "bind",
            Self::Reset => "reset",
        }
    }
}

impl fmt::Display for Intent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl Size for Intent {
    fn tls_serialized_len(&self) -> usize {
        1
    }
}

impl SerializeBytes for Intent {
    fn tls_serialize(&self) -> Result<Vec<u8>, TlsError> {
        Ok(alloc::vec![self.code()])
    }
}

impl DeserializeBytes for Intent {
    /// An unknown intent byte is a decode failure, never a default.
    ///
    /// `WIRE.md` §3.3 names "unknown variant bytes silently mapped to a
    /// default" as one of the four things re-encode equality exists to make
    /// loud. Mapping an unrecognised intent to `bind` would be the worst
    /// available default: it is the one that creates a handle.
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (&code, rest) = bytes.split_first().ok_or(TlsError::EndOfStream)?;
        let intent = Self::from_code(code)
            .ok_or_else(|| TlsError::DecodingError(alloc::format!("unknown intent {code}")))?;
        Ok((intent, rest))
    }
}

/// `authority_id = H("free2z/kt/v1/authority-id", authority_pk)`.
#[must_use]
pub fn authority_id(authority_pk: &f2z_codec::types::PublicKey) -> AuthorityId {
    AuthorityId::new(*hash(LABEL_AUTHORITY_ID, authority_pk.as_bytes()).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;
    use f2z_codec::canonical::{Canonical, decode_canonical};

    #[test]
    fn the_charset_is_exactly_a_to_z_zero_to_nine_and_underscore() {
        for byte in 0u8..=255 {
            let expected = byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_';
            assert_eq!(
                Handle::parse(&[byte]).is_ok(),
                expected,
                "byte {byte:#04x} disagreed with the charset"
            );
        }
    }

    #[test]
    fn uppercase_is_refused_and_never_folded() {
        assert_eq!(Handle::parse(b"Alice"), Err(AuthorityError::HandleCharset));
        assert_eq!(Handle::parse(b"ALICE"), Err(AuthorityError::HandleCharset));
        // …and the lowercase spelling is a different value, not the same one.
        assert_ne!(
            Handle::parse(b"alice").unwrap().as_bytes(),
            b"Alice".as_slice()
        );
    }

    #[test]
    fn the_length_bounds_are_one_and_thirty() {
        assert_eq!(Handle::parse(b""), Err(AuthorityError::HandleCharset));
        assert!(Handle::parse(&[b'a'; 30]).is_ok());
        assert_eq!(
            Handle::parse(&[b'a'; 31]),
            Err(AuthorityError::HandleCharset)
        );
    }

    #[test]
    fn non_ascii_is_refused_bytewise() {
        // The Cyrillic а of WIRE.md §14, UTF-8 encoded. Two bytes, neither of
        // which is in the charset.
        assert_eq!(
            Handle::parse("аlice".as_bytes()),
            Err(AuthorityError::HandleCharset)
        );
    }

    #[test]
    fn a_handle_round_trips_and_a_bad_one_does_not_decode() {
        let handle = Handle::parse(b"alice").unwrap();
        let bytes = handle.encode_canonical().unwrap();
        assert_eq!(bytes, alloc::vec![5, b'a', b'l', b'i', b'c', b'e']);
        assert_eq!(decode_canonical::<Handle>(&bytes).unwrap().value(), &handle);

        // Same shape, uppercase payload: refused by the decoder, so it can
        // never reach a verification rule as bytes-that-decoded.
        assert!(decode_canonical::<Handle>(&[5, b'A', b'l', b'i', b'c', b'e']).is_err());
        // Zero length is not a handle either.
        assert!(decode_canonical::<Handle>(&[0]).is_err());
    }

    #[test]
    fn intent_bytes_are_stable_and_unknown_ones_do_not_decode() {
        assert_eq!(Intent::Bind.code(), 1);
        assert_eq!(Intent::Reset.code(), 2);
        for intent in Intent::ALL {
            assert_eq!(Intent::from_code(intent.code()), Some(intent));
        }
        assert_eq!(Intent::from_code(0), None);
        assert!(decode_canonical::<Intent>(&[0]).is_err());
        assert!(decode_canonical::<Intent>(&[3]).is_err());
    }

    #[test]
    fn debug_never_renders_bytes() {
        assert_eq!(
            format!("{:?}", AuthorityId::new([0xab; 32])),
            "AuthorityId(<redacted>)"
        );
        assert_eq!(
            format!("{:?}", Handle::parse(b"alice").unwrap()),
            "Handle(<redacted; 5 bytes>)"
        );
    }

    #[test]
    fn handle_id_is_the_digest_of_the_handle_bytes() {
        let handle = Handle::parse(b"alice").unwrap();
        assert_eq!(
            handle.handle_id().as_bytes(),
            hash(LABEL_HANDLE_ID, b"alice").as_bytes()
        );
        assert_ne!(
            handle.handle_id(),
            Handle::parse(b"alicf").unwrap().handle_id()
        );
    }

    #[test]
    fn authority_id_matches_the_independent_nonuniform_digest_vector() {
        // Independently derived with:
        // printf(label || 00..1f) | b2sum -l 256
        // The expected bytes are a fixed protocol vector, not another call to
        // the production hash helper under test.
        let public_key = f2z_codec::types::PublicKey::new([
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
            0x1c, 0x1d, 0x1e, 0x1f,
        ]);
        assert_eq!(
            authority_id(&public_key).as_bytes(),
            &[
                0x6a, 0x83, 0xfd, 0x51, 0xbb, 0x57, 0xde, 0x5c, 0xef, 0x24, 0x71, 0x77, 0xdf, 0xb5,
                0x63, 0x36, 0xfc, 0xc7, 0x2a, 0x1e, 0x7c, 0x82, 0x2a, 0xd8, 0xc9, 0x2f, 0xf4, 0x76,
                0xf1, 0x33, 0xad, 0xb2,
            ]
        );
    }
}
