//! The SSE event grammar of a streamed `POST /v1/chat`.
//!
//! ```text
//! stream  = meta *(delta / tool_call_delta / tool_call) [usage] (done / error)
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
//! known. Both terminal events say whether their charge is final
//! ([`Settlement`]); their `check()` methods enforce the per-state rules of
//! [`crate::settlement`]. A client that sees an event name it does not know skips it
//! ([`EventError::UnknownEvent`]) — new event kinds are additive.
//!
//! [`Event`] also serializes as a tagged JSON object (`{"type":"meta",…}`),
//! which is the form an SDK forwards over an IPC channel.

use alloc::string::String;

use serde::{Deserialize, Serialize};

use crate::amount::{Milli2z, Whole2z};
use crate::chat::{FinishReason, ToolCall, Usage, UsageSource};
use crate::error::ErrorCode;
use crate::settlement::{self, NotFinal, Outcome, Settlement, SettlementError, double_option};

/// Every event name this crate knows, in grammar order.
pub const KNOWN_EVENTS: [&str; 7] = [
    "meta",
    "delta",
    "tool_call_delta",
    "tool_call",
    "usage",
    "done",
    "error",
];

/// One event of a chat stream.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// First event of every successful stream: the hold is placed.
    Meta(Meta),
    /// A chunk of assistant text.
    Delta(Delta),
    /// A fragment of a tool call still being generated. Informational: the
    /// complete [`Event::ToolCall`] for the same call follows and is
    /// authoritative.
    ToolCallDelta(ToolCallDelta),
    /// A complete tool call.
    ToolCall(ToolCall),
    /// Final usage, just before `done`.
    Usage(UsageEvent),
    /// The call is settled. Last event.
    Done(Done),
    /// The call failed. Last event.
    Error(ErrorEvent),
}

/// The `meta` event: the gateway has committed to a model, and the call is
/// billable on it. No `fallback` happens after it.
///
/// The fields after `hold_2z` are informational and optional on decode, so a
/// client never drops a stream over one of them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    /// The call's id; also `GET /v1/calls/{id}` and `X-F2Z-Call-Id`.
    pub call_id: String,
    /// The catalogue model answering — differs from `requested_model` only
    /// after a `fallback`.
    pub model: String,
    /// The initial reservation, in whole 2Z: the worst-case price. An
    /// extension can raise it; `done.hold_2z` is the final value.
    pub hold_2z: Whole2z,
    /// The model the request named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_model: Option<String>,
    /// The provider serving `model`, e.g. `openai`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The effective output cap after clamping for context and
    /// affordability. A client should tell the user when it is lower than
    /// asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    /// The input estimate the hold was computed from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens_estimate: Option<u64>,
    /// When the call was created, RFC 3339 UTC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

impl Meta {
    /// A `meta` with the required fields and no informational ones.
    #[must_use]
    pub fn new(call_id: impl Into<String>, model: impl Into<String>, hold_2z: Whole2z) -> Self {
        Self {
            call_id: call_id.into(),
            model: model.into(),
            hold_2z,
            requested_model: None,
            provider: None,
            max_output_tokens: None,
            input_tokens_estimate: None,
            created_at: None,
        }
    }
}

/// The `delta` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delta {
    /// Text to append to the assistant's reply.
    pub text: String,
}

/// The `tool_call_delta` event: a fragment of a tool call, as the provider
/// streamed it, for a client that wants to show a call taking shape.
///
/// Fragments with the same `index` belong to one call. The first carries
/// `id` and `name`; each carries a piece of `arguments` (possibly empty) to
/// append. Concatenated, a call's `arguments` pieces are exactly the
/// `arguments` of the complete `tool_call` event that follows them — which
/// is authoritative, and is all a client that ignores this event needs.
/// A provider that sends a call whole (xAI) yields one fragment per call.
/// A stream that fails mid-call leaves fragments with no `tool_call`: that
/// call never completed and must not be run. Sent only on streamed calls,
/// and best effort: a gateway under client backpressure drops fragments
/// (never the `tool_call`), so the concatenation can then be incomplete.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallDelta {
    /// The call's position among this turn's tool calls, from `0`.
    pub index: u32,
    /// The call's id, on its first fragment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The function name, on the fragment that first carries it (normally
    /// the first). Should a later fragment carry it again, the later value
    /// replaces the earlier one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// JSON text to append to the call's arguments.
    #[serde(default)]
    pub arguments: String,
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

