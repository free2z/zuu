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
//!   silently read a different number than the one that was signed. `1.0`
//!   and `1e3` are refused too, even though they denote integers: a signer
//!   should never emit them, and refusing is the fail-closed answer. `-0` is
//!   refused as well — except in a build where a dependent has unified
//!   `serde_json/arbitrary_precision` on, where serde_json itself reads it as
//!   the integer 0 and it canonicalizes to `0`, RFC 8785's own answer. In that
//!   build every non-integer number is refused at parse by [`parse_strict`]
//!   instead of here; integers behave identically in both builds, which the
//!   suite shows by passing under `--features serde_json/arbitrary_precision`.
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
#[non_exhaustive]
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

/// Parse JSON into a [`Value`], refusing any object with a duplicate member
/// name.
///
/// RFC 8785 §3.1 requires input free of duplicate names, and for a signed
/// document it matters: `serde_json` (like Python's `json`) keeps the *last*
/// duplicate, but another consumer of the same served bytes may keep the
/// first, and would then act on a value the signature was never computed
/// over. Refusing duplicates removes the ambiguity rather than picking a side.
///
/// # Errors
///
/// A `serde_json` error for malformed JSON or a duplicate member name.
pub fn parse_strict(json: &[u8]) -> Result<Value, serde_json::Error> {
    serde_json::from_slice::<NoDuplicates>(json).map(|v| v.0)
}

/// The private map key `serde_json`'s `arbitrary_precision` feature uses to
/// carry a number through `visit_map`.
const ARBITRARY_PRECISION_TOKEN: &str = "$serde_json::private::Number";

/// A [`Value`] whose deserialization refuses duplicate member names.
struct NoDuplicates(Value);

impl<'de> serde::Deserialize<'de> for NoDuplicates {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(NoDuplicatesVisitor).map(NoDuplicates)
    }
}

struct NoDuplicatesVisitor;

impl<'de> serde::de::Visitor<'de> for NoDuplicatesVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value without duplicate member names")
    }

    fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Value, E> {
        Ok(Value::from(v))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Value, E> {
        Ok(Value::from(v))
    }

    fn visit_f64<E>(self, v: f64) -> Result<Value, E> {
        // Kept, so that `to_canonical_json` is what refuses it — with the
        // specific "integers only" error rather than a parse error.
        Ok(serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number))
    }

    fn visit_str<E>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.into()))
    }

    fn visit_string<E>(self, v: alloc::string::String) -> Result<Value, E> {
        Ok(Value::String(v))
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(NoDuplicates(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut object = serde_json::Map::new();
        while let Some(name) = map.next_key::<alloc::string::String>()? {
            if name == ARBITRARY_PRECISION_TOKEN {
                // serde_json with `arbitrary_precision` — which any crate in a
                // dependent's graph can switch on by feature unification —
                // hands a number that is not a plain u64/i64 (every float) to
                // `visit_map` as a one-member map under this key. Accepting it
                // would turn that number into an object and change the
                // canonical bytes; refuse it instead — the catalogue admits
                // integers only, so nothing valid is lost. (A JSON
                // document that literally uses this member name is refused
                // too: no honest catalogue does.)
                return Err(serde::de::Error::custom(
                    "non-integer number (serde_json `arbitrary_precision` form) \
                     or reserved member name; canonical JSON admits integers only",
                ));
            }
            if object.contains_key(&name) {
                return Err(serde::de::Error::custom(format_args!(
                    "duplicate member name {name:?}"
                )));
            }
            let NoDuplicates(member) = map.next_value()?;
            object.insert(name, member);
        }
        Ok(Value::Object(object))
    }
}

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
        // as_u64 failed, so i < 0. Guarded anyway: emitting `-` before a
        // zero magnitude would produce `-0`, which is not canonical.
        if i >= 0 {
            return Err(CanonicalError::NonIntegerNumber);
        }
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
    fn every_control_character_is_escaped_in_lowercase_and_del_is_not() {
        // 0x00–0x1f: the five short forms, everything else `\u00xx` with
        // lowercase hex. 0x7f (DEL) is not a control character to JCS and is
        // emitted literally.
        let mut input = String::new();
        let mut expected = String::from("\"");
        for c in 0u8..0x20 {
            input.push(char::from(c));
            expected.push_str(&match c {
                0x08 => "\\b".into(),
                0x09 => "\\t".into(),
                0x0a => "\\n".into(),
                0x0c => "\\f".into(),
                0x0d => "\\r".into(),
                _ => alloc::format!("\\u{c:04x}"),
            });
        }
        input.push('\u{7f}');
        expected.push('\u{7f}');
        expected.push('"');
        let out = to_canonical_json(&Value::String(input)).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), expected);
        assert!(expected.contains("\\u001a") && expected.contains("\\u001f"));
    }

    #[test]
    fn the_arbitrary_precision_number_token_is_refused() {
        // What serde_json hands `visit_map` for `1.5` when the feature is on.
        assert!(parse_strict(br#"{"$serde_json::private::Number":"1.5"}"#).is_err());
        assert!(parse_strict(br#"{"a":[{"$serde_json::private::Number":"1"}]}"#).is_err());
    }

    #[test]
    fn duplicate_member_names_are_refused_at_any_depth() {
        assert!(parse_strict(br#"{"a":1,"a":2}"#).is_err());
        assert!(parse_strict(br#"{"x":[{"b":1,"c":{"d":0,"d":0}}]}"#).is_err());
        // Integers only here: under `arbitrary_precision` a float is refused
        // at parse (see `the_arbitrary_precision_number_token_is_refused`).
        let ok = parse_strict(br#"{"a":{"a":1},"b":[-15,null,"s",true]}"#).unwrap();
        let expected: Value =
            serde_json::from_str(r#"{"a":{"a":1},"b":[-15,null,"s",true]}"#).unwrap();
        assert_eq!(ok, expected);
    }

    #[test]
    fn integers_only_within_the_safe_range() {
        assert_eq!(canon("[0,-7,9007199254740991]"), "[0,-7,9007199254740991]");
        // `-0`: serde_json reads it as a float and it is refused — unless a
        // dependent unified serde_json's `arbitrary_precision` on, where it
        // reads as the integer 0 and canonicalizes to `0`, which is exactly
        // RFC 8785's (and Python's) answer. Either way it is never `-0`.
        let neg_zero: Value = serde_json::from_str("-0").unwrap();
        match to_canonical_json(&neg_zero) {
            Err(CanonicalError::NonIntegerNumber) => {}
            Ok(bytes) => assert_eq!(bytes, b"0"),
            other => panic!("-0: {other:?}"),
        }
        for bad in ["1.5", "1e3", "1.0"] {
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
