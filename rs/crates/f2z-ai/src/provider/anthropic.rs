//! Anthropic Messages (`POST /v1/messages`, `stream: true`).
//!
//! # Usage — the rule that settles the money
//!
//! * `message_start.message.usage` carries the input counts —
//!   `input_tokens`, `cache_read_input_tokens`,
//!   `cache_creation_input_tokens` (with its `cache_creation` 5-minute /
//!   1-hour split) — and a **placeholder** `output_tokens`.
//! * Every `message_delta.usage` is **cumulative**: running totals, not
//!   increments. In a server-tool flow each one can repeat the input counts,
//!   larger than `message_start`'s, because tool results were fed back in.
//! * So each count is taken from the **last** `message_delta` that carries
//!   it, falling back to `message_start` for a count no `message_delta`
//!   carried — never summed, and never from the first delta.
//! * The call's usage is **reported** only once a `message_delta` has carried
//!   `output_tokens`. A stream whose `message_delta` had no usage, or that
//!   ended before one, is [`UsageReport::Missing`] — `message_start`'s input
//!   counts ride along as `partial`, with output `0`, never settled on.
//!
//! Anthropic's buckets are already disjoint (`input_tokens` excludes cache
//! reads and writes), which is `f2z_ai_proto::Usage`'s convention. It reports
//! no thinking subset of `output_tokens`, so `reasoning_tokens` is `0`.
//! `server_tool_use.web_search_requests` is the provider-billed per-call tool
//! use: it is `usage.tool_calls`. `web_fetch_requests` is not — web fetch is
//! billed in tokens only (zuu#1066).
//!
//! Function calls the model makes (`tool_use` blocks) are in
//! `output_tokens`, as Anthropic counts them; they are not `tool_calls`,
//! which is the server-side count only. The pricing math does not change
//! for tools or for `response_format`.
//!
//! # Content
//!
//! `text_delta` → `delta`; a `tool_use` block emits `tool_call_delta`
//! fragments as its name and `input_json_delta` arguments arrive, then emits
//! one complete `tool_call` at its `content_block_stop`, its `id` unchanged —
//! the same id comes back as a `tool` message's `tool_call_id` and goes out as
//! the `tool_result` block's `tool_use_id`. Thinking, signatures,
//! server-tool blocks and citations are not streamed (chat-api.md §3.3).
//!
//! # Tool controls (OpenAI shape → Anthropic)
//!
//! | `/v1/chat` | Anthropic `tool_choice` |
//! |---|---|
//! | absent | absent (Anthropic's default, `auto`) |
//! | `"auto"` | `{"type":"auto"}` |
//! | `"none"` | `{"type":"none"}` — the tools stay defined, so a history carrying `tool_use` blocks remains valid and the prompt-cache prefix is unchanged |
//! | `"required"` | `{"type":"any"}` |
//! | `{"type":"function","function":{"name":n}}` | `{"type":"tool","name":n}` |
//! | `parallel_tool_calls: false` | `disable_parallel_tool_use: true` on the choice (`auto` when no choice was named; not added to `none`) |
//!
//! # Structured output (`response_format`)
//!
//! Anthropic has no `response_format`, so the adapter asks for it as a
//! **forced single tool**: one tool whose `input_schema` is the requested
//! schema (`{"type":"object"}` for `json_object`; `strict: true` carried onto
//! the tool when the request set it), `tool_choice: {"type":"tool"}` naming
//! it, parallel use disabled. The tool's input *is* the answer, so the stream
//! unwraps it: each `input_json_delta` fragment is re-emitted as a text
//! `delta`, the reply's `content` is the JSON text, and the `tool_use` stop
//! reason reads as `stop` — the client asked for content, not for a call.
//! `max_tokens` still reads as `length`. A forced call carries no text of its
//! own; text that does arrive — a refusal instead of the tool call — is
//! emitted as text, never deleted, so a client is not charged for a reply it
//! cannot see (and `refusal` reads as `content_filter`).
//!
//! # The hold
//!
//! Anthropic adds a tool-use system prompt to any request that carries tools
//! — a few hundred input tokens, more for a forced choice — that the
//! request's own bytes do not show. [`TOOL_USE_OVERHEAD_TOKENS`] is reserved
//! for it ([`super::reserved_overhead_tokens`]); the charge is still the
//! provider-reported usage.
//!
//! A `response_format` beside `tools` (or `tool_choice`) is refused before
//! any hold ([`check`]): the forced tool would make the caller's own tools
//! uncallable, which is dropping them. Note that some newer Anthropic models
//! refuse a forced `tool_choice` outright; the signed catalogue's
//! `capabilities.structured_output` must not be declared for those.

