//! The log's ECVRF private key.
//!
//! `KT.md` §6.1 is unusually strict about this key and the reason is worth
//! having next to the code: `vrf_public_key` *"determines every label in the
//! tree, so changing it silently invalidates every prior proof while producing
//! proofs that still verify under the new key. A client or witness that
//! observes a `vrf_public_key` change MUST treat it as a fork."*
//!
//! So there is no rotation path here and there should not be one. The key is
//! read once at startup, held for the life of the process (which is what
//! `akd_core`'s own trait documentation asks for), and published in every tree
//! head so that a change is detectable by everyone rather than by nobody.
//!
//! `akd_core` ships a `HardCodedAkdVRF` whose private key is a constant in the
//! library source. It exists for `akd`'s own tests. Using it in a real log
//! would make every label derivable by anyone who has read the crate, which
//! destroys the zero-knowledge property the whole construction is for —
//! [`FileVrf::forbid_hardcoded`] is the check that stops that reaching
//! production by accident.

use akd_core::ecvrf::{VRFKeyStorage, VrfError};
use f2z_codec::types::PublicKey;

use crate::error::{LogError, Result};

/// `akd_core::ecvrf::HardCodedAkdVRF`'s private key, verbatim from the library
/// source. Present here for exactly one purpose: refusing it.
const HARDCODED_TEST_VRF_SEED: [u8; 32] = [
    0xc9, 0xaf, 0xa9, 0xd8, 0x45, 0xba, 0x75, 0x16, 0x6b, 0x5c, 0x21, 0x57, 0x67, 0xb1, 0xd6, 0x93,
    0x4e, 0x50, 0xc3, 0xdb, 0x36, 0xe8, 0x9b, 0x12, 0x7b, 0x8a, 0x62, 0x2b, 0x12, 0x0f, 0x67, 0x21,
];

/// The log's VRF key, held in memory for the life of the process.
#[derive(Clone)]
pub struct FileVrf {
    seed: [u8; 32],
}

impl FileVrf {
    /// Load the VRF private key from a file — 32 raw bytes or 64 hex
    /// characters, the same shape as every other key file here.
    ///
    /// # Errors
    ///
    /// [`LogError::Config`] if the file is missing, unreadable, the wrong
    /// length, or contains `akd_core`'s hardcoded test key.
    pub fn load(path: &std::path::Path) -> Result<Self> {
        let raw = std::fs::read(path)
            .map_err(|error| LogError::Config(format!("{}: {error}", path.display())))?;
        let seed = if let Ok(exact) = <[u8; 32]>::try_from(raw.as_slice()) {
            exact
        } else {
            let text = core::str::from_utf8(&raw)
                .map_err(|_| LogError::Config(format!("{}: not a 32-byte key", path.display())))?
                .trim();
            crate::hexbytes::decode_array::<32>(text)
                .ok_or_else(|| LogError::Config(format!("{}: not a 32-byte key", path.display())))?
        };
        Self::from_seed(seed)
    }

    /// Build from a raw seed, refusing the library's test key.
    ///
    /// # Errors
    ///
    /// [`LogError::Config`] if the seed is `akd_core`'s hardcoded one.
    pub fn from_seed(seed: [u8; 32]) -> Result<Self> {
        Self::forbid_hardcoded(&seed)?;
        Ok(Self { seed })
    }

    /// Refuse `akd_core::ecvrf::HardCodedAkdVRF`'s key.
    ///
    /// A log running on it derives every label from a private key printed in a
    /// published crate: anyone can compute the label for any handle, walk the
    /// tree, and enumerate the directory. The zero-knowledge property is the
    /// reason `akd` was adopted over a cleartext log at all (ADR 0013), so this
    /// is a startup refusal rather than a warning.
    ///
    /// # Errors
    ///
    /// [`LogError::Config`] if it matches.
    pub fn forbid_hardcoded(seed: &[u8; 32]) -> Result<()> {
        if seed == &HARDCODED_TEST_VRF_SEED {
            return Err(LogError::Config(
                "the VRF key is akd_core's hardcoded test key: every label in the tree would be \
                 derivable by anyone who has read the crate"
                    .to_owned(),
            ));
        }
        Ok(())
    }

    /// The public half, as it appears in every `SignedTreeHead` (`KT.md` §6.1).
    ///
    /// # Errors
    ///
    /// [`LogError::Config`] if the seed is not a valid ECVRF private key.
    pub async fn public_key(&self) -> Result<PublicKey> {
        let key = self
            .get_vrf_public_key()
            .await
            .map_err(|error| LogError::Config(format!("vrf: {error}")))?;
        let bytes = <[u8; 32]>::try_from(key.as_bytes().as_slice())
            .map_err(|_| LogError::Config("vrf: public key is not 32 bytes".to_owned()))?;
        Ok(PublicKey::new(bytes))
    }
}

#[async_trait::async_trait]
impl VRFKeyStorage for FileVrf {
    async fn retrieve(&self) -> core::result::Result<Vec<u8>, VrfError> {
        Ok(self.seed.to_vec())
    }
}

/// Renders nothing. The seed is the one value in this process whose disclosure
/// makes the whole directory enumerable.
impl core::fmt::Debug for FileVrf {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("FileVrf(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use akd_core::ecvrf::VRFKeyStorage as _;

    use super::{FileVrf, HARDCODED_TEST_VRF_SEED};

    #[tokio::test]
    async fn the_copied_seed_still_matches_akd_cores_own() {
        let library = akd_core::ecvrf::HardCodedAkdVRF
            .retrieve()
            .await
            .expect("akd_core's hardcoded VRF key is retrievable");
        assert_eq!(
            library.as_slice(),
            &HARDCODED_TEST_VRF_SEED,
            "akd_core changed its hardcoded test key; forbid_hardcoded is now refusing a key \
             nobody ships and permitting the one that makes every label public",
        );
    }

    #[test]
    fn the_libraries_hardcoded_test_key_is_refused_at_startup() {
        let error = FileVrf::from_seed(HARDCODED_TEST_VRF_SEED).unwrap_err();
        assert!(format!("{error}").contains("hardcoded test key"));
    }

    #[test]
    fn a_real_key_loads_and_never_prints_itself() {
        let vrf = FileVrf::from_seed([0x42; 32]).unwrap();
        let rendered = format!("{vrf:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("4242"));
        assert!(!rendered.contains("66, 66"));
    }

    #[tokio::test]
    async fn the_public_key_is_thirty_two_bytes_and_stable() {
        let vrf = FileVrf::from_seed([0x11; 32]).unwrap();
        let a = vrf.public_key().await.unwrap();
        let b = vrf.public_key().await.unwrap();
        assert_eq!(a, b);
    }
}
