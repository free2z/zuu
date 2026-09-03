//! Small, fail-closed Markdown structure reader for normative documentation tests.
//!
//! This deliberately recognizes only the CommonMark constructs that can turn
//! source-looking prose into non-rendered/example content. A malformed or
//! unclosed construct returns `None`; callers must treat that as a failed
//! contract rather than guessing how a renderer will recover.

#![allow(dead_code, clippy::arithmetic_side_effects, clippy::indexing_slicing)]

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Heading {
    pub line: usize,
    pub level: usize,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct RenderedMarkdown {
    lines: Vec<Option<String>>,
    headings: Vec<Heading>,
    raw_html_lines: Vec<bool>,
    has_raw_html: bool,
}

#[derive(Clone, Copy, Debug)]
struct Fence {
    marker: char,
    length: usize,
}

const RAW_HTML_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "caption",
    "center",
    "code",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "html",
    "iframe",
    "legend",
    "li",
    "main",
    "menu",
    "nav",
    "noframes",
    "noscript",
    "object",
    "ol",
    "optgroup",
    "option",
    "p",
    "pre",
    "script",
    "search",
    "section",
    "span",
    "style",
    "summary",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "ul",
];

const VOID_HTML_TAGS: &[&str] = &[
    "area", "base", "basefont", "br", "col", "embed", "frame", "hr", "img", "input", "link",
    "menuitem", "meta", "param", "source", "track", "wbr",
];

fn fence_candidate(line: &str) -> Option<(char, usize, &str)> {
    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
    if spaces > 3 {
        return None;
    }
    let rest = line.get(spaces..)?;
    let marker = rest.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let length = rest
        .chars()
        .take_while(|character| *character == marker)
        .count();
    (length >= 3).then(|| (marker, length, &rest[length..]))
}

fn update_fence(fence: Option<Fence>, line: &str) -> (Option<Fence>, bool) {
    let Some((marker, length, trailing)) = fence_candidate(line) else {
        return (fence, fence.is_some());
    };
    match fence {
        None if marker == '`' && trailing.contains('`') => (None, false),
        None => (Some(Fence { marker, length }), true),
        Some(open)
            if marker == open.marker
                && length >= open.length
                && trailing
                    .chars()
                    .all(|character| matches!(character, ' ' | '\t')) =>
        {
            (None, true)
        }
        Some(open) => (Some(open), true),
    }
}

fn strip_comments(line: &str, in_comment: &mut bool) -> String {
    let mut remainder = line;
    let mut visible = String::new();
    loop {
        if *in_comment {
            let Some(end) = remainder.find("-->") else {
                return visible;
            };
            *in_comment = false;
            remainder = &remainder[end + 3..];
            continue;
        }
        let Some(start) = remainder.find("<!--") else {
            visible.push_str(remainder);
            return visible;
        };
        visible.push_str(&remainder[..start]);
        *in_comment = true;
        remainder = &remainder[start + 4..];
    }
}

fn opening_tag_tail(tail: &str) -> Option<bool> {
    let bytes = tail.as_bytes();
    let mut cursor = 0;
    loop {
        let before_whitespace = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor = cursor.saturating_add(1);
        }
        let had_whitespace = cursor > before_whitespace;
        let Some(byte) = bytes.get(cursor).copied() else {
            return Some(false);
        };
        if byte == b'/' {
            return (cursor.saturating_add(1) == bytes.len()).then_some(true);
        }
        // Every attribute must be separated from the tag name or prior
        // attribute. A terminal slash is the sole exception above.
        if !had_whitespace || !(byte.is_ascii_alphabetic() || matches!(byte, b'_' | b':')) {
            return None;
        }
        cursor = cursor.saturating_add(1);
        while bytes.get(cursor).is_some_and(|candidate| {
            candidate.is_ascii_alphanumeric() || matches!(candidate, b'_' | b'.' | b':' | b'-')
        }) {
            cursor = cursor.saturating_add(1);
        }
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor = cursor.saturating_add(1);
        }
        if bytes.get(cursor) != Some(&b'=') {
            continue;
        }
        cursor = cursor.saturating_add(1);
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor = cursor.saturating_add(1);
        }
        match bytes.get(cursor).copied()? {
            quote @ (b'\'' | b'"') => {
                cursor = cursor.saturating_add(1);
                while bytes.get(cursor).copied() != Some(quote) {
                    bytes.get(cursor)?;
                    cursor = cursor.saturating_add(1);
                }
                cursor = cursor.saturating_add(1);
            }
            _ => {
                let value_start = cursor;
                while bytes.get(cursor).is_some_and(|candidate| {
                    !candidate.is_ascii_whitespace()
                        && !matches!(candidate, b'"' | b'\'' | b'=' | b'<' | b'>' | b'`')
                }) {
                    cursor = cursor.saturating_add(1);
                }
                if cursor == value_start {
                    return None;
                }
            }
        }
    }
}

