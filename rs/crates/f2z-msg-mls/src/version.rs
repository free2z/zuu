//! The protocol version stored alongside group state, and why it exists.
//!
//! # §13-B: the ciphersuite codepoint is not IANA-assigned
//!
//! `ARCHITECTURE.md` §5.2 flags this as an open question and it is still open.
//! `0x004D` is what OpenMLS and libcrux ship for
//! `MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519`, and it is **not** an IANA
//! assignment — the registered MLS ciphersuites are `0x0001`–`0x0007`, and
//! X-Wing's own draft asks for `25722 = 0x647A` for HPKE/TLS, still marked
//! "(please)" in draft-10 §7.
//!
//! [#385](https://github.com/free2z/zuu/issues/385) narrowed the risk
//! considerably by checking the *bytes* rather than the label: libcrux
//! implements X-Wing draft-06, the live draft is -10, and all three Appendix C
//! vectors (`seed`, `pk`, `eseed`, `ct`, `ss`) are **byte-identical** between
//! them. The `-07`→`-10` changes are editorial, an ASN.1 module, a PEM header
//! fix, and re-expressing a SHAKE-256 request in bits instead of bytes.
//!
//! **So this is a naming risk, not a re-key.** When the codepoint is assigned,
//! the key schedule, the KEM and the wire bytes do not change; the two-byte
//! ciphersuite identifier inside `GroupContext` does.
//!
//! # What this module does about it
//!
//! It records, next to every group this engine creates, *which* protocol
//! revision produced the state — as [`ProtocolVersion`], a value the engine
//! writes and reads through the storage provider like any other entry. A future
//! relabel is then a migration that can be written: read the version, and if it
//! is the pre-assignment one, rewrite the ciphersuite id.
//!
//! The alternative — inferring it from the ciphersuite id in the stored
//! `GroupContext` — is exactly what stops working the moment the id is the
//! thing that moved.

use serde::{Deserialize, Serialize};

/// The ciphersuite codepoint this engine builds groups on, as OpenMLS 0.8.1 and
/// libcrux ship it today.
///
/// Named rather than left implicit so that the number a future migration has to
/// look for is written down in one place, with the paragraph above next to it.
pub const XWING_CIPHERSUITE_CODEPOINT: u16 = 0x004D;

/// The revision of *our* MLS profile that produced a group's stored state.
///
/// Not the MLS protocol version (that is RFC 9420's `mls10`, and OpenMLS owns
/// it) and not the storage version (that is
/// `openmls_traits::storage::CURRENT_VERSION`, and `f2z-msg-store` owns it).
/// This is the free2z-side revision: which ciphersuite codepoint, which
/// credential encoding, which exporter labels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[non_exhaustive]
#[repr(u16)]
pub enum ProtocolVersion {
    /// X-Wing at the **unassigned** codepoint `0x004D`,
    /// `free2z/device-credential/v1` credentials, and the `v1` exporter labels
    /// of `ARCHITECTURE.md` §5.4.
    V1Draft = 1,
}

impl ProtocolVersion {
    /// The version a group created by this build is stamped with.
    pub const CURRENT: Self = Self::V1Draft;

    /// The ciphersuite codepoint this version's groups were built on.
    #[must_use]
    pub const fn ciphersuite_codepoint(self) -> u16 {
        match self {
            Self::V1Draft => XWING_CIPHERSUITE_CODEPOINT,
        }
    }

    /// Whether this version's ciphersuite codepoint is an IANA assignment.
    ///
    /// `false` for everything shipping today. It is a method rather than a
    /// comment so that the migration, when it is written, has something to
    /// branch on that a test can also assert.
    #[must_use]
    pub const fn codepoint_is_registered(self) -> bool {
        match self {
            Self::V1Draft => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_current_version_is_the_draft_one_and_says_so() {
        assert_eq!(ProtocolVersion::CURRENT, ProtocolVersion::V1Draft);
        assert_eq!(
            ProtocolVersion::CURRENT.ciphersuite_codepoint(),
            XWING_CIPHERSUITE_CODEPOINT
        );
        assert!(
            !ProtocolVersion::CURRENT.codepoint_is_registered(),
            "0x004D is not an IANA assignment; see the module note and §13-B"
        );
    }

    #[test]
    fn the_version_round_trips_through_the_encoding_the_store_uses() {
        let encoded = serde_json::to_vec(&ProtocolVersion::CURRENT).unwrap();
        let decoded: ProtocolVersion = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, ProtocolVersion::CURRENT);
    }
}