use std::collections::BTreeMap;

use f2z_ai_proto::catalog::{ApiStyle, CatalogModel};
use f2z_ai_proto::chat::{
    ChatRequest, ContentPart, FinishReason, ResponseFormat, Role, ToolCall, ToolChoice, Usage,
};
use f2z_ai_proto::event::ToolCallDelta;
use f2z_ai_proto::{ErrorCode, OrderedJson};
use reqwest::header::{HeaderMap, HeaderValue};
use secrecy::{ExposeSecret as _, SecretString};
use serde_json::{Map, Value, json};

use super::sse::SseEvent;
use super::{
    Content, Ending, Malformed, Phase, Provider, ProviderFailure, Step, StreamParser, UsageReport,
    count, retryable_error_type,
};
use crate::error::ApiFailure;

/// The API version header value this adapter is written against.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// The Anthropic Messages adapter.
#[derive(Clone, Copy, Debug, Default)]
pub struct AnthropicMessages {
    /// The bound request asked for a `response_format`: the stream's one
    /// forced `tool_use` block is the reply's text ([`Provider::bind`]).
    structured: bool,
}

/// Input tokens reserved for Anthropic's tool-use system prompt and the
/// forced format tool's definition, on any request that sends tools. Anthropic
/// documents the system prompt per model and per `tool_choice` in the
/// hundreds of tokens (largest ~600 for a forced choice); this is that with
/// margin. It sizes the hold only — the charge is provider usage.
pub const TOOL_USE_OVERHEAD_TOKENS: u64 = 1024;

/// The forced tool's name for a `json_object` request (a `json_schema`
/// request's tool is named after its schema).
pub const JSON_OBJECT_TOOL: &str = "json_object";

/// The forced tool's description: what the model is told the tool is for.
/// Fixed text; nothing from the request.
const FORMAT_TOOL_DESCRIPTION: &str = "Respond by calling this tool. Its input is your complete answer, as JSON matching the input schema.";

/// The refusals this adapter makes for a request it cannot express, before
/// any hold, charge or provider request ([`super::check_tool_translation`]).
///
/// * `response_format` with `tools`, `tool_choice` or `parallel_tool_calls`:
///   the forced format tool would leave the caller's tools uncallable.
///   `details.reason = "response_format_unsupported"`, `details.conflict`
///   naming the other field.
/// * `tool_choice` or `parallel_tool_calls` with no `tools` (the gateway's
///   structural validation refuses this first; repeated here for the direct
///   adapter path): Anthropic has nothing to choose among.
///
/// # Errors
///
/// `400 invalid_request` naming the field.
pub fn check(request: &ChatRequest) -> Result<(), ApiFailure> {
    if request.response_format.is_some() {
        let conflict = if !request.tools.is_empty() {
            Some("tools")
        } else if request.tool_choice.is_some() {
            Some("tool_choice")
        } else if request.parallel_tool_calls.is_some() {
            Some("parallel_tool_calls")
        } else {
            None
        };
        if let Some(conflict) = conflict {
            return Err(ApiFailure::new(
                ErrorCode::InvalidRequest,
                "this model cannot combine response_format with tools",
            )
            .detail("field", "response_format")
            .detail("reason", super::RESPONSE_FORMAT_UNSUPPORTED)
            .detail("conflict", conflict));
        }
    }
    if request.tools.is_empty() {
        for (field, present) in [
            ("tool_choice", request.tool_choice.is_some()),
            ("parallel_tool_calls", request.parallel_tool_calls.is_some()),
        ] {
            if present {
                return Err(ApiFailure::new(
                    ErrorCode::InvalidRequest,
                    "tool_choice and parallel_tool_calls require tools",
                )
                .detail("field", field)
                .detail("reason", "requires_tools"));
            }
        }
    }
    Ok(())
}

