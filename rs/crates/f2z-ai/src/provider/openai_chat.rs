//! Chat Completions (`POST /v1/chat/completions`, `stream: true`) — xAI and
//! other OpenAI-compatible providers.
//!
//! # Usage
//!
//! A streamed Chat Completion reports usage **only** when the request sets
//! `stream_options.include_usage: true`; then one extra chunk with
//! `choices: []` carries it just before `data: [DONE]`. This adapter always
//! sets it. A stream that ends without that chunk is
//! [`UsageReport::Missing`].
//!
//! `prompt_tokens` includes disjoint `prompt_tokens_details.cached_tokens`
//! and `cache_write_tokens` subsets. Missing cache fields on legacy responses
//! mean zero. See the [official usage schema](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
//! What `completion_tokens` means differs by provider, and getting it wrong
//! under-charges every reasoning call:
//!
//! * OpenAI: `completion_tokens` **includes** `reasoning_tokens`;
//!   `total_tokens = prompt + completion`.
//! * xAI: `completion_tokens` **excludes** `reasoning_tokens`;
//!   `total_tokens = prompt + completion + reasoning`.
//!
//! The configured [`UsageConvention`] is the default, but the usage chunk
//! decides when it can: if `total_tokens` agrees with exactly one reading,
//! that reading is used, whatever was configured. Only when `total_tokens` is
//! absent or matches neither does the configuration decide, and then the
//! disagreement is logged. The two readings agree whenever
//! `reasoning_tokens` is `0`.
//!
//! # Content
//!
//! `choices[0].delta.content` → `delta`. `delta.tool_calls` arrive as
//! fragments keyed by `index` (the first carries `id` and `function.name`,
//! later ones `function.arguments` pieces); they are assembled and emitted as
//! complete `tool_call`s, in index order, when the choice's `finish_reason`
//! arrives. A stream cut before that emits none of them.

use std::collections::BTreeMap;

use f2z_ai_proto::catalog::{ApiStyle, CatalogModel};
use f2z_ai_proto::chat::{
    ChatRequest, ContentPart, FinishReason, ResponseFormat, Role, ToolCall, Usage,
};
use f2z_ai_proto::{ErrorCode, OrderedJson};
use reqwest::header::HeaderMap;
use secrecy::SecretString;
use serde_json::{Map, Value, json};

use super::openai_responses::bearer;
use super::sse::SseEvent;
use super::{
    Content, Ending, Malformed, Provider, ProviderFailure, Step, StreamParser, UsageReport, count,
    data_url, retryable_error_type,
};
use crate::error::ApiFailure;

/// What `completion_tokens` counts, when the usage chunk cannot say.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UsageConvention {
    /// OpenAI: `completion_tokens` includes `reasoning_tokens`.
    #[default]
    CompletionIncludesReasoning,
    /// xAI: `completion_tokens` excludes `reasoning_tokens`.
    CompletionExcludesReasoning,
}

/// The Chat Completions adapter.
#[derive(Clone, Copy, Debug, Default)]
pub struct OpenAiChat {
    convention: UsageConvention,
}

