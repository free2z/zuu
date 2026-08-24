//! Length-prefixed vectors of non-byte elements.
//!
//! `WIRE.md` §3.4 writes these as `T x<0..2^k-1>`: a `k`-bit length prefix
//! whose value is the number of **bytes** the elements occupy, not the number
//! of elements. `tls_codec` ships `TlsVecU8`/`TlsVecU16`/`TlsVecU24` for exactly
//! this shape, but only against the `std` `Serialize`/`Deserialize` traits —
//! this crate is `no_std` and uses the `SerializeBytes`/`DeserializeBytes`
//! halves, which `tls_codec` implements for its *byte* vectors and not for its
//! generic ones.
//!
//! So the three types below exist to fill that gap and nothing else. They are
//! the same encoding, reached through the traits that compile for
//! `wasm32-unknown-unknown`.
//!
//! Two properties matter for §3.3, and both are tested:
//!
//! - A declared length that exceeds the bytes actually present is an error, not
//!   a short read.
//! - Bytes left over inside the declared length after the last element decodes
//!   are an error, not silently dropped. That is the "vector whose declared
//!   length exceeds its contents" case §3.3 names by hand.

use alloc::vec::Vec;
use core::fmt;

use tls_codec::{DeserializeBytes, Error as TlsError, SerializeBytes, Size};

macro_rules! length_prefixed_vec {
    ($(#[$meta:meta])* $name:ident, $prefix:expr) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, Default)]
        pub struct $name<T>(Vec<T>);

        impl<T> $name<T> {
            /// The width of the length prefix, in bytes.
            pub const PREFIX_LEN: usize = $prefix;

            /// The largest byte length the prefix can describe.
            pub const MAX_BYTES: usize = (1usize << (8 * $prefix)) - 1;

            /// Wrap a vector. The byte length is checked on encode, not here,
            /// because it is not knowable until the elements are serialized.
            #[must_use]
            pub const fn new(items: Vec<T>) -> Self {
                Self(items)
            }

            /// The elements.
            #[must_use]
            pub fn as_slice(&self) -> &[T] {
                &self.0
            }

            /// The number of elements — not the encoded byte length.
            #[must_use]
            pub fn len(&self) -> usize {
                self.0.len()
            }

            /// Whether there are no elements.
            #[must_use]
            pub fn is_empty(&self) -> bool {
                self.0.is_empty()
            }

            /// Consume this, yielding the elements.
            #[must_use]
            pub fn into_vec(self) -> Vec<T> {
                self.0
            }
        }

        impl<T> From<Vec<T>> for $name<T> {
            fn from(items: Vec<T>) -> Self {
                Self(items)
            }
        }

        impl<T: fmt::Debug> fmt::Debug for $name<T> {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.debug_list().entries(self.0.iter()).finish()
            }
        }

        impl<T: Size> Size for $name<T> {
            fn tls_serialized_len(&self) -> usize {
                self.0
                    .iter()
                    .fold($prefix, |total, item| {
                        total.saturating_add(item.tls_serialized_len())
                    })
            }
        }

        impl<T: SerializeBytes + Size> SerializeBytes for $name<T> {
            fn tls_serialize(&self) -> Result<Vec<u8>, TlsError> {
                let mut body = Vec::new();
                for item in &self.0 {
                    body.extend_from_slice(&item.tls_serialize()?);
                }
                if body.len() > Self::MAX_BYTES {
                    return Err(TlsError::InvalidVectorLength);
                }
                let mut out = Vec::with_capacity(body.len().saturating_add($prefix));
                let length = body.len().to_be_bytes();
                let start = length.len().checked_sub($prefix).ok_or(TlsError::LibraryError)?;
                out.extend_from_slice(length.get(start..).ok_or(TlsError::LibraryError)?);
                out.extend_from_slice(&body);
                Ok(out)
            }
        }

        impl<T: DeserializeBytes + Size> DeserializeBytes for $name<T> {
            fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
                let prefix = bytes.get(..$prefix).ok_or(TlsError::EndOfStream)?;
                let mut length = 0usize;
                for byte in prefix {
                    length = length
                        .checked_mul(256)
                        .and_then(|value| value.checked_add(usize::from(*byte)))
                        .ok_or(TlsError::InvalidVectorLength)?;
                }
                let rest = bytes.get($prefix..).ok_or(TlsError::EndOfStream)?;
                // A declared length longer than what is present is an error.
                // Truncating to what arrived is how a decoder becomes more
                // permissive than its encoder (§3.3).
                let mut body = rest.get(..length).ok_or(TlsError::EndOfStream)?;
                let remainder = rest.get(length..).ok_or(TlsError::EndOfStream)?;

                let mut items = Vec::new();
                while !body.is_empty() {
                    let (item, next) = T::tls_deserialize_bytes(body)?;
                    if next.len() >= body.len() {
                        // A zero-width element would loop forever. No structure
                        // in WIRE.md encodes to zero bytes, so this is a
                        // malformed input, not a shape to support.
                        return Err(TlsError::DecodingError(alloc::format!(
                            "zero-length element in a length-prefixed vector"
                        )));
                    }
                    items.push(item);
                    body = next;
                }
                Ok((Self(items), remainder))
            }
        }
    };
}