/// The Anthropic `tool_choice` for a request's tool controls, or `None` to
/// leave Anthropic's default (`auto`, parallel calls allowed).
fn tool_choice(request: &ChatRequest) -> Option<Value> {
    let serial = request.parallel_tool_calls == Some(false);
    let mut choice = match &request.tool_choice {
        None if serial => json!({"type": "auto"}),
        None => return None,
        Some(ToolChoice::Auto) => json!({"type": "auto"}),
        // Nothing to call, so nothing to serialise.
        Some(ToolChoice::None) => return Some(json!({"type": "none"})),
        Some(ToolChoice::Required) => json!({"type": "any"}),
        Some(ToolChoice::Function { name }) => json!({"type": "tool", "name": name}),
    };
    if serial && let Some(object) = choice.as_object_mut() {
        object.insert("disable_parallel_tool_use".into(), json!(true));
    }
    Some(choice)
}

/// The forced tool that carries a `response_format`, and the `tool_choice`
/// that forces it. The tool is an [`OrderedJson`]: its `input_schema` is the
/// caller's schema, which reaches Anthropic in the caller's member order
/// (zuu#1132) and so must never pass through a `Value`.
fn format_tool(format: &ResponseFormat) -> (OrderedJson, Value) {
    let (name, schema, strict) = match format {
        ResponseFormat::JsonObject {} => (
            JSON_OBJECT_TOOL,
            OrderedJson::object([("type", OrderedJson::from("object"))]),
            None,
        ),
        ResponseFormat::JsonSchema { json_schema } => (
            json_schema.name.as_str(),
            json_schema.schema.clone(),
            json_schema.strict,
        ),
    };
    let mut tool = vec![
        ("name", OrderedJson::from(name)),
        ("description", OrderedJson::from(FORMAT_TOOL_DESCRIPTION)),
        ("input_schema", schema),
    ];
    // Only an explicit `true` is sent: absent and `false` are Anthropic's
    // default, as they are OpenAI's.
    if strict == Some(true) {
        tool.push(("strict", OrderedJson::from(true)));
    }
    (
        OrderedJson::object(tool),
        json!({"type": "tool", "name": name, "disable_parallel_tool_use": true}),
    )
}

impl Provider for AnthropicMessages {
    fn style(&self) -> ApiStyle {
        ApiStyle::AnthropicMessages
    }