impl OpenAiChat {
    /// An adapter reading `completion_tokens` by `convention` when the usage
    /// chunk is ambiguous.
    #[must_use]
    pub const fn new(convention: UsageConvention) -> Self {
        Self { convention }
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

impl Provider for OpenAiChat {
    fn style(&self) -> ApiStyle {
        ApiStyle::OpenaiChat
    }

    fn path(&self) -> &'static str {
        "/v1/chat/completions"
    }

    fn headers(&self, key: &SecretString) -> Result<HeaderMap, ApiFailure> {
        bearer(key)
    }

    fn body(
        &self,
        request: &ChatRequest,
        model: &CatalogModel,
        max_output_tokens: u64,
    ) -> Result<OrderedJson, ApiFailure> {
        // A system or tool message is text here, and an assistant turn
        // carries no image.
        super::images_only_on(request, &[Role::User])?;
        super::check_response_format(request, model)?;
        // No tool_choice / parallel_tool_calls translation here yet: refused,
        // never dropped.
        super::check_tool_translation(request, model)?;
        let messages: Vec<Value> = request
            .messages
            .iter()
            .map(|message| match message.role {
                Role::System => json!({"role": "system", "content": text_of(&message.content)}),
                Role::User => {
                    let content: Vec<Value> = message
                        .content
                        .iter()
                        .map(|part| match part {
                            ContentPart::Text { text } => json!({"type": "text", "text": text}),
                            ContentPart::Image { media_type, data } => json!({
                                "type": "image_url",
                                "image_url": {"url": data_url(media_type, data)},
                            }),
                        })
                        .collect();
                    json!({"role": "user", "content": content})
                }
                Role::Assistant => {
                    let mut m = Map::new();
                    m.insert("role".into(), json!("assistant"));
                    let text = text_of(&message.content);
                    m.insert(
                        "content".into(),
                        if text.is_empty() && !message.tool_calls.is_empty() {
                            Value::Null
                        } else {
                            json!(text)
                        },
                    );
                    if !message.tool_calls.is_empty() {
                        m.insert(
                            "tool_calls".into(),
                            Value::Array(
                                message
                                    .tool_calls
                                    .iter()
                                    .map(|c| {
                                        json!({"id": c.id, "type": "function",
                                               "function": {"name": c.name, "arguments": c.arguments}})
                                    })
                                    .collect(),
                            ),
                        );
                    }
                    Value::Object(m)
                }
                Role::Tool => json!({
                    "role": "tool", "tool_call_id": message.tool_call_id,
                    "content": text_of(&message.content),
                }),
            })
            .collect();
        let mut body = Map::new();
        body.insert("model".into(), json!(model.provider_model_id));
        // Signed prices describe standard processing; omission would select
        // the OpenAI project's mutable default (including premium tiers).
        if model.provider == "openai" {
            body.insert("service_tier".into(), json!("default"));
        }
        body.insert("messages".into(), Value::Array(messages));
        body.insert("max_completion_tokens".into(), json!(max_output_tokens));
        body.insert("stream".into(), json!(true));
        // Without this a streamed Chat Completion reports no usage at all.
        body.insert("stream_options".into(), json!({"include_usage": true}));
        let mut caller = Vec::new();
        if !request.tools.is_empty() {
            caller.push((
                "tools",
                OrderedJson::array(request.tools.iter().map(|tool| {
                    OrderedJson::object([
                        ("type", OrderedJson::from("function")),
                        (
                            "function",
                            OrderedJson::object(super::tool_members(tool, "parameters")),
                        ),
                    ])
                })),
            ));
        }
        if let Some(format) = &request.response_format {
            // The unified shape IS Chat Completions' shape; it is rebuilt
            // member by member anyway, so nothing the proto type does not
            // name can reach the provider. The schema itself goes as the
            // caller ordered it (zuu#1132): OpenAI emits the reply's keys in
            // schema order.
            let wire = match format {
                ResponseFormat::JsonObject {} => {
                    OrderedJson::object([("type", OrderedJson::from("json_object"))])
                }
                ResponseFormat::JsonSchema { json_schema } => {
                    let mut schema = vec![
                        ("name", OrderedJson::from(json_schema.name.as_str())),
                        ("schema", json_schema.schema.clone()),
                    ];
                    if let Some(strict) = json_schema.strict {
                        schema.push(("strict", OrderedJson::from(strict)));
                    }
                    OrderedJson::object([
                        ("type", OrderedJson::from("json_schema")),
                        ("json_schema", OrderedJson::object(schema)),
                    ])
                }
            };
            caller.push(("response_format", wire));
        }
        Ok(super::ordered_body(body, caller))
    }

    fn parser(&self) -> Box<dyn StreamParser> {
        Box::new(Parser {
            convention: self.convention,
            ..Parser::default()
        })
    }
}

#[derive(Debug, Default)]
struct PendingTool {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Default)]
struct Parser {
    convention: UsageConvention,
    tools: BTreeMap<u64, PendingTool>,
    /// The index the previous fragment went to.
    last_index: Option<u64>,
    /// Argument and name bytes buffered across every pending tool call.
    pending_bytes: usize,
    finish_reason: Option<FinishReason>,
    usage: Option<Usage>,
    failure: Option<ProviderFailure>,
    done: bool,
}

