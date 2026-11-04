//! Randomness from the OS CSPRNG (via `ring`), for the PKCE verifier,
//! `state`, `nonce` and idempotency keys. There is no seeded or global
//! generator: every value is drawn fresh.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::{SecureRandom, SystemRandom};

use crate::error::Error;

fn fill<const N: usize>() -> Result<[u8; N], Error> {
    let mut bytes = [0u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::Internal("the OS random number generator failed".into()))?;
    Ok(bytes)
}

/// 32 random bytes, base64url without padding: 43 characters, 256 bits.
/// Used for the PKCE verifier (RFC 7636 §4.1: 43–128 characters), `state`
/// (the spec asks for at least 128 bits) and `nonce`.
pub(crate) fn token_43() -> Result<String, Error> {
    Ok(URL_SAFE_NO_PAD.encode(fill::<32>()?))
}

/// A random UUIDv4 in lower-case hyphenated form: an `Idempotency-Key`
/// (1–128 ASCII characters) that is also readable in a log.
pub(crate) fn uuid_v4() -> Result<String, Error> {
    let mut b = fill::<16>()?;
    if let Some(v) = b.get_mut(6) {
        *v = (*v & 0x0f) | 0x40;
    }
    if let Some(v) = b.get_mut(8) {
        *v = (*v & 0x3f) | 0x80;
    }
    let mut out = String::with_capacity(36);
    for (i, byte) in b.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push_str(&format!("{byte:02x}"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_length_is_in_rfc7636_bounds_and_values_differ() {
        let a = token_43().unwrap();
        let b = token_43().unwrap();
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        );
    }

    #[test]
    fn uuid_shape() {
        let u = uuid_v4().unwrap();
        assert_eq!(u.len(), 36);
        assert_eq!(u.as_bytes()[14], b'4');
        assert!(matches!(u.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }
}