    fn path(&self) -> &'static str {
        "/v1/messages"
    }

    fn headers(&self, key: &SecretString) -> Result<HeaderMap, ApiFailure> {
        let mut headers = HeaderMap::new();
        let mut value = HeaderValue::from_str(key.expose_secret()).map_err(|_| {
            ApiFailure::new(ErrorCode::Internal, "a provider key is not a valid header")
                .detail("reason", "provider_key")
        })?;
        value.set_sensitive(true);
        headers.insert("x-api-key", value);
        headers.insert(
            "anthropic-version",
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );
        Ok(headers)
    }

    fn body(
        &self,
        request: &ChatRequest,
        model: &CatalogModel,
        max_output_tokens: u64,
    ) -> Result<OrderedJson, ApiFailure> {
        // `system` is text, and an assistant turn carries no image; a
        // `tool_result` does.
        super::images_only_on(request, &[Role::User, Role::Tool])?;
        // A `response_format` only where the catalogue declares the model
        // honours it; and nothing this adapter cannot express. Refused, never
        // dropped (an unconstrained answer billed as a structured one).
        super::check_response_format(request, model)?;
        super::check_tool_translation(request, model)?;
        // No effort control on Messages (`thinking` takes a budget): refused
        // whatever the catalogue says, never dropped.
        super::check_reasoning_effort(request, model)?;
        let mut system = None;
        let mut turns: Vec<(&'static str, Vec<Value>)> = Vec::new();
        for (index, message) in request.messages.iter().enumerate() {
            let (role, blocks) = match message.role {
                Role::System => {
                    system = Some(text_of(&message.content));
                    continue;
                }
                Role::User => ("user", parts(&message.content)),
                Role::Assistant => {
                    let mut blocks = parts(&message.content);
                    for (call_index, call) in message.tool_calls.iter().enumerate() {
                        let input: Value = serde_json::from_str(&call.arguments)
                            .ok()
                            .filter(Value::is_object)
                            .ok_or_else(|| {
                                ApiFailure::new(
                                    ErrorCode::InvalidRequest,
                                    "tool call arguments must be a JSON object for this model",
                                )
                                .detail(
                                    "field",
                                    format!("messages[{index}].tool_calls[{call_index}].arguments"),
                                )
                                .detail("reason", "not_a_json_object")
                            })?;
                        blocks.push(json!({
                            "type": "tool_use", "id": call.id, "name": call.name, "input": input,
                        }));
                    }
                    ("assistant", blocks)
                }
                Role::Tool => (
                    "user",
                    vec![json!({
                        "type": "tool_result",
                        "tool_use_id": message.tool_call_id,
                        "content": parts(&message.content),
                    })],
                ),
            };
            // Anthropic alternates roles: consecutive turns of one role (tool
            // results, or tool results then the user's next words) are one
            // turn with their blocks in order.
            if blocks.is_empty() {
                // Nothing Anthropic accepts is left of this turn.
                continue;
            }
            match turns.last_mut() {
                Some((last, existing)) if *last == role => existing.extend(blocks),
                _ => turns.push((role, blocks)),
            }
        }
        let mut body = Map::new();
        body.insert("model".into(), json!(model.provider_model_id));
        body.insert("max_tokens".into(), json!(max_output_tokens));
        body.insert("stream".into(), json!(true));
        if let Some(system) = system {
            body.insert("system".into(), json!(system));
        }
        body.insert(
            "messages".into(),
            Value::Array(
                turns
                    .into_iter()
                    .map(|(role, content)| json!({"role": role, "content": content}))
                    .collect(),
            ),
        );
        let mut caller = Vec::new();
        if let Some(format) = &request.response_format {
            let (tool, choice) = format_tool(format);
            body.insert("tool_choice".into(), choice);
            caller.push(("tools", OrderedJson::array([tool])));
        } else if !request.tools.is_empty() {
            if let Some(choice) = tool_choice(request) {
                body.insert("tool_choice".into(), choice);
            }
            caller.push((
                "tools",
                OrderedJson::array(
                    request
                        .tools
                        .iter()
                        .map(|tool| OrderedJson::object(super::tool_members(tool, "input_schema"))),
                ),
            ));
        }
        Ok(super::ordered_body(body, caller))
    }

    fn bind(&mut self, request: &ChatRequest) {
        self.structured = request.response_format.is_some();
    }

    fn parser(&self) -> Box<dyn StreamParser> {
        Box::new(Parser {
            structured: self.structured,
            ..Parser::default()
        })
    }
}

fn text_of(content: &[ContentPart]) -> String {
    let mut out = String::new();
    for part in content {
        if let ContentPart::Text { text } = part {
            out.push_str(text);
        }
    }
    out
}

fn parts(content: &[ContentPart]) -> Vec<Value> {
    content
        .iter()
        // Anthropic answers 400 to an empty text block.
        .filter(|part| !matches!(part, ContentPart::Text { text } if text.is_empty()))
        .map(|part| match part {
            ContentPart::Text { text } => json!({"type": "text", "text": text}),
            ContentPart::Image { media_type, data } => json!({
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": data},
            }),
        })
        .collect()
}

/// The usage counts, each `None` until some event reports it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Counts {
    input: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    cache_write_1h: Option<u64>,
    output: Option<u64>,
    server_tools: Option<u64>,
}