/// Normalise a Chat Completions `usage` object.
fn usage_of(usage: &Value, convention: UsageConvention) -> Result<Usage, Malformed> {
    let prompt = count(usage.get("prompt_tokens"), "usage.prompt_tokens")?
        .ok_or(Malformed("usage without prompt_tokens"))?;
    let completion = count(usage.get("completion_tokens"), "usage.completion_tokens")?
        .ok_or(Malformed("usage without completion_tokens"))?;
    let total = count(usage.get("total_tokens"), "usage.total_tokens")?;
    let cached = count(
        usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens")),
        "usage.prompt_tokens_details.cached_tokens",
    )?
    .unwrap_or(0);
    let written = count(
        usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cache_write_tokens")),
        "usage.prompt_tokens_details.cache_write_tokens",
    )?
    .unwrap_or(0);
    // Both cache counts are disjoint subsets of the provider's total input.
    // Chained subtraction also rejects a sum that would overflow u64.
    let ordinary = prompt
        .checked_sub(cached)
        .and_then(|rest| rest.checked_sub(written))
        .ok_or(Malformed("cache token subsets exceed input total"))?;
    let reasoning = count(
        usage
            .get("completion_tokens_details")
            .and_then(|d| d.get("reasoning_tokens")),
        "usage.completion_tokens_details.reasoning_tokens",
    )?
    .unwrap_or(0);
    if cached > prompt {
        return Err(Malformed("cached_tokens exceeds prompt_tokens"));
    }
    let including = prompt.checked_add(completion);
    let excluding = including.and_then(|n| n.checked_add(reasoning));
    let convention = match total {
        Some(t) if Some(t) == including && Some(t) != excluding => {
            UsageConvention::CompletionIncludesReasoning
        }
        Some(t) if Some(t) == excluding && Some(t) != including => {
            UsageConvention::CompletionExcludesReasoning
        }
        Some(_) if reasoning > 0 && including != excluding => {
            tracing::warn!(
                reasoning_tokens = reasoning,
                "chat usage total_tokens matches neither reasoning convention; using the configured one"
            );
            convention
        }
        _ => convention,
    };
    let output = match convention {
        UsageConvention::CompletionIncludesReasoning => {
            if reasoning > completion {
                return Err(Malformed("reasoning_tokens exceeds completion_tokens"));
            }
            completion
        }
        UsageConvention::CompletionExcludesReasoning => completion
            .checked_add(reasoning)
            .ok_or(Malformed("output overflows"))?,
    };
    Ok(Usage {
        input_tokens: ordinary,
        cached_input_tokens: cached,
        cache_write_tokens: written,
        output_tokens: output,
        reasoning_tokens: reasoning,
        images: 0,
        tool_calls: 0,
    })
}

fn finish_reason(reason: &str) -> FinishReason {
    match reason {
        "length" => FinishReason::Length,
        "tool_calls" | "function_call" => FinishReason::ToolCalls,
        "content_filter" => FinishReason::ContentFilter,
        _ => FinishReason::Stop,
    }
}

impl Parser {
    /// Where a tool-call fragment belongs. With an `index`, there. Without
    /// one (some compatible providers omit it): a fragment carrying a new
    /// `id` starts the next call, and one without an `id` continues the
    /// previous call — never merged into call `0` by default.
    fn fragment_index(&self, index: Option<u64>, id: Option<&str>) -> u64 {
        if let Some(index) = index {
            return index;
        }
        let Some(last) = self.last_index else {
            return self
                .tools
                .keys()
                .next_back()
                .map_or(0, |k| k.saturating_add(1));
        };
        match (id, self.tools.get(&last)) {
            (Some(id), Some(tool)) if !tool.id.is_empty() && tool.id != id => {
                last.saturating_add(1)
            }
            _ => last,
        }
    }

    fn flush_tools(&mut self, out: &mut Vec<Content>) {
        self.pending_bytes = 0;
        for (_, tool) in std::mem::take(&mut self.tools) {
            out.push(Content::ToolCall(ToolCall {
                id: tool.id,
                name: tool.name,
                arguments: tool.arguments,
            }));
        }
    }
}