fn raw_html_tags(line: &str) -> Option<Vec<(bool, bool, String)>> {
    let mut tags = Vec::new();
    let bytes = line.as_bytes();
    let mut cursor = 0;
    while let Some(relative) = line[cursor..].find('<') {
        let start = cursor + relative;
        let mut position = start.saturating_add(1);
        let closing = bytes.get(position) == Some(&b'/');
        if closing {
            position = position.saturating_add(1);
        }

        // HTML tag names begin immediately after `<` or `</`. In particular,
        // `</ details>` is text, not a closing tag.
        if !bytes.get(position).is_some_and(u8::is_ascii_alphabetic) {
            cursor = start.saturating_add(1);
            continue;
        }
        let name_start = position;
        while bytes
            .get(position)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            position = position.saturating_add(1);
        }
        let name_end = position;
        let name = line[name_start..name_end].to_ascii_lowercase();
        let recognized =
            RAW_HTML_TAGS.contains(&name.as_str()) || VOID_HTML_TAGS.contains(&name.as_str());
        if !bytes
            .get(position)
            .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'/' || *byte == b'>')
        {
            if recognized {
                return None;
            }
            cursor = start.saturating_add(1);
            continue;
        }

        // Attribute values may contain `>` or `/>`; only an unquoted `>`
        // terminates the tag. HTML does not use backslash escapes for quotes.
        let mut quote = None;
        let mut end = None;
        while let Some(byte) = bytes.get(position).copied() {
            match (quote, byte) {
                (Some(open), candidate) if candidate == open => quote = None,
                (None, b'\'' | b'"') => quote = Some(byte),
                (None, b'>') => {
                    end = Some(position);
                    break;
                }
                _ => {}
            }
            position = position.saturating_add(1);
        }
        let Some(end) = end else {
            return (!recognized).then_some(tags);
        };

        let trailing = &line[name_end..end];
        let valid = if closing {
            trailing
                .bytes()
                .all(|byte| byte.is_ascii_whitespace())
                .then_some(false)
        } else {
            opening_tag_tail(trailing)
        };
        if recognized {
            let _syntactically_self_closing = valid?;
            // HTML browsers ignore the self-closing flag on non-void elements:
            // `<details />` still opens a container. Treating that spelling as
            // balanced would let it hide all following normative prose.
            let self_closing = VOID_HTML_TAGS.contains(&name.as_str());
            tags.push((closing, self_closing, name));
        }
        cursor = end.saturating_add(1);
        if cursor >= bytes.len() {
            break;
        }
    }
    Some(tags)
}

fn update_html_stack(stack: &mut Vec<String>, tags: &[(bool, bool, String)]) {
    for (closing, self_closing, name) in tags {
        if *closing {
            if let Some(position) = stack.iter().rposition(|open| open == name) {
                stack.truncate(position);
            }
        } else if !self_closing {
            stack.push(name.clone());
        }
    }
}

fn atx_heading(line: &str) -> Option<(usize, String)> {
    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
    if spaces > 3 {
        return None;
    }
    let rest = line.get(spaces..)?;
    let level = rest.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let after = rest.get(level..)?;
    if !after.is_empty() && !after.starts_with([' ', '\t']) {
        return None;
    }
    let mut text = after.trim().to_owned();
    if let Some(without_closer) = text.strip_suffix('#') {
        let trimmed = without_closer.trim_end_matches('#').trim_end();
        if trimmed.len() < without_closer.len() {
            text = trimmed.to_owned();
        }
    }
    Some((level, text))
}

fn setext_level(line: &str) -> Option<usize> {
    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
    if spaces > 3 {
        return None;
    }
    let rest = line.get(spaces..)?.trim_end_matches([' ', '\t']);
    if !rest.is_empty() && rest.bytes().all(|byte| byte == b'=') {
        Some(1)
    } else if !rest.is_empty() && rest.bytes().all(|byte| byte == b'-') {
        Some(2)
    } else {
        None
    }
}