impl Counts {
    fn read(usage: &Value) -> Result<Self, Malformed> {
        let creation = usage.get("cache_creation");
        let split = |key| count(creation.and_then(|c| c.get(key)), "usage.cache_creation");
        let (five_min, one_hour) = (
            split("ephemeral_5m_input_tokens")?,
            split("ephemeral_1h_input_tokens")?,
        );
        let cache_write = match count(
            usage.get("cache_creation_input_tokens"),
            "usage.cache_creation_input_tokens",
        )? {
            Some(n) => Some(n),
            // Only the split was sent: its sum is the write count.
            None if five_min.is_some() || one_hour.is_some() => {
                Some(five_min.unwrap_or(0).saturating_add(one_hour.unwrap_or(0)))
            }
            None => None,
        };
        let server = usage.get("server_tool_use");
        let search = count(
            server.and_then(|s| s.get("web_search_requests")),
            "usage.server_tool_use",
        )?;
        Ok(Self {
            input: count(usage.get("input_tokens"), "usage.input_tokens")?,
            cache_read: count(
                usage.get("cache_read_input_tokens"),
                "usage.cache_read_input_tokens",
            )?,
            cache_write,
            cache_write_1h: one_hour,
            output: count(usage.get("output_tokens"), "usage.output_tokens")?,
            server_tools: search,
        })
    }

    /// `self` with every count `later` carries replaced by `later`'s: the
    /// last report of each count wins.
    fn overlay(self, later: Self) -> Self {
        Self {
            input: later.input.or(self.input),
            cache_read: later.cache_read.or(self.cache_read),
            cache_write: later.cache_write.or(self.cache_write),
            cache_write_1h: later.cache_write_1h.or(self.cache_write_1h),
            output: later.output.or(self.output),
            server_tools: later.server_tools.or(self.server_tools),
        }
    }

    fn usage(self, output: u64) -> Usage {
        Usage {
            input_tokens: self.input.unwrap_or(0),
            cached_input_tokens: self.cache_read.unwrap_or(0),
            cache_write_tokens: self.cache_write.unwrap_or(0),
            output_tokens: output,
            reasoning_tokens: 0,
            images: 0,
            tool_calls: self.server_tools.unwrap_or(0),
        }
    }
}

#[derive(Debug)]
struct PendingTool {
    id: String,
    name: String,
    json: String,
    initial: Value,
}

/// The forced `response_format` block, while it streams.
#[derive(Debug)]
struct FormatBlock {
    index: u64,
    /// Whether any of its JSON was emitted as text.
    emitted: bool,
    /// The block's `input` at `content_block_start`: the answer when no
    /// `input_json_delta` follows.
    initial: Value,
}

#[derive(Debug, Default)]
struct Parser {
    /// The request asked for a `response_format`: the forced tool's input is
    /// the reply's text, and its `tool_use` stop is `stop`.
    structured: bool,
    /// The forced block, once it started.
    format: Option<FormatBlock>,
    /// Whether the forced block has started (it may start once).
    format_seen: bool,
    started: bool,
    /// `message_start`'s counts, with its placeholder `output_tokens` dropped.
    start: Counts,
    /// The overlay of every `message_delta`'s counts, in order.
    deltas: Counts,
    stop_reason: Option<FinishReason>,
    tools: BTreeMap<u64, PendingTool>,
    /// Argument bytes buffered across every pending tool call.
    pending_bytes: usize,
    failure: Option<ProviderFailure>,
    finished: bool,
}

fn parse_json(data: &str) -> Result<Value, Malformed> {
    serde_json::from_str(data).map_err(|_| Malformed("event data is not JSON"))
}

fn finish_reason(stop: &str) -> FinishReason {
    match stop {
        "max_tokens" | "model_context_window_exceeded" => FinishReason::Length,
        "tool_use" => FinishReason::ToolCalls,
        "refusal" => FinishReason::ContentFilter,
        // `end_turn`, `stop_sequence`, and `pause_turn` (a server-tool pause:
        // the turn ended; the client may continue it).
        _ => FinishReason::Stop,
    }
}

