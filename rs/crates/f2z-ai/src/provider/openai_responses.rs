//! OpenAI Responses (`POST /v1/responses`, `stream: true`).
//!
//! # Usage
//!
//! Reported once, on the terminal event's `response.usage`, and the terminal
//! event is one of **three**: `response.completed`, `response.incomplete`
//! (the output limit, or a content filter — `incomplete_details.reason`) and
//! `response.failed`. All three carry usage, and an adapter that treated only
//! `response.completed` as the end would lose the usage of every call that
//! reached its `out_cap` — the common case, since the gateway always sends
//! one.
//!
//! OpenAI's conventions, normalised to `f2z_ai_proto::Usage`'s disjoint
//! buckets:
//!
//! * `input_tokens` **includes** `input_tokens_details.cached_tokens`, so
//!   uncached input is the difference. There is no cache-write count: writes
//!   are ordinary input here.
//! * `output_tokens` **includes** `output_tokens_details.reasoning_tokens`,
//!   which is therefore the informational subset.
//! * A `null` usage is [`UsageReport::Missing`], never zero.
//!
//! Server-side tool calls (`web_search_call`, `file_search_call`, …) are
//! billed per call and are not in `usage`; they are counted from the
//! response's output items into `usage.tool_calls`. v1 never enables one
//! (chat-api.md §2.1), so this count is `0` unless a provider starts calling
//! hosted tools unasked — in which case the call is billed, not hidden.
//!
//! # Content
//!
//! `response.output_text.delta` (and `response.refusal.delta`) → `delta`. A
//! `function_call` output item is emitted as one `tool_call` from its
//! `response.output_item.done`, whose item carries the complete arguments.
//! Reasoning is not streamed.

use f2z_ai_proto::ErrorCode;
use f2z_ai_proto::catalog::{ApiStyle, CatalogModel};
use f2z_ai_proto::chat::{ChatRequest, ContentPart, FinishReason, Role, ToolCall, Usage};
use reqwest::header::{HeaderMap, HeaderValue};
use secrecy::{ExposeSecret as _, SecretString};
use serde_json::{Map, Value, json};

use super::sse::SseEvent;
use super::{
    Content, Ending, Malformed, Phase, Provider, ProviderFailure, Step, StreamParser, UsageReport,
    count, data_url, retryable_error_type,
};
use crate::error::ApiFailure;

/// Output item types that are provider-hosted tool invocations, billed per
/// call. `function_call` (and `custom_tool_call`) are the client's own tools.
const HOSTED_TOOL_ITEMS: [&str; 5] = [
    "web_search_call",
    "file_search_call",
    "code_interpreter_call",
    "image_generation_call",
    "mcp_call",
];

/// The OpenAI Responses adapter.
#[derive(Clone, Copy, Debug, Default)]
pub struct OpenAiResponses;

/// `Authorization: Bearer <key>`, marked sensitive. Shared with Chat
/// Completions.
pub(crate) fn bearer(key: &SecretString) -> Result<HeaderMap, ApiFailure> {
    let mut value =
        HeaderValue::from_str(&format!("Bearer {}", key.expose_secret())).map_err(|_| {
            ApiFailure::new(ErrorCode::Internal, "a provider key is not a valid header")
                .detail("reason", "provider_key")
        })?;
    value.set_sensitive(true);
    let mut headers = HeaderMap::new();
    headers.insert(reqwest::header::AUTHORIZATION, value);
    Ok(headers)
}

impl Provider for OpenAiResponses {
    fn style(&self) -> ApiStyle {
        ApiStyle::OpenaiResponses
    }

