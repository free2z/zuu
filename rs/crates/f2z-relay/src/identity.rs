//! The relay's long-term Ed25519 identity (§5.2), and where it lives.
//!
//! # Why losing it is not a small thing
//!
//! `relay_id = H("free2z/relay/v1/relay-id", relay_identity_pk)`, and §7.2 puts
//! that value inside every `queue_advert` that ever named this relay — inside
//! the MLS group, where the relay cannot reach it. A relay that comes back with
//! a new identity key is, to every client that ever spoke to it, **a different
//! relay that has taken over the address**: §5.2's substitution check fires,
//! the mismatch is fatal, and the client is told the relay it names behaved
//! incorrectly.
//!
//! So the key file is the one piece of state whose loss is not recoverable by
//! restoring a backup of the queues, and `identity.generate` defaults to `true`
//! only because a first run has to be able to happen at all. A deployment that
//! provisions keys out of band should set it to `false`, so a lost volume fails
//! loudly instead of quietly becoming somebody else.
//!
//! # The file
//!
//! 64 hexadecimal characters and a newline: the 32-byte Ed25519 seed. Written
//! with mode `0600` on Unix, and refused on load if the mode is wider — a
//! world-readable identity key is the relay's whole authenticity, and a warning
//! is not enough.

use std::path::Path;

use f2z_relay_proto::key::SigningKey;

/// Why an identity could not be established.
#[derive(Debug)]
pub enum IdentityError {
    /// The file could not be read or written.
    Io(std::io::Error),
    /// The file is not 64 hexadecimal characters.
    Malformed,
    /// The file is readable by somebody other than its owner.
    Permissions(u32),
    /// The file is missing and `identity.generate` is off.
    Missing,
    /// The operating system refused to provide randomness.
    NoRandomness,
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "identity key file: {error}"),
            Self::Malformed => f.write_str(
                "identity key file must be exactly 64 hexadecimal characters (a 32-byte seed)",
            ),
            Self::Permissions(mode) => write!(
                f,
                "identity key file is readable beyond its owner (mode {mode:o}); \
                 chmod 600 it"
            ),
            Self::Missing => f.write_str(
                "no identity key file and identity.generate is false; provision one, \
                 or accept that a new key makes this a different relay to every \
                 client that ever held a queue advert naming it (WIRE.md §5.2)",
            ),
            Self::NoRandomness => f.write_str("the operating system refused to provide randomness"),
        }
    }
}

impl std::error::Error for IdentityError {}

impl From<std::io::Error> for IdentityError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Load the identity from `path`, creating it when `generate` allows.
///
/// # Errors
///
/// [`IdentityError`], every variant of which is a startup failure rather than a
/// warning.
pub fn load_or_create(path: &Path, generate: bool) -> Result<SigningKey, IdentityError> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            check_permissions(path)?;
            let seed = crate::config::decode_seed(text.trim()).ok_or(IdentityError::Malformed)?;
            Ok(SigningKey::from_seed(&seed))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !generate {
                return Err(IdentityError::Missing);
            }
            let seed = crate::rng::seed().map_err(|_| IdentityError::NoRandomness)?;
            write_seed(path, &seed)?;
            Ok(SigningKey::from_seed(&seed))
        }
        Err(error) => Err(IdentityError::Io(error)),
    }
}

/// Take the identity from a configured hex seed.
///
/// For a container with no persistent volume. The seed is key material; see
/// [`crate::config::Identity`] for what `--print-config` does with it.
///
/// # Errors
///
/// [`IdentityError::Malformed`] if it is not 64 hexadecimal characters.
pub fn from_hex(text: &str) -> Result<SigningKey, IdentityError> {
    let seed = crate::config::decode_seed(text.trim()).ok_or(IdentityError::Malformed)?;
    Ok(SigningKey::from_seed(&seed))
}

fn write_seed(path: &Path, seed: &[u8; 32]) -> Result<(), IdentityError> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = String::with_capacity(65);
    for byte in seed {
        // `{:02x}` on a `u8`, without pulling in a formatting helper.
        text.push(hex_digit(byte >> 4));
        text.push(hex_digit(byte & 0x0f));
    }
    text.push('\n');

    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, text.as_bytes())?;
    }
    Ok(())
}

fn check_permissions(path: &Path) -> Result<(), IdentityError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(path)?.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(IdentityError::Permissions(mode));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// The digit for a nibble, in checked arithmetic.
///
/// The workspace denies `arithmetic_side_effects` for every crate under `rs/`,
/// and this file writes a private key: an out-of-range value here would be a
/// key file that does not decode back to the key in memory.
const fn hex_digit(nibble: u8) -> char {
    let digit = match nibble {
        0..=9 => b'0'.checked_add(nibble),
        10..=15 => match nibble.checked_sub(10) {
            Some(offset) => b'a'.checked_add(offset),
            None => None,
        },
        _ => None,
    };
    match digit {
        Some(byte) => byte as char,
        // Unreachable: every caller masks to four bits. `'?'` rather than a
        // panic, because a panic in a key writer is the worst possible failure
        // mode and a malformed file is caught on the next load.
        None => '?',
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("f2z-relay-identity-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_generated_key_is_stable_across_loads() {
        let dir = temp_dir("stable");
        let path = dir.join("identity.key");
        let first = load_or_create(&path, true).unwrap();
        let second = load_or_create(&path, true).unwrap();
        assert_eq!(first.public_key(), second.public_key());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_key_without_generate_is_a_startup_failure() {
        let dir = temp_dir("missing");
        let path = dir.join("identity.key");
        assert!(matches!(
            load_or_create(&path, false),
            Err(IdentityError::Missing)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_key_is_refused_rather_than_hashed_into_something() {
        let dir = temp_dir("malformed");
        let path = dir.join("identity.key");
        std::fs::write(&path, "not a key\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(matches!(
            load_or_create(&path, true),
            Err(IdentityError::Malformed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_world_readable_key_is_refused() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = temp_dir("perms");
        let path = dir.join("identity.key");
        load_or_create(&path, true).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            load_or_create(&path, true),
            Err(IdentityError::Permissions(_))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hex_seed_and_a_key_file_produce_the_same_key() {
        let key = from_hex(&"11".repeat(32)).unwrap();
        assert_eq!(
            key.public_key(),
            SigningKey::from_seed(&[0x11; 32]).public_key()
        );
        assert!(from_hex("nope").is_err());
    }

    #[test]
    fn the_error_display_never_carries_the_seed() {
        let rendered = format!("{}", IdentityError::Malformed);
        assert!(!rendered.contains("1111"));
    }
}
