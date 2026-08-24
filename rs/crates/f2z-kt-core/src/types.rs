//! The newtypes this crate adds on top of `f2z-codec`'s, and the redacting
//! `Debug` they all carry.
//!
//! `f2z-codec`'s [`PublicKey`], [`Signature`], [`Digest`] and [`ShortBytes`] are
//! reused verbatim rather than restated: they are the same wire shapes with the
//! same redaction requirement, and a second copy of a `Debug` impl is a second
//! chance to get it wrong. What is added here is what the directory needs and
//! the relay does not — a [`LogId`], a charset-checked [`Handle`], and a
//! `<0..2^16-1>` byte string for the X-Wing KEM key.
//!
//! **The trap this module exists to avoid** is the one `f2z-codec`'s redaction
//! test names: `tls_codec`'s own byte vectors derive `Debug` and print
//! `TlsByteVecU16 { vec: [222, 222, …] }` — a complete dump containing no hex at
//! all. Every variable-length field in a `DirectoryEntry` is therefore a newtype
//! here, never a bare `tls_codec` vector, and `tests/redaction.rs` checks the
//! decimal encoding specifically.
//!
//! A `DirectoryEntry` is public by design — it is how `@alice` is discoverable —
//! so redaction here is not confidentiality. It is the same operational property
//! `ADR 0004` buys: `--log-level trace` on a directory server must not become a
//! downloadable copy of the social graph, written by the operator, to disk, for
//! as long as log rotation keeps it.
//!
//! [`PublicKey`]: f2z_codec::types::PublicKey
//! [`Signature`]: f2z_codec::types::Signature
//! [`Digest`]: f2z_codec::types::Digest
//! [`ShortBytes`]: f2z_codec::types::ShortBytes

use core::fmt;

use tls_codec::{
    DeserializeBytes, Error as TlsError, SerializeBytes, Size, TlsByteVecU8, TlsByteVecU16,
};

use crate::error::KtError;

/// Declare a fixed-width byte newtype with a redacting `Debug` and the three
/// `tls_codec` traits delegated to `[u8; N]`.
///
/// The same shape as `f2z-codec`'s `opaque_fixed!`. It is repeated rather than
/// exported because a macro crossing a crate boundary would fix the error type
/// of `from_slice` in the wrong crate.
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

            /// The all-zero value.
            #[must_use]
            pub const fn zero() -> Self {
                Self([0u8; $len])
            }

            /// Borrow the bytes.
            #[must_use]
            pub const fn as_bytes(&self) -> &[u8; $len] {
                &self.0
            }

            /// Whether every byte is zero.
            ///
            /// `KT.md` gives all-zero a meaning in two places: a
            /// `prev_entry_hash` at `entry_version` 1 (§4.2) and a
            /// `successor_log_pk` that announces no successor (§6.4).
            #[must_use]
            pub fn is_zero(&self) -> bool {
                self.0.iter().all(|byte| *byte == 0)
            }

            /// Wrap a slice of exactly the right length.
            ///
            /// # Errors
            ///
            /// [`KtError::Malformed`] if the slice is a different length.
            pub fn from_slice(bytes: &[u8]) -> Result<Self, KtError> {
                let array: [u8; $len] = bytes.try_into().map_err(|_| KtError::Malformed)?;
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
    /// `log_id = H("free2z/kt/v1/log-id", genesis_log_pk)` (`KT.md` §6.1).
    ///
    /// A distinct type from [`Digest`] on purpose. It is compared against a
    /// pinned value in nine different structures, and a root hash reaching a
    /// `log_id` comparison by accident would be a silent accept.
    ///
    /// [`Digest`]: f2z_codec::types::Digest
    LogId,
    32
);

/// A directory handle: `opaque handle<1..30>`, ASCII `[a-z0-9_]{1,30}`.
///
/// `WIRE.md` §14 fixes the charset and `KT.md` §1.3 states the consequence:
/// **it is the log's label, and it is why the log's labels are not
/// homograph-attackable.** The charset is checked on construction and again on
/// decode, so a handle that reached this type is a handle the VRF input can be
/// built from without further thought.
///
/// Unlike every other variable-length field here, a `Handle` renders in `Debug`.
/// A handle is the one field of a directory entry whose entire purpose is to be
/// public and human-readable, and hiding it would make a log's diagnostics
/// useless while protecting nothing that is not already published. The rendering
/// is safe because the charset admits no control characters, so a handle cannot
/// forge a log line.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Handle(TlsByteVecU8);