fn starts_list_item(line: &str) -> bool {
    let trimmed = line.trim_start_matches([' ', '\t']);
    if trimmed
        .strip_prefix(['-', '+', '*'])
        .is_some_and(|rest| rest.starts_with([' ', '\t']))
    {
        return true;
    }
    let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
    (1..=9).contains(&digits)
        && trimmed
            .get(digits..)
            .and_then(|rest| rest.strip_prefix(['.', ')']))
            .is_some_and(|rest| rest.starts_with([' ', '\t']))
}

fn normalize(lines: impl IntoIterator<Item = String>) -> String {
    let mut normalized = Vec::new();
    let mut previous_blank = true;
    for line in lines {
        let line = line.trim_end().to_owned();
        let blank = line.trim().is_empty();
        if !blank || !previous_blank {
            normalized.push(line);
        }
        previous_blank = blank;
    }
    while normalized.last().is_some_and(|line| line.is_empty()) {
        normalized.pop();
    }
    normalized.join("\n")
}

impl RenderedMarkdown {
    pub fn parse(source: &str) -> Option<Self> {
        let mut lines = Vec::new();
        let mut raw_html_lines = Vec::new();
        let mut fence = None;
        let mut in_comment = false;
        let mut special_raw_end: Option<&str> = None;
        let mut html_stack = Vec::new();
        let mut has_raw_html = false;
        let mut in_indented_code = false;
        let mut paragraph_open = false;
        let mut lazy_blockquote_paragraph = false;

        'lines: for raw_line in source.lines() {
            if let Some(end) = special_raw_end {
                if raw_line.contains(end) {
                    special_raw_end = None;
                }
                lines.push(None);
                raw_html_lines.push(true);
                paragraph_open = false;
                lazy_blockquote_paragraph = false;
                continue;
            }

            // CommonMark's raw comment block consumes both its opening line
            // and the line containing its closing delimiter. Text after the
            // delimiter on either line does not become a structural heading.
            let raw_comment_line = in_comment || raw_line.contains("<!--");
            let comment_block_line = in_comment || raw_line.trim_start().starts_with("<!--");
            has_raw_html |= raw_line.contains("<!--");
            let line = strip_comments(raw_line, &mut in_comment);
            if comment_block_line {
                lines.push(None);
                raw_html_lines.push(true);
                paragraph_open = false;
                lazy_blockquote_paragraph = false;
                continue;
            }

            let (next_fence, is_fence_content) = update_fence(fence, &line);
            fence = next_fence;
            if is_fence_content {
                lines.push(None);
                raw_html_lines.push(raw_comment_line);
                in_indented_code = false;
                paragraph_open = false;
                lazy_blockquote_paragraph = false;
                continue;
            }

            let trimmed = line.trim_start();
            for (opening, closing) in [("<?", "?>"), ("<![CDATA[", "]]>")] {
                if trimmed.starts_with(opening) {
                    has_raw_html = true;
                    if !trimmed.contains(closing) {
                        special_raw_end = Some(closing);
                    }
                    lines.push(None);
                    raw_html_lines.push(true);
                    paragraph_open = false;
                    lazy_blockquote_paragraph = false;
                    continue 'lines;
                }
            }
            if trimmed.starts_with("<!")
                && !trimmed.starts_with("<!--")
                && !trimmed.starts_with("<![CDATA[")
            {
                has_raw_html = true;
                if !trimmed.contains('>') {
                    special_raw_end = Some(">");
                }
                lines.push(None);
                raw_html_lines.push(true);
                paragraph_open = false;
                lazy_blockquote_paragraph = false;
                continue 'lines;
            }

            let tags = raw_html_tags(&line)?;
            has_raw_html |= !tags.is_empty();
            let hidden_by_html = !html_stack.is_empty() || !tags.is_empty();
            update_html_stack(&mut html_stack, &tags);
            if hidden_by_html {
                lines.push(None);
                raw_html_lines.push(true);
                paragraph_open = false;
                lazy_blockquote_paragraph = false;
                continue;
            }

            if line.trim().is_empty() {
                if in_indented_code {
                    lines.push(None);
                } else {
                    lines.push(Some(line));
                }
                raw_html_lines.push(raw_comment_line);
                paragraph_open = false;
                lazy_blockquote_paragraph = false;
                continue;
            }

            let leading_spaces = line.bytes().take_while(|byte| *byte == b' ').count();
            let content = line.get(leading_spaces..)?;
            let quoted = content.strip_prefix('>');
            if lazy_blockquote_paragraph
                && quoted.is_none()
                && atx_heading(&line).is_none()
                && setext_level(&line).is_none()
                && fence_candidate(&line).is_none()
                && !starts_list_item(&line)
            {
                // A block quote marker may be omitted on paragraph
                // continuation lines. They remain quoted/example content even
                // though the source line no longer begins with `>`.
                lines.push(None);
                raw_html_lines.push(raw_comment_line);
                paragraph_open = false;
                continue;
            }

            let indented = line.starts_with('\t') || leading_spaces >= 4;
            if indented {
                // CommonMark indented code cannot interrupt a paragraph. Four
                // spaces after an ordinary prose line are therefore a visible
                // lazy/paragraph continuation; only a block-context indent
                // starts (or continues) indented code.
                if in_indented_code || !paragraph_open {
                    lines.push(None);
                    in_indented_code = true;
                    paragraph_open = false;
                } else {
                    lines.push(Some(line));
                    in_indented_code = false;
                    paragraph_open = true;
                }
                raw_html_lines.push(raw_comment_line);
                continue;
            }

            in_indented_code = false;
            if let Some(quoted) = quoted {
                lines.push(None);
                raw_html_lines.push(raw_comment_line);
                paragraph_open = false;
                let quoted = quoted.strip_prefix([' ', '\t']).unwrap_or(quoted);
                lazy_blockquote_paragraph = !quoted.is_empty()
                    && atx_heading(quoted).is_none()
                    && setext_level(quoted).is_none()
                    && fence_candidate(quoted).is_none()
                    && !starts_list_item(quoted);
                continue;
            }
            lazy_blockquote_paragraph = false;
            paragraph_open = atx_heading(&line).is_none() && setext_level(&line).is_none();
            lines.push(Some(line));
            raw_html_lines.push(raw_comment_line);
        }

