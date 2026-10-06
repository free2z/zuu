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
    "gpt-4.5",
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
    ///
    /// **Bounded work.** The BPE's pre-tokeniser splits text into pieces —
    /// a word with its combining marks, a run of punctuation and symbols, a
    /// run of whitespace, one to three digits — and merges each piece on its
    /// own; its time and transient memory (some 32 bytes per input byte of
    /// the piece) grow with the longest piece, which a request controls: a
    /// 4 MiB prompt of one letter, or of `a` + U+0301, is one piece. Every
    /// unbounded kind of piece lies inside a run of non-whitespace,
    /// non-digit characters or inside a run of whitespace, so a run of
    /// either kind longer than [`LONG_RUN_BYTES`] is cut into pieces of at
    /// most that many bytes and each piece is merged on its own, with
    /// [`CUT_PENALTY`] tokens per cut for the merges a cut can prevent.
    /// Digits need no cut: the pre-tokeniser already takes them three at a
    /// time. No run of natural language, code, JSON or base64 comes near
    /// the limit, so the count is the BPE's own for every real prompt.
    #[must_use]
    pub fn count(self, text: &str) -> u64 {
        let encode = |piece: &str| {
            u64::try_from(self.bpe().encode_ordinary(piece).len()).unwrap_or(u64::MAX)
        };
        let mut total = 0u64;
        for segment in segments(text) {
            total = total.saturating_add(match segment {
                Segment::Text(piece) => encode(piece),
                Segment::LongRun(run) => {
                    // Cut out of its surroundings (two cuts), then into
                    // bounded chunks at character boundaries.
                    let mut n = CUT_PENALTY.saturating_mul(2);
                    let mut rest = run;
                    while !rest.is_empty() {
                        let mut at = rest.len().min(LONG_RUN_BYTES);
                        while !rest.is_char_boundary(at) {
                            at = at.saturating_sub(1);
                        }
                        let (chunk, tail) = rest.split_at(at);
                        n = n.saturating_add(encode(chunk));
                        if !tail.is_empty() {
                            n = n.saturating_add(CUT_PENALTY);
                        }
                        rest = tail;
                    }
                    n
                }
            });
        }
        total
    }
}

/// The longest run the BPE is handed in one piece.
pub const LONG_RUN_BYTES: usize = 16 * 1024;
/// Tokens added per cut: a cut can only prevent merges that straddle it,
/// which changes the count by a handful of tokens either way (`"jaa"` +
/// `"oog"` is 2 tokens apart, 3 together), so the count on either side of a
/// cut is held safe by this allowance.
pub const CUT_PENALTY: u64 = 8;

enum Segment<'a> {
    Text(&'a str),
    LongRun(&'a str),
}

/// The coarse classes whose runs bound every piece the pre-tokeniser can
/// form: a piece never crosses from whitespace to non-whitespace and never
/// contains a digit beside a non-digit (digits are taken 1–3 at a time, so
/// a digit run is never one piece and needs no cut).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Space,
    Digit,
    Other,
}

fn class(c: char) -> Class {
    if c.is_whitespace() {
        Class::Space
    } else if c.is_numeric() {
        Class::Digit
    } else {
        Class::Other
    }
}

