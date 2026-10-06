//! The conformance corpus (`tests/fixtures/conformance/`) and its runner's
//! machinery: the fixture schema, an order-preserving JSON tree for the
//! `provider_request` comparator, the mutation (negative-control) engine,
//! and a real gateway — HTTP server, metering layer, real provider adapter —
//! in front of the `f2z-ai-testkit` loopback mock, over an in-memory ledger
//! that counts holds and extensions.
//!
//! `tests/conformance.rs` is the runner; `tests/fixtures/conformance/README.md`
//! is the schema's documentation, and every rule it states is enforced here.

#![allow(
    dead_code,
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::http::{HeaderMap, StatusCode};
use f2z_ai::catalog::{Fixed, VerifiedCatalog, now_unix};
use f2z_ai::config::ProviderConfig;
use f2z_ai::ledger::{Failure, Ledger, Operation};
use f2z_ai::meter::Metered;
use f2z_ai::provider::ProviderBackend;
use f2z_ai::{
    ApiFailure, Deps,
    auth::{Admitted, Gatekeeper, Principal},
};
use f2z_ai_proto::Event;
use f2z_ai_proto::chat::{ChatRequest, ChatResponse};
use f2z_ai_testkit::mock::{MockProvider, Scenario};
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{adapter_support, support};

// ---------------------------------------------------------------------------
// An order-preserving JSON tree
// ---------------------------------------------------------------------------

/// JSON whose objects keep their members in the order they were written.
/// `serde_json::Value` sorts members (no `preserve_order` in this
/// workspace), so a comparator over it could never see a reordered schema —
/// the zuu#1132 defect class. `==` is order-sensitive; [`J::sorted`] gives the
/// JSON-data-model view for the members whose order means nothing (events,
/// usage).
#[derive(Clone, Debug, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<J>),
    Object(Vec<(String, J)>),
}

