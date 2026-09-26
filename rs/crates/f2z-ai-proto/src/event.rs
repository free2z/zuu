//! The SSE event grammar of a streamed `POST /v1/chat`.
//!
//! ```text
//! stream  = meta *(delta / tool_call) [usage] (done / error)
//!         / error                                  ; failed before meta
//! ```
//!
//! Each event is one SSE frame: `event: <name>` naming the variant, and one
//! `data:` line carrying the payload as a single-line JSON object:
//!
//! ```text
//! event: meta
//! data: {"call_id":"c_1","model":"gpt-4.1-mini","hold_2z":3}
//!
//! ```
//!
//! A stream ends with exactly one `done` or `error`. `usage` precedes `done`
//! and is omitted only when the stream ends in `error` before any usage is
//! known. A client that sees an event name it does not know skips it
//! ([`EventError::UnknownEvent`]) — new event kinds are additive.
//!
//! [`Event`] also serializes as a tagged JSON object (`{"type":"meta",…}`),
//! which is the form an SDK forwards over an IPC channel.

use alloc::string::String;

use serde::{Deserialize, Serialize};

use crate::chat::{FinishReason, ToolCall, Usage, UsageSource};
use crate::error::ApiError;

/// Every event name this crate knows, in grammar order.
pub const KNOWN_EVENTS: [&str; 6] = ["meta", "delta", "tool_call", "usage", "done", "error"];

/// One event of a chat stream.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// First event of every successful stream: the hold is placed.
    Meta(Meta),
    /// A chunk of assistant text.
    Delta(Delta),
    /// A complete tool call.
    ToolCall(ToolCall),
    /// Final usage, just before `done`.
    Usage(UsageEvent),
    /// The call is settled. Last event.
    Done(Done),
    /// The call failed. Last event.
    Error(ApiError),
}

/// The `meta` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    /// The call's id; also `GET /v1/calls/{id}`.
    pub call_id: String,
    /// The catalogue model answering.
    pub model: String,
    /// What was held against the balance, in whole 2Z: the worst-case price.
    pub hold_2z: u64,
}

/// The `delta` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delta {
    /// Text to append to the assistant's reply.
    pub text: String,
}

/// The `usage` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageEvent {
    /// What the call used.
    pub usage: Usage,
    /// Where `usage` came from.
    #[serde(default)]
    pub source: UsageSource,
}

/// The `done` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Done {
    /// What was charged, in whole 2Z. At most `meta.hold_2z` unless the
    /// provider over-ran the cap, which the platform writes off.
    pub charged_2z: u64,
    /// The ledger receipt for the charge.
    pub receipt_id: String,
    /// Why generation stopped.
    pub finish_reason: FinishReason,
    /// The balance after the charge, in milli-2Z, if known. A hint only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance_hint_milli_2z: Option<u64>,
}

/// Why an SSE frame could not be turned into an [`Event`].
#[non_exhaustive]
#[derive(Debug)]
pub enum EventError {
    /// The `event:` name is not one this crate knows. Skip the frame.
    UnknownEvent(String),
    /// The `data:` payload is not valid for the named event.
    Payload(serde_json::Error),
}

impl core::fmt::Display for EventError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnknownEvent(name) => write!(f, "unknown SSE event {name:?}"),
            Self::Payload(e) => write!(f, "invalid SSE event payload: {e}"),
        }
    }
}

impl core::error::Error for EventError {}