impl Handle {
    /// The longest handle `WIRE.md` §14 allows.
    pub const MAX_LEN: usize = 30;

    /// Wrap bytes after checking `[a-z0-9_]{1,30}`.
    ///
    /// # Errors
    ///
    /// [`KtError::BadHandle`] if the bytes are empty, longer than
    /// [`Handle::MAX_LEN`], or contain anything outside the charset.
    pub fn new(bytes: impl Into<Vec<u8>>) -> Result<Self, KtError> {
        let bytes = bytes.into();
        if !Self::is_valid(&bytes) {
            return Err(KtError::BadHandle);
        }
        Ok(Self(TlsByteVecU8::new(bytes)))
    }

    /// Whether these bytes are a valid handle (`WIRE.md` §14).
    #[must_use]
    pub fn is_valid(bytes: &[u8]) -> bool {
        !bytes.is_empty()
            && bytes.len() <= Self::MAX_LEN
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
    }

    /// Re-check the charset on a decoded value.
    ///
    /// `tls_codec` cannot express `[a-z0-9_]`, so a `Handle` that arrived over
    /// the wire has had its length checked and nothing else. Every structure
    /// carrying one calls this from its own `validate`.
    ///
    /// # Errors
    ///
    /// [`KtError::BadHandle`] as [`Handle::new`].
    pub fn validate(&self) -> Result<(), KtError> {
        if Self::is_valid(self.as_slice()) {
            Ok(())
        } else {
            Err(KtError::BadHandle)
        }
    }

    /// The handle bytes.
    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }

    /// The handle length in bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.as_slice().len()
    }

    /// Whether the handle is empty — only reachable from a decode, never from
    /// [`Handle::new`].
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.as_slice().is_empty()
    }
}

impl fmt::Debug for Handle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // A decoded handle has not been charset-checked yet, so render defensively
        // rather than assuming the invariant this type is *supposed* to hold.
        let bytes = self.0.as_slice();
        match (Self::is_valid(bytes), core::str::from_utf8(bytes)) {
            (true, Ok(text)) => write!(f, "Handle({text})"),
            _ => write!(f, "Handle(<invalid; {} bytes>)", bytes.len()),
        }
    }
}

impl Size for Handle {
    fn tls_serialized_len(&self) -> usize {
        self.0.tls_serialized_len()
    }
}

impl SerializeBytes for Handle {
    fn tls_serialize(&self) -> Result<Vec<u8>, TlsError> {
        self.0.tls_serialize()
    }
}

impl DeserializeBytes for Handle {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (inner, rest) = TlsByteVecU8::tls_deserialize_bytes(bytes)?;
        Ok((Self(inner), rest))
    }
}

/// An X-Wing hybrid KEM public key: `opaque device_kem_pk<1..2^16-1>`
/// (`KT.md` §4.1).
///
/// X25519 + ML-KEM-768, so it is roughly 1.2 KB and cannot use the `<0..255>`
/// prefix [`ShortBytes`] carries. A newtype rather than a bare `TlsByteVecU16`
/// for the reason the module note gives: a derived `Debug` on a `tls_codec`
/// vector prints every byte as a decimal list.
///
/// [`ShortBytes`]: f2z_codec::types::ShortBytes
#[derive(Clone, PartialEq, Eq, Default)]
pub struct KemPublicKey(TlsByteVecU16);

impl KemPublicKey {
    /// The largest value the `<0..2^16-1>` length prefix can describe.
    pub const MAX_LEN: usize = (1usize << 16) - 1;

    /// Wrap bytes.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the bytes are empty — the field is
    /// `<1..2^16-1>` — or longer than [`KemPublicKey::MAX_LEN`].
    pub fn new(bytes: impl Into<Vec<u8>>) -> Result<Self, KtError> {
        let bytes = bytes.into();
        if bytes.is_empty() || bytes.len() > Self::MAX_LEN {
            return Err(KtError::Malformed);
        }
        Ok(Self(TlsByteVecU16::new(bytes)))
    }

    /// The key bytes.
    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }

    /// The key length in bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.as_slice().len()
    }

    /// Whether the key is empty. `<1..2^16-1>` forbids it, so this is only
    /// reachable from a decode and is what `validate` rejects.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.as_slice().is_empty()
    }
}

impl fmt::Debug for KemPublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "KemPublicKey(<redacted; {} bytes>)", self.len())
    }
}

