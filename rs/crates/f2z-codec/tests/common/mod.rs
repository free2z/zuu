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
/// do, which is what [`code_only`] is for.
pub fn without_comment(line: &str) -> &str {
    match line.find("//") {
        Some(index) => &line[..index],
        None => line,
    }
}

/// A line with its string literals, character literals and line comment
/// removed, so that neither a `{` inside a `format!` nor a `.verify(` inside a
/// doc comment is read as code.
///
/// This is the stricter cousin of [`without_comment`], needed wherever a scan
/// looks at *function* bodies. It is a lexer, not a parser: a raw string with
/// an embedded quote (`r#"..."#`) is not modelled, and a block comment is not
/// modelled. Neither appears in the tree today, and both would make the scan
/// noisier rather than blinder — a `//`-free `/* ... */` mentioning
/// `.verify(` would be reported, and the report names a file and a line for a
/// person to read.
pub fn code_only(line: &str) -> String {
    let bytes: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut index = 0usize;
    while index < bytes.len() {
        let current = bytes[index];
        if current == '/' && bytes.get(index + 1) == Some(&'/') {
            break;
        }
        if current == '"' {
            index += 1;
            while index < bytes.len() {
                if bytes[index] == '\\' {
                    index += 2;
                    continue;
                }
                if bytes[index] == '"' {
                    index += 1;
                    break;
                }
                index += 1;
            }
            // Leave a placeholder so `"a".len()` does not become `.len()`
            // glued to whatever preceded the literal.
            out.push('_');
            continue;
        }
        // A character literal, distinguished from a lifetime by the closing
        // quote: `'a'` and `'\n'` are literals, `'a` in `&'a str` is not.
        if current == '\'' {
            let escaped = bytes.get(index + 1) == Some(&'\\');
            let closing = if escaped { index + 3 } else { index + 2 };
            if bytes.get(closing) == Some(&'\'') {
                out.push('_');
                index = closing + 1;
                continue;
            }
        }
        out.push(current);
        index += 1;
    }
    out
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
    let lines: Vec<String> = source.lines().map(code_only).collect();
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
