//! A Server-Sent Events decoder for provider streams (the WHATWG
//! event-stream grammar), fed arbitrary byte chunks.
//!
//! A chunk boundary can fall anywhere — inside a field name, inside a UTF-8
//! code point, between the `\r` and `\n` of a line ending — so the decoder
//! keeps its partial line across [`Decoder::push`] calls and only interprets a
//! line once it is complete. Lines may end in `\n`, `\r\n` or a lone `\r`.
//! Comment lines (`:` …) and fields other than `event` and `data` are
//! ignored; several `data:` lines join with `\n`.
//!
//! Memory is bounded: a single line, or a single event's data, larger than
//! [`MAX_EVENT_BYTES`] is an error rather than an allocation. OpenAI's closing
//! events repeat the whole output text, so the bound is generous.

/// The largest event (and line) accepted: 16 MiB.
pub const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;

/// One dispatched event. `Debug` reports the data by length: it is model
/// output, which never reaches a log line.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SseEvent {
    /// The `event:` field; empty when the stream sent none.
    pub event: String,
    /// The `data:` lines, joined with `\n`.
    pub data: String,
}

/// The stream is not a well-formed event stream within the bounds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SseError {
    /// A line or event exceeded [`MAX_EVENT_BYTES`].
    TooLarge,
    /// A field was not UTF-8.
    NotUtf8,
}

impl std::fmt::Debug for SseEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SseEvent")
            .field("event", &self.event)
            .field("data_len", &self.data.len())
            .finish()
    }
}

/// The incremental decoder. `Debug` reports its buffers by length, per the
/// workspace rule against derived byte dumps
/// (`f2z-codec/tests/workspace_debug_scan.rs`).
#[derive(Default)]
pub struct Decoder {
    line: Vec<u8>,
    /// The previous chunk ended in `\r`: a leading `\n` in the next one is
    /// that line ending's second half, not an empty line.
    after_cr: bool,
    event: String,
    data: String,
    has_data: bool,
}

impl std::fmt::Debug for Decoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Decoder")
            .field("line_len", &self.line.len())
            .field("after_cr", &self.after_cr)
            .field("event", &self.event)
            .field("data_len", &self.data.len())
            .field("has_data", &self.has_data)
            .finish()
    }
}

impl Decoder {
    /// A decoder at the start of a stream.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed `chunk`, appending every event it completes to `out`.
    ///
    /// # Errors
    ///
    /// [`SseError`] — the decoder is then unusable for this stream.
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<SseEvent>) -> Result<(), SseError> {
        let mut rest = chunk;
        if self.after_cr {
            self.after_cr = false;
            if let Some((b'\n', tail)) = rest.split_first() {
                rest = tail;
            }
        }
        while let Some(end) = rest.iter().position(|b| *b == b'\n' || *b == b'\r') {
            let (head, tail) = rest.split_at(end);
            if self.line.len().saturating_add(head.len()) > MAX_EVENT_BYTES {
                return Err(SseError::TooLarge);
            }
            self.line.extend_from_slice(head);
            let terminator = tail.first().copied();
            rest = tail.get(1..).unwrap_or_default();
            if terminator == Some(b'\r') {
                match rest.first() {
                    Some(b'\n') => rest = rest.get(1..).unwrap_or_default(),
                    Some(_) => {}
                    None => self.after_cr = true,
                }
            }
            let line = std::mem::take(&mut self.line);
            self.line_done(&line, out)?;
        }
        if self.line.len().saturating_add(rest.len()) > MAX_EVENT_BYTES {
            return Err(SseError::TooLarge);
        }
        self.line.extend_from_slice(rest);
        Ok(())
    }

    fn line_done(&mut self, line: &[u8], out: &mut Vec<SseEvent>) -> Result<(), SseError> {
        if line.is_empty() {
            if self.has_data || !self.event.is_empty() {
                out.push(SseEvent {
                    event: std::mem::take(&mut self.event),
                    data: std::mem::take(&mut self.data),
                });
            }
            self.has_data = false;
            return Ok(());
        }
        if line.first() == Some(&b':') {
            return Ok(());
        }
        let (name, value) = match line.iter().position(|b| *b == b':') {
            Some(colon) => {
                let (name, value) = line.split_at(colon);
                let value = value.get(1..).unwrap_or_default();
                (name, value.strip_prefix(b" ").unwrap_or(value))
            }
            None => (line, &[][..]),
        };
        match name {
            b"event" => {
                self.event = std::str::from_utf8(value)
                    .map_err(|_| SseError::NotUtf8)?
                    .to_owned();
            }
            b"data" => {
                let value = std::str::from_utf8(value).map_err(|_| SseError::NotUtf8)?;
                if self
                    .data
                    .len()
                    .saturating_add(value.len())
                    .saturating_add(1)
                    > MAX_EVENT_BYTES
                {
                    return Err(SseError::TooLarge);
                }
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_in(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut d = Decoder::new();
        let mut out = Vec::new();
        for c in chunks {
            d.push(c, &mut out).unwrap();
        }
        out
    }

    fn ev(event: &str, data: &str) -> SseEvent {
        SseEvent {
            event: event.into(),
            data: data.into(),
        }
    }

    #[test]
    fn named_and_unnamed_events_and_comments() {
        let out = decode_in(&[b"event: a\ndata: {\"x\":1}\n\n: ping\n\ndata: [DONE]\n\n"]);
        assert_eq!(out, vec![ev("a", "{\"x\":1}"), ev("", "[DONE]")]);
    }

    #[test]
    fn every_split_point_decodes_the_same() {
        let stream =
            "event: e\r\ndata: h\u{e9}llo\r\ndata: two\r\n\r\ndata:x\r\rdata: y\n\n".as_bytes();
        let whole = decode_in(&[stream]);
        assert_eq!(
            whole,
            vec![ev("e", "h\u{e9}llo\ntwo"), ev("", "x"), ev("", "y")]
        );
        for i in 0..=stream.len() {
            let (a, b) = stream.split_at(i);
            assert_eq!(decode_in(&[a, b]), whole, "split at {i}");
        }
        let bytes: Vec<&[u8]> = stream.chunks(1).collect();
        assert_eq!(decode_in(&bytes), whole);
    }

    #[test]
    fn an_unterminated_event_is_not_dispatched() {
        assert!(decode_in(&[b"event: a\ndata: {\"x\":"]).is_empty());
    }

    #[test]
    fn an_oversized_line_is_refused_not_buffered() {
        let mut d = Decoder::new();
        let mut out = Vec::new();
        let big = vec![b'a'; MAX_EVENT_BYTES];
        d.push(b"data: ", &mut out).unwrap();
        assert_eq!(d.push(&big, &mut out), Err(SseError::TooLarge));
    }
}