/// The `done` event: the terminal event of a successful call.
///
/// Which amounts are present depends on [`Done::settlement`] — see
/// [`crate::settlement`] and [`Done::check`]. Under `pending`, only
/// `hold_2z` is; under `released`, nothing was charged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Done {
    /// The final charge, in whole 2Z. Absent while `settlement` is
    /// `pending`; `0` (or absent) when `released`. **Consumers must not read
    /// this directly** — a tolerant decode leaves it `None` under a default
    /// `settled`; use [`Done::outcome`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charged_2z: Option<Whole2z>,
    /// The ledger's id for this settlement, distinct from the call id.
    /// Present only when `settlement` is `settled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_id: Option<String>,
    /// Why generation stopped.
    pub finish_reason: FinishReason,
    /// The available balance after the charge, in milli-2Z, as of
    /// settlement. A hint only; absent while `pending`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance_hint_milli_2z: Option<Milli2z>,
    /// Whether the amounts here are final. `settled` when absent.
    #[serde(default)]
    pub settlement: Settlement,
    /// The final reservation: can exceed `meta.hold_2z` after an extension.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_2z: Option<Whole2z>,
    /// What was given back: `max(0, hold − charged)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_2z: Option<Whole2z>,
    /// What was actually taken: `charged_2z × 1000 − shortfall_milli_2z`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collected_milli_2z: Option<Milli2z>,
    /// What could not be taken and was written off (`metering.md` §5.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortfall_milli_2z: Option<Milli2z>,
    /// Remaining spend under the grant's cap for the hold's period.
    /// `None`: absent (settlement pending). `Some(None)`: `null`, the grant
    /// has no cap. `Some(Some(n))`: `n` milli-2Z remain.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    pub cap_remaining_milli_2z: Option<Option<Milli2z>>,
    /// Where the usage the charge was computed from came from.
    #[serde(default)]
    pub usage_source: UsageSource,
}

impl Done {
    fn bare(settlement: Settlement, finish_reason: FinishReason) -> Self {
        Self {
            charged_2z: None,
            receipt_id: None,
            finish_reason,
            balance_hint_milli_2z: None,
            settlement,
            hold_2z: None,
            released_2z: None,
            collected_milli_2z: None,
            shortfall_milli_2z: None,
            cap_remaining_milli_2z: None,
            usage_source: UsageSource::Provider,
        }
    }

    /// A settled `done` with the charge and its receipt; set the optional
    /// amounts on the result, then [`Done::check`] it.
    #[must_use]
    pub fn settled(
        charged_2z: Whole2z,
        receipt_id: impl Into<String>,
        finish_reason: FinishReason,
    ) -> Self {
        Self {
            charged_2z: Some(charged_2z),
            receipt_id: Some(receipt_id.into()),
            ..Self::bare(Settlement::Settled, finish_reason)
        }
    }

    /// A `done` whose settlement the ledger has not confirmed: no amounts
    /// but the final hold.
    #[must_use]
    pub fn pending(hold_2z: Whole2z, finish_reason: FinishReason) -> Self {
        Self {
            hold_2z: Some(hold_2z),
            ..Self::bare(Settlement::Pending, finish_reason)
        }
    }

    /// A `done` whose hold had expired before it could be settled: nothing
    /// charged, the whole hold released.
    #[must_use]
    pub fn released(hold_2z: Whole2z, finish_reason: FinishReason) -> Self {
        Self {
            charged_2z: Some(Whole2z::ZERO),
            hold_2z: Some(hold_2z),
            released_2z: Some(hold_2z),
            ..Self::bare(Settlement::Released, finish_reason)
        }
    }

    fn fields(&self) -> settlement::Fields<'_> {
        settlement::Fields {
            settlement: self.settlement,
            charged_2z: self.charged_2z,
            receipt_id: self.receipt_id.as_deref(),
            collected_milli_2z: self.collected_milli_2z,
            shortfall_milli_2z: self.shortfall_milli_2z,
            hold_2z: self.hold_2z,
            released_2z: self.released_2z,
            post_settlement: [
                (
                    "balance_hint_milli_2z",
                    self.balance_hint_milli_2z.is_some(),
                ),
                (
                    "cap_remaining_milli_2z",
                    self.cap_remaining_milli_2z.is_some(),
                ),
                ("", false),
            ],
            success: true,
            partial: false,
        }
    }

    /// Check the amounts against the rules of [`Done::settlement`]. For a
    /// producer, before it emits the event.
    ///
    /// # Errors
    ///
    /// The first rule broken, naming the field.
    pub fn check(&self) -> Result<(), SettlementError> {
        settlement::check(&self.fields())
    }

    /// What a consumer may conclude: the charge if final, otherwise
    /// [`Outcome::NotFinal`] — including when the event breaks the rules.
    /// Read this, never [`Done::charged_2z`] directly.
    #[must_use]
    pub fn outcome(&self) -> Outcome<'_> {
        settlement::outcome(&self.fields())
    }
}