impl J {
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_else(|e| panic!("not JSON ({e}): {text}"))
    }

    pub fn of(value: &Value) -> Self {
        Self::parse(&value.to_string())
    }

    pub fn to_value(&self) -> Value {
        serde_json::from_str(&self.to_string()).unwrap()
    }

    /// The same tree with every object's members sorted by name.
    pub fn sorted(&self) -> Self {
        match self {
            Self::Array(items) => Self::Array(items.iter().map(Self::sorted).collect()),
            Self::Object(members) => {
                let mut members: Vec<(String, J)> = members
                    .iter()
                    .map(|(k, v)| (k.clone(), v.sorted()))
                    .collect();
                members.sort_by(|a, b| a.0.cmp(&b.0));
                Self::Object(members)
            }
            other => other.clone(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            Self::Object(members) => members.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn members(&self) -> &[(String, J)] {
        match self {
            Self::Object(members) => members,
            _ => &[],
        }
    }

    /// The child at one pointer segment. On an array `-1` is the last item.
    fn child_mut(&mut self, segment: &str) -> Option<&mut J> {
        match self {
            Self::Object(members) => members
                .iter_mut()
                .find(|(k, _)| k == segment)
                .map(|(_, v)| v),
            Self::Array(items) => {
                let index = array_index(segment, items.len())?;
                items.get_mut(index)
            }
            _ => None,
        }
    }

    /// RFC 6901 pointer, plus `-1` for an array's last item. `""` is the
    /// whole value.
    pub fn pointer_mut(&mut self, pointer: &str) -> Option<&mut J> {
        segments(pointer)
            .into_iter()
            .try_fold(self, |node, segment| node.child_mut(&segment))
    }
}

fn array_index(segment: &str, len: usize) -> Option<usize> {
    if segment == "-1" {
        return len.checked_sub(1);
    }
    segment.parse::<usize>().ok().filter(|i| *i < len)
}

fn segments(pointer: &str) -> Vec<String> {
    if pointer.is_empty() {
        return Vec::new();
    }
    assert!(
        pointer.starts_with('/'),
        "a pointer starts with '/': {pointer:?}"
    );
    pointer[1..]
        .split('/')
        .map(|s| s.replace("~1", "/").replace("~0", "~"))
        .collect()
}

impl fmt::Display for J {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Null => f.write_str("null"),
            Self::Bool(b) => write!(f, "{b}"),
            Self::Number(n) => write!(f, "{n}"),
            Self::String(s) => write!(f, "{}", Value::String(s.clone())),
            Self::Array(items) => {
                f.write_str("[")?;
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        f.write_str(",")?;
                    }
                    write!(f, "{item}")?;
                }
                f.write_str("]")
            }
            Self::Object(members) => {
                f.write_str("{")?;
                for (i, (k, v)) in members.iter().enumerate() {
                    if i > 0 {
                        f.write_str(",")?;
                    }
                    write!(f, "{}:{v}", Value::String(k.clone()))?;
                }
                f.write_str("}")
            }
        }
    }
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = J;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<J, E> {
                Ok(J::Null)
            }
            fn visit_none<E>(self) -> Result<J, E> {
                Ok(J::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<J, E> {
                Ok(J::Bool(b))
            }
            fn visit_i64<E>(self, n: i64) -> Result<J, E> {
                Ok(J::Number(n.into()))
            }
            fn visit_u64<E>(self, n: u64) -> Result<J, E> {
                Ok(J::Number(n.into()))
            }
            fn visit_f64<E: de::Error>(self, n: f64) -> Result<J, E> {
                serde_json::Number::from_f64(n)
                    .map(J::Number)
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E>(self, s: &str) -> Result<J, E> {
                Ok(J::String(s.to_owned()))
            }
            fn visit_string<E>(self, s: String) -> Result<J, E> {
                Ok(J::String(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<J, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(J::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<J, A::Error> {
                let mut members: Vec<(String, J)> = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, J>()? {
                    if members.iter().any(|(seen, _)| *seen == k) {
                        return Err(de::Error::custom(format!("duplicate member {k:?}")));
                    }
                    members.push((k, v));
                }
                Ok(J::Object(members))
            }
        }
        d.deserialize_any(V)
    }
}

// ---------------------------------------------------------------------------
// The fixture schema
// ---------------------------------------------------------------------------

/// The features the corpus has directories for, and the signed capability a
/// SUCCESS fixture of that feature must declare. A new feature directory
/// must be added here, which is the point: a directory the runner does not
/// know is refused rather than silently skipped.
pub const FEATURES: [(&str, Option<&str>); 3] = [
    ("text", None),
    ("structured_output", Some("structured_output")),
    ("tool_calling", Some("tools")),
];

/// Top-level provider-body members a fixture may leave unlisted, per
/// `api_style`: the transport and the conversation, which every request
/// carries. Any OTHER member the provider receives must be listed in
/// `expect.provider_request` (with its exact value, or `null` for "must be
/// absent") — so a member that leaks into a provider body is a red test,
/// not a review finding.
pub fn baseline_members(api_style: &str) -> &'static [&'static str] {
    match api_style {
        "openai_chat" => &[
            "model",
            "service_tier",
            "messages",
            "max_completion_tokens",
            "stream",
            "stream_options",
        ],
        "openai_responses" => &[
            "model",
            "service_tier",
            "input",
            "max_output_tokens",
            "stream",
            "store",
        ],
        "anthropic_messages" => &["model", "max_tokens", "stream", "system", "messages"],
        other => panic!("no baseline for api_style {other:?}: teach the runner first"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fixture {
    pub name: String,
    pub feature: String,
    pub source: String,
    /// `true` only for a scrubbed capture someone made with a real key.
    #[serde(default)]
    pub recorded: bool,
    pub api_style: String,
    pub provider: String,
    pub catalog_model: CatalogModelSpec,
    /// The unified `ChatRequest`, without `stream` (the runner sets it).
    pub request: J,
    pub expect: Expect,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogModelSpec {
    #[serde(default)]
    pub capabilities: BTreeMap<String, Value>,
    /// Ai-api-design §3.3 members: carried into the signed model as written
    /// (`CatalogModel` tolerates them), read by no gateway yet.
    #[serde(default)]
    pub controls: Option<Value>,
    #[serde(default)]
    pub limits: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    pub refusal: Option<Refusal>,
    #[serde(default)]
    pub provider_request: Option<J>,
    #[serde(default)]
    pub provider_stream: Option<ProviderStream>,
    #[serde(default)]
    pub events: Option<Vec<Value>>,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub usage: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    pub hold_extends: Option<u64>,
    /// Ai-api-design §3.4: what each compat encoding (S6–S8) must render.
    /// Must be `{}` until an encoding exists to check it against.
    pub encodings: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refusal {
    pub status: u16,
    pub code: String,
    /// The members of `error.details` the refusal must carry, exactly.
    pub details: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ProviderStream {
    /// The body, byte for byte.
    Raw(String),
    /// One SSE frame per item: a string is `data: <string>`; an object is
    /// `data: <json>` for `openai_chat`, and `event: <its type>` +
    /// `data: <json>` for the named-event styles.
    Frames(Vec<Value>),
}

impl ProviderStream {
    pub fn body(&self, api_style: &str) -> String {
        match self {
            Self::Raw(body) => body.clone(),
            Self::Frames(frames) => frames
                .iter()
                .map(|frame| match frame {
                    Value::String(data) => format!("data: {data}\n\n"),
                    object if api_style == "openai_chat" => format!("data: {object}\n\n"),
                    object => {
                        let event = object["type"]
                            .as_str()
                            .unwrap_or_else(|| panic!("a named-event frame has a type: {object}"));
                        format!("event: {event}\ndata: {object}\n\n")
                    }
                })
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MutationFile {
    pub feature: String,
    pub mutations: Vec<Mutation>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mutation {
    pub name: String,
    pub target: Target,
    pub op: Op,
    pub path: String,
    #[serde(default)]
    pub value: Option<J>,
    /// Restrict to these fixtures (each must then be affected). Absent: every
    /// success fixture of the feature the mutation can change.
    #[serde(default)]
    pub fixtures: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    ProviderRequest,
    Events,
    Usage,
    FinishReason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Remove,
    Replace,
    Add,
    /// Reverse an array's items or an object's members.
    Reverse,
}

pub fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/conformance")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn sorted_entries(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    entries
}

/// The corpus: every fixture, validated, and every feature's mutation list.
/// Anything in the directory the runner does not understand is a failure,
/// never a skip.
pub struct Corpus {
    pub fixtures: Vec<Fixture>,
    pub mutations: BTreeMap<String, Vec<Mutation>>,
}

pub fn load() -> Corpus {
    let mut fixtures = Vec::new();
    let mut mutations = BTreeMap::new();
    let mut names = BTreeSet::new();
    for entry in sorted_entries(&corpus_dir()) {
        let file = entry.file_name().unwrap().to_str().unwrap().to_owned();
        if entry.is_file() {
            assert_eq!(
                file, "README.md",
                "unexpected file in the corpus root: {file}"
            );
            continue;
        }
        let feature = file;
        assert!(
            FEATURES.iter().any(|(f, _)| *f == feature),
            "feature directory {feature:?} is not in conformance_support::FEATURES"
        );
        for path in sorted_entries(&entry) {
            let stem = path.file_stem().unwrap().to_str().unwrap().to_owned();
            assert_eq!(
                path.extension().and_then(|e| e.to_str()),
                Some("json"),
                "{}: the corpus holds .json files only",
                path.display()
            );
            let text = read(&path);
            if stem == "mutations" {
                let list: MutationFile = serde_json::from_str(&text)
                    .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
                assert_eq!(list.feature, feature, "{}", path.display());
                assert!(
                    !list.mutations.is_empty(),
                    "{}: no mutations",
                    path.display()
                );
                mutations.insert(feature.clone(), list.mutations);
                continue;
            }
            let fixture: Fixture =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert_eq!(
                fixture.name,
                stem,
                "{}: name is the file stem",
                path.display()
            );
            assert_eq!(
                fixture.feature,
                feature,
                "{}: feature is the directory",
                path.display()
            );
            assert!(
                names.insert(fixture.name.clone()),
                "duplicate fixture name {}",
                fixture.name
            );
            if let Err(e) = validate(&fixture) {
                panic!("{}: {e}", path.display());
            }
            fixtures.push(fixture);
        }
        assert!(
            mutations.contains_key(&feature),
            "feature {feature:?} has no mutations.json: negative controls are part of the corpus"
        );
    }
    assert!(!fixtures.is_empty(), "the corpus went missing");
    Corpus {
        fixtures,
        mutations,
    }
}

/// The signed capabilities `request` exercises. Derived from the request,
/// never from the fixture's own labels, so a fixture cannot under-declare.
pub fn required_capabilities(request: &J) -> BTreeSet<&'static str> {
    let mut out = BTreeSet::new();
    let tools = request.get("tools").map_or(0, |t| match t {
        J::Array(items) => items.len(),
        _ => 0,
    });
    if tools > 0
        || request.get("tool_choice").is_some()
        || request.get("parallel_tool_calls").is_some()
    {
        out.insert("tools");
    }
    if let Some(J::Array(items)) = request.get("tools")
        && items
            .iter()
            .any(|t| t.get("strict") == Some(&J::Bool(true)))
    {
        out.insert("strict_tools");
    }
    if request.get("response_format").is_some() {
        out.insert("structured_output");
    }
    if let Some(J::Array(messages)) = request.get("messages")
        && messages.iter().any(|m| match m.get("content") {
            Some(J::Array(parts)) => parts
                .iter()
                .any(|p| p.get("type") == Some(&J::String("image".into()))),
            _ => false,
        })
    {
        out.insert("vision");
    }
    out
}

/// The schema's rules beyond what `deny_unknown_fields` checks. `Err` is a
/// corpus defect: the runner refuses the fixture.
pub fn validate(fixture: &Fixture) -> Result<(), String> {
    if fixture.source.trim().len() < 20 {
        return Err("`source` must say where the shape came from".into());
    }
    let _ = baseline_members(&fixture.api_style);
    let request = ChatRequest::deserialize(&mut serde_json::Deserializer::from_str(
        &fixture.request.to_string(),
    ))
    .map_err(|e| format!("request is not a ChatRequest: {e}"))?;
    if fixture.request.get("stream").is_some() {
        return Err("request must not set `stream`: the runner runs both".into());
    }
    if request.model.is_empty() {
        return Err("request.model names the fixture's catalogue model".into());
    }
    if !fixture.expect.encodings.is_empty() {
        return Err(
            "expect.encodings is checked by no runner yet (S6-S8 add the decoders); \
             data nobody checks would read as proof"
                .into(),
        );
    }
    for (name, value) in &fixture.catalog_model.capabilities {
        if !value.is_boolean() {
            return Err(format!("capabilities.{name} must be a boolean"));
        }
    }
    let e = &fixture.expect;
    if let Some(refusal) = &e.refusal {
        if e.provider_request.is_some()
            || e.provider_stream.is_some()
            || e.events.is_some()
            || e.finish_reason.is_some()
            || e.usage.is_some()
            || e.hold_extends.is_some()
        {
            return Err(
                "a refusal fixture pins the refusal only: nothing reaches a provider".into(),
            );
        }
        if !(400..500).contains(&refusal.status) {
            return Err("a refusal is a 4xx".into());
        }
        return Ok(());
    }
    // A success fixture: the corpus cannot claim a feature works on a model
    // whose signed catalogue entry does not carry it.
    let declared = |cap: &str| fixture.catalog_model.capabilities.get(cap) == Some(&json!(true));
    for cap in required_capabilities(&fixture.request) {
        if !declared(cap) {
            return Err(format!(
                "the request uses `{cap}`, which catalog_model.capabilities does not carry; \
                 a success fixture must declare every capability it exercises \
                 (or expect a refusal)"
            ));
        }
    }
    if let Some((_, Some(cap))) = FEATURES.iter().find(|(f, _)| *f == fixture.feature)
        && !declared(cap)
    {
        return Err(format!(
            "feature {} needs capabilities.{cap}: true on a success fixture",
            fixture.feature
        ));
    }
    let Some(J::Object(_)) = &e.provider_request else {
        return Err("a success fixture pins expect.provider_request (an object)".into());
    };
    if e.hold_extends.is_none() {
        return Err("a success fixture pins expect.hold_extends".into());
    }
    let pinned = [
        e.events.is_some(),
        e.finish_reason.is_some(),
        e.usage.is_some(),
    ];
    match (&e.provider_stream, pinned) {
        (Some(_), [true, true, true]) => {}
        (Some(_), _) => {
            return Err(
                "a fixture with a provider_stream pins events, finish_reason and usage".into(),
            );
        }
        (None, [false, false, false]) => {}
        (None, _) => {
            return Err(
                "events / finish_reason / usage without a provider_stream would assert the \
                 mock's own rendering"
                    .into(),
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

/// Members whose value is a caller-supplied JSON Schema. Inside one, member
/// order is part of what the provider sees — OpenAI emits a structured
/// reply's keys in schema order (zuu#1132) — so it is compared; everywhere
/// else an object is the gateway's own construction, its member order is
/// serde's incidental one, and only its members and values are compared.
/// Arrays are always order-sensitive.
pub const SCHEMA_MEMBERS: [&str; 3] = ["parameters", "input_schema", "schema"];

/// `want == got`, member order compared only inside a schema.
pub fn same(want: &J, got: &J, ordered: bool) -> bool {
    match (want, got) {
        (J::Array(a), J::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y, ordered))
        }
        (J::Object(a), J::Object(b)) => {
            let inner = |k: &str| ordered || SCHEMA_MEMBERS.contains(&k);
            if ordered {
                a.len() == b.len()
                    && a.iter()
                        .zip(b)
                        .all(|((ka, va), (kb, vb))| ka == kb && same(va, vb, inner(ka)))
            } else {
                a.len() == b.len()
                    && a.iter()
                        .all(|(k, v)| got.get(k).is_some_and(|g| same(v, g, inner(k))))
            }
        }
        _ => want == got,
    }
}

/// Every way `sent` (the body the provider received, in arrival order)
/// differs from `expected`: each listed member must be present with exactly
/// that value ([`same`]: order-sensitive inside schemas and arrays) or absent
/// where `null`; any unlisted member must be one of the style's
/// [`baseline_members`]; and the provider is always streamed.
pub fn provider_request_mismatches(expected: &J, sent: &J, api_style: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (name, want) in expected.members() {
        match (want, sent.get(name)) {
            (J::Null, None) => {}
            (J::Null, Some(got)) => out.push(format!("{name}: must be absent, sent {got}")),
            (_, None) => out.push(format!("{name}: missing, expected {want}")),
            (_, Some(got)) if !same(want, got, SCHEMA_MEMBERS.contains(&name.as_str())) => {
                let order = if want.sorted() == got.sorted() {
                    " (same members, different order inside a schema)"
                } else {
                    ""
                };
                out.push(format!("{name}: expected {want}, sent {got}{order}"));
            }
            _ => {}
        }
    }
    let baseline = baseline_members(api_style);
    for (name, value) in sent.members() {
        if expected.get(name).is_none() && !baseline.contains(&name.as_str()) {
            out.push(format!(
                "{name}: sent ({value}) but not listed in expect.provider_request"
            ));
        }
    }
    if sent.get("stream") != Some(&J::Bool(true)) {
        out.push("stream: the provider is always streamed".into());
    }
    out
}

/// The listed usage members, exactly.
pub fn usage_mismatches(expected: &BTreeMap<String, Value>, got: &J) -> Vec<String> {
    let got = got.to_value();
    expected
        .iter()
        .filter(|(k, v)| got.get(k.as_str()) != Some(v))
        .map(|(k, v)| {
            format!(
                "usage.{k}: expected {v}, got {}",
                got.get(k.as_str()).unwrap_or(&Value::Null)
            )
        })
        .collect()
}

pub fn events_mismatch(expected: &[Value], got: &J) -> Option<String> {
    let want = J::of(&Value::Array(expected.to_vec())).sorted();
    (want != got.sorted()).then(|| format!("events: expected {want}, got {}", got.sorted()))
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/// `value` after `mutation`, or `None` when the mutation does not apply to it
/// (the path does not resolve, or the result is unchanged).
pub fn mutate(value: &J, mutation: &Mutation) -> Option<J> {
    let mut out = value.clone();
    let segs = segments(&mutation.path);
    match mutation.op {
        Op::Replace => {
            let new = mutation.value.clone().expect("replace needs a value");
            *out.pointer_mut(&mutation.path)? = new;
        }
        Op::Reverse => match out.pointer_mut(&mutation.path)? {
            J::Array(items) if items.len() > 1 => items.reverse(),
            J::Object(members) if members.len() > 1 => members.reverse(),
            _ => return None,
        },
        Op::Remove | Op::Add => {
            let (last, parent) = segs.split_last().expect("remove/add needs a member path");
            let parent_ptr: String = parent.iter().map(|s| format!("/{s}")).collect();
            let parent = out.pointer_mut(&parent_ptr)?;
            match (mutation.op, parent) {
                (Op::Remove, J::Object(members)) => {
                    let at = members.iter().position(|(k, _)| k == last)?;
                    members.remove(at);
                }
                (Op::Remove, J::Array(items)) => {
                    let at = array_index(last, items.len())?;
                    items.remove(at);
                }
                (Op::Add, J::Object(members)) => {
                    if members.iter().any(|(k, _)| k == last) {
                        return None;
                    }
                    let new = mutation.value.clone().expect("add needs a value");
                    members.push((last.clone(), new));
                }
                _ => return None,
            }
        }
    }
    (out != *value).then_some(out)
}

// ---------------------------------------------------------------------------
// The gateway under test
// ---------------------------------------------------------------------------

/// The catalogue the fixture describes: one model, `request.model`, with
/// the fixture's provider, `api_style` and `catalog_model` members. Nothing
/// is inherited from another fixture or a shared catalogue.
pub fn catalog_for(fixture: &Fixture, capabilities: &BTreeMap<String, Value>) -> VerifiedCatalog {
    let id = fixture.request.get("model").unwrap().to_value();
    let id = id.as_str().unwrap();
    let mut model = json!({
        "id": id, "provider": fixture.provider, "provider_model_id": format!("{id}-upstream"),
        "api_style": fixture.api_style,
        "prices": PRICES.to_value(),
        "min_charge_2z": 1, "safety_factor_bps": 10000, "context_window": 200000,
        "max_output_tokens": 8192, "ttfb_timeout_ms": 10000, "enabled": true,
        "capabilities": capabilities,
    });
    if let Some(controls) = &fixture.catalog_model.controls {
        model["controls"] = controls.clone();
    }
    if let Some(limits) = &fixture.catalog_model.limits {
        model["limits"] = limits.clone();
    }
    let now = now_unix();
    let catalog = serde_json::from_value(json!({
        "schema": 1, "version": 1, "issued_at": now - 60, "expires_at": now + 3600,
        "rate_card_version": 1, "platform_margin_bps": 2000, "models": [model],
    }))
    .unwrap_or_else(|e| {
        panic!(
            "{}: catalog_model does not make a catalogue: {e}",
            fixture.name
        )
    });
    VerifiedCatalog::from_verified(catalog).unwrap()
}

/// Every fixture model's prices, in nano-USD per million tokens (per unit
/// for images and server tool calls): gpt-4o-like, so a settlement's cost is
/// a real number of nano-USD and a mis-scaled one is visible.
pub struct Prices {
    pub input: u64,
    pub cached_input: u64,
    pub cache_write: u64,
    pub output: u64,
    pub image: u64,
    pub tool_call: u64,
}

pub const PRICES: Prices = Prices {
    input: 2_500_000_000,
    cached_input: 1_250_000_000,
    cache_write: 3_125_000_000,
    output: 10_000_000_000,
    image: 1_000_000,
    tool_call: 25_000_000,
};

impl Prices {
    fn to_value(&self) -> Value {
        json!({"input_nusd_per_mtok": self.input, "cached_input_nusd_per_mtok": self.cached_input,
               "cache_write_nusd_per_mtok": self.cache_write, "output_nusd_per_mtok": self.output,
               "image_nusd": self.image, "tool_call_nusd": self.tool_call})
    }

    /// The cost of `usage` (a normalised `Usage` as JSON) in whole nano-USD,
    /// rounded up — computed here, independently of `f2z_ai_proto::pricing`,
    /// as the oracle for what the gateway hands the ledger's settle.
    pub fn cost_nusd(&self, usage: &Value) -> u128 {
        let n = |k: &str| {
            u128::from(
                usage[k]
                    .as_u64()
                    .unwrap_or_else(|| panic!("usage.{k}: {usage}")),
            )
        };
        let micro = n("input_tokens") * u128::from(self.input)
            + n("cached_input_tokens") * u128::from(self.cached_input)
            + n("cache_write_tokens") * u128::from(self.cache_write)
            + n("output_tokens") * u128::from(self.output)
            + (n("images") * u128::from(self.image) + n("tool_calls") * u128::from(self.tool_call))
                * 1_000_000;
        micro.div_ceil(1_000_000)
    }
}

/// Every provider the corpus uses, at the mock. xAI reports
/// `completion_tokens` without reasoning, as configured in production.
fn backend(base_url: &str) -> ProviderBackend {
    let mut providers = BTreeMap::new();
    for (name, include) in [("openai", true), ("xai", false), ("anthropic", true)] {
        providers.insert(
            name.to_owned(),
            ProviderConfig {
                base_url: base_url.to_owned(),
                api_key: format!("test-key-{name}").into(),
                completion_tokens_include_reasoning: include,
            },
        );
    }
    ProviderBackend::new(&providers, adapter_support::tuning(0)).unwrap()
}

struct Gate;
#[async_trait]
impl Gatekeeper for Gate {
    async fn admit(&self, _headers: &HeaderMap) -> Result<Admitted, ApiFailure> {
        Ok(Admitted {
            principal: Principal {
                sub: "11111111-1111-4111-8111-111111111111".into(),
                client_id: "opaque.native-client_7f3c2e".into(),
                app_id: "22222222-2222-4222-8222-222222222222".into(),
                scope: "ai:invoke".into(),
                aep: 1,
                agen: 1,
                exp: u64::MAX,
                jti: "conformance".into(),
            },
            lease: None,
        })
    }
}

/// One call's ledger, in memory: it answers the metering layer the way the
/// production functions do and counts what was asked of it.
#[derive(Default)]
pub struct LedgerState {
    call: Option<Uuid>,
    request: Value,
    completion: Value,
    pub hold: Option<Uuid>,
    amount: i64,
    pub terminal: Option<&'static str>,
    /// `extend` calls that only refresh the hold (the heartbeat), not the
    /// post-hold resize.
    pub extends: u64,
    pub holds: u64,
    /// Every `settle`: `(cost_nusd, usage)` exactly as the gateway sent it.
    pub settles: Vec<(i64, Value)>,
}

impl LedgerState {
    fn context() -> Value {
        json!({"status":"ok","available_milli_2z":100_000_000,"cap_remaining_milli_2z":null,
               "debt_milli_2z":0,"open_holds":0,"frozen":false,
               "consented_markup_bps":0,"effective_markup_bps":0})
    }
    fn record(&self) -> Value {
        let status = match (self.terminal, self.completion.is_null()) {
            (Some("settled"), _) => "settled",
            (Some(_), _) => "released",
            (None, true) => "streaming",
            (None, false) => "settling",
        };
        json!({"call_id":self.call,"status":status,"request":self.request,"completion":self.completion,
               "created_at":"2026-10-05T00:00:00Z","settled_at":self.terminal.map(|_|"2026-10-05T00:00:01Z"),
               "error":null,
               "attempts":self.hold.map(|id|vec![json!({"hold_id":id,"attempt":1})]).unwrap_or_default(),
               "settlement":self.terminal.and_then(|outcome|self.hold.map(|id|json!({
                   "hold_id":id,"outcome":outcome,"hold_milli_2z":self.amount,
                   "priced_milli_2z":if outcome=="settled" {1000} else {0},
                   "collected_milli_2z":if outcome=="settled" {1000} else {0},
                   "shortfall_milli_2z":0,"applied_markup_bps":0})))})
    }
}

#[derive(Default)]
pub struct MemoryLedger(pub Mutex<LedgerState>);

#[async_trait]
impl Ledger for MemoryLedger {
    async fn execute(&self, op: &Operation) -> Result<Value, Failure> {
        let mut m = self.0.lock().unwrap();
        Ok(match op {
            Operation::Context(_) => LedgerState::context(),
            Operation::Claim { call, request, .. } => {
                let status = if m.call.is_some() {
                    "pending"
                } else {
                    m.call = Some(*call);
                    m.request = request.clone();
                    "claimed"
                };
                json!({"status":status,"call_id":m.call,"record":m.record(),"context":LedgerState::context()})
            }
            Operation::Hold { amount_milli, .. } => {
                m.holds += 1;
                m.hold.get_or_insert_with(Uuid::now_v7);
                m.amount = *amount_milli;
                json!({"status":"held","state":"open","hold_id":m.hold,"amount":m.amount,
                       "applied_markup_bps":0,"available":100_000_000,"cap_remaining":null,
                       "expires_at":"2026-10-05T00:05:00Z"})
            }
            Operation::Extend { amount_milli, .. } => {
                match amount_milli {
                    Some(amount) => m.amount = *amount,
                    None => m.extends += 1,
                }
                json!({"status":"held","state":"open","amount":m.amount,"available":100_000_000,
                       "cap_remaining":null,"expires_at":"2026-10-05T00:05:00Z"})
            }
            Operation::Complete {
                completion,
                no_hold,
                ..
            } => {
                if m.completion.is_null() {
                    m.completion = completion.clone();
                }
                if *no_hold {
                    m.terminal = Some("released");
                }
                json!({"status":"recorded","record":m.record()})
            }
            Operation::Settle {
                cost_nusd, usage, ..
            } => {
                m.settles.push((*cost_nusd, usage.clone()));
                m.terminal.get_or_insert("settled");
                json!({"status":"settled"})
            }
            Operation::Release { .. } => {
                m.terminal.get_or_insert("released");
                json!({"status":m.terminal})
            }
            Operation::Read { call, .. } => {
                if Some(*call) == m.call {
                    json!({"status":"found","record":m.record()})
                } else {
                    json!({"status":"not_found","record":null})
                }
            }
        })
    }
}

/// A running gateway for one fixture: the real server and metering layer,
/// the real provider adapter, the mock replaying the fixture's stream.
pub struct Harness {
    pub running: support::Running,
    pub mock: MockProvider,
    pub ledger: Arc<MemoryLedger>,
}

impl Harness {
    pub async fn start(fixture: &Fixture, capabilities: &BTreeMap<String, Value>) -> Self {
        let scenario = match &fixture.expect.provider_stream {
            Some(stream) => Scenario::default().with_replay(stream.body(&fixture.api_style)),
            // A request-only fixture: the mock renders its own stream.
            None => Scenario::default(),
        };
        let mock = MockProvider::start(scenario).await.unwrap();
        let ledger = Arc::new(MemoryLedger::default());
        let meter = Arc::new(Metered::new(ledger.clone(), backend(&mock.base_url())));
        let running = support::start(
            &support::config(&[]),
            Deps {
                gate: Arc::new(Gate),
                catalog: Arc::new(Fixed(catalog_for(fixture, capabilities))),
                backend: meter.clone(),
                settler: meter,
            },
        )
        .await;
        support::wait_readyz(running.admin, StatusCode::OK).await;
        Self {
            running,
            mock,
            ledger,
        }
    }

    pub async fn post(&self, path: &str, body: &str) -> (StatusCode, String) {
        let request = axum::http::Request::post(path)
            .header("host", "gateway")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_owned()))
            .unwrap();
        let response = support::send(self.running.public, request).await;
        let status = response.status();
        (status, support::text(response).await)
    }

    /// Wait for the call's ledger terminal (settle / release).
    pub async fn settled(&self) -> Option<&'static str> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(t) = self.ledger.0.lock().unwrap().terminal {
                    return t;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .ok()
    }

    pub async fn stop(self) {
        self.mock.shutdown().await;
    }
}

/// The request body for one run, `stream` set, member order preserved.
pub fn request_text(fixture: &Fixture, stream: bool) -> String {
    let J::Object(mut members) = fixture.request.clone() else {
        panic!("{}: request is an object", fixture.name);
    };
    members.push(("stream".into(), J::Bool(stream)));
    J::Object(members).to_string()
}

/// The client's SSE body as events; `:` comment lines (keep-alives) skipped.
pub fn client_events(body: &str) -> Vec<Event> {
    let mut events = Vec::new();
    for frame in body.split("\n\n").filter(|f| !f.trim().is_empty()) {
        let mut name = None;
        let mut data = String::new();
        for line in frame.lines() {
            if let Some(n) = line.strip_prefix("event: ") {
                name = Some(n.to_owned());
            } else if let Some(d) = line.strip_prefix("data: ") {
                data.push_str(d);
            }
        }
        let Some(name) = name else {
            continue;
        };
        events.push(Event::from_sse(&name, &data).unwrap_or_else(|e| panic!("{e}: {frame}")));
    }
    events
}

/// What one successful run produced, as the comparators read it.
#[derive(Debug)]
pub struct Observed {
    pub provider_request: J,
    /// The adapter events the client saw (not meta / usage / done).
    pub events: J,
    pub usage: J,
    pub finish_reason: J,
}

pub fn content_events(events: &[Event]) -> J {
    J::of(&Value::Array(
        events
            .iter()
            .filter(|e| !matches!(e, Event::Meta(_) | Event::Usage(_) | Event::Done(_)))
            .map(|e| serde_json::to_value(e).unwrap())
            .collect(),
    ))
}

/// The content events a `stream: false` reply is equivalent to.
pub fn reply_events(reply: &ChatResponse) -> J {
    let mut out = Vec::new();
    let text = reply.message.text();
    if !text.is_empty() {
        out.push(json!({"type": "delta", "text": text}));
    }
    for call in &reply.message.tool_calls {
        let mut value = serde_json::to_value(call).unwrap();
        value["type"] = json!("tool_call");
        out.push(value);
    }
    J::of(&Value::Array(out))
}

pub fn ser<T: Serialize>(value: &T) -> J {
    J::of(&serde_json::to_value(value).unwrap())
}