/// `text` as ordinary stretches and the long same-class runs cut out of
/// them, in order.
fn segments(text: &str) -> Vec<Segment<'_>> {
    // Byte ranges of the runs longer than the limit.
    let mut long_runs: Vec<(usize, usize)> = Vec::new();
    let mut run_start = 0usize;
    let mut run_class: Option<Class> = None;
    for (offset, c) in text.char_indices() {
        let current = class(c);
        if run_class != Some(current) {
            if run_class != Some(Class::Digit) && offset.saturating_sub(run_start) > LONG_RUN_BYTES
            {
                long_runs.push((run_start, offset));
            }
            run_start = offset;
            run_class = Some(current);
        }
    }
    if run_class != Some(Class::Digit) && text.len().saturating_sub(run_start) > LONG_RUN_BYTES {
        long_runs.push((run_start, text.len()));
    }
    let mut out = Vec::new();
    let mut emitted = 0usize;
    for (start, end) in long_runs {
        if let Some(before) = text.get(emitted..start).filter(|t| !t.is_empty()) {
            out.push(Segment::Text(before));
        }
        if let Some(run) = text.get(start..end) {
            out.push(Segment::LongRun(run));
        }
        emitted = end;
    }
    if let Some(tail) = text.get(emitted..).filter(|t| !t.is_empty()) {
        out.push(Segment::Text(tail));
    }
    out
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
/// Keywords **measured** to cost nothing in the provider's rendering
/// (validation constraints and the structural members the walk follows).
/// Any other member — `title`, `default`, `examples`, `format`, `$ref`,
/// `minLength`, … — was not measured and is counted as its JSON text, which
/// is never fewer tokens than any rendering of it.
const FREE_SCHEMA_KEYWORDS: &[&str] = &[
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "prefixItems",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "enum",
    "const",
    "description",
    "pattern",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minItems",
    "maxItems",
    "$defs",
    "definitions",
    "patternProperties",
    "strict",
];
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
        // The adapter sends a message's text parts concatenated, and token
        // counts are not additive across a concatenation (`"jaa"` + `"oog"`
        // is 2 tokens apart and 3 together), so the parts are counted as
        // the one string the provider sees. Image parts are refused by
        // `meter::plan` in this build.
        let mut text = String::new();
        for part in &message.content {
            if let ContentPart::Text { text: piece } = part {
                text.push_str(piece);
            }
        }
        n = n.saturating_add(count(&text));
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
            // The format's `name` was not separable in the measurements
            // (`SCHEMA_BLOCK` was measured with short names); counted so a
            // long one cannot hide.
            n = n
                .saturating_add(SCHEMA_BLOCK)
                .saturating_add(count(&json_schema.name))
                .saturating_add(schema_tokens(
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
    for (key, value) in object {
        if !FREE_SCHEMA_KEYWORDS.contains(&key.as_str()) {
            n = n
                .saturating_add(count(key))
                .saturating_add(count(&value.to_string()))
                .saturating_add(PER_DESCRIPTION);
        }
    }
    n
}

/// The encoding an output estimate for `model` is counted with:
/// the model's own, or `o200k_base` as the approximation for a provider
/// without one.
#[must_use]
pub fn output_encoding(model: &CatalogModel) -> Encoding {
    Encoding::for_model(model).unwrap_or(Encoding::O200kBase)
}

/// Generated text counted as it arrives, in bounded chunks, so that a call
/// retains at most [`OUTPUT_CHUNK_BYTES`] of its answer rather than all of
/// it (metering.md §5.4 counts "everything the provider produced", and a
/// gateway holds `max_concurrent_calls` of those at once). Every flushed
/// chunk is a cut, charged [`CUT_PENALTY`] like the cuts in
/// [`Encoding::count`], so the running total is never below the count of
/// the whole text.
#[derive(Default)]
pub struct OutputCounter {
    counted: u64,
    pending: String,
}

/// Text retained per call before it is counted and dropped.
pub const OUTPUT_CHUNK_BYTES: usize = 64 * 1024;

impl OutputCounter {
    /// Append generated text, counting and dropping full chunks.
    pub fn push(&mut self, encoding: Encoding, text: &str) {
        self.pending.push_str(text);
        while self.pending.len() > OUTPUT_CHUNK_BYTES {
            let mut at = OUTPUT_CHUNK_BYTES;
            while !self.pending.is_char_boundary(at) {
                at = at.saturating_sub(1);
            }
            let rest = self.pending.split_off(at);
            self.counted = self
                .counted
                .saturating_add(encoding.count(&self.pending))
                .saturating_add(CUT_PENALTY);
            self.pending = rest;
        }
    }

    /// The tokens of everything pushed so far.
    #[must_use]
    pub fn tokens(&self, encoding: Encoding) -> u64 {
        self.counted.saturating_add(encoding.count(&self.pending))
    }

    /// Whether anything was pushed.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.counted == 0 && self.pending.is_empty()
    }
}

/// [`output_tokens`] over an [`OutputCounter`].
#[must_use]
pub fn output_tokens_counted(
    model: &CatalogModel,
    text: &OutputCounter,
    tool_calls: &[ToolCall],
    fragments: &[String],
) -> u64 {
    let encoding = output_encoding(model);
    tool_output(encoding, text.tokens(encoding), tool_calls, fragments)
}

/// metering.md §5.4's output estimate: everything the provider produced —
/// the text and the tool calls' names and arguments — tokenised with the
/// model's encoding (`o200k_base` as the approximation for a provider
/// without one) and scaled by [`OUTPUT_ESTIMATE_BPS`].
///
/// Tool calls arrive twice on a stream: as `tool_call_delta` fragments and,
/// at the end, as the complete `tool_call`. `fragments` is each call's
/// fragments concatenated (name, then arguments); `tool_calls` the complete
/// calls. On a stream that ended properly both say the same thing; on one
/// cut mid-call only the fragments carry what was generated — and billed.
/// The **larger** of the two is counted, never both.
#[must_use]
pub fn output_tokens(
    model: &CatalogModel,
    text: &str,
    tool_calls: &[ToolCall],
    fragments: &[String],
) -> u64 {
    let encoding = output_encoding(model);
    tool_output(encoding, encoding.count(text), tool_calls, fragments)
}