/// The `error` event: the terminal event of a failed call, and what the
/// failure still cost.
///
/// A provider **refusal** before `meta` is a lone `error` with
/// `charged_2z: 0` and no receipt. A provider that accepted the request and
/// then failed — before or after output — settles the call for what it is
/// owed (`meta` precedes that `error`). `delivery_aborted` always carries
/// `settlement: "pending"`: the call is still running upstream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEvent {
    /// What went wrong, for a program. Whether to retry is
    /// [`ErrorEvent::retryable`], which also accounts for what the failed
    /// call cost.
    pub code: ErrorCode,
    /// What went wrong, for a log. Never prompt or completion text.
    #[serde(default)]
    pub message: String,
    /// Whether the amounts here are final. `settled` when absent.
    #[serde(default)]
    pub settlement: Settlement,
    /// What the failed call cost, in whole 2Z. `0` before any output;
    /// absent while `pending`. **Consumers must not read this directly**;
    /// use [`ErrorEvent::outcome`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charged_2z: Option<Whole2z>,
    /// The ledger's settlement id, when something was charged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_id: Option<String>,
    /// What was actually taken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collected_milli_2z: Option<Milli2z>,
    /// What could not be taken and was written off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortfall_milli_2z: Option<Milli2z>,
    /// Whether the client received at least one `delta`, `tool_call_delta`
    /// or `tool_call`.
    #[serde(default)]
    pub partial: bool,
}

impl ErrorEvent {
    /// An error before `meta`: nothing produced, nothing charged.
    #[must_use]
    pub fn uncharged(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            settlement: Settlement::Settled,
            charged_2z: Some(Whole2z::ZERO),
            receipt_id: None,
            collected_milli_2z: None,
            shortfall_milli_2z: None,
            partial: false,
        }
    }

    fn fields(&self) -> settlement::Fields<'_> {
        settlement::Fields {
            settlement: self.settlement,
            charged_2z: self.charged_2z,
            receipt_id: self.receipt_id.as_deref(),
            collected_milli_2z: self.collected_milli_2z,
            shortfall_milli_2z: self.shortfall_milli_2z,
            hold_2z: None,
            released_2z: None,
            post_settlement: [("", false); 3],
            success: false,
            partial: self.partial,
        }
    }

    /// Check the amounts against the rules of [`ErrorEvent::settlement`],
    /// that a `partial` settled failure charged at least 1 2Z, and that
    /// `delivery_aborted` is `pending`. For a producer.
    ///
    /// # Errors
    ///
    /// The first rule broken, naming the field.
    pub fn check(&self) -> Result<(), SettlementError> {
        if self.code == ErrorCode::DeliveryAborted && self.settlement != Settlement::Pending {
            return Err(SettlementError::DeliveryAbortedNotPending);
        }
        settlement::check(&self.fields())
    }

    /// What a consumer may conclude about the failed call's cost. Read this,
    /// never [`ErrorEvent::charged_2z`] directly.
    #[must_use]
    pub fn outcome(&self) -> Outcome<'_> {
        if self.code == ErrorCode::DeliveryAborted && self.settlement != Settlement::Pending {
            return Outcome::NotFinal(NotFinal::Invalid(
                SettlementError::DeliveryAbortedNotPending,
            ));
        }
        settlement::outcome(&self.fields())
    }

    /// Whether an SDK may retry this call on its own (with a **new**
    /// `Idempotency-Key`): the code is retryable **and** the failed call
    /// delivered nothing and is known to have charged nothing. A charged,
    /// partial or not-final failure is never retried automatically.
    /// Prefer this to [`ErrorCode::retryable`], which knows only the code.
    #[must_use]
    pub fn retryable(&self) -> bool {
        settlement::retry_allowed(self.code.retryable(), self.partial, &self.outcome())
    }
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
            Self::ToolCallDelta(_) => "tool_call_delta",
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
            Self::ToolCallDelta(p) => serde_json::to_string(p),
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
            "tool_call_delta" => serde_json::from_str(data).map(Self::ToolCallDelta),
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
