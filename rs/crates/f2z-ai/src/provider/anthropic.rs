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
//! `server_tool_use.web_search_requests` (and `web_fetch_requests`) are the
//! provider-billed per-call tool uses: they are `usage.tool_calls`.
//!
//! # Content
//!
//! `text_delta` → `delta`; a `tool_use` block is buffered from
//! `content_block_start` through its `input_json_delta` fragments and emitted
//! as one `tool_call` at its `content_block_stop`. Thinking, signatures,
//! server-tool blocks and citations are not streamed (chat-api.md §3.3).

use std::collections::BTreeMap;

use f2z_ai_proto::ErrorCode;
use f2z_ai_proto::catalog::{ApiStyle, CatalogModel};
use f2z_ai_proto::chat::{ChatRequest, ContentPart, FinishReason, Role, ToolCall, Usage};
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
pub struct AnthropicMessages;

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
    ) -> Result<Value, ApiFailure> {
        // `system` is text, and an assistant turn carries no image; a
        // `tool_result` does.
        super::images_only_on(request, &[Role::User, Role::Tool])?;
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
        if !request.tools.is_empty() {
            body.insert(
                "tools".into(),
                Value::Array(
                    request
                        .tools
                        .iter()
                        .map(|tool| {
                            let mut t = Map::new();
                            t.insert("name".into(), json!(tool.name));
                            if let Some(d) = &tool.description {
                                t.insert("description".into(), json!(d));
                            }
                            t.insert("input_schema".into(), tool.parameters.clone());
                            Value::Object(t)
                        })
                        .collect(),
                ),
            );
        }
        Ok(Value::Object(body))
    }

    fn parser(&self) -> Box<dyn StreamParser> {
        Box::new(Parser::default())
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
        let fetch = count(
            server.and_then(|s| s.get("web_fetch_requests")),
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
            server_tools: match (search, fetch) {
                (None, None) => None,
                (a, b) => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0))),
            },
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

#[derive(Debug, Default)]
struct Parser {
    started: bool,
    /// `message_start`'s counts, with its placeholder `output_tokens` dropped.
    start: Counts,
    /// The overlay of every `message_delta`'s counts, in order.
    deltas: Counts,
    stop_reason: Option<FinishReason>,
    tools: BTreeMap<u64, PendingTool>,
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
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
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
                        if !text.is_empty() {
                            out.push(Content::Text(text.to_owned()));
                        }
                    }
                    Some("input_json_delta") => {
                        let part = delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .ok_or(Malformed("input_json_delta"))?;
                        if let Some(tool) = self.tools.get_mut(&index) {
                            tool.json.push_str(part);
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
                if let Some(tool) = self.tools.remove(&index) {
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
                    self.stop_reason = Some(finish_reason(stop));
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
        feed(
            &mut p,
            "content_block_start",
            json!({"type":"content_block_start","index":0,
                   "content_block":{"type":"tool_use","id":"toolu_1","name":"f","input":{}}}),
        );
        for part in ["{\"a\"", ": 1}"] {
            assert!(
                feed(
                    &mut p,
                    "content_block_delta",
                    json!({"type":"content_block_delta","index":0,
                           "delta":{"type":"input_json_delta","partial_json":part}}),
                )
                .is_empty()
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
