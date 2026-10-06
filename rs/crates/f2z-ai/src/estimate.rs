//! Token estimates: the **input** estimate that sizes a hold (metering.md
//! §4) and the **output** estimate a call settles on when the provider's
//! usage frame never arrives (metering.md §5.4).
//!
//! # The input estimate
//!
//! For a model whose tokeniser this gateway has — every OpenAI model, by
//! family prefix of `provider_model_id` ([`Encoding::for_model`]) — the
//! estimate is the provider's own BPE run over the prompt, plus the framing
//! OpenAI's Chat Completions API adds per message, per tool definition and
//! per `response_format` schema. The framing constants were **measured
//! against `usage.prompt_tokens` on 2026-10-05** (gpt-4o-mini; gpt-4o counts
//! identically) across 14 schema shapes, 16 tool shapes and the 27 recorded
//! ¡AHA! requests in `tests/fixtures/estimate/`, and `tests/estimate.rs`
//! asserts on every one of them that the estimate is **never below** what
//! the provider billed and never more than a bounded factor above it. The
//! headline: a 28 KB strict schema plus 12 KB of messages, billed at 7,346
//! prompt tokens, was reserved at 46,321 by the byte bound this replaces and
//! is reserved at ~7,900 by this estimate (before the catalogue's
//! `safety_factor_bps`).
//!
//! What was learned, and encoded below:
//!
//! * Message text is exact: `3` tokens per message plus the role word,
//!   plus `3` to prime the reply (the published recipe), the content parts
//!   concatenated with no per-part cost, `name` as its tokens plus one.
//! * A `response_format` JSON schema is **not** billed as its JSON text —
//!   it is rendered to a compact form in which every property key, type
//!   word, description, and enum value appears, and the validation
//!   keywords (`pattern`, `minimum`, `maximum`, `minItems`, …,
//!   `additionalProperties`, `required`) cost nothing. The compact JSON of
//!   the ¡AHA! schema is 8,016 tokens; the provider bills 4,460.
//! * A tool definition is rendered the same way but cheaper per property
//!   (`3` rather than `6`), with `8` per function and `12` once for the
//!   block. A prior tool call in the history costs its name and arguments
//!   plus `8`, and `16` more per call when one assistant message carries
//!   several (the parallel-call wrapper). The call `id` is not rendered.
//!   `tool_choice: required` costs nothing and a named function `8`; both
//!   are reserved at `10`.
//!
//! Every constant is the measured value rounded **up**, so the estimate's
//! error is one-sided: on the recorded corpus it runs 0–8 % high on real
//! prompts and up to a third high on the pathological ones (a schema that is
//! all enum values). The catalogue's `safety_factor_bps` is applied on top
//! by `meter::plan`.
//!
//! For every other provider — and for an OpenAI model id this build does
//! not recognise — the estimate stays the **byte bound** it always was: the
//! UTF-8 length of the serialised messages, tools and schema, plus 64. A
//! byte is never less than a token, so that bound cannot under-reserve; it
//! over-reserves by roughly 4–5× on English text, which is the cost of a
//! provider without a vendored tokeniser.
//!
//! # The output estimate
//!
//! [`output_tokens`] counts what the provider produced — delivered or not —
//! with the model's tokeniser (`o200k_base` as the approximation for a
//! provider without one) and scales it by **11,000 bps**, the factor
//! metering.md §5.4 fixes. Reasoning tokens are not streamed and are not in
//! it: a reasoning model whose usage frame was lost is under-charged, and
//! metering.md §5.4 names that loss the platform's.
//!
//! Nothing here touches a network or a file: the BPE ranks are compiled into
//! the binary (`tiktoken-rs`), and the first use of an encoding pays its
//! ~130 ms table build once per process.

use f2z_ai_proto::{
    catalog::CatalogModel,
    chat::{ChatRequest, ContentPart, ResponseFormat, Role, ToolCall, ToolChoice},
    pricing::{Bps, apply_safety_factor},
};
use serde_json::Value;

/// The BPE a model is tokenised with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    /// gpt-4o and every later OpenAI family (gpt-4.1, gpt-5, gpt-6, o-series).
    O200kBase,
    /// gpt-4 and gpt-3.5.
    Cl100kBase,
}

/// OpenAI families on `o200k_base`, matched as prefixes of the upstream
/// model id. Order matters where one prefix is a prefix of another:
/// `gpt-4o` and `gpt-4.1` are listed before `cl100k`'s `gpt-4`.
const O200K_FAMILIES: &[&str] = &[
    "gpt-4o",
    "chatgpt-4o",
    "gpt-4.1",
    "gpt-5",
    "gpt-6",
    "o1",
    "o3",
    "o4",
];
/// OpenAI families on `cl100k_base`.
const CL100K_FAMILIES: &[&str] = &["gpt-4", "gpt-3.5"];

