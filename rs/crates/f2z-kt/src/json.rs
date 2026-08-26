//! JSON is a container, never a transcript.
//!
//! `KT.md` §9.1 has the log descriptor served *"as `tls_codec` bytes and as
//! JSON with the same values and the same signature"*, and §9.2 makes the rest
//! of the API `application/octet-stream`. The reason to offer JSON at all is
//! `WIRE.md` §11.2's: a researcher with `curl` and no protocol library should
//! be able to look at a log.
//!
//! # The rule this module exists to enforce
//!
//! **Every JSON response carries the `tls_codec` bytes verbatim, base64url, and
//! those bytes are the only thing anything is ever verified against.** The
//! human-readable fields beside them are a rendering. Nothing is signed over
//! JSON, nothing is reconstructed from JSON, and a JSON body whose rendered
//! fields disagreed with its embedded bytes would change no signature's
//! verdict — it would only be wrong in a way a reader can catch by decoding the
//! bytes.
//!
//! §9.1 is honest about the residual: nothing forces the two representations to
//! agree except the operator. What makes divergence costly is that the same key
//! signed the bytes in both.
//!
//! Every response therefore carries `"authoritative": "tls_codec"` — a
//! machine-readable statement of which half a client is supposed to use, so
//! that a client author who reaches for the convenient half has to ignore a
//! field that says not to.

/// The base64url alphabet, unpadded (RFC 4648 §5). Unpadded because these
/// strings appear inside JSON where the length is already known, and `=` in a
/// URL-safe alphabet defeats the point of choosing it.
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encode bytes as unpadded base64url.
#[must_use]
pub fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3).saturating_mul(4));
    for chunk in bytes.chunks(3) {
        let b0 = chunk.first().copied().unwrap_or(0);
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let triple = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        let indices = [
            (triple >> 18) & 0x3f,
            (triple >> 12) & 0x3f,
            (triple >> 6) & 0x3f,
            triple & 0x3f,
        ];
        let keep = match chunk.len() {
            1 => 2,
            2 => 3,
            _ => 4,
        };
        for index in indices.iter().take(keep) {
            let position = usize::try_from(*index).unwrap_or(0);
            if let Some(symbol) = ALPHABET.get(position) {
                out.push(char::from(*symbol));
            }
        }
    }
    out
}

/// Escape a string for a JSON body.
///
/// Conservative on purpose: every byte outside printable ASCII becomes a `\u`
/// escape, so an operator-supplied descriptor field cannot terminate a string
/// or inject a control character into anyone's log viewer.
#[must_use]
pub fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (' '..='~').contains(&c) => out.push(c),
            c => {
                let mut buffer = [0u16; 2];
                for unit in c.encode_utf16(&mut buffer) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out
}

/// Wrap `tls_codec` bytes in the container.
///
/// `fields` is pre-rendered JSON object members (`"key": value`, comma
/// separated) or empty. They are a **rendering**; see the module note.
#[must_use]
pub fn container(bytes: &[u8], fields: &str) -> String {
    if fields.is_empty() {
        format!(
            "{{\"authoritative\":\"tls_codec\",\"encoding\":\"base64url\",\"tls_codec\":\"{}\"}}",
            base64url(bytes)
        )
    } else {
        format!(
            "{{\"authoritative\":\"tls_codec\",\"encoding\":\"base64url\",\"tls_codec\":\"{}\",\"rendered\":{{{fields}}}}}",
            base64url(bytes)
        )
    }
}

/// An error body in the same container shape.
#[must_use]
pub fn error_container(bytes: &[u8], code: u16, name: Option<&str>) -> String {
    let rendered = match name {
        Some(name) => format!("\"code\":{code},\"name\":\"{}\"", escape(name)),
        // KT.md §9.5: ERR_INTERNAL carries no detail, ever — not even its own
        // name, which would distinguish it from a future internal code.
        None => format!("\"code\":{code}"),
    };
    container(bytes, &rendered)
}

#[cfg(test)]
mod tests {
    use super::{base64url, container, error_container, escape};

