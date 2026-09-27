//! Shared test helpers: an SSE splitter and a *reference adapter* that reads
//! usage out of a stream by each provider's published conventions — written
//! independently of the mock's renderer, so agreement between the two is
//! evidence rather than a tautology.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_ai_proto::Usage;
use f2z_ai_testkit::mock::{ChatFlavor, ProviderStyle};
use serde_json::Value;

/// One SSE frame: its `event:` name, if any, and its `data:` payload.
#[derive(Clone, Debug)]
pub struct Frame {
    pub event: Option<String>,
    pub data: String,
}

impl Frame {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.data)
            .unwrap_or_else(|e| panic!("frame data is not JSON ({e}): {}", self.data))
    }
}

/// Split a complete SSE body into frames. Panics on a partial trailing frame:
/// callers that expect truncation split by hand.
pub fn frames(bytes: &[u8]) -> Vec<Frame> {
    let text = std::str::from_utf8(bytes).unwrap();
    assert!(
        text.is_empty() || text.ends_with("\n\n"),
        "body does not end on a frame boundary"
    );
    text.split("\n\n")
        .filter(|f| !f.is_empty())
        .map(|f| {
            let mut event = None;
            let mut data = String::new();
            for line in f.lines() {
                if let Some(e) = line.strip_prefix("event: ") {
                    event = Some(e.to_owned());
                } else if let Some(d) = line.strip_prefix("data: ") {
                    data = d.to_owned();
                } else {
                    panic!("unexpected SSE line: {line:?}");
                }
            }
            Frame { event, data }
        })
        .collect()
}

fn u(v: &Value, ptr: &str) -> u64 {
    v.pointer(ptr).and_then(Value::as_u64).unwrap_or(0)
}

/// What a correct gateway adapter derives from a complete stream.
pub fn adapter_usage(style: ProviderStyle, flavor: ChatFlavor, body: &[u8]) -> Option<Usage> {
    let fs = frames(body);
    match style {
        ProviderStyle::OpenAiResponses => {
            let done = fs
                .iter()
                .find(|f| f.event.as_deref() == Some("response.completed"))?;
            let usage = done.json().pointer("/response/usage")?.clone();
            if usage.is_null() {
                return None;
            }
            let input = u(&usage, "/input_tokens");
            let cached = u(&usage, "/input_tokens_details/cached_tokens");
            Some(Usage {
                input_tokens: input - cached,
                cached_input_tokens: cached,
                output_tokens: u(&usage, "/output_tokens"),
                reasoning_tokens: u(&usage, "/output_tokens_details/reasoning_tokens"),
                ..Usage::default()
            })
        }
        ProviderStyle::ChatCompletions => {
            let usage = fs
                .iter()
                .filter(|f| f.data != "[DONE]")
                .map(Frame::json)
                .find_map(|v| v.get("usage").filter(|u| !u.is_null()).cloned())?;
            let prompt = u(&usage, "/prompt_tokens");
            let cached = u(&usage, "/prompt_tokens_details/cached_tokens");
            let completion = u(&usage, "/completion_tokens");
            let reasoning = u(&usage, "/completion_tokens_details/reasoning_tokens");
            let output = match flavor {
                ChatFlavor::OpenAi => completion,
                ChatFlavor::Xai => completion + reasoning,
            };
            Some(Usage {
                input_tokens: prompt - cached,
                cached_input_tokens: cached,
                output_tokens: output,
                reasoning_tokens: reasoning,
                ..Usage::default()
            })
        }
        ProviderStyle::AnthropicMessages => {
            let start = fs
                .iter()
                .find(|f| f.event.as_deref() == Some("message_start"))?
                .json();
            let delta = fs
                .iter()
                .find(|f| f.event.as_deref() == Some("message_delta"))?
                .json();
            let out = delta.pointer("/usage/output_tokens")?.as_u64()?;
            Some(Usage {
                input_tokens: u(&start, "/message/usage/input_tokens"),
                cached_input_tokens: u(&start, "/message/usage/cache_read_input_tokens"),
                cache_write_tokens: u(&start, "/message/usage/cache_creation_input_tokens"),
                output_tokens: out,
                ..Usage::default()
            })
        }
    }
}

/// The concatenated visible text of a complete stream.
pub fn visible_text(style: ProviderStyle, body: &[u8]) -> String {
    let mut s = String::new();
    for f in frames(body) {
        match style {
            ProviderStyle::OpenAiResponses => {
                if f.event.as_deref() == Some("response.output_text.delta") {
                    s.push_str(f.json()["delta"].as_str().unwrap());
                }
            }
            ProviderStyle::ChatCompletions => {
                if f.data == "[DONE]" {
                    continue;
                }
                if let Some(c) = f.json().pointer("/choices/0/delta/content") {
                    s.push_str(c.as_str().unwrap());
                }
            }
            ProviderStyle::AnthropicMessages => {
                let v = if f.event.as_deref() == Some("content_block_delta") {
                    f.json()
                } else {
                    continue;
                };
                if v["delta"]["type"] == "text_delta" {
                    s.push_str(v["delta"]["text"].as_str().unwrap());
                }
            }
        }
    }
    s
}
