//! `POST /v1/chat` — the unified request and the non-streaming response.
//!
//! # Strict in, tolerant out
//!
//! A [`ChatRequest`] is parsed with `deny_unknown_fields`: the gateway refuses
//! a field it does not understand rather than silently ignoring, say, a
//! misspelt `max_output_tokens` and billing a call the caller thought was
//! capped. `metadata` is the extension point for caller-defined data.
//!
//! Everything the gateway *sends* — [`ChatResponse`], [`Usage`], and the
//! events in [`crate::event`] — tolerates unknown fields, so a gateway can add
//! a field without breaking every deployed SDK.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use serde::{Deserialize, Serialize};

use crate::amount::{Milli2z, Whole2z};
use crate::settlement::{self, Settlement, SettlementError, double_option};

/// The body of `POST /v1/chat` and `POST /v1/chat/estimate`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatRequest {
    /// A catalogue model id, e.g. `"gpt-4.1-mini"`. Not a provider model id.
    pub model: String,
    /// The conversation, oldest first.
    pub messages: Vec<Message>,
    /// Function tools the model may call. The gateway never *runs* a tool: a
    /// call comes back to the client as a `tool_call` event.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Tool>,
    /// Upper bound on output tokens. The gateway may clamp it further to the
    /// model's window and to what the caller can afford; it never raises it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    /// `true` (the default) answers with an SSE stream of
    /// [`crate::event::Event`]s; `false` answers with one [`ChatResponse`].
    #[serde(default = "default_stream")]
    pub stream: bool,
    /// Caller-defined string pairs, echoed into the call record. Never sent
    /// to the model provider.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, String>,
    /// Opt-in, **ordered** fallback models. If the current model fails with
    /// a provider-side error ([`crate::ErrorCode::falls_back`]) **before the
    /// gateway commits to it** — before its first content event, which is
    /// when `meta` is sent — the gateway releases that attempt's hold, takes
    /// a new hold at the next model's price, and tries it. Never after
    /// `meta`, never after the client disconnected, and each model at most
    /// once: [`ChatRequest::attempts`] is the order. A hold that cannot be
    /// taken for a fallback ends the call with that code. `meta.model` names
    /// the model that answered. Empty means no fallback.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallback: Vec<String>,
}

impl ChatRequest {
    /// The models a call may try, in order, each at most once: `model`, then
    /// each `fallback` entry not already listed. Attempt `n` (from 1) is the
    /// `n`-th item, and its ledger `hold_key` is `(call_id, n)`, so a call
    /// has at most `1 + fallback.len()` holds.
    pub fn attempts(&self) -> impl Iterator<Item = &str> {
        core::iter::once(self.model.as_str()).chain(
            self.fallback
                .iter()
                .enumerate()
                .filter(|&(i, id)| {
                    *id != self.model
                        && !self
                            .fallback
                            .get(..i)
                            .is_some_and(|earlier| earlier.contains(id))
                })
                .map(|(_, id)| id.as_str()),
        )
    }
}

fn default_stream() -> bool {
    true
}

/// One turn of the conversation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    /// Who produced this turn.
    pub role: Role,
    /// The turn's content, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content: Vec<ContentPart>,
    /// On an `assistant` turn: the tool calls the model made. Decoded
    /// strictly here, although [`ToolCall`] itself is tolerant (it also
    /// arrives in responses and events): `deny_unknown_fields` does not
    /// propagate into a nested type on its own.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "strict_tool_calls"
    )]
    pub tool_calls: Vec<ToolCall>,
    /// On a `tool` turn: the [`ToolCall::id`] this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// [`ToolCall`]'s request-side shape: the same fields, refusing any other.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictToolCall {
    id: String,
    name: String,
    arguments: String,
}

fn strict_tool_calls<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<ToolCall>, D::Error> {
    let calls = Vec::<StrictToolCall>::deserialize(d)?;
    Ok(calls
        .into_iter()
        .map(|c| ToolCall {
            id: c.id,
            name: c.name,
            arguments: c.arguments,
        })
        .collect())
}

/// The author of a [`Message`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Instructions from the application.
    System,
    /// The end user.
    User,
    /// The model.
    Assistant,
    /// A tool result supplied by the client.
    Tool,
}

