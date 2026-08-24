//! The source walk shared by this crate's workspace-wide source scans.
//!
//! # Why this is a module and not a copy in each scan
//!
//! `workspace_debug_scan.rs` exists because #572's `Debug` scan resolved its
//! root from `CARGO_MANIFEST_DIR` and so covered one crate. The fix was a walk
//! over every crate under `rs/crates/` plus a **coverage anchor** asserting
//! every crate was reached. When #603 asked for a second workspace-wide scan,
//! the obvious move was to copy that walk — which is the thing
//! `workspace_debug_scan.rs`'s own module note rejects in a different guise:
//! "*n* copies of a scanner drift, and the copy that matters is the one in the
//! crate whose author did not know to add it".
//!
//! Two copies of the enumeration is exactly that failure at file scale: the
//! anchor's promise is that *the list of crates cannot silently narrow*, and
//! two lists can narrow independently. So there is one list, here, and both
//! scans assert against it.
//!
//! Cargo does not build `tests/common/mod.rs` as its own test target — only
//! top-level files in `tests/` become targets — so this is a plain module each
//! scan declares with `mod common;`.

// Each scan uses a different subset of these helpers, and every integration
// test is its own crate, so what one does not call is dead code there.
#![allow(dead_code)]
// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's parser is a remote denial of
// service; neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

/// One `.rs` file under some workspace crate's `src/`.
pub struct SourceFile {
    /// The crate directory name under `rs/crates/`.
    pub krate: String,
    /// `<crate>/<path within the crate>`, e.g. `f2z-relay-proto/src/key.rs`.
    /// This is what a violation names, so it is the path a reader can open.
    pub label: String,
    /// The file's contents.
    pub source: String,
}

/// `rs/crates/`, resolved from this crate's manifest rather than from the
/// process CWD so the tests do not depend on where cargo was invoked.
pub fn crates_root() -> std::path::PathBuf {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest.parent().unwrap().to_path_buf();
    assert!(
        root.join("f2z-codec").join("Cargo.toml").is_file(),
        "{root:?} is not rs/crates/; this test's idea of the workspace layout is stale"
    );
    root
}

/// Every crate directory under `rs/crates/`, by name.
///
/// This is the list the scans must cover, and it is read off the filesystem
/// rather than written down here — a crate added tomorrow appears in it
/// without anyone editing this file, which is the whole point. `rs/Cargo.toml`
/// declares `members = ["crates/*"]`, so the glob and this walk agree by
/// construction.
pub fn workspace_crates() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(crates_root())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.join("Cargo.toml").is_file())
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert!(
        names.len() >= 2,
        "found {} crate(s) under rs/crates/, which is too few to be real: {names:?}",
        names.len()
    );
    names
}

