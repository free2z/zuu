//! The log's signing key, behind a trait, with a file-backed default.
//!
//! # Why this is a trait at all
//!
//! The log signing key signs three different things — tree heads (`KT.md`
//! §6.1), submission receipts (§5.3) and log-key transitions (§6.4) — and every
//! one of them is a statement the log cannot take back. An operator who wants
//! that key in an HSM or a cloud KMS should not have to fork the server, and an
//! operator who does not want a cloud SDK in the binary should not have to
//! carry one.
//!
//! So: [`LogSigner`] is the interface, [`FileSigner`] is the default, and **the
//! ordinary build has no cloud dependency at all** — not an optional one, not a
//! disabled one, none. `cargo tree` on the default feature set contains no
//! network client and no SDK.
//!
//! # What the `kms` feature actually is, stated plainly
//!
//! [`KmsSigner`] delegates to an operator-configured **external command**. It
//! writes the message to that command's stdin and reads a 64-byte Ed25519
//! signature from its stdout. `aws kms sign`, `gcloud kms asymmetric-sign`, a
//! PKCS#11 shim, or a two-line script in front of a YubiHSM all fit that shape.
//!
//! That is a deliberate reduction of "KMS support" to the part that is actually
//! ours to get right. Vendoring one cloud vendor's SDK would pick a winner, add
//! a few hundred crates to a security-critical binary, and still not cover the
//! HSM case. This covers all of them and adds **zero** dependencies in either
//! feature configuration — the feature gate exists because the code path
//! spawns a subprocess, which is a capability a hardened deployment may want
//! compiled out entirely.
//!
//! The honest limits are in [`KmsSigner`]'s own documentation, and they are
//! real: this design cannot verify that the far side is a KMS rather than a
//! file, and it inherits the process-spawn surface.
//!
//! # What is never logged
//!
//! No implementation of [`LogSigner`] may render its key material. [`Debug`] is
//! hand-written on every type here, [`FileSigner`] holds an
//! `ed25519_dalek::SigningKey` whose bytes are zeroized on drop (the workspace
//! enables `zeroize`), and the public key is the only thing any of them will
//! print.

use core::fmt;

use ed25519_dalek::{Signer as _, SigningKey};
use f2z_codec::types::{PublicKey, Signature};

use crate::error::{LogError, Result};

/// Sign bytes with the log's signing key.
///
/// Implementations MUST be usable from many tasks at once — the epoch scheduler
/// signs tree heads while the API signs receipts — which is why this takes
/// `&self` and requires `Send + Sync`.
pub trait LogSigner: Send + Sync {
    /// The public half, which appears in the log descriptor (`KT.md` §9.1) and
    /// is what every verifier checks against.
    fn public_key(&self) -> PublicKey;

    /// Sign `message` — always a `signing_bytes()` transcript from
    /// `f2z-kt-core`, never a bare hash and never a caller-assembled buffer.
    ///
    /// # Errors
    ///
    /// [`LogError::Signer`] if the backing key store refused or was
    /// unreachable. A signing failure is never fatal to the process: the epoch
    /// scheduler retries, because an epoch the log cannot sign is better
    /// published late than not at all.
    fn sign(&self, message: &[u8]) -> Result<Signature>;
}

/// A signing key held in a file on disk — the default.
///
/// The file is 32 raw bytes or 64 hex characters, the same shape `f2z-assert`
/// reads, so an operator learns one format for the whole system.
pub struct FileSigner {
    key: SigningKey,
    public: PublicKey,
}

impl FileSigner {
    /// Load a signing key from a file.
    ///
    /// # Errors
    ///
    /// [`LogError::Signer`] if the file is missing, unreadable, or is not 32
    /// raw bytes or 64 hex characters.
    pub fn load(path: &std::path::Path) -> Result<Self> {
        let raw = std::fs::read(path)
            .map_err(|error| LogError::Signer(format!("{}: {error}", path.display())))?;
        let seed = decode_seed(&raw)
            .ok_or_else(|| LogError::Signer(format!("{}: not a 32-byte key", path.display())))?;
        Ok(Self::from_seed(&seed))
    }

    /// Build a signer from a raw 32-byte seed.
    ///
    /// Exposed because the acceptance tests stand up a whole log in-process and
    /// a test that had to write a key file first would be testing the
    /// filesystem.
    #[must_use]
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let key = SigningKey::from_bytes(seed);
        let public = PublicKey::new(key.verifying_key().to_bytes());
        Self { key, public }
    }
}

impl LogSigner for FileSigner {
    fn public_key(&self) -> PublicKey {
        self.public
    }

    fn sign(&self, message: &[u8]) -> Result<Signature> {
        Ok(Signature::new(self.key.sign(message).to_bytes()))
    }
}

/// Renders the public key and nothing else. The private half has no `Debug`
/// path out of this type, by construction rather than by discipline.
impl fmt::Debug for FileSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileSigner")
            .field("public_key", &self.public)
            .field("key", &"<redacted>")
            .finish()
    }
}

/// Read a key file's bytes as a 32-byte seed: 32 raw bytes, or 64 hex
/// characters with surrounding whitespace trimmed.
fn decode_seed(raw: &[u8]) -> Option<[u8; 32]> {
    if let Ok(exact) = <[u8; 32]>::try_from(raw) {
        return Some(exact);
    }
    let text = core::str::from_utf8(raw).ok()?.trim();
    crate::hexbytes::decode_array::<32>(text)
}

