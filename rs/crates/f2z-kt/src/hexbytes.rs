//! Base16, by hand.
//!
//! Twenty lines rather than a dependency, and the reason is not asceticism: the
//! log and the witness both read keys and identifiers from configuration files
//! and both print them back, so this runs on operator input on the process's
//! startup path. A decoder that is entirely in front of the reviewer is worth
//! more here than one that is entirely correct somewhere else.
//!
//! Lowercase on output, either case on input, no separators, no `0x`, exact
//! length or nothing.

/// Render bytes as lowercase base16.
#[must_use]
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        out.push(nibble(byte >> 4));
        out.push(nibble(byte & 0x0f));
    }
    out
}

/// Decode base16 into a fixed-size array, or `None`.
///
/// Exact length is required: a 63-character key file is a truncated key file,
/// and padding it would turn a typo into a key nobody meant to use.
#[must_use]
pub fn decode_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    let decoded = decode(text)?;
    <[u8; N]>::try_from(decoded.as_slice()).ok()
}

/// Decode base16 into a byte vector, or `None` on any non-hex byte or an odd
/// length.
#[must_use]
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let (Some(hi), Some(lo)) = (pair.first().copied(), pair.get(1).copied()) else {
            return None;
        };
        let hi = value(hi)?;
        let lo = value(lo)?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

/// The base16 alphabet, written out rather than computed.
///
/// `b'0' + value` is what this would ordinarily be, and the workspace denies
/// `arithmetic_side_effects` for a good reason: that family of bugs is exactly
/// the family that turns a parser on an unauthenticated path into a remote
/// denial of service. Sixteen arms have no such family, stay `const`, and need
/// no indexing — which the workspace also denies.
const fn nibble(value: u8) -> char {
    match value & 0x0f {
        0 => '0',
        1 => '1',
        2 => '2',
        3 => '3',
        4 => '4',
        5 => '5',
        6 => '6',
        7 => '7',
        8 => '8',
        9 => '9',
        10 => 'a',
        11 => 'b',
        12 => 'c',
        13 => 'd',
        14 => 'e',
        _ => 'f',
    }
}

const fn value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => byte.checked_sub(b'0'),
        b'a'..=b'f' => match byte.checked_sub(b'a') {
            Some(offset) => offset.checked_add(10),
            None => None,
        },
        b'A'..=b'F' => match byte.checked_sub(b'A') {
            Some(offset) => offset.checked_add(10),
            None => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{decode, decode_array, encode};

    #[test]
    fn a_round_trip_is_lowercase_and_exact() {
        let bytes = [0x00, 0x0f, 0xf0, 0xff, 0xa5];
        assert_eq!(encode(&bytes), "000ff0ffa5");
        assert_eq!(decode("000FF0FFA5").as_deref(), Some(bytes.as_slice()));
    }

    #[test]
    fn a_wrong_length_is_refused_rather_than_padded() {
        assert_eq!(decode("abc"), None);
        assert_eq!(decode_array::<32>(&"ab".repeat(31)), None);
        assert!(decode_array::<32>(&"ab".repeat(32)).is_some());
    }

    #[test]
    fn anything_that_is_not_hex_is_none_rather_than_zero() {
        assert_eq!(decode("gg"), None);
        assert_eq!(decode("0x01"), None);
        assert_eq!(decode("00 11"), None);
    }
}