/// Every `.rs` file under every workspace crate's `src/`, labelled
/// `<crate>/<path>` so a violation names the crate it is in.
pub fn source_files() -> Vec<SourceFile> {
    fn walk(
        krate: &str,
        crate_dir: &std::path::Path,
        dir: &std::path::Path,
        out: &mut Vec<SourceFile>,
    ) {
        let read = std::fs::read_dir(dir);
        assert!(read.is_ok(), "could not read {dir:?}");
        let entries = read.unwrap();
        let mut paths: Vec<std::path::PathBuf> =
            entries.map(|entry| entry.unwrap().path()).collect();
        // `read_dir` order is filesystem order. Sorting makes a failure list
        // reproducible between a developer's machine and CI.
        paths.sort();
        for path in paths {
            if path.is_dir() {
                walk(krate, crate_dir, &path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let within = path.strip_prefix(crate_dir).unwrap();
                out.push(SourceFile {
                    krate: krate.to_owned(),
                    label: format!("{krate}/{}", within.to_string_lossy().replace('\\', "/")),
                    source: std::fs::read_to_string(&path).unwrap(),
                });
            }
        }
    }
    let root = crates_root();
    let mut out = Vec::new();
    for krate in workspace_crates() {
        let crate_dir = root.join(&krate);
        let src = crate_dir.join("src");
        assert!(
            src.is_dir(),
            "{krate} has a Cargo.toml but no src/, so the scan cannot see it"
        );
        walk(&krate, &crate_dir, &src, &mut out);
    }
    assert!(!out.is_empty(), "found no source files to scan");
    out
}

/// Strip a line comment, so a brace inside a doc comment does not confuse the
/// depth count. Struct bodies contain no string literals, so a naive cut is
/// safe there and a real parser is not worth the dependency; function bodies
/// do, which is what [`code_lines`] is for.
pub fn without_comment(line: &str) -> &str {
    match line.find("//") {
        Some(index) => &line[..index],
        None => line,
    }
}

/// Source projected to code-only physical lines.
///
/// Strings, character literals, line comments, and nested block comments are
/// replaced while newlines are retained. Keeping the physical line count is
/// what lets a source scan report the real line that violated its rule. A
/// malformed unterminated string or block comment is a refusal, not permission
/// to scan a projection whose state is unknown.
pub fn code_lines(source: &str) -> Vec<String> {
    fn raw_string_start(chars: &[char], at: usize) -> Option<(usize, usize)> {
        let mut cursor = at;
        if matches!(chars.get(cursor), Some('b' | 'c')) {
            cursor += 1;
        }
        if chars.get(cursor) != Some(&'r') {
            return None;
        }
        cursor += 1;
        let hashes = chars[cursor..]
            .iter()
            .take_while(|byte| **byte == '#')
            .count();
        cursor += hashes;
        (chars.get(cursor) == Some(&'"')).then_some((cursor, hashes))
    }

    let bytes: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut index = 0usize;
    while index < bytes.len() {
        let current = bytes[index];
        if let Some((quote, hashes)) = raw_string_start(&bytes, index) {
            for _ in index..=quote {
                out.push(' ');
            }
            index = quote + 1;
            let mut closed = false;
            while index < bytes.len() {
                if bytes[index] == '"'
                    && bytes
                        .get(index + 1..index + 1 + hashes)
                        .is_some_and(|suffix| suffix.iter().all(|byte| *byte == '#'))
                {
                    out.push(' ');
                    for _ in 0..hashes {
                        out.push(' ');
                    }
                    index += 1 + hashes;
                    closed = true;
                    break;
                }
                out.push(if bytes[index] == '\n' { '\n' } else { ' ' });
                index += 1;
            }
            assert!(
                closed,
                "unterminated raw string literal: refusing to scan an incomplete Rust projection"
            );
            continue;
        }
        if current == '/' && bytes.get(index + 1) == Some(&'/') {
            while index < bytes.len() && bytes[index] != '\n' {
                out.push(' ');
                index += 1;
            }
            continue;
        }
        if current == '/' && bytes.get(index + 1) == Some(&'*') {
            out.push(' ');
            out.push(' ');
            index += 2;
            let mut depth = 1usize;
            while index < bytes.len() && depth > 0 {
                if bytes[index] == '/' && bytes.get(index + 1) == Some(&'*') {
                    out.push(' ');
                    out.push(' ');
                    index += 2;
                    depth += 1;
                } else if bytes[index] == '*' && bytes.get(index + 1) == Some(&'/') {
                    out.push(' ');
                    out.push(' ');
                    index += 2;
                    depth -= 1;
                } else {
                    out.push(if bytes[index] == '\n' { '\n' } else { ' ' });
                    index += 1;
                }
            }
            assert_eq!(
                depth, 0,
                "unterminated block comment: refusing to scan an incomplete Rust projection"
            );
            continue;
        }
        if current == '"' {
            out.push('_');
            index += 1;
            let mut closed = false;
            while index < bytes.len() {
                if bytes[index] == '\\' {
                    out.push(' ');
                    if bytes.get(index + 1) == Some(&'\n') {
                        out.push('\n');
                    } else {
                        out.push(' ');
                    }
                    index += 2;
                    continue;
                }
                if bytes[index] == '"' {
                    out.push(' ');
                    index += 1;
                    closed = true;
                    break;
                }
                out.push(if bytes[index] == '\n' { '\n' } else { ' ' });
                index += 1;
            }
            assert!(
                closed,
                "unterminated string literal: refusing to scan an incomplete Rust projection"
            );
            continue;
        }
        // A character literal, distinguished from a lifetime by the closing
        // quote after exactly one scalar value or one Rust escape.
        if current == '\'' {
            let content = index + 1;
            let closing = if bytes.get(content) == Some(&'\\') {
                match bytes.get(content + 1) {
                    Some('x') => content + 4,
                    Some('u') if bytes.get(content + 2) == Some(&'{') => bytes[content + 3..]
                        .iter()
                        .position(|byte| *byte == '}')
                        .map_or(bytes.len(), |offset| content + 4 + offset),
                    Some(_) => content + 2,
                    None => bytes.len(),
                }
            } else {
                content + 1
            };
            if bytes.get(closing) == Some(&'\'') {
                out.push('_');
                for _ in index + 1..=closing {
                    out.push(' ');
                }
                index = closing + 1;
                continue;
            }
        }
        out.push(current);
        index += 1;
    }
    out.lines().map(str::to_owned).collect()
}

/// True when `haystack` contains `needle` as a whole identifier — not as part
/// of a longer one. `CommandVerifier` does not contain the identifier
/// `Verifier`, and `verify_strict` does not contain `verify`.
pub fn contains_identifier(haystack: &str, needle: &str) -> bool {
    identifier_positions(haystack, needle).next().is_some()
}

/// Byte offsets at which `needle` appears in `haystack` as a whole identifier.
pub fn identifier_positions<'a>(
    haystack: &'a str,
    needle: &'a str,
) -> impl Iterator<Item = usize> + 'a {
    haystack.match_indices(needle).filter_map(move |(at, _)| {
        let before_ok = haystack[..at]
            .chars()
            .next_back()
            .is_none_or(|c| !is_identifier_char(c));
        let after = at + needle.len();
        let after_ok = haystack[after..]
            .chars()
            .next()
            .is_none_or(|c| !is_identifier_char(c));
        (before_ok && after_ok).then_some(at)
    })
}

