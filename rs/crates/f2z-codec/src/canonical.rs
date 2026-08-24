//! Re-encode equality — `WIRE.md` §3.3, the rule that closes the
//! parse-versus-verify gap.
//!
//! On every received frame, in both directions, the receiver MUST:
//!
//! 1. **Decode** the bytes into the typed structure.
//! 2. **Re-encode** that structure with the same codec.
//! 3. **Byte-compare** the re-encoding against the received bytes.
//! 4. Use the **re-encoded** bytes — never the received bytes — as the input to
//!    any hash or signature operation (§5).
//!
//! A mismatch at step 3 is a fatal `ERR_MALFORMED`. No retry, no partial
//! acceptance.
//!
//! This module is the only place in the system that performs steps 1-3, and
//! [`Canonicalized`] is the only way to get bytes out of it, so step 4 is
//! structural rather than remembered: there is no API that hands a caller a
//! decoded value together with the bytes it arrived in.
//!
//! ADR 0008 is explicit that this rule "compensates for implementation slack,
//! not format ambiguity". The TLS presentation language already has exactly one
//! encoding per value; decoders are what drift. So the cost is one extra encode
//! per frame — negligible against a signature verification — and the benefit is
//! that trailing bytes, over-wide length prefixes, vectors whose declared
//! length exceeds their contents, and unknown variant bytes silently mapped to
//! a default all become the same loud, immediate, testable failure.

use alloc::vec::Vec;

use tls_codec::{DeserializeBytes, SerializeBytes};

use crate::error::CodecError;

/// A value that arrived as bytes, together with the canonical bytes it
/// re-encodes to.
///
/// Constructed only by [`decode_canonical`], which has already proved the two
/// agree. [`Canonicalized::bytes`] is therefore always safe to hash or sign:
/// there is no path by which a caller can obtain the *received* bytes from
/// here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Canonicalized<T> {
    value: T,
    encoded: Vec<u8>,
}

impl<T> Canonicalized<T> {
    /// The decoded value.
    pub const fn value(&self) -> &T {
        &self.value
    }

    /// The canonical bytes: what §5 hashes and what a signature covers.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.encoded
    }

    /// Consume this, yielding the value and its canonical bytes.
    #[must_use]
    pub fn into_parts(self) -> (T, Vec<u8>) {
        (self.value, self.encoded)
    }

    /// Consume this, yielding only the value.
    #[must_use]
    pub fn into_value(self) -> T {
        self.value
    }
}

/// Decode `bytes`, re-encode, and byte-compare (`WIRE.md` §3.3).
///
/// # Errors
///
/// - [`CodecError::Decode`] if the bytes are not a well-formed `T`, including
///   when they carry trailing data past the last field.
/// - [`CodecError::NotCanonical`] if `T` decoded but re-encodes to something
///   else. Fatal: send `ERR_MALFORMED` and close the connection.
pub fn decode_canonical<T>(bytes: &[u8]) -> Result<Canonicalized<T>, CodecError>
where
    T: DeserializeBytes + SerializeBytes,
{
    // `tls_deserialize_exact_bytes` refuses trailing data, which is the first
    // half of §3.3's "no unknown trailing bytes" rule.
    let value = T::tls_deserialize_exact_bytes(bytes)?;
    let encoded = SerializeBytes::tls_serialize(&value)?;
    if encoded.as_slice() != bytes {
        return Err(CodecError::NotCanonical);
    }
    Ok(Canonicalized { value, encoded })
}

/// Encode a value to its canonical bytes.
///
/// # Errors
///
/// [`CodecError::Decode`] if the value cannot be encoded — in practice, a
/// vector longer than its length prefix can describe.
pub fn encode<T: SerializeBytes>(value: &T) -> Result<Vec<u8>, CodecError> {
    Ok(SerializeBytes::tls_serialize(value)?)
}

/// A wire structure that participates in re-encode equality.
///
/// A blanket implementation covers every `tls_codec` type this crate defines;
/// the trait exists so callers can write `RelayFrame::decode_canonical(bytes)`
/// and so no other crate is tempted to hand-roll steps 1-3.
pub trait Canonical: DeserializeBytes + SerializeBytes + Sized {
    /// Decode with re-encode equality (`WIRE.md` §3.3).
    ///
    /// # Errors
    ///
    /// As [`decode_canonical`].
    fn decode_canonical(bytes: &[u8]) -> Result<Canonicalized<Self>, CodecError> {
        decode_canonical(bytes)
    }

    /// The canonical encoding of this value.
    ///
    /// # Errors
    ///
    /// As [`encode`].
    fn encode_canonical(&self) -> Result<Vec<u8>, CodecError> {
        encode(self)
    }
}

impl<T> Canonical for T where T: DeserializeBytes + SerializeBytes + Sized {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::Response;
    use alloc::vec;

    #[test]
    fn trailing_bytes_are_rejected() {
        let response = Response::error(crate::error::ErrorCode::NoAccess);
        let mut encoded = response.encode_canonical().unwrap();
        assert!(decode_canonical::<Response>(&encoded).is_ok());

        encoded.push(0);
        assert_eq!(
            decode_canonical::<Response>(&encoded),
            Err(CodecError::Decode),
            "a decoder that skips trailing bytes is the §3.3 hazard itself"
        );
    }

    #[test]
    fn truncation_is_rejected() {
        assert_eq!(decode_canonical::<Response>(&[]), Err(CodecError::Decode));
        assert_eq!(
            decode_canonical::<Response>(&[0, 0]),
            Err(CodecError::Decode)
        );
    }

    #[test]
    fn an_overlong_length_prefix_is_rejected() {
        // status = 0, body length prefix claims 5 bytes, only 2 follow.
        let bytes = vec![0x00, 0x00, 0x00, 0x00, 0x05, 0xaa, 0xbb];
        assert_eq!(
            decode_canonical::<Response>(&bytes),
            Err(CodecError::Decode)
        );
    }
}