    #[test]
    fn base64url_matches_rfc_4648_section_5_unpadded() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(b"fooba"), "Zm9vYmE");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
        // The two alphabet positions that differ from plain base64.
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn an_operator_string_cannot_close_its_own_field_with_a_quotation_mark() {
        // Renamed from `an_operator_string_cannot_escape_its_own_field`
        // (zuu#763). The old name claimed the general property — that *no*
        // operator string can escape its field — while the body exercised one
        // of the two characters that can do it. Three arms of `escape` could
        // be broken at once with this test, and every other test in every
        // crate that depends on `f2z-kt`, still green. A name that asserts
        // more than the body checks is the defect, not a symptom of it; the
        // rest of the property is now covered below and, for the backslash,
        // against a rendered descriptor field in `crate::descriptor`.
        let hostile = "free2z\",\"authoritative\":\"json";
        let rendered = escape(hostile);
        assert!(!rendered.contains("\",\""));
        assert!(rendered.contains("\\\""));
    }

    #[test]
    fn every_container_says_which_half_is_authoritative() {
        // Both branches, because production takes both: `api.rs`'s `respond`
        // is called with an empty rendering once and with a real one twice
        // (zuu#710). The name claims every container, so it asserts every
        // container.
        let bare = container(b"abc", "");
        assert!(bare.contains("\"authoritative\":\"tls_codec\""));
        assert!(bare.contains("\"tls_codec\":\"YWJj\""));
        assert!(
            !bare.contains("\"rendered\""),
            "an empty rendering must not produce an empty `rendered` object"
        );

        let with_rendering = container(b"abc", "\"epoch\":7");
        assert!(with_rendering.contains("\"authoritative\":\"tls_codec\""));
        assert!(with_rendering.contains("\"tls_codec\":\"YWJj\""));
        assert!(with_rendering.contains("\"rendered\":{\"epoch\":7}"));

        // The authoritative half is byte-identical across both branches: the
        // rendering is added beside the `tls_codec` member, never in place of
        // it, which is the property the module note is about.
        assert!(bare.contains("\"tls_codec\":\"YWJj\""));
        assert_eq!(
            bare.matches("\"tls_codec\"").count(),
            with_rendering.matches("\"tls_codec\"").count()
        );

        // Both are well-formed objects that a JSON reader can actually parse:
        // balanced braces, and the rendering nested rather than spliced.
        for body in [&bare, &with_rendering] {
            assert!(body.starts_with('{') && body.ends_with('}'));
            assert_eq!(
                body.matches('{').count(),
                body.matches('}').count(),
                "unbalanced container: {body}"
            );
        }
    }

    #[test]
    fn an_internal_error_renders_its_code_and_nothing_else() {
        let body = error_container(b"", 11, None);
        assert!(body.contains("\"code\":11"));
        assert!(
            !body.contains("name"),
            "ERR_INTERNAL carries no detail, ever (KT.md §9.5)"
        );
        let named = error_container(b"", 4, Some("ERR_BAD_AUTHORIZATION"));
        assert!(named.contains("ERR_BAD_AUTHORIZATION"));
    }

    // -----------------------------------------------------------------------
    // `escape`'s own coverage, one byte class per test (zuu#763).
    //
    // Unlike `f2z-relay`'s `json_string` — whose control and `\u` arms are
    // unreachable because `WIRE.md` §11.1 restricts the eight operator strings
    // to printable ASCII and `capabilities::validate` refuses anything else
    // before the renderer sees it — **every arm here is reachable in
    // production**. `LogDescriptor::validate` constrains `kt_versions`,
    // `log_id` and `configuration` and places no restriction whatsoever on the
    // operator string bytes, so all seven of `operator_name`,
    // `operator_contact`, `operator_jurisdiction`, `operator_policy_url`,
    // `source_repo_url`, `source_commit` and `build_digest` arrive at `escape`
    // exactly as an operator configured them, by way of
    // `String::from_utf8_lossy` in `crate::descriptor::render`.
    //
    // One byte class per test, and each payload holds *only* characters of the
    // class under test, so a break in one arm cannot be masked by another
    // arm's bytes in the same assertion — which is precisely how the backslash,
    // newline and `\u{04x}` arms were all deletable with every dependent crate
    // green. Each assertion is the whole returned string rather than a
    // substring: `f2z-kt` hand-renders its JSON (that is what this module is
    // for) and carries no JSON parser, so these are reviewed literals.

    #[test]
    fn the_json_escaper_escapes_a_quotation_mark() {
        assert_eq!(escape("\""), "\\\"");
    }

    #[test]
    fn the_json_escaper_escapes_a_backslash() {
        // A lone backslash that survives unescaped is the field-escape of
        // zuu#763; `crate::descriptor`'s tests assert the same arm against a
        // real rendered descriptor field, which is where it actually bites.
        assert_eq!(escape("\\"), "\\\\");
    }

    #[test]
    fn the_json_escaper_escapes_a_newline() {
        assert_eq!(escape("\n"), "\\n");
    }

    #[test]
    fn the_json_escaper_escapes_a_carriage_return() {
        assert_eq!(escape("\r"), "\\r");
    }

    #[test]
    fn the_json_escaper_escapes_a_tab() {
        assert_eq!(escape("\t"), "\\t");
    }

    #[test]
    fn the_json_escaper_passes_the_rest_of_printable_ascii_through_unchanged() {
        // `0x20..=0x7e` minus the two characters with a short form of their
        // own, which the two tests above already own.
        let printable: String = (0x20u8..=0x7e)
            .filter(|byte| *byte != b'"' && *byte != b'\\')
            .map(char::from)
            .collect();
        assert_eq!(escape(&printable), printable);
    }

    #[test]
    fn the_json_escaper_renders_everything_else_as_utf16_code_units() {
        // The C0 controls with no two-character form, DEL, and every
        // non-ASCII character.
        assert_eq!(escape("\u{0}"), "\\u0000");
        assert_eq!(escape("\u{1f}"), "\\u001f");
        assert_eq!(escape("\u{7f}"), "\\u007f");
        assert_eq!(escape("\u{e9}"), "\\u00e9");
        // U+2028 LINE SEPARATOR: legal unescaped in JSON, illegal unescaped in
        // a JavaScript string literal. Escaping it is why "conservative on
        // purpose" is worth the width.
        assert_eq!(escape("\u{2028}"), "\\u2028");
        // U+1F600 is astral, so `c.encode_utf16` emits a **surrogate pair** —
        // two `\u` escapes for one character, which is what RFC 8259 §7
        // requires and what a JSON reader reassembles.
        //
        // This is deliberately NOT what `f2z-relay`'s `json_string` does: that
        // This is deliberately NOT what `f2z-relay`'s `json_string` does:
        // that one is byte-wise over `&[u8]` and would render the same
        // character as its four UTF-8 bytes, `\u00f0\u009f\u0098\u0080`.
        // Both are correct for their own input type — `&str` here, `&[u8]`
        // there — and the two renderers are meant to differ. Do not
        // "align" them.
        assert_eq!(escape("\u{1f600}"), "\\ud83d\\ude00");
    }
}