/// Whether `c` can appear inside a Rust identifier.
pub fn is_identifier_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The half-open line ranges covered by `#[cfg(test)]` items.
///
/// Used to hold the registered exemptions in the strict-verification scan to
/// test code: a deliberate non-strict call is a fixture proving what plain
/// verification accepts, and a fixture lives under `#[cfg(test)]`. An
/// exemption that drifted into a shipped code path would stop matching this
/// and the scan would refuse it.
pub fn cfg_test_ranges(source: &str) -> Vec<(usize, usize)> {
    let lines = code_lines(source);
    let mut ranges = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        if !lines[index].contains("#[cfg(test)]") {
            index += 1;
            continue;
        }
        let start = index;
        // Walk forward to the item's opening brace, then to its match.
        let mut depth = 0i32;
        let mut opened = false;
        let mut cursor = index;
        while cursor < lines.len() {
            let line = &lines[cursor];
            depth += i32::try_from(line.matches('{').count()).unwrap();
            depth -= i32::try_from(line.matches('}').count()).unwrap();
            if line.contains('{') {
                opened = true;
            }
            cursor += 1;
            if opened && depth <= 0 {
                break;
            }
        }
        if opened {
            ranges.push((start, cursor));
        }
        index = cursor.max(start + 1);
    }
    ranges
}

/// Whether `line` (a zero-based line index) sits inside a `#[cfg(test)]` item.
pub fn in_cfg_test(ranges: &[(usize, usize)], line: usize) -> bool {
    ranges
        .iter()
        .any(|(start, end)| line >= *start && line < *end)
}

#[cfg(test)]
mod tests {
    use super::code_lines;

    #[test]
    fn code_projection_strips_nested_block_comments_without_moving_lines() {
        let source = "fn verify() {\n  let _ = r#\"not code \" verify_strict /*\"#;\n  let _ = \"not code \\\" verify_strict }\";\n  let _ = '\\u{7d}';\n  // verify_strict\n  /* outer\n     /* inner */ verify_strict\n  */\n  Ok(())\n}";
        let lines = code_lines(source);
        let joined = lines.join("\n");
        assert_eq!(lines.len(), source.lines().count());
        assert!(joined.contains("fn verify()"));
        assert!(joined.contains("Ok(())"));
        assert!(
            !joined.contains("verify_strict"),
            "a comment or literal cannot satisfy a source-code contract"
        );
        assert_eq!(
            joined.matches('}').count(),
            1,
            "a brace inside a string or character literal moved function depth"
        );
    }

    #[test]
    #[should_panic(
        expected = "unterminated block comment: refusing to scan an incomplete Rust projection"
    )]
    fn code_projection_refuses_an_unterminated_block_comment() {
        let _ = code_lines("fn verify() { /* verify_strict");
    }

    #[test]
    #[should_panic(
        expected = "unterminated string literal: refusing to scan an incomplete Rust projection"
    )]
    fn code_projection_refuses_an_unterminated_string() {
        let _ = code_lines("fn verify() { let claim = \"verify_strict");
    }

    #[test]
    #[should_panic(
        expected = "unterminated raw string literal: refusing to scan an incomplete Rust projection"
    )]
    fn code_projection_refuses_an_unterminated_raw_string() {
        let _ = code_lines("fn verify() { let claim = r#\"verify_strict");
    }
}