impl Event {
    /// The SSE `event:` name of this variant.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Meta(_) => "meta",
            Self::Delta(_) => "delta",
            Self::ToolCall(_) => "tool_call",
            Self::Usage(_) => "usage",
            Self::Done(_) => "done",
            Self::Error(_) => "error",
        }
    }

    /// Whether this event ends the stream.
    #[must_use]
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done(_) | Self::Error(_))
    }

    /// The payload as single-line JSON, without the `type` tag.
    ///
    /// # Errors
    ///
    /// Only if serialization fails, which the types here cannot cause.
    pub fn data_json(&self) -> Result<String, serde_json::Error> {
        match self {
            Self::Meta(p) => serde_json::to_string(p),
            Self::Delta(p) => serde_json::to_string(p),
            Self::ToolCall(p) => serde_json::to_string(p),
            Self::Usage(p) => serde_json::to_string(p),
            Self::Done(p) => serde_json::to_string(p),
            Self::Error(p) => serde_json::to_string(p),
        }
    }

    /// The whole SSE frame: `event: <name>\ndata: <json>\n\n`.
    ///
    /// `serde_json` escapes every control character inside strings, so the
    /// JSON never contains a raw newline and one `data:` line always suffices.
    ///
    /// # Errors
    ///
    /// As [`Event::data_json`].
    pub fn to_sse(&self) -> Result<String, serde_json::Error> {
        let data = self.data_json()?;
        let mut frame = String::with_capacity(
            data.len()
                .saturating_add(self.name().len())
                .saturating_add(16),
        );
        frame.push_str("event: ");
        frame.push_str(self.name());
        frame.push_str("\ndata: ");
        frame.push_str(&data);
        frame.push_str("\n\n");
        Ok(frame)
    }

    /// Parse one SSE frame's `event:` name and its (joined) `data:` payload.
    ///
    /// # Framing the caller does
    ///
    /// This crate does no I/O and does not split a byte stream. The caller's
    /// SSE reader (per the WHATWG EventSource rules) splits frames on a blank
    /// line, accepts `\n`, `\r\n` or `\r` line endings, takes the value after
    /// `event:` (one optional leading space removed) as `name`, and joins the
    /// `data:` lines with `\n` as `data`. The gateway always sends exactly one
    /// `data:` line per frame. A frame with no `event:` line is not one of
    /// ours; comment lines (`:`) and `id:`/`retry:` fields are the reader's to
    /// drop. As a guard against a reader that splits on `\n` alone, a
    /// trailing `\r` on `name` is removed here.
    ///
    /// # Errors
    ///
    /// [`EventError::UnknownEvent`] for a name this crate does not know —
    /// skip the frame; [`EventError::Payload`] for a payload that does not
    /// fit the name.
    pub fn from_sse(name: &str, data: &str) -> Result<Self, EventError> {
        let name = name.strip_suffix('\r').unwrap_or(name);
        let parsed = match name {
            "meta" => serde_json::from_str(data).map(Self::Meta),
            "delta" => serde_json::from_str(data).map(Self::Delta),
            "tool_call" => serde_json::from_str(data).map(Self::ToolCall),
            "usage" => serde_json::from_str(data).map(Self::Usage),
            "done" => serde_json::from_str(data).map(Self::Done),
            "error" => serde_json::from_str(data).map(Self::Error),
            other => return Err(EventError::UnknownEvent(other.into())),
        };
        parsed.map_err(EventError::Payload)
    }

    /// Parse the tagged IPC form (`{"type":"meta",…}`).
    ///
    /// Prefer this to deserializing [`Event`] directly: a `type` this crate
    /// does not know comes back as the skippable
    /// [`EventError::UnknownEvent`], exactly as [`Event::from_sse`] reports
    /// it, rather than as an opaque deserialization error.
    ///
    /// # Errors
    ///
    /// [`EventError::UnknownEvent`] for an unknown `type`;
    /// [`EventError::Payload`] for anything else that does not parse.
    pub fn from_ipc_json(json: &str) -> Result<Self, EventError> {
        let value: serde_json::Value = serde_json::from_str(json).map_err(EventError::Payload)?;
        if let Some(kind) = value.get("type").and_then(serde_json::Value::as_str)
            && !KNOWN_EVENTS.contains(&kind)
        {
            return Err(EventError::UnknownEvent(kind.into()));
        }
        serde_json::from_value(value).map_err(EventError::Payload)
    }
}