impl Encoding {
    /// The exact tokeniser for a catalogue model, or `None` when this build
    /// has none for it: a provider other than `openai`, or an OpenAI id
    /// outside the families above. `None` means the byte bound.
    #[must_use]
    pub fn for_model(model: &CatalogModel) -> Option<Self> {
        if model.provider != "openai" {
            return None;
        }
        Self::for_openai_id(&model.provider_model_id)
    }

    /// The tokeniser for an OpenAI model id, by family prefix.
    #[must_use]
    pub fn for_openai_id(id: &str) -> Option<Self> {
        if O200K_FAMILIES.iter().any(|family| id.starts_with(family)) {
            Some(Self::O200kBase)
        } else if CL100K_FAMILIES.iter().any(|family| id.starts_with(family)) {
            Some(Self::Cl100kBase)
        } else {
            None
        }
    }

    fn bpe(self) -> &'static tiktoken_rs::CoreBPE {
        match self {
            Self::O200kBase => tiktoken_rs::o200k_base_singleton(),
            Self::Cl100kBase => tiktoken_rs::cl100k_base_singleton(),
        }
    }

    /// The number of tokens in `text`, with special-token spellings
    /// (`<|endoftext|>`) treated as ordinary text — the way the API treats
    /// user content.
    #[must_use]
    pub fn count(self, text: &str) -> u64 {
        u64::try_from(self.bpe().encode_ordinary(text).len()).unwrap_or(u64::MAX)
    }
}

/// Where a JSON schema is rendered, which decides its per-property cost.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SchemaPlace {
    /// `response_format.json_schema.schema`.
    ResponseFormat,
    /// A tool's `parameters`.
    Tool,
}

// Framing, measured 2026-10-05 against `usage.prompt_tokens` (see the module
// documentation). Each is the measured value rounded up.
/// Per message: the recipe's `tokens_per_message`.
const PER_MESSAGE: u64 = 3;
/// Once per request: the recipe's reply priming.
const REPLY_PRIMING: u64 = 3;
/// A message `name`: its tokens plus this.
const PER_NAME: u64 = 1;
/// A prior tool call in the history: name and arguments plus this.
const PER_TOOL_CALL: u64 = 8;
/// Each call in an assistant message that carries more than one.
const PER_PARALLEL_CALL: u64 = 16;
/// A tool-result message's reference to its call (the id is not rendered).
const PER_TOOL_RESULT: u64 = 3;
/// Once when any tool is defined.
const TOOLS_BLOCK: u64 = 12;
/// Per tool definition, beside its name, description and parameters.
const PER_TOOL: u64 = 8;
/// `tool_choice: required` or a named function.
const TOOL_CHOICE: u64 = 10;
/// Once per `response_format` JSON schema.
const SCHEMA_BLOCK: u64 = 18;
/// Per property of a `response_format` schema, beside its key and type.
const SCHEMA_PROPERTY: u64 = 6;
/// Per property of a tool's parameters, beside its key and type.
const TOOL_PROPERTY: u64 = 3;
/// Per `description`, beside its text.
const PER_DESCRIPTION: u64 = 2;
/// Per `enum` value (and `const`), beside its JSON text.
const PER_ENUM_VALUE: u64 = 2;
/// Per schema node that is not a property value: array items, `anyOf` /
/// `oneOf` / `allOf` branches, and the root of a tool's parameters.
const PER_CONTAINER: u64 = 5;
/// Below this nesting the walk stops and the subtree's compact JSON text
/// is counted instead — larger, never smaller, than its rendering.
const MAX_SCHEMA_DEPTH: u32 = 64;
/// The byte bound's framing allowance.
const BYTE_BOUND_FRAMING: u64 = 64;
/// metering.md §5.4: `output_tokens = ceil(tokenise(…) × 11000 / 10⁴)`.
pub const OUTPUT_ESTIMATE_BPS: Bps = Bps(11_000);

/// An input estimate, before the catalogue's `safety_factor_bps`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputEstimate {
    /// The token count.
    pub tokens: u64,
    /// `true` when a tokeniser counted it; `false` for the byte bound.
    pub exact: bool,
}