impl Size for KemPublicKey {
    fn tls_serialized_len(&self) -> usize {
        self.0.tls_serialized_len()
    }
}

impl SerializeBytes for KemPublicKey {
    fn tls_serialize(&self) -> Result<Vec<u8>, TlsError> {
        self.0.tls_serialize()
    }
}

impl DeserializeBytes for KemPublicKey {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (inner, rest) = TlsByteVecU16::tls_deserialize_bytes(bytes)?;
        Ok((Self(inner), rest))
    }
}

/// Check a `<0..255>` field against the exact constant `KT.md` §6.2 requires.
///
/// The first thing every `validate` does, per §6.2: *"a verifier MUST check it
/// before anything else."*
///
/// # Errors
///
/// [`KtError::WrongLabel`] if the field is anything but `expected`.
pub fn check_label(actual: &f2z_codec::types::ShortBytes, expected: &[u8]) -> Result<(), KtError> {
    if actual.as_slice() == expected {
        Ok(())
    } else {
        Err(KtError::WrongLabel)
    }
}

/// Build a `<0..255>` field holding a §6.2 label constant.
///
/// # Errors
///
/// [`KtError::Malformed`] if the constant is longer than 255 bytes, which no
/// label in §6.2 is.
pub fn label_field(label: &[u8]) -> Result<f2z_codec::types::ShortBytes, KtError> {
    f2z_codec::types::ShortBytes::new(label).map_err(KtError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_codec::canonical::{Canonical, decode_canonical};

    #[test]
    fn the_handle_charset_is_wire_md_section_14() {
        assert!(Handle::new(b"alice".to_vec()).is_ok());
        assert!(Handle::new(b"a_1".to_vec()).is_ok());
        assert!(Handle::new(vec![b'a'; 30]).is_ok());

        assert_eq!(Handle::new(b"".to_vec()), Err(KtError::BadHandle));
        assert_eq!(Handle::new(vec![b'a'; 31]), Err(KtError::BadHandle));
        assert_eq!(Handle::new(b"Alice".to_vec()), Err(KtError::BadHandle));
        assert_eq!(Handle::new(b"al-ice".to_vec()), Err(KtError::BadHandle));
        // The homograph case §1.3 names: a Cyrillic 'а' is not ASCII 'a'.
        assert_eq!(
            Handle::new("аlice".as_bytes().to_vec()),
            Err(KtError::BadHandle)
        );
        assert_eq!(Handle::new(b"ali ce".to_vec()), Err(KtError::BadHandle));
    }

    #[test]
    fn a_decoded_handle_is_re_checked_not_trusted() {
        // A handle that never went through `Handle::new`: the length prefix is
        // all `tls_codec` enforces, so an uppercase handle decodes cleanly.
        let bytes = [5u8, b'A', b'l', b'i', b'c', b'e'];
        let decoded = decode_canonical::<Handle>(&bytes).unwrap();
        assert_eq!(decoded.value().validate(), Err(KtError::BadHandle));
    }

    #[test]
    fn handles_round_trip_canonically() {
        let handle = Handle::new(b"alice_2".to_vec()).unwrap();
        let bytes = handle.encode_canonical().unwrap();
        assert_eq!(bytes, [7u8, b'a', b'l', b'i', b'c', b'e', b'_', b'2']);
        assert_eq!(decode_canonical::<Handle>(&bytes).unwrap().value(), &handle);
    }

    #[test]
    fn a_kem_key_must_not_be_empty() {
        assert_eq!(KemPublicKey::new(Vec::new()), Err(KtError::Malformed));
        assert_eq!(KemPublicKey::new(vec![7u8; 1216]).unwrap().len(), 1216);
    }

    #[test]
    fn log_id_zero_is_recognisable() {
        assert!(LogId::zero().is_zero());
        assert!(!LogId::new([1u8; 32]).is_zero());
    }

    #[test]
    fn debug_renders_a_handle_and_redacts_a_kem_key() {
        let handle = Handle::new(b"alice".to_vec()).unwrap();
        assert_eq!(format!("{handle:?}"), "Handle(alice)");
        let key = KemPublicKey::new(vec![0xdeu8; 1216]).unwrap();
        assert_eq!(format!("{key:?}"), "KemPublicKey(<redacted; 1216 bytes>)");
        assert_eq!(format!("{:?}", LogId::new([0xde; 32])), "LogId(<redacted>)");
    }
}