length_prefixed_vec!(
    /// `T x<0..255>` — a one-byte length prefix.
    VecU8,
    1
);

length_prefixed_vec!(
    /// `T x<0..2^16-1>` — a two-byte length prefix.
    VecU16,
    2
);

length_prefixed_vec!(
    /// `T x<0..2^24-1>` — a three-byte length prefix.
    VecU24,
    3
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::{Canonical, decode_canonical};
    use alloc::vec;

    #[test]
    fn the_prefix_counts_bytes_not_elements() {
        let versions: VecU8<u16> = vec![1u16, 2, 3].into();
        let bytes = versions.encode_canonical().unwrap();
        assert_eq!(bytes, vec![6, 0, 1, 0, 2, 0, 3]);
        assert_eq!(bytes.len(), versions.tls_serialized_len());
        assert_eq!(
            decode_canonical::<VecU8<u16>>(&bytes).unwrap().value(),
            &versions
        );
    }

    #[test]
    fn wider_prefixes_are_big_endian() {
        let sizes: VecU16<u32> = vec![1024u32, 4096].into();
        assert_eq!(
            sizes.encode_canonical().unwrap(),
            vec![0, 8, 0, 0, 4, 0, 0, 0, 16, 0]
        );
        let wide: VecU24<u32> = vec![7u32].into();
        assert_eq!(wide.encode_canonical().unwrap(), vec![0, 0, 4, 0, 0, 0, 7]);
    }

    #[test]
    fn an_empty_vector_is_just_a_zero_prefix() {
        let empty: VecU16<u32> = Vec::new().into();
        let bytes = empty.encode_canonical().unwrap();
        assert_eq!(bytes, vec![0, 0]);
        assert!(
            decode_canonical::<VecU16<u32>>(&bytes)
                .unwrap()
                .value()
                .is_empty()
        );
    }

    #[test]
    fn a_declared_length_longer_than_the_contents_is_refused() {
        // Prefix claims 8 bytes; 4 follow. §3.3 names this case by hand.
        let bytes = vec![8u8, 0, 0, 0, 1];
        assert!(decode_canonical::<VecU8<u32>>(&bytes).is_err());
    }

    #[test]
    fn leftover_bytes_inside_the_declared_length_are_refused() {
        // Prefix claims 6 bytes but u32 elements consume 4 at a time, so two
        // bytes are stranded. Truncating them would let two encodings mean the
        // same value.
        let bytes = vec![6u8, 0, 0, 0, 1, 0, 0];
        assert!(decode_canonical::<VecU8<u32>>(&bytes).is_err());
    }

    #[test]
    fn trailing_bytes_after_the_vector_are_returned_not_swallowed() {
        let bytes = vec![2u8, 0, 1, 0xff];
        let (value, rest) = VecU8::<u16>::tls_deserialize_bytes(&bytes).unwrap();
        assert_eq!(value.as_slice(), &[1u16]);
        assert_eq!(rest, &[0xff]);
        // …and the canonical decoder refuses them, because it demands the whole
        // input be consumed.
        assert!(decode_canonical::<VecU8<u16>>(&bytes).is_err());
    }
}