/// The input estimate for `request` on `model`, before the safety factor.
/// `None` only when the request cannot be serialised, which `chat::validate`
/// has already ruled out.
#[must_use]
pub fn input_tokens(request: &ChatRequest, model: &CatalogModel) -> Option<InputEstimate> {
    match Encoding::for_model(model) {
        Some(encoding) => Some(InputEstimate {
            tokens: prompt_tokens(encoding, request),
            exact: true,
        }),
        None => byte_bound(request).map(|tokens| InputEstimate {
            tokens,
            exact: false,
        }),
    }
}

/// The conservative byte-token reservation every provider had before a
/// tokeniser: roles, message framing, tool definitions, prior tool
/// arguments and results, and the `response_format` schema. Metadata is
/// excluded.
fn byte_bound(request: &ChatRequest) -> Option<u64> {
    let mut bytes = serde_json::to_vec(&(&request.messages, &request.tools))
        .ok()?
        .len();
    if let Some(format) = &request.response_format {
        bytes = bytes.saturating_add(serde_json::to_vec(format).ok()?.len());
    }
    Some(
        u64::try_from(bytes)
            .ok()?
            .saturating_add(BYTE_BOUND_FRAMING),
    )
}

const fn role_word(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

/// OpenAI Chat Completions prompt tokens: messages, tools, `tool_choice`
/// and `response_format`, with the measured framing.
fn prompt_tokens(encoding: Encoding, request: &ChatRequest) -> u64 {
    let count = |text: &str| encoding.count(text);
    let mut n = REPLY_PRIMING;
    for message in &request.messages {
        n = n
            .saturating_add(PER_MESSAGE)
            .saturating_add(count(role_word(message.role)));
        for part in &message.content {
            // Image parts are refused by `meter::plan` in this build; a text
            // part costs exactly its tokens, however many parts there are.
            if let ContentPart::Text { text } = part {
                n = n.saturating_add(count(text));
            }
        }
        let parallel = message.tool_calls.len() > 1;
        for call in &message.tool_calls {
            n = n
                .saturating_add(count(&call.name))
                .saturating_add(count(&call.arguments))
                .saturating_add(PER_TOOL_CALL);
            if parallel {
                n = n.saturating_add(PER_PARALLEL_CALL);
            }
        }
        if message.tool_call_id.is_some() {
            n = n.saturating_add(PER_TOOL_RESULT);
        }
    }
    // `Message` has no `name` field in this wire format (chat-api.md §2.1);
    // PER_NAME is kept for the day it does.
    let _ = PER_NAME;
    if !request.tools.is_empty() {
        n = n.saturating_add(TOOLS_BLOCK);
        for tool in &request.tools {
            n = n.saturating_add(PER_TOOL).saturating_add(count(&tool.name));
            if let Some(description) = &tool.description {
                n = n
                    .saturating_add(count(description))
                    .saturating_add(PER_DESCRIPTION);
            }
            n = n.saturating_add(schema_tokens(
                encoding,
                &tool.parameters.to_value(),
                SchemaPlace::Tool,
            ));
        }
    }
    if matches!(
        request.tool_choice,
        Some(ToolChoice::Required | ToolChoice::Function { .. })
    ) {
        n = n.saturating_add(TOOL_CHOICE);
    }
    match &request.response_format {
        Some(ResponseFormat::JsonSchema { json_schema }) => {
            n = n.saturating_add(SCHEMA_BLOCK).saturating_add(schema_tokens(
                encoding,
                &json_schema.schema.to_value(),
                SchemaPlace::ResponseFormat,
            ));
        }
        // `json_object` injects nothing measurable (the API requires the
        // word "json" in the prompt instead).
        Some(ResponseFormat::JsonObject {}) | None => {}
    }
    n
}

/// The tokens a JSON schema costs in OpenAI's compact rendering: keys, type
/// words, descriptions and enum values, with the measured per-property and
/// per-container framing. Validation keywords cost nothing. The root is a
/// property-like node for a `response_format` schema (`SCHEMA_BLOCK` covers
/// it) and a container for a tool's parameters.
fn schema_tokens(encoding: Encoding, schema: &Value, place: SchemaPlace) -> u64 {
    schema_node(
        encoding,
        schema,
        place == SchemaPlace::ResponseFormat,
        place,
        0,
    )
}

fn schema_node(
    encoding: Encoding,
    node: &Value,
    is_property: bool,
    place: SchemaPlace,
    depth: u32,
) -> u64 {
    let count = |text: &str| encoding.count(text);
    let Some(object) = node.as_object() else {
        // A boolean schema (`true` / `false`) or a malformed node: nothing
        // to render.
        return 0;
    };
    if depth > MAX_SCHEMA_DEPTH {
        // Deeper than any real schema: count the subtree's JSON text, which
        // is never fewer tokens than its rendering.
        return count(&node.to_string());
    }
    let per_property = match place {
        SchemaPlace::ResponseFormat => SCHEMA_PROPERTY,
        SchemaPlace::Tool => TOOL_PROPERTY,
    };
    let mut n = if is_property { 0 } else { PER_CONTAINER };
    match object.get("type") {
        Some(Value::String(word)) => n = n.saturating_add(count(word)),
        Some(Value::Array(words)) => {
            for word in words {
                if let Some(word) = word.as_str() {
                    n = n.saturating_add(count(word));
                }
            }
        }
        _ => {}
    }
    if let Some(description) = object.get("description") {
        let text = description
            .as_str()
            .map_or_else(|| description.to_string(), str::to_owned);
        n = n
            .saturating_add(count(&text))
            .saturating_add(PER_DESCRIPTION);
    }
    if let Some(Value::Array(values)) = object.get("enum") {
        for value in values {
            n = n
                .saturating_add(count(&value.to_string()))
                .saturating_add(PER_ENUM_VALUE);
        }
    }
    if let Some(value) = object.get("const") {
        n = n
            .saturating_add(count(&value.to_string()))
            .saturating_add(PER_ENUM_VALUE);
    }
    let child = depth.saturating_add(1);
    for keyed in ["properties", "patternProperties", "$defs", "definitions"] {
        if let Some(Value::Object(members)) = object.get(keyed) {
            for (key, value) in members {
                n = n
                    .saturating_add(count(key))
                    .saturating_add(per_property)
                    .saturating_add(schema_node(encoding, value, true, place, child));
            }
        }
    }
    match object.get("items") {
        Some(Value::Array(items)) => {
            for item in items {
                n = n.saturating_add(schema_node(encoding, item, false, place, child));
            }
        }
        Some(items) => n = n.saturating_add(schema_node(encoding, items, false, place, child)),
        None => {}
    }
    for branches in ["anyOf", "oneOf", "allOf", "prefixItems"] {
        if let Some(Value::Array(branches)) = object.get(branches) {
            for branch in branches {
                n = n.saturating_add(schema_node(encoding, branch, false, place, child));
            }
        }
    }
    for single in ["additionalProperties", "not", "if", "then", "else"] {
        if let Some(value @ Value::Object(_)) = object.get(single) {
            n = n.saturating_add(schema_node(encoding, value, false, place, child));
        }
    }
    n
}

/// metering.md §5.4's output estimate: everything the provider produced —
/// the text and each tool call's name and arguments — tokenised with the
/// model's encoding (`o200k_base` as the approximation for a provider
/// without one) and scaled by [`OUTPUT_ESTIMATE_BPS`].
#[must_use]
pub fn output_tokens(model: &CatalogModel, text: &str, tool_calls: &[ToolCall]) -> u64 {
    let encoding = Encoding::for_model(model).unwrap_or(Encoding::O200kBase);
    let mut raw = encoding.count(text);
    for call in tool_calls {
        raw = raw
            .saturating_add(encoding.count(&call.name))
            .saturating_add(encoding.count(&call.arguments));
    }
    apply_safety_factor(raw, OUTPUT_ESTIMATE_BPS).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(provider: &str, upstream: &str) -> CatalogModel {
        serde_json::from_value(json!({
            "id": "m", "provider": provider, "provider_model_id": upstream,
            "api_style": "openai_chat",
            "prices": {"input_nusd_per_mtok": 1000, "cached_input_nusd_per_mtok": 100,
                       "cache_write_nusd_per_mtok": 1250, "output_nusd_per_mtok": 4000,
                       "image_nusd": 0, "tool_call_nusd": 0},
            "min_charge_2z": 1, "safety_factor_bps": 10000, "context_window": 128000,
            "max_output_tokens": 16384, "ttfb_timeout_ms": 10000, "enabled": true
        }))
        .unwrap()
    }

    #[test]
    fn openai_families_map_to_their_encoding_and_nothing_else_does() {
        for id in [
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4o-2024-08-06",
            "chatgpt-4o-latest",
            "gpt-4.1-nano",
            "gpt-5",
            "gpt-5.6-sol",
            "gpt-6-astra",
            "o1",
            "o3-mini",
            "o4-mini",
        ] {
            assert_eq!(
                Encoding::for_openai_id(id),
                Some(Encoding::O200kBase),
                "{id}"
            );
        }
        for id in ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"] {
            assert_eq!(
                Encoding::for_openai_id(id),
                Some(Encoding::Cl100kBase),
                "{id}"
            );
        }
        for id in [
            "text-embedding-3-small",
            "davinci-002",
            "omni-moderation",
            "",
        ] {
            assert_eq!(Encoding::for_openai_id(id), None, "{id}");
        }
        // The provider decides before the id does: another provider's
        // "gpt-4o" (a proxy, a relabel) is not tokenised as OpenAI's.
        assert_eq!(Encoding::for_model(&model("xai", "gpt-4o")), None);
        assert_eq!(
            Encoding::for_model(&model("openai", "gpt-4o")),
            Some(Encoding::O200kBase)
        );
    }

    #[test]
    fn the_byte_bound_is_what_it_was_and_the_tokeniser_is_far_below_it() {
        let request: ChatRequest = serde_json::from_value(json!({
            "model": "m", "max_output_tokens": 10,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "The quick brown fox jumps over the lazy dog."}]}]
        }))
        .unwrap();
        let bytes = serde_json::to_vec(&(&request.messages, &request.tools))
            .unwrap()
            .len() as u64
            + 64;
        let fallback = input_tokens(&request, &model("anthropic", "claude-sonnet-5")).unwrap();
        assert_eq!(
            fallback,
            InputEstimate {
                tokens: bytes,
                exact: false
            }
        );
        let exact = input_tokens(&request, &model("openai", "gpt-4o")).unwrap();
        assert!(exact.exact);
        // 3 (priming) + 3 (message) + 1 (role) + 10 (the sentence).
        assert_eq!(exact.tokens, 17);
        assert!(
            exact.tokens * 4 < fallback.tokens,
            "{exact:?} vs {fallback:?}"
        );
    }

    #[test]
    fn validation_keywords_cost_nothing_and_words_cost_their_tokens() {
        let enc = Encoding::O200kBase;
        let plain = json!({"type": "object", "properties": {"n": {"type": "integer"}}});
        let constrained = json!({"type": "object", "properties": {"n": {"type": "integer",
            "minimum": 1, "maximum": 10, "pattern": "^[a-z]{0,47}$"}},
            "required": ["n"], "additionalProperties": false});
        assert_eq!(
            schema_tokens(enc, &plain, SchemaPlace::ResponseFormat),
            schema_tokens(enc, &constrained, SchemaPlace::ResponseFormat)
        );
        let described = json!({"type": "object", "properties": {"n": {"type": "integer",
            "description": "How many apples the learner counted."}}});
        let extra = schema_tokens(enc, &described, SchemaPlace::ResponseFormat)
            - schema_tokens(enc, &plain, SchemaPlace::ResponseFormat);
        assert_eq!(
            extra,
            enc.count("How many apples the learner counted.") + PER_DESCRIPTION
        );
        // A tool's parameters render cheaper per property than a
        // response_format schema (3 against 6 beside the key and type).
        let two = json!({"type": "object", "properties": {"n": {"type": "integer"}, "m": {"type": "integer"}}});
        let marginal = |place| schema_tokens(enc, &two, place) - schema_tokens(enc, &plain, place);
        assert_eq!(
            marginal(SchemaPlace::Tool),
            enc.count("m") + 1 + TOOL_PROPERTY
        );
        assert_eq!(
            marginal(SchemaPlace::ResponseFormat),
            enc.count("m") + 1 + SCHEMA_PROPERTY
        );
    }

    #[test]
    fn a_pathological_depth_is_counted_as_text_not_walked() {
        let mut deep = json!({"type": "string"});
        for _ in 0..200 {
            deep = json!({"type": "array", "items": deep});
        }
        let n = schema_tokens(Encoding::O200kBase, &deep, SchemaPlace::ResponseFormat);
        assert!(n > 200, "{n}");
    }

    #[test]
    fn output_estimate_scales_text_and_tool_arguments_by_eleven_tenths() {
        let m = model("openai", "gpt-4o");
        assert_eq!(output_tokens(&m, "", &[]), 0);
        let text = "The quick brown fox jumps over the lazy dog.";
        assert_eq!(Encoding::O200kBase.count(text), 10);
        assert_eq!(output_tokens(&m, text, &[]), 11);
        let call = ToolCall {
            id: "call_1".into(),
            name: "lookup".into(),
            arguments: "{\"name\":\"area\"}".into(),
        };
        let raw = 10
            + Encoding::O200kBase.count("lookup")
            + Encoding::O200kBase.count("{\"name\":\"area\"}");
        assert_eq!(output_tokens(&m, text, &[call]), raw.div_ceil(10) + raw);
        // A provider without a tokeniser is approximated with o200k.
        assert_eq!(
            output_tokens(&model("anthropic", "claude-sonnet-5"), text, &[]),
            11
        );
    }
}