    fn path(&self) -> &'static str {
        "/v1/responses"
    }

    fn headers(&self, key: &SecretString) -> Result<HeaderMap, ApiFailure> {
        bearer(key)
    }

    fn body(
        &self,
        request: &ChatRequest,
        model: &CatalogModel,
        max_output_tokens: u64,
    ) -> Result<Value, ApiFailure> {
        // `function_call_output` is text here, and an assistant turn carries
        // no image.
        super::images_only_on(request, &[Role::User, Role::System])?;
        let mut input = Vec::new();
        for message in &request.messages {
            match message.role {
                Role::System | Role::User => {
                    let role = if message.role == Role::System {
                        "system"
                    } else {
                        "user"
                    };
                    let content: Vec<Value> = message
                        .content
                        .iter()
                        .map(|part| match part {
                            ContentPart::Text { text } => {
                                json!({"type": "input_text", "text": text})
                            }
                            ContentPart::Image { media_type, data } => json!({
                                "type": "input_image", "image_url": data_url(media_type, data),
                            }),
                        })
                        .collect();
                    input.push(json!({"role": role, "content": content}));
                }
                Role::Assistant => {
                    let content: Vec<Value> = message
                        .content
                        .iter()
                        .filter_map(|part| match part {
                            ContentPart::Text { text } => {
                                Some(json!({"type": "output_text", "text": text}))
                            }
                            // An assistant turn carries no image.
                            ContentPart::Image { .. } => None,
                        })
                        .collect();
                    if !content.is_empty() {
                        input.push(json!({"role": "assistant", "content": content}));
                    }
                    for call in &message.tool_calls {
                        input.push(json!({
                            "type": "function_call", "call_id": call.id,
                            "name": call.name, "arguments": call.arguments,
                        }));
                    }
                }
                Role::Tool => {
                    let mut output = String::new();
                    for part in &message.content {
                        if let ContentPart::Text { text } = part {
                            output.push_str(text);
                        }
                    }
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": message.tool_call_id, "output": output,
                    }));
                }
            }
        }
        let mut body = Map::new();
        body.insert("model".into(), json!(model.provider_model_id));
        body.insert("input".into(), Value::Array(input));
        body.insert("max_output_tokens".into(), json!(max_output_tokens));
        body.insert("stream".into(), json!(true));
        // The gateway keeps no completions (chat-api.md §7); neither should
        // the provider on its behalf.
        body.insert("store".into(), json!(false));
        if !request.tools.is_empty() {
            body.insert(
                "tools".into(),
                Value::Array(
                    request
                        .tools
                        .iter()
                        .map(|tool| {
                            let mut t = Map::new();
                            t.insert("type".into(), json!("function"));
                            t.insert("name".into(), json!(tool.name));
                            if let Some(d) = &tool.description {
                                t.insert("description".into(), json!(d));
                            }
                            t.insert("parameters".into(), tool.parameters.clone());
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

#[derive(Debug, Default)]
struct Parser {
    hosted_tool_calls: u64,
    function_calls: u64,
    terminal: Option<Terminal>,
}

#[derive(Debug)]
struct Terminal {
    finish_reason: Option<FinishReason>,
    usage: Option<Usage>,
    hosted_tool_calls: Option<u64>,
    failure: Option<ProviderFailure>,
}

fn usage_of(response: &Value) -> Result<Option<Usage>, Malformed> {
    let Some(usage) = response.get("usage").filter(|u| !u.is_null()) else {
        return Ok(None);
    };
    let input = count(usage.get("input_tokens"), "usage.input_tokens")?
        .ok_or(Malformed("usage without input_tokens"))?;
    let output = count(usage.get("output_tokens"), "usage.output_tokens")?
        .ok_or(Malformed("usage without output_tokens"))?;
    let cached = count(
        usage
            .get("input_tokens_details")
            .and_then(|d| d.get("cached_tokens")),
        "usage.input_tokens_details.cached_tokens",
    )?
    .unwrap_or(0);
    let reasoning = count(
        usage
            .get("output_tokens_details")
            .and_then(|d| d.get("reasoning_tokens")),
        "usage.output_tokens_details.reasoning_tokens",
    )?
    .unwrap_or(0);
    if cached > input || reasoning > output {
        // A subset larger than its whole: the arithmetic below would invent
        // or lose tokens.
        return Err(Malformed("usage subset exceeds its total"));
    }
    Ok(Some(Usage {
        input_tokens: input.saturating_sub(cached),
        cached_input_tokens: cached,
        cache_write_tokens: 0,
        output_tokens: output,
        reasoning_tokens: reasoning,
        images: 0,
        tool_calls: 0,
    }))
}

fn hosted_calls_in(response: &Value) -> Option<u64> {
    let output = response.get("output")?.as_array()?;
    Some(
        output
            .iter()
            .filter(|item| {
                item.get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|t| HOSTED_TOOL_ITEMS.contains(&t))
            })
            .fold(0u64, |n, _| n.saturating_add(1)),
    )
}

impl StreamParser for Parser {
    fn feed(&mut self, event: &SseEvent, out: &mut Vec<Content>) -> Result<Step, Malformed> {
        if event.data.is_empty() {
            return Ok(Step::Continue);
        }
        let data: Value =
            serde_json::from_str(&event.data).map_err(|_| Malformed("event data is not JSON"))?;
        let kind = data
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(event.event.as_str());
        match kind {
            // A refusal is the model's answer, shown like any other text;
            // the turn still ends in one of the three terminal events.
            "response.output_text.delta" | "response.refusal.delta" => {
                let text = data
                    .get("delta")
                    .and_then(Value::as_str)
                    .ok_or(Malformed("delta"))?;
                if !text.is_empty() {
                    out.push(Content::Text(text.to_owned()));
                }
            }
            "response.output_item.done" => {
                let item = data.get("item").ok_or(Malformed("output_item.done item"))?;
                match item.get("type").and_then(Value::as_str) {
                    Some("function_call") => {
                        self.function_calls = self.function_calls.saturating_add(1);
                        let field =
                            |k: &str| item.get(k).and_then(Value::as_str).map(str::to_owned);
                        out.push(Content::ToolCall(ToolCall {
                            id: field("call_id").ok_or(Malformed("function_call call_id"))?,
                            name: field("name").ok_or(Malformed("function_call name"))?,
                            arguments: field("arguments").unwrap_or_default(),
                        }));
                    }
                    Some(t) if HOSTED_TOOL_ITEMS.contains(&t) => {
                        self.hosted_tool_calls = self.hosted_tool_calls.saturating_add(1);
                    }
                    _ => {}
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                let response = data
                    .get("response")
                    .ok_or(Malformed("terminal without response"))?;
                let (finish_reason, failure) = match kind {
                    // Responses has no separate stop reason for a turn that
                    // ended in function calls; the output items say so.
                    "response.completed" if self.function_calls > 0 => {
                        (Some(FinishReason::ToolCalls), None)
                    }
                    "response.completed" => (Some(FinishReason::Stop), None),
                    "response.incomplete" => {
                        let reason = response
                            .get("incomplete_details")
                            .and_then(|d| d.get("reason"))
                            .and_then(Value::as_str);
                        let finish = if reason == Some("content_filter") {
                            FinishReason::ContentFilter
                        } else {
                            // `max_output_tokens`, and any reason newer than
                            // this adapter: the output was cut short.
                            FinishReason::Length
                        };
                        (Some(finish), None)
                    }
                    _ => {
                        let code = response
                            .get("error")
                            .and_then(|e| e.get("code"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        (
                            None,
                            Some(ProviderFailure {
                                code: ErrorCode::ProviderError,
                                reason: "stream_error",
                                status: None,
                                retryable: retryable_error_type(code),
                                retry_after: None,
                                phase: Phase::BeforeContent,
                            }),
                        )
                    }
                };
                self.terminal = Some(Terminal {
                    finish_reason,
                    usage: usage_of(response)?,
                    hosted_tool_calls: hosted_calls_in(response),
                    failure,
                });
                return Ok(Step::Terminal);
            }
            "error" => {
                let code = data.get("code").and_then(Value::as_str).unwrap_or_default();
                self.terminal = Some(Terminal {
                    finish_reason: None,
                    usage: None,
                    hosted_tool_calls: None,
                    failure: Some(ProviderFailure::new(
                        ErrorCode::ProviderError,
                        "stream_error",
                        retryable_error_type(code),
                    )),
                });
                return Ok(Step::Terminal);
            }
            _ => {}
        }
        Ok(Step::Continue)
    }

    fn end(&mut self, _terminal: bool) -> Ending {
        let Some(terminal) = self.terminal.take() else {
            return Ending {
                finish_reason: None,
                usage: UsageReport::Missing { partial: None },
                cache_write_1h_tokens: 0,
                failure: Some(ProviderFailure::new(
                    ErrorCode::ProviderError,
                    "truncated",
                    true,
                )),
            };
        };
        let hosted = terminal.hosted_tool_calls.unwrap_or(self.hosted_tool_calls);
        Ending {
            finish_reason: terminal.finish_reason,
            usage: match terminal.usage {
                Some(usage) => UsageReport::Reported(Usage {
                    tool_calls: hosted,
                    ..usage
                }),
                None => UsageReport::Missing { partial: None },
            },
            cache_write_1h_tokens: 0,
            failure: terminal.failure,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(p: &mut Parser, data: Value) -> Result<Step, Malformed> {
        let mut out = Vec::new();
        p.feed(
            &SseEvent {
                event: String::new(),
                data: data.to_string(),
            },
            &mut out,
        )
    }

    #[test]
    fn incomplete_is_a_terminal_with_usage() {
        let mut p = Parser::default();
        let step = feed(
            &mut p,
            json!({"type":"response.incomplete","response":{
                "status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},
                "output":[],
                "usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":20},
                         "output_tokens":30,"output_tokens_details":{"reasoning_tokens":12}}}}),
        )
        .unwrap();
        assert_eq!(step, Step::Terminal);
        let end = p.end(true);
        assert_eq!(end.finish_reason, Some(FinishReason::Length));
        assert_eq!(
            end.usage,
            UsageReport::Reported(Usage {
                input_tokens: 30,
                cached_input_tokens: 20,
                output_tokens: 30,
                reasoning_tokens: 12,
                ..Usage::default()
            })
        );
    }

    #[test]
    fn a_null_usage_is_missing_and_a_subset_above_its_total_is_malformed() {
        let mut p = Parser::default();
        feed(
            &mut p,
            json!({"type":"response.completed","response":{"usage":null}}),
        )
        .unwrap();
        assert_eq!(p.end(true).usage, UsageReport::Missing { partial: None });

        let mut p = Parser::default();
        let bad = feed(
            &mut p,
            json!({"type":"response.completed","response":{"usage":{
                "input_tokens":5,"input_tokens_details":{"cached_tokens":6},"output_tokens":1}}}),
        );
        assert!(bad.is_err());
    }

    #[test]
    fn hosted_tool_items_are_billed_calls() {
        let mut p = Parser::default();
        feed(
            &mut p,
            json!({"type":"response.completed","response":{
                "output":[{"type":"web_search_call"},{"type":"function_call"},{"type":"message"}],
                "usage":{"input_tokens":1,"output_tokens":1}}}),
        )
        .unwrap();
        assert_eq!(p.end(true).usage.reported().map(|u| u.tool_calls), Some(1));
    }
}