/// One part of a [`Message`]'s content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentPart {
    /// Plain text.
    Text {
        /// The text.
        text: String,
    },
    /// An inline image. There is deliberately **no URL form**: the gateway
    /// never fetches a client-supplied URL.
    Image {
        /// IANA media type, e.g. `image/png`.
        media_type: String,
        /// Standard base64 (RFC 4648 §4) of the image bytes.
        data: String,
    },
}

/// A function tool the model may call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    /// The function name the model will call.
    pub name: String,
    /// What the function does, for the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON Schema of the arguments object.
    pub parameters: serde_json::Value,
}

/// A call the model made to one of the request's [`Tool`]s.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    /// Opaque id, echoed back as [`Message::tool_call_id`] on the result.
    pub id: String,
    /// The [`Tool::name`] called.
    pub name: String,
    /// The arguments, as JSON **text** exactly as the model produced it. The
    /// model's output is not guaranteed to be valid JSON, so it is not parsed
    /// here.
    pub arguments: String,
}

/// Provider-reported usage, normalized across providers.
///
/// Every field is a count; [`crate::pricing::ModelPrices`] says what each one
/// costs. Missing fields read as zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default)]
pub struct Usage {
    /// Uncached input tokens.
    pub input_tokens: u64,
    /// Input tokens read from the provider's prompt cache.
    pub cached_input_tokens: u64,
    /// Input tokens written to the provider's prompt cache.
    pub cache_write_tokens: u64,
    /// Output tokens, **including** reasoning tokens.
    pub output_tokens: u64,
    /// The reasoning subset of `output_tokens`. Informational only: it is
    /// already inside `output_tokens` and is never priced a second time.
    pub reasoning_tokens: u64,
    /// Input images.
    pub images: u64,
    /// Server-side tool invocations the catalogue prices.
    pub tool_calls: u64,
}

/// Where a [`Usage`] came from.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    /// Reported by the model provider. The normal case.
    #[default]
    Provider,
    /// The provider reported none; the gateway estimated it from the streamed
    /// output and recorded that it did.
    Estimated,
    /// A source newer than this crate. Deserialization only: an old client
    /// must not throw away a paid-for answer over a label it does not know.
    #[serde(other)]
    Unknown,
}

/// Why generation stopped.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    /// The model finished its turn.
    Stop,
    /// `max_output_tokens` (possibly as clamped) was reached.
    Length,
    /// The model is waiting on tool results.
    ToolCalls,
    /// The provider's content filter stopped it.
    ContentFilter,
    /// The client cancelled.
    Cancelled,
    /// A reason newer than this crate. Deserialization only.
    #[serde(other)]
    Unknown,
}

/// The assistant turn inside a [`ChatResponse`].
///
/// A separate type from the request's [`Message`] on purpose: [`Message`] is
/// strict (`deny_unknown_fields`) because a gateway must refuse what it does
/// not understand, and a *response* decoded with those rules would make every
/// deployed client reject a whole completed, paid-for answer the day the
/// gateway adds a field. This type tolerates unknown fields and unknown
/// content-part types. To send the reply back as history, convert it with
/// [`AssistantMessage::into_message`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantMessage {
    /// The reply's content, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content: Vec<OutputPart>,
    /// The tool calls the model made.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
}

/// One part of an [`AssistantMessage`].
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutputPart {
    /// Plain text.
    Text {
        /// The text.
        text: String,
    },
    /// A part type newer than this crate. Deserialization only; dropped by
    /// [`AssistantMessage::into_message`].
    #[serde(other)]
    Unknown,
}

impl AssistantMessage {
    /// The reply as an `assistant` [`Message`] for the next request's history.
    /// Parts of an unknown type are dropped: this crate cannot re-send what it
    /// cannot name.
    #[must_use]
    pub fn into_message(self) -> Message {
        Message {
            role: Role::Assistant,
            content: self
                .content
                .into_iter()
                .filter_map(|part| match part {
                    OutputPart::Text { text } => Some(ContentPart::Text { text }),
                    OutputPart::Unknown => None,
                })
                .collect(),
            tool_calls: self.tool_calls,
            tool_call_id: None,
        }
    }

    /// The concatenated text of every text part.
    #[must_use]
    pub fn text(&self) -> String {
        let mut out = String::new();
        for part in &self.content {
            if let OutputPart::Text { text } = part {
                out.push_str(text);
            }
        }
        out
    }
}

