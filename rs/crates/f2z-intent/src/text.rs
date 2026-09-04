//! Text a wallet can render unambiguously, and nothing else.
//!
//! # Why this is a refusal and not an escape
//!
//! `#528` established the requirement: the native payment review renders
//! layout controls *visibly* rather than letting a memo spoof the review it
//! appears inside. The bridge inherits the requirement and answers it one step
//! earlier — by refusing the code points outright at the parse boundary.
//!
//! The reason the answer differs is that the source differs. A memo typed by
//! the wallet's own user into the wallet's own field is content the user
//! authored and can see; escaping it preserves their text while making the
//! trickery visible. A `purpose` string arriving over the bridge is authored
//! by *another app* with the explicit goal of appearing inside ZUULI's
//! confirmation, and its whole job is to be read by a human who is about to
//! delegate authority. There is no legitimate intent-bridge string that needs
//! U+202E RIGHT-TO-LEFT OVERRIDE, and "render it visibly" still spends screen
//! space on an attacker's payload. So: fail closed.
//!
//! [`escape_layout_controls`] exists anyway, because the *response* side and
//! the log side both render text this module has already accepted, and a
//! renderer that assumes its input is clean is a renderer that stops being
//! true the moment someone widens the parse rule.
//!
//! # What is refused
//!
//! - Anything that is not valid UTF-8.
//! - The empty string, where a field is required.
//! - C0 (`U+0000`–`U+001F`) and C1 (`U+007F`–`U+009F`) controls, newline and
//!   tab included. A confirmation line is one line.
//! - Leading or trailing whitespace, so two strings that render identically
//!   cannot be distinct bytes.
//! - Every Unicode bidirectional and invisible-formatting control:
//!   `U+00AD`, `U+061C`, `U+180E`, `U+200B`–`U+200F`, `U+202A`–`U+202E`,
//!   `U+2060`–`U+2064`, `U+2066`–`U+2069`, `U+FEFF`, and the tag block
//!   `U+E0000`–`U+E007F`.
//!
//! # What is deliberately *not* refused
//!
//! Confusable scripts. `раypal` in Cyrillic is accepted here, because refusing
//! it means shipping a confusables table into a `no_std` crate and because the
//! control that actually stops it is elsewhere: ZUULI renders the *caller*
//! from its own registry (see [`crate::caller`]), never from a string the
//! caller supplied. That limit is stated rather than papered over.

use alloc::string::String;
use core::fmt::Write as _;

use f2z_codec::types::ShortBytes;

use crate::error::IntentError;

/// The longest a bridge text field may be, in bytes.
///
/// A `<0..255>` length prefix is the hard ceiling; this is the same number
/// stated as a rule so that a reader does not have to infer a policy from an
/// encoding.
pub const MAX_TEXT_BYTES: usize = 255;

/// Whether `point` is a code point no bridge text may contain.
///
/// `const` and branch-free of any table, so it is auditable by reading it.
#[must_use]
pub const fn is_forbidden(point: char) -> bool {
    matches!(
        point,
        '\u{0000}'..='\u{001f}'
            | '\u{007f}'..='\u{009f}'
            | '\u{00ad}'
            | '\u{061c}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{feff}'
            | '\u{e0000}'..='\u{e007f}'
    )
}

/// Bridge text: UTF-8, bounded, non-empty, trimmed, and free of every code
/// point [`is_forbidden`] names.
///
/// The invariant is established once, at construction, and there is no way to
/// build one that skips it — [`VisibleText::new`] is the only constructor, and
/// the inner value is private.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VisibleText(String);

impl VisibleText {
    /// Parse bytes as bridge text.
    ///
    /// # Errors
    ///
    /// [`IntentError::InvalidValue`] if the bytes are not UTF-8, are empty,
    /// exceed [`MAX_TEXT_BYTES`], are not trimmed, or contain a forbidden code
    /// point.
    pub fn new(bytes: &[u8]) -> Result<Self, IntentError> {
        if bytes.is_empty() || bytes.len() > MAX_TEXT_BYTES {
            return Err(IntentError::InvalidValue);
        }
        let text = core::str::from_utf8(bytes).map_err(|_| IntentError::InvalidValue)?;
        if text.trim() != text {
            return Err(IntentError::InvalidValue);
        }
        if text.chars().any(is_forbidden) {
            return Err(IntentError::InvalidValue);
        }
        Ok(Self(String::from(text)))
    }