fn tool_output(
    encoding: Encoding,
    text_tokens: u64,
    tool_calls: &[ToolCall],
    fragments: &[String],
) -> u64 {
    let complete = tool_calls.iter().fold(0u64, |n, call| {
        n.saturating_add(encoding.count(&call.name))
            .saturating_add(encoding.count(&call.arguments))
    });
    let fragmented = fragments
        .iter()
        .fold(0u64, |n, f| n.saturating_add(encoding.count(f)));
    let raw = text_tokens.saturating_add(complete.max(fragmented));
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
        assert_eq!(
            Encoding::for_openai_id("gpt-4.5-preview"),
            Some(Encoding::O200kBase)
        );
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
    fn unmeasured_keywords_are_counted_as_their_json_text() {
        let enc = Encoding::O200kBase;
        let plain = json!({"type": "object", "properties": {"n": {"type": "integer"}}});
        let decorated = json!({"type": "object", "properties": {"n": {"type": "integer",
            "title": "Count", "default": 3, "examples": [1, 2, 3], "format": "int32"}}});
        let extra = schema_tokens(enc, &decorated, SchemaPlace::ResponseFormat)
            - schema_tokens(enc, &plain, SchemaPlace::ResponseFormat);
        let text = enc.count("title")
            + enc.count("\"Count\"")
            + enc.count("default")
            + enc.count("3")
            + enc.count("examples")
            + enc.count("[1,2,3]")
            + enc.count("format")
            + enc.count("\"int32\"");
        assert_eq!(extra, text + 4 * PER_DESCRIPTION);
        // A megabyte of whitespace reaches the regex engine only in bounded
        // chunks (whole, it overflows fancy-regex's stack and panics).
        let spaces = " ".repeat(1 << 20);
        let chunks = (1u64 << 20) / LONG_RUN_BYTES as u64;
        let spaces_alone = enc.count(&spaces);
        assert!(spaces_alone < (1u64 << 20) / 64 + (chunks + 1) * CUT_PENALTY);
        assert!(spaces_alone >= (chunks + 1) * CUT_PENALTY);
        assert!(enc.count(&format!("{spaces}x")) >= spaces_alone);
        assert!(Encoding::Cl100kBase.count(&format!("{spaces}x")) > 0);
    }

    #[test]
    fn the_output_counter_retains_one_chunk_and_never_undercounts() {
        let enc = Encoding::O200kBase;
        let mut counter = OutputCounter::default();
        assert!(counter.is_empty());
        let sentence = "The quick brown fox jumps over the lazy dog. ";
        let mut whole = String::new();
        // Pushed a sentence at a time, ~200 KiB in all: three flushes.
        while whole.len() < 200 * 1024 {
            counter.push(enc, sentence);
            whole.push_str(sentence);
        }
        assert!(!counter.is_empty());
        assert!(counter.pending.len() <= OUTPUT_CHUNK_BYTES);
        let exact = enc.count(&whole);
        let counted = counter.tokens(enc);
        assert!(counted >= exact, "{counted} < {exact}");
        // Three cuts' allowance, plus the few tokens a cut mid-word adds.
        assert!(counted <= exact + 4 * CUT_PENALTY, "{counted} vs {exact}");
        // A multi-byte character astride the chunk boundary is kept whole.
        let mut counter = OutputCounter::default();
        counter.push(enc, &"é".repeat(OUTPUT_CHUNK_BYTES));
        assert!(counter.pending.len() <= OUTPUT_CHUNK_BYTES);
        assert!(counter.tokens(enc) > 0);
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
        assert_eq!(output_tokens(&m, "", &[], &[]), 0);
        let text = "The quick brown fox jumps over the lazy dog.";
        assert_eq!(Encoding::O200kBase.count(text), 10);
        assert_eq!(output_tokens(&m, text, &[], &[]), 11);
        let call = ToolCall {
            id: "call_1".into(),
            name: "lookup".into(),
            arguments: "{\"name\":\"area\"}".into(),
        };
        let raw = 10
            + Encoding::O200kBase.count("lookup")
            + Encoding::O200kBase.count("{\"name\":\"area\"}");
        assert_eq!(
            output_tokens(&m, text, std::slice::from_ref(&call), &[]),
            raw.div_ceil(10) + raw
        );
        // Fragments and the complete call describe the same generation:
        // the larger counts, never the sum.
        let fragments = vec!["lookup{\"name\":\"area\"}".to_owned()];
        let both = output_tokens(&m, text, std::slice::from_ref(&call), &fragments);
        assert!(both <= raw.div_ceil(10) + raw + 2, "{both}");
        assert_eq!(output_tokens(&m, text, &[], &fragments), both);
        // A provider without a tokeniser is approximated with o200k.
        assert_eq!(
            output_tokens(&model("anthropic", "claude-sonnet-5"), text, &[], &[]),
            11
        );
    }

    #[test]
    fn a_message_is_counted_as_the_one_string_the_provider_sees() {
        // "jaa" and "oog" are one token each apart and three together.
        let enc = Encoding::O200kBase;
        assert_eq!(
            (enc.count("jaa"), enc.count("oog"), enc.count("jaaoog")),
            (1, 1, 3)
        );
        let split: ChatRequest = serde_json::from_value(json!({
            "model": "m", "max_output_tokens": 10,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "jaa"}, {"type": "text", "text": "oog"}]}]
        }))
        .unwrap();
        let joined: ChatRequest = serde_json::from_value(json!({
            "model": "m", "max_output_tokens": 10,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "jaaoog"}]}]
        }))
        .unwrap();
        let m = model("openai", "gpt-4o");
        assert_eq!(input_tokens(&split, &m), input_tokens(&joined, &m));
        assert_eq!(input_tokens(&joined, &m).unwrap().tokens, 3 + 3 + 1 + 3);
    }

    #[test]
    fn a_long_run_is_merged_in_bounded_chunks_never_as_one_piece() {
        let enc = Encoding::O200kBase;
        // Below the limit: the exact BPE count (8 bytes per token here).
        let short = "a".repeat(LONG_RUN_BYTES);
        assert_eq!(enc.count(&short), (LONG_RUN_BYTES / 8) as u64);
        // Over it: two bounded chunks, the exact count of each, plus the
        // allowance for the two outer cuts and the one between them.
        let long = "a".repeat(LONG_RUN_BYTES + 8);
        assert_eq!(
            enc.count(&long),
            (LONG_RUN_BYTES / 8) as u64 + 1 + 3 * CUT_PENALTY
        );
        // Text around a long run is still counted exactly; the run is the
        // whole non-whitespace stretch.
        let (before, run, after) = (
            "The quick brown fox ",
            "a".repeat(LONG_RUN_BYTES * 2),
            " jumps over the lazy dog.",
        );
        let text = format!("{before}{run}{after}");
        assert_eq!(
            enc.count(&text),
            enc.count(before) + enc.count(after) + (LONG_RUN_BYTES / 4) as u64 + 3 * CUT_PENALTY
        );
        // Letters and combining marks are one piece to the pre-tokeniser,
        // as are punctuation and marks: both are one non-whitespace run
        // here and are cut.
        for pathological in ["a\u{301}", "!\u{301}", "\u{301}", "—a", "—!"] {
            let run = pathological.repeat(LONG_RUN_BYTES);
            let segments = segments(&run);
            assert!(
                segments.iter().all(|s| matches!(s, Segment::LongRun(_))),
                "{pathological:?} was not cut"
            );
            assert!(enc.count(&run) > 0);
        }
        // A digit run is taken three at a time by the pre-tokeniser and is
        // never cut here; letters beside digits break every other run.
        let digits = "7".repeat(LONG_RUN_BYTES * 2);
        assert!(
            segments(&digits)
                .iter()
                .all(|s| matches!(s, Segment::Text(_)))
        );
        assert_eq!(enc.count(&digits), (LONG_RUN_BYTES * 2 / 3) as u64 + 1);
        let mixed = "a1".repeat(LONG_RUN_BYTES);
        assert_eq!(enc.count(&mixed), mixed.len() as u64);
        // A megabyte of one letter: 64 bounded pieces, not one (a debug
        // build is slow here, so the timing is not asserted; the chunk
        // arithmetic is).
        let huge = "a".repeat(1 << 20);
        let chunks = (1u64 << 20) / LONG_RUN_BYTES as u64;
        assert_eq!(
            enc.count(&huge),
            (1u64 << 20) / 8 + (chunks + 1) * CUT_PENALTY
        );
    }
}