impl StreamParser for Parser {
    fn feed(&mut self, event: &SseEvent, out: &mut Vec<Content>) -> Result<Step, Malformed> {
        let data = event.data.trim();
        if data.is_empty() {
            return Ok(Step::Continue);
        }
        if data == "[DONE]" {
            self.done = true;
            self.flush_tools(out);
            return Ok(Step::Terminal);
        }
        let chunk: Value =
            serde_json::from_str(data).map_err(|_| Malformed("chunk is not JSON"))?;
        if let Some(error) = chunk.get("error").filter(|e| !e.is_null()) {
            let kind = error
                .get("type")
                .and_then(Value::as_str)
                .or_else(|| error.get("code").and_then(Value::as_str))
                .unwrap_or_default();
            self.failure = Some(ProviderFailure::new(
                ErrorCode::ProviderError,
                "stream_error",
                retryable_error_type(kind),
            ));
            return Ok(Step::Terminal);
        }
        if let Some(choices) = chunk.get("choices").and_then(Value::as_array) {
            for choice in choices {
                // One choice is requested; any other index is not ours.
                if choice.get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
                    continue;
                }
                if let Some(delta) = choice.get("delta") {
                    // A refusal is the model's answer, streamed like text.
                    for field in ["content", "refusal"] {
                        if let Some(text) = delta.get(field).and_then(Value::as_str)
                            && !text.is_empty()
                        {
                            out.push(Content::Text(text.to_owned()));
                        }
                    }
                    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                        for call in calls {
                            let id = call.get("id").and_then(Value::as_str);
                            let index =
                                self.fragment_index(call.get("index").and_then(Value::as_u64), id);
                            self.last_index = Some(index);
                            if !self.tools.contains_key(&index)
                                && self.tools.len() >= super::MAX_PENDING_TOOLS
                            {
                                return Err(Malformed("too many pending tool calls"));
                            }
                            let added = call.get("function").map_or(0, |f| {
                                f.get("arguments")
                                    .and_then(Value::as_str)
                                    .map_or(0, str::len)
                                    .saturating_add(
                                        f.get("name").and_then(Value::as_str).map_or(0, str::len),
                                    )
                            });
                            self.pending_bytes = self.pending_bytes.saturating_add(added);
                            if self.pending_bytes > super::MAX_PENDING_TOOL_BYTES {
                                return Err(Malformed("tool call arguments too large"));
                            }
                            let tool = self.tools.entry(index).or_default();
                            if let Some(id) = id {
                                id.clone_into(&mut tool.id);
                            }
                            let function = call.get("function");
                            if let Some(name) =
                                function.and_then(|f| f.get("name")).and_then(Value::as_str)
                            {
                                // OpenAI sends the name once; some compatible
                                // providers repeat it whole on every fragment.
                                // A repeat is not a second half.
                                if tool.name != name {
                                    tool.name.push_str(name);
                                }
                            }
                            if let Some(args) = function
                                .and_then(|f| f.get("arguments"))
                                .and_then(Value::as_str)
                            {
                                tool.arguments.push_str(args);
                            }
                        }
                    }
                }
                if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                    self.finish_reason = Some(finish_reason(reason));
                    self.flush_tools(out);
                }
            }
        }
        if let Some(usage) = chunk.get("usage").filter(|u| !u.is_null()) {
            self.usage = Some(usage_of(usage, self.convention)?);
        }
        Ok(Step::Continue)
    }

    fn end(&mut self, _terminal: bool) -> Ending {
        // `[DONE]` is the terminal; a body that ended after the choice's
        // finish_reason and the usage chunk without it lost nothing that is
        // billed, so it is not a failure. One that ended before the
        // finish_reason was cut.
        let failure = self.failure.clone().or_else(|| {
            (!self.done && self.finish_reason.is_none())
                .then(|| ProviderFailure::new(ErrorCode::ProviderError, "truncated", true))
        });
        Ending {
            finish_reason: if failure.is_some() {
                None
            } else {
                self.finish_reason
            },
            usage: match self.usage {
                Some(u) => UsageReport::Reported(u),
                None => UsageReport::Missing { partial: None },
            },
            cache_write_1h_tokens: 0,
            failure,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_writes_are_exclusive_and_charge_at_the_write_rate() {
        // Official wire fields; input is ordinary + cache reads + cache writes.
        let wire = json!({"prompt_tokens":100,"completion_tokens":4,
            "prompt_tokens_details":{"cached_tokens":20,"cache_write_tokens":30}});
        let usage = usage_of(&wire, UsageConvention::CompletionIncludesReasoning).unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.cached_input_tokens,
                usage.cache_write_tokens
            ),
            (50, 20, 30)
        );
        let prices = f2z_ai_proto::pricing::ModelPrices {
            input_nusd_per_mtok: 2_000_000_000,
            cached_input_nusd_per_mtok: 200_000_000,
            cache_write_nusd_per_mtok: 2_500_000_000,
            output_nusd_per_mtok: 10_000_000_000,
            ..Default::default()
        };
        assert_eq!(
            f2z_ai_proto::pricing::metered_cost_nusd(&usage, &prices)
                .unwrap()
                .get(),
            219_000
        );
    }

    #[test]
    fn impossible_or_malformed_cache_writes_are_rejected() {
        for (input, cached, written) in [
            (100_u64, 20_u64, json!(81)),
            (100, 0, json!(101)),
            (u64::MAX, u64::MAX, json!(1)),
            (100, 0, json!(-1)),
            (100, 0, json!(1.5)),
            (100, 0, json!("30")),
        ] {
            let wire = json!({"prompt_tokens":input,"completion_tokens":4,
                "prompt_tokens_details":{"cached_tokens":cached,"cache_write_tokens":written}});
            assert!(
                usage_of(&wire, UsageConvention::CompletionIncludesReasoning).is_err(),
                "accepted invalid cache usage: {wire}"
            );
        }
    }

    #[test]
    fn total_tokens_decides_the_reasoning_convention() {
        let xai = json!({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 23,
                         "completion_tokens_details": {"reasoning_tokens": 8}});
        for configured in [
            UsageConvention::CompletionIncludesReasoning,
            UsageConvention::CompletionExcludesReasoning,
        ] {
            assert_eq!(usage_of(&xai, configured).unwrap().output_tokens, 13);
        }
        let openai = json!({"prompt_tokens": 10, "completion_tokens": 13, "total_tokens": 23,
                            "completion_tokens_details": {"reasoning_tokens": 8}});
        for configured in [
            UsageConvention::CompletionIncludesReasoning,
            UsageConvention::CompletionExcludesReasoning,
        ] {
            assert_eq!(usage_of(&openai, configured).unwrap().output_tokens, 13);
        }
        let no_total = json!({"prompt_tokens": 10, "completion_tokens": 5,
                              "completion_tokens_details": {"reasoning_tokens": 8}});
        assert_eq!(
            usage_of(&no_total, UsageConvention::CompletionExcludesReasoning)
                .unwrap()
                .output_tokens,
            13
        );
    }

    #[test]
    fn fragments_without_an_index_or_with_a_repeated_name_assemble_correctly() {
        let mut p = Parser::default();
        let mut out = Vec::new();
        for chunk in [
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"id":"a","function":{"name":"f","arguments":"{\"x\""}}]}}]}),
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"name":"f","arguments":":1}"}}]}}]}),
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"id":"b","function":{"name":"g","arguments":"{}"}}]}}]}),
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
        ] {
            p.feed(
                &SseEvent {
                    event: String::new(),
                    data: chunk.to_string(),
                },
                &mut out,
            )
            .unwrap();
        }
        assert_eq!(
            out,
            vec![
                Content::ToolCall(ToolCall {
                    id: "a".into(),
                    name: "f".into(),
                    arguments: "{\"x\":1}".into()
                }),
                Content::ToolCall(ToolCall {
                    id: "b".into(),
                    name: "g".into(),
                    arguments: "{}".into()
                }),
            ]
        );
    }

    #[test]
    fn a_refusal_is_streamed_as_text() {
        let mut p = Parser::default();
        let mut out = Vec::new();
        p.feed(
            &SseEvent {
                event: String::new(),
                data: json!({"choices":[{"index":0,"delta":{"refusal":"I can't."}}]}).to_string(),
            },
            &mut out,
        )
        .unwrap();
        assert_eq!(out, vec![Content::Text("I can't.".into())]);
    }

    #[test]
    fn tool_call_fragments_become_one_call_at_the_finish() {
        let mut p = Parser::default();
        let mut out = Vec::new();
        for chunk in [
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":""}}]}}]}),
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"a\""}}]}}]}),
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}),
        ] {
            p.feed(
                &SseEvent {
                    event: String::new(),
                    data: chunk.to_string(),
                },
                &mut out,
            )
            .unwrap();
        }
        assert!(out.is_empty());
        p.feed(
            &SseEvent {
                event: String::new(),
                data: json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
                    .to_string(),
            },
            &mut out,
        )
        .unwrap();
        assert_eq!(
            out,
            vec![Content::ToolCall(ToolCall {
                id: "call_1".into(),
                name: "f".into(),
                arguments: "{\"a\":1}".into()
            })]
        );
    }
}
