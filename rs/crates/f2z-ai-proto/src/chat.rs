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
    /// Opt-in ordered fallback models, tried only if `model` fails before its
    /// first byte reaches the client. Empty means no fallback.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallback: Vec<String>,
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
    /// On an `assistant` turn: the tool calls the model made.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// On a `tool` turn: the [`ToolCall::id`] this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    /// Reported by the model provider. The normal case.
    #[default]
    Provider,
    /// The provider reported none; the gateway estimated it from the streamed
    /// output and recorded that it did.
    Estimated,
}

/// Why generation stopped.
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

/// The body of a `POST /v1/chat` answered with `"stream": false`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatResponse {
    /// The call's id; also `GET /v1/calls/{id}`.
    pub call_id: String,
    /// The catalogue model that actually answered (a fallback, if one did).
    pub model: String,
    /// The assistant's reply.
    pub message: Message,
    /// Why generation stopped.
    pub finish_reason: FinishReason,
    /// What the call used.
    pub usage: Usage,
    /// Where `usage` came from.
    #[serde(default)]
    pub usage_source: UsageSource,
    /// What was charged, in whole 2Z.
    pub charged_2z: u64,
    /// The ledger receipt for the charge.
    pub receipt_id: String,
    /// The caller's balance after the charge, in milli-2Z, if known. A hint:
    /// the ledger is the authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance_hint_milli_2z: Option<u64>,
}

/// The body of a `POST /v1/chat/estimate` answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EstimateResponse {
    /// The catalogue model priced.
    pub model: String,
    /// Estimated input tokens, safety factor applied.
    pub input_tokens: u64,
    /// The output cap the call would run with, after clamping.
    pub max_output_tokens: u64,
    /// What a call would hold, in whole 2Z: the price of the worst case.
    pub hold_2z: u64,
}
