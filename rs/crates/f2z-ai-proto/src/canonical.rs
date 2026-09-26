//! Canonical JSON: the bytes the catalogue signature covers.
//!
//! This is RFC 8785 (JSON Canonicalization Scheme) restricted to the subset
//! the catalogue uses, where the restriction removes the only hard part of
//! JCS and every divergence between implementations with it:
//!
//! * **Numbers must be integers with magnitude ≤ 2⁵³ − 1.** JCS serializes
//!   numbers with ECMAScript's `Number.prototype.toString`, which is where
//!   Python, JavaScript and Rust implementations disagree in practice. Every
//!   catalogue number is an integer (prices in nano-USD, ratios in basis
//!   points), so a float is refused outright rather than canonicalized. The
//!   2⁵³ bound is I-JSON's (RFC 7493): beyond it, a JavaScript verifier would
//!   silently read a different number than the one that was signed. `-0`,
//!   `1.0` and `1e3` are refused too, even though they denote integers: a
//!   signer should never emit them, and refusing is the fail-closed answer.
//! * **Object members are sorted by the UTF-16 code units of their names**,
//!   as JCS §3.2.3 requires (not by UTF-8 bytes, which order differently above
//!   U+FFFF).
//! * **No whitespace.** Strings are escaped per JCS §3.2.2.2: `"` and `\`,
//!   the five short escapes `\b \f \n \r \t`, every other control character as
//!   `\u00xx` in lowercase hex, and everything else — including non-ASCII and
//!   `/` — literally.
//!
//! For documents inside that subset, the output is byte-identical to any
//! conforming RFC 8785 implementation, e.g. Python's
//! `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
//! for ASCII member names.

use alloc::vec::Vec;
use core::fmt;

use serde_json::Value;

/// The largest integer magnitude a canonical document may contain: 2⁵³ − 1.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Why a value has no canonical form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanonicalError {
    /// A number that is not an integer.
    NonIntegerNumber,
    /// An integer outside ±(2⁵³ − 1).
    UnsafeInteger,
}

impl fmt::Display for CanonicalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonIntegerNumber => f.write_str("canonical JSON admits integers only"),
            Self::UnsafeInteger => f.write_str("integer outside the I-JSON safe range"),
        }
    }
}

impl core::error::Error for CanonicalError {}

/// The canonical encoding of `value`.
///
/// # Errors
///
/// [`CanonicalError`] if `value` contains a non-integer or out-of-range number.
pub fn to_canonical_json(value: &Value) -> Result<Vec<u8>, CanonicalError> {
    let mut out = Vec::new();
    write_value(&mut out, value)?;
    Ok(out)
}

fn write_value(out: &mut Vec<u8>, value: &Value) -> Result<(), CanonicalError> {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(n) => write_integer(out, n)?,
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i != 0 {
                    out.push(b',');
                }
                write_value(out, item)?;
            }
            out.push(b']');
        }
        Value::Object(map) => {
            let mut members: Vec<_> = map.iter().collect();
            members.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            out.push(b'{');
            for (i, (name, member)) in members.into_iter().enumerate() {
                if i != 0 {
                    out.push(b',');
                }
                write_string(out, name);
                out.push(b':');
                write_value(out, member)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}

fn write_integer(out: &mut Vec<u8>, n: &serde_json::Number) -> Result<(), CanonicalError> {
    if let Some(u) = n.as_u64() {
        if u > MAX_SAFE_INTEGER {
            return Err(CanonicalError::UnsafeInteger);
        }
        push_decimal(out, u);
    } else if let Some(i) = n.as_i64() {
        // as_u64 failed, so i < 0.
        let magnitude = i.unsigned_abs();
        if magnitude > MAX_SAFE_INTEGER {
            return Err(CanonicalError::UnsafeInteger);
        }
        out.push(b'-');
        push_decimal(out, magnitude);
    } else {
        return Err(CanonicalError::NonIntegerNumber);
    }
    Ok(())
}

fn push_decimal(out: &mut Vec<u8>, mut v: u64) {
    let mut digits = [0u8; 20];
    let mut len = 0usize;
    loop {
        let digit = u8::try_from(v.checked_rem(10).unwrap_or(0)).unwrap_or(0);
        if let Some(slot) = digits.get_mut(len) {
            *slot = b'0'.saturating_add(digit);
        }
        len = len.saturating_add(1);
        v = v.checked_div(10).unwrap_or(0);
        if v == 0 {
            break;
        }
    }
    for d in digits.iter().take(len).rev() {
        out.push(*d);
    }
}

fn write_string(out: &mut Vec<u8>, s: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    for ch in s.chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{08}' => out.extend_from_slice(b"\\b"),
            '\u{0c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if u32::from(c) < 0x20 => {
                let b = u8::try_from(u32::from(c)).unwrap_or(0);
                let hi = HEX.get(usize::from(b >> 4)).copied().unwrap_or(b'0');
                let lo = HEX.get(usize::from(b & 0x0f)).copied().unwrap_or(b'0');
                out.extend_from_slice(b"\\u00");
                out.push(hi);
                out.push(lo);
            }
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::String;

    fn canon(json: &str) -> String {
        let v: Value = serde_json::from_str(json).unwrap();
        String::from_utf8(to_canonical_json(&v).unwrap()).unwrap()
    }

    #[test]
    fn sorts_members_and_drops_whitespace() {
        assert_eq!(
            canon(r#"{ "b": [1, 2, {"z": null, "a": true}], "a": "x" }"#),
            r#"{"a":"x","b":[1,2,{"a":true,"z":null}]}"#
        );
    }

    #[test]
    fn member_order_is_utf16_not_utf8() {
        // U+FF61 (UTF-16 0xFF61) sorts AFTER U+1F600 (UTF-16 0xD83D…) in
        // UTF-16 order, but BEFORE it in UTF-8 byte order (EF… < F0…).
        assert_eq!(
            canon("{\"\u{ff61}\":1,\"\u{1f600}\":2}"),
            "{\"\u{1f600}\":2,\"\u{ff61}\":1}"
        );
    }

    #[test]
    fn escapes_per_jcs() {
        assert_eq!(
            canon(r#""a\"b\\c\/d\u0001\né ""#),
            "\"a\\\"b\\\\c/d\\u0001\\n\u{e9}\u{2028}\""
        );
    }

    #[test]
    fn integers_only_within_the_safe_range() {
        assert_eq!(canon("[0,-7,9007199254740991]"), "[0,-7,9007199254740991]");
        // `-0` too: serde_json reads it as a float. Python reads it as the int 0, so
        // a signer that emitted it would be refused here — fail closed, and no
        // honest signer writes `-0`.
        for bad in ["1.5", "1e3", "1.0", "-0"] {
            let v: Value = serde_json::from_str(bad).unwrap();
            assert_eq!(
                to_canonical_json(&v),
                Err(CanonicalError::NonIntegerNumber),
                "{bad}"
            );
        }
        for bad in ["9007199254740992", "-9007199254740992"] {
            let v: Value = serde_json::from_str(bad).unwrap();
            assert_eq!(
                to_canonical_json(&v),
                Err(CanonicalError::UnsafeInteger),
                "{bad}"
            );
        }
    }
}