impl StreamParser for Parser {
    fn feed(&mut self, event: &SseEvent, out: &mut Vec<Content>) -> Result<Step, Malformed> {
        let kind = event.event.as_str();
        if kind == "ping" || (kind.is_empty() && event.data.is_empty()) {
            return Ok(Step::Continue);
        }
        let data = parse_json(&event.data)?;
        let kind = if kind.is_empty() {
            data.get("type").and_then(Value::as_str).unwrap_or_default()
        } else {
            kind
        };
        match kind {
            "message_start" => {
                let usage = data
                    .get("message")
                    .and_then(|m| m.get("usage"))
                    .ok_or(Malformed("message_start without usage"))?;
                // The output count here is a placeholder, not a report.
                self.start = Counts {
                    output: None,
                    ..Counts::read(usage)?
                };
                self.started = true;
            }
            "content_block_start" => {
                let index = data
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or(Malformed("block index"))?;
                let block = data
                    .get("content_block")
                    .ok_or(Malformed("content_block"))?;
                if self.structured && block.get("type").and_then(Value::as_str) == Some("tool_use")
                {
                    // The forced tool, and parallel use was disabled: a
                    // second block is not a stream this request produces.
                    if self.format_seen {
                        return Err(Malformed("more than one response_format block"));
                    }
                    self.format_seen = true;
                    self.format = Some(FormatBlock {
                        index,
                        emitted: false,
                        initial: block.get("input").cloned().unwrap_or_else(|| json!({})),
                    });
                } else if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    if self.tools.len() >= super::MAX_PENDING_TOOLS {
                        return Err(Malformed("too many pending tool calls"));
                    }
                    let field = |k: &str| block.get(k).and_then(Value::as_str).map(str::to_owned);
                    self.tools.insert(
                        index,
                        PendingTool {
                            id: field("id").ok_or(Malformed("tool_use id"))?,
                            name: field("name").ok_or(Malformed("tool_use name"))?,
                            json: String::new(),
                            initial: block.get("input").cloned().unwrap_or_else(|| json!({})),
                        },
                    );
                    let tool = self.tools.get(&index).ok_or(Malformed("tool_use"))?;
                    out.push(Content::ToolCallDelta(ToolCallDelta {
                        index: u32::try_from(index)
                            .map_err(|_| Malformed("tool call index out of range"))?,
                        id: Some(tool.id.clone()),
                        name: Some(tool.name.clone()),
                        arguments: String::new(),
                    }));
                }
            }
            "content_block_delta" => {
                let index = data
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or(Malformed("block index"))?;
                let delta = data.get("delta").ok_or(Malformed("delta"))?;
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = delta
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or(Malformed("text_delta"))?;
                        // A forced call carries no text; text that arrives
                        // anyway (a refusal) is delivered, never deleted.
                        if !text.is_empty() {
                            out.push(Content::Text(text.to_owned()));
                        }
                    }
                    Some("input_json_delta") => {
                        let part = delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .ok_or(Malformed("input_json_delta"))?;
                        if let Some(format) = self.format.as_mut().filter(|f| f.index == index) {
                            // Re-emitted as it arrives: the JSON answer
                            // streams like any other reply.
                            if !part.is_empty() {
                                format.emitted = true;
                                out.push(Content::Text(part.to_owned()));
                            }
                        } else if let Some(tool) = self.tools.get_mut(&index) {
                            self.pending_bytes = self.pending_bytes.saturating_add(part.len());
                            if self.pending_bytes > super::MAX_PENDING_TOOL_BYTES {
                                return Err(Malformed("tool call arguments too large"));
                            }
                            tool.json.push_str(part);
                            if !part.is_empty() {
                                out.push(Content::ToolCallDelta(ToolCallDelta {
                                    index: u32::try_from(index)
                                        .map_err(|_| Malformed("tool call index out of range"))?,
                                    id: None,
                                    name: None,
                                    arguments: part.to_owned(),
                                }));
                            }
                        }
                    }
                    // thinking, signature, citations: not streamed in v1.
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = data
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or(Malformed("block index"))?;
                if let Some(format) = self.format.take_if(|f| f.index == index) {
                    // A block whose input arrived whole, at its start.
                    if !format.emitted {
                        out.push(Content::Text(format.initial.to_string()));
                    }
                } else if let Some(tool) = self.tools.remove(&index) {
                    self.pending_bytes = self.pending_bytes.saturating_sub(tool.json.len());
                    let arguments = if tool.json.is_empty() {
                        tool.initial.to_string()
                    } else {
                        tool.json
                    };
                    out.push(Content::ToolCall(ToolCall {
                        id: tool.id,
                        name: tool.name,
                        arguments,
                    }));
                }
            }
            "message_delta" => {
                if let Some(stop) = data
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(Value::as_str)
                {
                    self.stop_reason = Some(match finish_reason(stop) {
                        // The forced format tool ended the turn: the client
                        // asked for content, and got it.
                        FinishReason::ToolCalls if self.structured => FinishReason::Stop,
                        reason => reason,
                    });
                }
                if let Some(usage) = data.get("usage").filter(|u| !u.is_null()) {
                    // Cumulative: the latest report of each count replaces
                    // the earlier one.
                    self.deltas = self.deltas.overlay(Counts::read(usage)?);
                }
            }
            "message_stop" => {
                self.finished = true;
                return Ok(Step::Terminal);
            }
            "error" => {
                let kind = data
                    .get("error")
                    .and_then(|e| e.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let retryable = retryable_error_type(kind);
                self.failure = Some(ProviderFailure {
                    code: if kind == "timeout_error" {
                        ErrorCode::ProviderTimeout
                    } else {
                        ErrorCode::ProviderError
                    },
                    reason: "stream_error",
                    status: None,
                    retryable,
                    retry_after: None,
                    phase: Phase::BeforeContent,
                });
                return Ok(Step::Terminal);
            }
            // Unknown event names are additive in Anthropic's versioning
            // policy: skip them.
            _ => {}
        }
        Ok(Step::Continue)
    }

    fn end(&mut self, terminal: bool) -> Ending {
        let counts = self.start.overlay(self.deltas);
        let usage = match self.deltas.output {
            Some(output) => UsageReport::Reported(counts.usage(output)),
            None => UsageReport::Missing {
                partial: self.started.then(|| counts.usage(0)),
            },
        };
        let failure = self.failure.clone().or_else(|| {
            (!(terminal && self.finished))
                .then(|| ProviderFailure::new(ErrorCode::ProviderError, "truncated", true))
        });
        Ending {
            finish_reason: if failure.is_some() {
                None
            } else {
                self.stop_reason.or(Some(FinishReason::Stop))
            },
            usage,
            cache_write_1h_tokens: counts.cache_write_1h.unwrap_or(0),
            failure,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(p: &mut Parser, event: &str, data: Value) -> Vec<Content> {
        let mut out = Vec::new();
        p.feed(
            &SseEvent {
                event: event.into(),
                data: data.to_string(),
            },
            &mut out,
        )
        .unwrap();
        out
    }

    fn start(p: &mut Parser) {
        feed(
            p,
            "message_start",
            json!({"type":"message_start","message":{"usage":{
                "input_tokens": 100, "cache_read_input_tokens": 7,
                "cache_creation_input_tokens": 30,
                "cache_creation": {"ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 10},
                "output_tokens": 1}}}),
        );
    }

    #[test]
    fn the_last_cumulative_delta_wins_and_start_fills_the_gaps() {
        let mut p = Parser::default();
        start(&mut p);
        for (input, output, search) in [(150, 10, 1), (300, 40, 2), (400, 55, 3)] {
            feed(
                &mut p,
                "message_delta",
                json!({"type":"message_delta","delta":{"stop_reason":null},
                       "usage":{"input_tokens": input, "output_tokens": output,
                                "server_tool_use": {"web_search_requests": search}}}),
            );
        }
        feed(&mut p, "message_stop", json!({"type":"message_stop"}));
        let end = p.end(true);
        assert_eq!(
            end.usage,
            UsageReport::Reported(Usage {
                input_tokens: 400,
                cached_input_tokens: 7,
                cache_write_tokens: 30,
                output_tokens: 55,
                reasoning_tokens: 0,
                images: 0,
                tool_calls: 3,
            })
        );
        assert_eq!(end.cache_write_1h_tokens, 10);
        assert_eq!(end.failure, None);
    }

    #[test]
    fn the_start_placeholder_is_never_a_report() {
        let mut p = Parser::default();
        start(&mut p);
        feed(
            &mut p,
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        );
        feed(&mut p, "message_stop", json!({"type":"message_stop"}));
        let end = p.end(true);
        match end.usage {
            UsageReport::Missing { partial: Some(u) } => {
                assert_eq!((u.input_tokens, u.output_tokens), (100, 0));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_tool_use_block_is_one_complete_call() {
        let mut p = Parser::default();
        start(&mut p);
        let out = feed(
            &mut p,
            "content_block_start",
            json!({"type":"content_block_start","index":0,
                   "content_block":{"type":"tool_use","id":"toolu_1","name":"f","input":{}}}),
        );
        assert_eq!(
            out,
            vec![Content::ToolCallDelta(ToolCallDelta {
                index: 0,
                id: Some("toolu_1".into()),
                name: Some("f".into()),
                arguments: String::new(),
            })]
        );
        for part in ["{\"a\"", ": 1}"] {
            assert_eq!(
                feed(
                    &mut p,
                    "content_block_delta",
                    json!({"type":"content_block_delta","index":0,
                           "delta":{"type":"input_json_delta","partial_json":part}}),
                ),
                vec![Content::ToolCallDelta(ToolCallDelta {
                    index: 0,
                    id: None,
                    name: None,
                    arguments: part.into(),
                })]
            );
        }
        let out = feed(
            &mut p,
            "content_block_stop",
            json!({"type":"content_block_stop","index":0}),
        );
        assert_eq!(
            out,
            vec![Content::ToolCall(ToolCall {
                id: "toolu_1".into(),
                name: "f".into(),
                arguments: "{\"a\": 1}".into()
            })]
        );
    }

    #[test]
    fn web_fetch_is_not_a_per_call_tool_and_empty_text_is_not_sent() {
        let mut p = Parser::default();
        start(&mut p);
        feed(
            &mut p,
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},
                   "usage":{"output_tokens": 5,
                            "server_tool_use": {"web_search_requests": 2, "web_fetch_requests": 7}}}),
        );
        feed(&mut p, "message_stop", json!({"type":"message_stop"}));
        assert_eq!(p.end(true).usage.reported().map(|u| u.tool_calls), Some(2));

        let parts = parts(&[
            ContentPart::Text {
                text: String::new(),
            },
            ContentPart::Text { text: "x".into() },
        ]);
        assert_eq!(parts, vec![json!({"type": "text", "text": "x"})]);
    }

    #[test]
    fn unbounded_tool_arguments_are_refused() {
        let mut p = Parser::default();
        start(&mut p);
        feed(
            &mut p,
            "content_block_start",
            json!({"type":"content_block_start","index":0,
                   "content_block":{"type":"tool_use","id":"t","name":"f","input":{}}}),
        );
        let part = "x".repeat(64 * 1024);
        let mut refused = false;
        for _ in 0..100 {
            let mut out = Vec::new();
            let r = p.feed(
                &SseEvent {
                    event: "content_block_delta".into(),
                    data: json!({"type":"content_block_delta","index":0,
                                 "delta":{"type":"input_json_delta","partial_json":part}})
                    .to_string(),
                },
                &mut out,
            );
            if r.is_err() {
                refused = true;
                break;
            }
        }
        assert!(refused, "4 MiB of pending arguments is the limit");
    }

    #[test]
    fn a_non_integer_count_is_malformed_not_zero() {
        let mut p = Parser::default();
        let mut out = Vec::new();
        let r = p.feed(
            &SseEvent {
                event: "message_start".into(),
                data: json!({"message":{"usage":{"input_tokens":"12"}}}).to_string(),
            },
            &mut out,
        );
        assert!(r.is_err());
    }
}