#[cfg(feature = "kms")]
pub use kms::KmsSigner;

#[cfg(feature = "kms")]
mod kms {
    use core::fmt;
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    use f2z_codec::types::{PublicKey, Signature};

    use super::LogSigner;
    use crate::error::{LogError, Result};

    /// Sign by delegating to an operator-configured external command.
    ///
    /// The command receives the message on **stdin** and must write exactly 64
    /// raw bytes, or 128 hex characters, of Ed25519 signature to **stdout**. A
    /// non-zero exit status, a short read, or anything on stdout that is not a
    /// signature is a [`LogError::Signer`].
    ///
    /// # What this does and does not give you
    ///
    /// It gives you: a signing key that never enters this process's address
    /// space, an audit trail wherever the far side keeps one, and the ability
    /// to put an HSM, a cloud KMS or a hardware token behind the log without
    /// forking the server or adding a vendor SDK to the binary.
    ///
    /// It does **not** give you: any assurance about what is on the other end.
    /// This type cannot tell a KMS from `cat signature.bin`. The public key is
    /// configured, not attested, so a misconfiguration that points at the wrong
    /// key produces signatures that simply fail to verify — loudly, at the
    /// first tree head, which is the failure mode to prefer but is not a
    /// substitute for checking the configuration.
    ///
    /// It also inherits the process-spawn surface: one `fork`/`exec` per
    /// signature, on a path an unauthenticated submission can reach through the
    /// receipt in `KT.md` §5.3. Rate-limit `/kt/v1/submit` accordingly; the
    /// default configuration does.
    pub struct KmsSigner {
        program: std::ffi::OsString,
        args: Vec<std::ffi::OsString>,
        public: PublicKey,
    }

    impl KmsSigner {
        /// Configure the delegate.
        ///
        /// `public` is the public half of whatever key the command signs with.
        /// It is configuration, not a claim this type can check — see the type
        /// documentation.
        #[must_use]
        pub fn new(
            program: std::ffi::OsString,
            args: Vec<std::ffi::OsString>,
            public: PublicKey,
        ) -> Self {
            Self {
                program,
                args,
                public,
            }
        }
    }

    impl LogSigner for KmsSigner {
        fn public_key(&self) -> PublicKey {
            self.public
        }

        fn sign(&self, message: &[u8]) -> Result<Signature> {
            let mut child = Command::new(&self.program)
                .args(&self.args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| LogError::Signer(format!("spawn: {error}")))?;
            {
                let stdin = child
                    .stdin
                    .as_mut()
                    .ok_or_else(|| LogError::Signer("no stdin".to_owned()))?;
                stdin
                    .write_all(message)
                    .map_err(|error| LogError::Signer(format!("write: {error}")))?;
            }
            let output = child
                .wait_with_output()
                .map_err(|error| LogError::Signer(format!("wait: {error}")))?;
            if !output.status.success() {
                return Err(LogError::Signer("signing command failed".to_owned()));
            }
            if let Ok(exact) = <[u8; 64]>::try_from(output.stdout.as_slice()) {
                return Ok(Signature::new(exact));
            }
            let text = core::str::from_utf8(&output.stdout)
                .map_err(|_| LogError::Signer("signature is not 64 bytes".to_owned()))?
                .trim();
            crate::hexbytes::decode_array::<64>(text)
                .map(Signature::new)
                .ok_or_else(|| LogError::Signer("signature is not 64 bytes".to_owned()))
        }
    }

    /// The command is rendered; the key is a public key. Nothing secret passes
    /// through this type, and this states that rather than assuming it.
    impl fmt::Debug for KmsSigner {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("KmsSigner")
                .field("program", &self.program)
                .field("public_key", &self.public)
                .finish()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FileSigner, LogSigner};

    #[test]
    fn a_file_signer_signs_verifiably_and_never_prints_its_key() {
        let signer = FileSigner::from_seed(&[7u8; 32]);
        let signature = signer.sign(b"free2z").unwrap();
        f2z_kt_core::sig::verify(&signer.public_key(), b"free2z", &signature).unwrap();

        let rendered = format!("{signer:?}");
        assert!(rendered.contains("<redacted>"));
        // The seed is 32 copies of 0x07; a leak would render as hex or as a
        // decimal byte list. Check both, because `Debug` for `[u8; N]` prints
        // decimals and a hex-only assertion would sail past it.
        assert!(!rendered.contains("0707"));
        assert!(!rendered.contains("7, 7, 7"));
    }

    #[test]
    fn a_hex_key_file_and_a_raw_key_file_load_to_the_same_signer() {
        let dir = crate::testing::temp_dir("signer-formats");
        let raw = dir.join("raw.key");
        let hex = dir.join("hex.key");
        std::fs::write(&raw, [9u8; 32]).unwrap();
        std::fs::write(&hex, format!("{}\n", "09".repeat(32))).unwrap();

        let a = FileSigner::load(&raw).unwrap();
        let b = FileSigner::load(&hex).unwrap();
        assert_eq!(a.public_key(), b.public_key());
    }

    #[test]
    fn a_key_file_of_the_wrong_length_is_refused_rather_than_padded() {
        let dir = crate::testing::temp_dir("signer-short");
        let path = dir.join("short.key");
        std::fs::write(&path, [1u8; 31]).unwrap();
        assert!(FileSigner::load(&path).is_err());
    }
}