        if fence.is_some() || in_comment || special_raw_end.is_some() || !html_stack.is_empty() {
            return None;
        }

        let mut headings = Vec::new();
        for (line_number, line) in lines.iter().enumerate() {
            let Some(line) = line else { continue };
            if let Some((level, text)) = atx_heading(line) {
                headings.push(Heading {
                    line: line_number,
                    level,
                    text,
                });
                continue;
            }
            if let Some(level) = setext_level(line)
                && line_number > 0
                && let Some(Some(previous)) = lines.get(line_number - 1)
                && !previous.trim().is_empty()
            {
                headings.push(Heading {
                    line: line_number - 1,
                    level,
                    text: previous.trim().to_owned(),
                });
            }
        }

        Some(Self {
            lines,
            headings,
            raw_html_lines,
            has_raw_html,
        })
    }

    pub fn section(&self, level: usize, text: &str) -> Option<String> {
        let matches = self
            .headings
            .iter()
            .filter(|heading| heading.level == level && heading.text == text)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return None;
        }
        let start = matches[0].line;
        let end = self
            .headings
            .iter()
            .find(|heading| heading.line > start && heading.level <= level)
            .map_or(self.lines.len(), |heading| heading.line);
        Some(normalize(
            self.lines[start + 1..end].iter().filter_map(Clone::clone),
        ))
    }

    pub const fn has_raw_html(&self) -> bool {
        self.has_raw_html
    }

    /// Whether a uniquely named rendered section contains raw HTML syntax.
    ///
    /// A protected normative section can use this to fail closed without
    /// rejecting reviewed claim-marker comments elsewhere in the document.
    pub fn section_has_raw_html(&self, level: usize, text: &str) -> Option<bool> {
        let matches = self
            .headings
            .iter()
            .filter(|heading| heading.level == level && heading.text == text)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return None;
        }
        let start = matches[0].line;
        let end = self
            .headings
            .iter()
            .find(|heading| heading.line > start && heading.level <= level)
            .map_or(self.lines.len(), |heading| heading.line);
        Some(self.raw_html_lines[start..end].iter().any(|raw| *raw))
    }

    pub fn child_headings(
        &self,
        level: usize,
        text: &str,
        child_level: usize,
    ) -> Option<Vec<String>> {
        let parent = self
            .headings
            .iter()
            .filter(|heading| heading.level == level && heading.text == text)
            .collect::<Vec<_>>();
        if parent.len() != 1 {
            return None;
        }
        let start = parent[0].line;
        let end = self
            .headings
            .iter()
            .find(|heading| heading.line > start && heading.level <= level)
            .map_or(self.lines.len(), |heading| heading.line);
        Some(
            self.headings
                .iter()
                .filter(|heading| {
                    heading.line > start && heading.line < end && heading.level == child_level
                })
                .map(|heading| heading.text.clone())
                .collect(),
        )
    }

    pub fn paragraphs(&self) -> Vec<String> {
        normalize(self.lines.iter().filter_map(Clone::clone))
            .split("\n\n")
            .map(str::trim)
            .filter(|paragraph| !paragraph.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

pub fn stable_digest(texts: impl IntoIterator<Item = String>) -> u64 {
    // A deterministic change detector, not a cryptographic commitment. The
    // reviewed expected value lives beside each exact prose contract.
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for text in texts {
        for byte in text.bytes().chain(core::iter::once(0xff)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::RenderedMarkdown;

    #[test]
    fn four_space_indent_cannot_interrupt_a_paragraph() {
        let rendered = RenderedMarkdown::parse(
            "#### Policy\nRequired text.\n    Visible contradictory continuation.\n#### Next",
        )
        .expect("ordinary paragraph continuation parses");

        assert_eq!(
            rendered.section(4, "Policy").as_deref(),
            Some("Required text.\n    Visible contradictory continuation.")
        );
    }

    #[test]
    fn a_blank_line_allows_indented_code_to_start_and_continue() {
        let rendered = RenderedMarkdown::parse(
            "#### Policy\nRequired text.\n\n    example one\n\n    example two\n#### Next",
        )
        .expect("an indented code block may end at EOF or a non-indented line");

        assert_eq!(
            rendered.section(4, "Policy").as_deref(),
            Some("Required text.")
        );
    }

    #[test]
    fn an_unmarked_blockquote_paragraph_continuation_stays_quoted() {
        let rendered = RenderedMarkdown::parse(
            "> quoted example\nunmarked continuation\n    four-space continuation\n#### Visible",
        )
        .expect("a lazy blockquote continuation parses");

        assert_eq!(rendered.paragraphs(), vec!["#### Visible"]);
        assert!(rendered.section(4, "Visible").is_some());
    }

    #[test]
    fn raw_html_is_scoped_to_the_section_that_contains_it() {
        let rendered = RenderedMarkdown::parse(
            "<!-- reviewed marker -->\n### Protected\n<span>visible policy</span>\n### Ordinary\nkept",
        )
        .expect("balanced raw HTML parses");

        assert_eq!(rendered.section_has_raw_html(3, "Protected"), Some(true));
        assert_eq!(rendered.section_has_raw_html(3, "Ordinary"), Some(false));
        assert!(rendered.has_raw_html());
    }

    #[test]
    fn raw_html_attributes_may_contain_greater_than_characters() {
        let rendered = RenderedMarkdown::parse(
            "<details title=\"an ordinary a > b label\">\n#### Hidden\n</details>\n#### Visible\nkept",
        )
        .expect("a quoted attribute must not leave the raw HTML stack open");

        assert!(rendered.section(4, "Hidden").is_none());
        assert_eq!(rendered.section(4, "Visible").as_deref(), Some("kept"));
    }

    #[test]
    fn commonmark_hgroup_container_cannot_hide_a_heading() {
        let rendered =
            RenderedMarkdown::parse("<hgroup>\n#### Hidden\n</hgroup>\n#### Visible\nkept")
                .expect("a balanced CommonMark hgroup raw block parses");

        assert!(rendered.section(4, "Hidden").is_none());
        assert_eq!(rendered.section(4, "Visible").as_deref(), Some("kept"));
        assert!(rendered.has_raw_html());
    }

    #[test]
    fn quoted_self_close_token_does_not_self_close_a_container() {
        let rendered = RenderedMarkdown::parse(
            "<details title=\"/>\">\n#### Hidden\n</details>\n#### Visible\nkept",
        )
        .expect("the real closing tag must balance the container");

        assert!(rendered.section(4, "Hidden").is_none());
        assert_eq!(rendered.section(4, "Visible").as_deref(), Some("kept"));
    }

    #[test]
    fn non_void_self_close_syntax_still_opens_an_html_container() {
        assert!(
            RenderedMarkdown::parse("<details />\n#### Still hidden").is_none(),
            "HTML ignores self-close syntax on a non-void container"
        );
    }

    #[test]
    fn whitespace_after_closing_slash_is_not_a_closing_tag() {
        assert!(
            RenderedMarkdown::parse("<details>\n</ details>\n#### Still hidden").is_none(),
            "a malformed spaced close must not pop the raw HTML stack"
        );
    }
}
