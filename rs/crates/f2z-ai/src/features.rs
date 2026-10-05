//! Which request features a call asked for — never what they contained.
//!
//! On 2026-10-05 a third-party app reported output that violated its strict
//! `response_format` json_schema, and nothing durable could answer "did the
//! client send `response_format` at all?": the call record held only the
//! model, provider, catalogue version and `metadata`, and the `response` log
//! line only route, status and latency. [`RequestFeatures`] is that answer,
//! recorded on the ledger's call claim (when
//! [`crate::config::Config::ledger_features_meta`] is on) and on the
//! `response` log line of `route=chat` and `route=estimate`.
//!
//! **Content-free by construction.** Every member is a closed enum, a
//! boolean, a count, or the schema's *name*, re-checked here against the same
//! `[A-Za-z0-9_-]{1,64}` rule `ResponseFormat::check` enforces (anything else
//! is recorded as absent). No schema body, no prompt, no tool definition, no
//! free text. The ledger (`ledger.gateway_metadata_valid`, tuzi migration
//! `0006_call_features`) refuses any other shape.

use f2z_ai_proto::chat::{ChatRequest, MAX_RESPONSE_SCHEMA_NAME_CHARS, ResponseFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The largest count recorded: the ledger's bound (`2^31 - 1`).
const MAX_COUNT: u32 = 2_147_483_647;

/// `response_format.type`, when one was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseFormatKind {
    /// `{"type":"json_schema", …}`.
    JsonSchema,
    /// `{"type":"json_object"}`.
    JsonObject,
}

impl ResponseFormatKind {
    /// The wire name, for a log field.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::JsonSchema => "json_schema",
            Self::JsonObject => "json_object",
        }
    }
}

/// The per-call `features` object. Every member is always present on the
/// wire (`null` where absent), exactly as the ledger requires.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestFeatures {
    /// `response_format.type`, or `None` when the request sent none.
    pub response_format: Option<ResponseFormatKind>,
    /// `response_format.json_schema.strict` as sent; `None` when absent.
    pub response_format_strict: Option<bool>,
    /// `response_format.json_schema.name`; `None` when absent.
    pub response_format_schema_name: Option<String>,
    /// Compact serialized size of `response_format.json_schema.schema`, in
    /// bytes; `0` when absent.
    pub response_format_schema_bytes: u32,
    /// `tools.len()`.
    pub tools: u32,
    /// `max_output_tokens_strict`.
    pub max_output_tokens_strict: bool,
    /// `stream`.
    pub stream: bool,
    /// `fallback.len()`.
    pub fallback: u32,
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(MAX_COUNT).min(MAX_COUNT)
}

fn schema_name(name: &str) -> Option<String> {
    let valid = !name.is_empty()
        && name.len() <= MAX_RESPONSE_SCHEMA_NAME_CHARS
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    valid.then(|| name.to_owned())
}

impl RequestFeatures {
    /// Describe `request`. Never fails and never copies content.
    #[must_use]
    pub fn of(request: &ChatRequest) -> Self {
        let (response_format, strict, name, bytes) = match &request.response_format {
            None => (None, None, None, 0),
            Some(ResponseFormat::JsonObject {}) => {
                (Some(ResponseFormatKind::JsonObject), None, None, 0)
            }
            Some(ResponseFormat::JsonSchema { json_schema }) => (
                Some(ResponseFormatKind::JsonSchema),
                json_schema.strict,
                schema_name(&json_schema.name),
                serde_json::to_vec(&json_schema.schema).map_or(0, |b| count(b.len())),
            ),
        };
        Self {
            response_format,
            response_format_strict: strict,
            response_format_schema_name: name,
            response_format_schema_bytes: bytes,
            tools: count(request.tools.len()),
            max_output_tokens_strict: request.max_output_tokens_strict,
            stream: request.stream,
            fallback: count(request.fallback.len()),
        }
    }

    /// The ledger/call-record JSON object.
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// Read back a stored object; `None` unless it has exactly this shape.
    #[must_use]
    pub fn from_json(value: &Value) -> Option<Self> {
        let parsed: Self = serde_json::from_value(value.clone()).ok()?;
        (parsed
            .response_format_schema_name
            .as_deref()
            .is_none_or(|n| schema_name(n).is_some())
            && parsed.tools <= MAX_COUNT
            && parsed.fallback <= MAX_COUNT
            && parsed.response_format_schema_bytes <= MAX_COUNT)
            .then_some(parsed)
    }
}

/// What the `response` log line of a chat or estimate request carries,
/// attached to the response as an extension by [`crate::chat::handle`].
#[derive(Clone, Debug)]
pub struct Logged {
    /// The decoded request's features.
    pub features: RequestFeatures,
    /// The call id, when one was assigned or recovered (always a UUID).
    pub call_id: Option<uuid::Uuid>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(body: Value) -> ChatRequest {
        serde_json::from_value(body).unwrap()
    }

    #[test]
    fn a_strict_json_schema_is_described_without_its_content() {
        let schema = json!({"type":"object","properties":{"secret_field":{"type":"string"}}});
        let r = request(json!({
            "model":"m","messages":[{"role":"user","content":[{"type":"text","text":"the prompt"}]}],
            "response_format":{"type":"json_schema","json_schema":{"name":"activity_spec","schema":schema,"strict":true}},
            "fallback":["a","b"],"stream":false,
        }));
        let f = RequestFeatures::of(&r);
        let expected_bytes = serde_json::to_vec(&schema).unwrap().len();
        assert_eq!(
            f.to_json(),
            json!({"response_format":"json_schema","response_format_strict":true,
                   "response_format_schema_name":"activity_spec",
                   "response_format_schema_bytes":expected_bytes,"tools":0,
                   "max_output_tokens_strict":false,"stream":false,"fallback":2})
        );
        let text = f.to_json().to_string();
        assert!(!text.contains("secret_field") && !text.contains("the prompt"));
        assert_eq!(RequestFeatures::from_json(&f.to_json()), Some(f));
    }

    #[test]
    fn absent_features_are_nulls_and_zeros() {
        let r = request(
            json!({"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}]}),
        );
        assert_eq!(
            RequestFeatures::of(&r).to_json(),
            json!({"response_format":null,"response_format_strict":null,
                   "response_format_schema_name":null,"response_format_schema_bytes":0,
                   "tools":0,"max_output_tokens_strict":false,"stream":true,"fallback":0})
        );
        let o = request(
            json!({"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"JSON"}]}],
            "response_format":{"type":"json_object"}}),
        );
        assert_eq!(
            RequestFeatures::of(&o).response_format,
            Some(ResponseFormatKind::JsonObject)
        );
    }

    #[test]
    fn a_name_outside_the_rule_is_never_recorded() {
        assert_eq!(schema_name("has space"), None);
        assert_eq!(schema_name(""), None);
        assert_eq!(schema_name(&"a".repeat(65)), None);
        assert_eq!(schema_name("ok_Name-9").as_deref(), Some("ok_Name-9"));
    }

    #[test]
    fn a_stored_object_of_another_shape_is_not_projected() {
        let mut v = RequestFeatures::of(&request(
            json!({"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}]}),
        ))
        .to_json();
        v["prompt"] = json!("leak");
        assert_eq!(RequestFeatures::from_json(&v), None);
        assert_eq!(RequestFeatures::from_json(&json!("json_schema")), None);
        let mut bad = RequestFeatures::of(&request(
            json!({"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}]}),
        ))
        .to_json();
        bad["response_format_schema_name"] = json!("has space");
        assert_eq!(RequestFeatures::from_json(&bad), None);
    }
}