    /// The text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The wire encoding, `opaque <1..255>`.
    ///
    /// # Errors
    ///
    /// [`IntentError::InvalidValue`] if the value somehow exceeds the prefix,
    /// which [`VisibleText::new`] has already made impossible.
    pub fn to_short_bytes(&self) -> Result<ShortBytes, IntentError> {
        ShortBytes::new(self.0.as_bytes().to_vec()).map_err(IntentError::from)
    }
}

/// Renders the text, never the raw bytes, and escapes anything that could
/// forge a log line.
///
/// Bridge text is not a secret — it is authored to be shown — so redacting it
/// would hide the very field an operator reading a refusal needs to see. What
/// it must not do is emit a code point that rearranges the log around it, and
/// [`escape_layout_controls`] is exactly that guarantee.
impl core::fmt::Debug for VisibleText {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "VisibleText({:?})", escape_layout_controls(&self.0))
    }
}

/// Replace every code point [`is_forbidden`] names with `U+FFFD`-style visible
/// escape text, leaving everything else alone.
///
/// The output is safe to place inside a line of a confirmation or a log
/// without changing the meaning of the text around it.
#[must_use]
pub fn escape_layout_controls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for point in text.chars() {
        if is_forbidden(point) {
            // `u32::from(char)` is total; the `U+XXXX` form is the one a
            // Unicode chart uses, so an operator can look the point up. A
            // write into a `String` cannot fail, and the `Result` is dropped
            // rather than unwrapped so this stays inside the workspace's
            // `panic`/`unwrap_used` denials.
            let _ = write!(out, "<U+{:04X}>", u32::from(point));
        } else {
            out.push(point);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn ordinary_text_is_accepted() {
        let text = VisibleText::new(b"Sign in to free2z").unwrap();
        assert_eq!(text.as_str(), "Sign in to free2z");
    }

    #[test]
    fn every_forbidden_class_is_refused() {
        for point in [
            '\u{0000}',
            '\u{000a}',
            '\u{001f}',
            '\u{007f}',
            '\u{0085}',
            '\u{00ad}',
            '\u{061c}',
            '\u{180e}',
            '\u{200b}',
            '\u{200f}',
            '\u{202e}',
            '\u{2062}',
            '\u{2069}',
            '\u{feff}',
            '\u{e0041}',
        ] {
            let mut bytes = vec![b'a'];
            let mut buffer = [0u8; 4];
            bytes.extend_from_slice(point.encode_utf8(&mut buffer).as_bytes());
            bytes.push(b'b');
            assert_eq!(
                VisibleText::new(&bytes),
                Err(IntentError::InvalidValue),
                "U+{:04X} must not survive the parse boundary",
                u32::from(point)
            );
        }
    }

    #[test]
    fn untrimmed_empty_oversize_and_non_utf8_are_refused() {
        assert_eq!(VisibleText::new(b" a"), Err(IntentError::InvalidValue));
        assert_eq!(VisibleText::new(b"a "), Err(IntentError::InvalidValue));
        assert_eq!(VisibleText::new(b""), Err(IntentError::InvalidValue));
        assert_eq!(
            VisibleText::new(&[b'a'; MAX_TEXT_BYTES + 1]),
            Err(IntentError::InvalidValue)
        );
        assert_eq!(
            VisibleText::new(&[0xff, 0xfe]),
            Err(IntentError::InvalidValue)
        );
    }

    #[test]
    fn escaping_names_the_code_point() {
        assert_eq!(
            escape_layout_controls("a\u{202e}b\u{e0041}"),
            "a<U+202E>b<U+E0041>"
        );
        assert_eq!(escape_layout_controls("plain"), "plain");
    }

    #[test]
    fn debug_cannot_carry_a_layout_control() {
        // Constructed through the private field on purpose: the point is that
        // even if the parse rule were widened tomorrow, the renderer would
        // still be safe.
        let smuggled = VisibleText(String::from("a\u{202e}b"));
        let rendered = alloc::format!("{smuggled:?}");
        assert!(!rendered.contains('\u{202e}'), "{rendered}");
        assert!(rendered.contains("<U+202E>"), "{rendered}");
    }
}
