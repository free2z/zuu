//! An incremental Server-Sent Events reader (WHATWG HTML §9.2.6), just
//! enough of it for `/v1/chat`: `event:` and `data:` fields, comment lines,
//! and any of `\n`, `\r\n` or `\r` as a line ending — so a `\r\n`-framed
//! stream still names its events, and a trailing CR never reaches an event
//! name. `id:` and `retry:` are read and dropped (the gateway has no
//! resumption in v1).

use crate::error::Error;

/// The longest line accepted. A `data:` line is one JSON event; nothing the
/// gateway sends comes close, so a longer line is a broken or hostile peer.
const MAX_LINE: usize = 4 * 1024 * 1024;

/// One dispatched event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Frame {
    pub event: String,
    pub data: String,
}

#[derive(Default)]
pub(crate) struct Parser {
    line: Vec<u8>,
    event: String,
    data: String,
    has_data: bool,
    /// The previous byte was a CR, so an immediately following LF is part
    /// of the same line ending.
    after_cr: bool,
    /// Whether the first line has been seen (a leading BOM is dropped).
    started: bool,
}

impl std::fmt::Debug for Parser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Buffered bytes may be completion text: report their length only.
        f.debug_struct("Parser")
            .field("buffered_line_len", &self.line.len())
            .field("data_len", &self.data.len())
            .finish_non_exhaustive()
    }
}

impl Parser {
    /// Feed bytes; complete events are appended to `out`.
    pub(crate) fn push(&mut self, bytes: &[u8], out: &mut Vec<Frame>) -> Result<(), Error> {
        for &b in bytes {
            if self.after_cr {
                self.after_cr = false;
                if b == b'\n' {
                    continue;
                }
            }
            match b {
                b'\n' => self.end_line(out),
                b'\r' => {
                    self.end_line(out);
                    self.after_cr = true;
                }
                _ => {
                    if self.line.len() >= MAX_LINE {
                        return Err(Error::Protocol("an SSE line exceeds 4 MiB".into()));
                    }
                    self.line.push(b);
                }
            }
        }
        Ok(())
    }

    fn end_line(&mut self, out: &mut Vec<Frame>) {
        let raw = std::mem::take(&mut self.line);
        let mut line = String::from_utf8_lossy(&raw).into_owned();
        if !self.started {
            self.started = true;
            if let Some(rest) = line.strip_prefix('\u{feff}') {
                line = rest.to_owned();
            }
        }
        if line.is_empty() {
            self.dispatch(out);
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line.as_str(), ""),
        };
        match field {
            "event" => value.clone_into(&mut self.event),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            _ => {}
        }
    }

    fn dispatch(&mut self, out: &mut Vec<Frame>) {
        let event = std::mem::take(&mut self.event);
        let data = std::mem::take(&mut self.data);
        if std::mem::take(&mut self.has_data) {
            out.push(Frame { event, data });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_chunks(chunks: &[&[u8]]) -> Vec<Frame> {
        let mut p = Parser::default();
        let mut out = Vec::new();
        for c in chunks {
            p.push(c, &mut out).unwrap();
        }
        out
    }

    fn frame(event: &str, data: &str) -> Frame {
        Frame {
            event: event.into(),
            data: data.into(),
        }
    }

    #[test]
    fn lf_crlf_and_cr_line_endings_all_frame() {
        let lf = parse_chunks(&[b"event: meta\ndata: {}\n\n"]);
        let crlf = parse_chunks(&[b"event: meta\r\ndata: {}\r\n\r\n"]);
        let cr = parse_chunks(&[b"event: meta\rdata: {}\r\r"]);
        assert_eq!(lf, vec![frame("meta", "{}")]);
        assert_eq!(crlf, lf);
        assert_eq!(cr, lf);
    }

    #[test]
    fn a_crlf_split_across_chunks_is_one_line_ending() {
        let out = parse_chunks(&[
            b"event: delta\r",
            b"\ndata: {\"text\":\"a\"}\r",
            b"\n\r",
            b"\n",
        ]);
        assert_eq!(out, vec![frame("delta", "{\"text\":\"a\"}")]);
    }

    #[test]
    fn comments_ids_and_bom_are_dropped_and_multi_data_joins() {
        let out = parse_chunks(&[
            "\u{feff}: ping\n\nid: 1\nevent: x\ndata: a\ndata: b\n\n".as_bytes(),
            b"data:c\n\n",
        ]);
        assert_eq!(out, vec![frame("x", "a\nb"), frame("", "c")]);
    }

    #[test]
    fn an_unterminated_event_is_not_dispatched() {
        assert!(parse_chunks(&[b"event: done\ndata: {}\n"]).is_empty());
    }

    #[test]
    fn utf8_split_across_chunks_survives() {
        let bytes = "event: delta\ndata: {\"text\":\"é\"}\n\n".as_bytes();
        let (a, b) = bytes.split_at(29); // inside the two bytes of é
        assert_eq!(
            parse_chunks(&[a, b]),
            vec![frame("delta", "{\"text\":\"é\"}")]
        );
    }
}