/// The body of a `POST /v1/chat` answered with `"stream": false` and `200`:
/// the union of the stream's events.
///
/// Which amounts are present depends on [`ChatResponse::settlement`], as in
/// [`crate::event::Done`]; [`ChatResponse::check`] enforces it. A failure
/// after output began is not this type: it is a `502` whose `details` carry
/// the `error` event's fields.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatResponse {
    /// The call's id; also `GET /v1/calls/{id}`.
    pub call_id: String,
    /// The catalogue model that actually answered (a fallback, if one did).
    pub model: String,
    /// The assistant's reply.
    pub message: AssistantMessage,
    /// Why generation stopped.
    pub finish_reason: FinishReason,
    /// What the call used.
    pub usage: Usage,
    /// Where `usage` came from.
    #[serde(default)]
    pub usage_source: UsageSource,
    /// The final charge, in whole 2Z. Absent while `settlement` is
    /// `pending`; `0` (or absent) when `released`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charged_2z: Option<Whole2z>,
    /// The ledger's id for this settlement. Present only when `settled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_id: Option<String>,
    /// The available balance after the charge, in milli-2Z, if known. A
    /// hint: the ledger is the authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance_hint_milli_2z: Option<Milli2z>,
    /// The model the request named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_model: Option<String>,
    /// The provider serving `model`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Whether the amounts here are final. `settled` when absent.
    #[serde(default)]
    pub settlement: Settlement,
    /// The final reservation, in whole 2Z.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_2z: Option<Whole2z>,
    /// What was given back: `max(0, hold − charged)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_2z: Option<Whole2z>,
    /// What was actually taken: `charged_2z × 1000 − shortfall_milli_2z`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collected_milli_2z: Option<Milli2z>,
    /// What could not be taken and was written off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortfall_milli_2z: Option<Milli2z>,
    /// Remaining spend under the grant's cap. `None`: absent. `Some(None)`:
    /// `null`, no cap. `Some(Some(n))`: `n` milli-2Z remain.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    pub cap_remaining_milli_2z: Option<Option<Milli2z>>,
    /// When the call was created, RFC 3339 UTC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// When it was settled, RFC 3339 UTC. Absent while `pending`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<String>,
}

impl ChatResponse {
    /// Check the amounts against the rules of [`ChatResponse::settlement`].
    ///
    /// # Errors
    ///
    /// The first rule broken, naming the field.
    pub fn check(&self) -> Result<(), SettlementError> {
        settlement::check(&settlement::Fields {
            settlement: self.settlement,
            charged_2z: self.charged_2z,
            receipt_id: self.receipt_id.as_deref(),
            collected_milli_2z: self.collected_milli_2z,
            shortfall_milli_2z: self.shortfall_milli_2z,
            hold_2z: self.hold_2z,
            released_2z: self.released_2z,
            post_settlement: &[
                (
                    "balance_hint_milli_2z",
                    self.balance_hint_milli_2z.is_some(),
                ),
                (
                    "cap_remaining_milli_2z",
                    self.cap_remaining_milli_2z.is_some(),
                ),
                ("settled_at", self.settled_at.is_some()),
            ],
            success: true,
        })
    }
}

/// The body of a `POST /v1/chat/estimate` answer: steps 1–5 of a call, with
/// no hold, no charge and no provider call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EstimateResponse {
    /// The catalogue model priced.
    pub model: String,
    /// Estimated input tokens, safety factor applied.
    pub input_tokens: u64,
    /// The output cap the call would run with, after clamping.
    pub max_output_tokens: u64,
    /// What a call would hold now, in whole 2Z: the price of the worst case.
    pub hold_2z: Whole2z,
    /// The model's minimum charge, in whole 2Z.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_charge_2z: Option<Whole2z>,
    /// The user's available balance, as read for the clamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_milli_2z: Option<Milli2z>,
    /// Remaining spend under the grant's cap. `None`: absent. `Some(None)`:
    /// `null`, no cap. `Some(Some(n))`: `n` milli-2Z remain.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    pub cap_remaining_milli_2z: Option<Option<Milli2z>>,
    /// The signed catalogue version the estimate was priced from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_version: Option<u64>,
}
