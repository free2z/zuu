# Changelog

## 0.2.0 — 2026-10-06

First tagged release, `sdk-v0.2.0`, versioned together with the other Free2Z
SDK packages; `0.1.0` was never tagged or published. Not on a registry yet:
pin the Git tag. Consolidated notes and the gateway compatibility matrix
(minimum `f2z-ai` gateway: zuu `d26c9397`; `reasoning_effort` needs
`b8e0c814` or later): [RELEASES.md](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/RELEASES.md#sdk-v020--2026-10-06).

### Breaking

- `Tool::parameters` and `JsonSchemaFormat::schema` are `OrderedJson`, not
  `serde_json::Value` (#1143). Parse schema text
  (`"…".parse::<OrderedJson>()`) to keep its order; `OrderedJson::from(json!(…))`
  compiles but is already sorted.
- `ChatRequest` gained `max_output_tokens_strict`, `response_format`,
  `tool_choice`, `parallel_tool_calls` and `reasoning_effort`, and `Tool`
  gained `strict`: a struct literal must name them. Prefer
  `ChatRequest::new` and the builders.

### Added and changed

- `ErrorEvent` documentation (#1171): a provider that accepted the request
  and then failed settles the call for what it is owed (`meta` precedes the
  `error`); only a provider refusal is a lone, uncharged `error`.
- `ChatRequest::new(model, messages)` and builders (`with_max_output_tokens`,
  `strict`, `with_response_format`, `with_metadata`); `Message::{system,
  user, assistant, text}`. A request built this way keeps compiling as the
  contract gains additive fields.
- `Milli2z::display_2z()` (`Display2z`): exact `41.500` display text.
- `ChatRequest::reasoning_effort` (`ReasoningEffort`: `minimal`, `low`,
  `medium`, `high`; builder `with_reasoning_effort`) — free2z/zuu#1151, effort
  only: opt-in, omitted on the wire when absent; any other string, another
  case or a present `null` is refused at decode, and the error never quotes
  the value.
- `ModelCapabilities::reasoning_effort` (signed, absent = `false`, not
  serialized when `false`) and `CatalogModel::controls` (`ModelControls {
  effort_levels }`, absent = not narrowed, an unknown level string is kept
  and inert).
- `ChatRequest::tool_choice` (`ToolChoice`: `"auto"`, `"none"`, `"required"`,
  `{"type":"function","function":{"name":…}}`) and
  `ChatRequest::parallel_tool_calls` (free2z/zuu#1128): OpenAI's shapes,
  opt-in, omitted on the wire when absent; a present `null`, another string,
  another `type` or an extra member is refused at decode.
- Tool calling, OpenAI-compatible slice (zuu#1128): `Tool::strict` (omitted
  when absent, refused when `null`). `ChatRequest::check_tools`
  holds the structural limits (`MAX_TOOLS` 128, names 1–64 of `[A-Za-z0-9_-]`
  and unique, `MAX_TOOL_SCHEMA_BYTES` 32 KiB, controls only beside `tools`).
  New `tool_call_delta` event (`event::ToolCallDelta`, `KNOWN_EVENTS` now 7):
  streamed argument fragments ahead of the authoritative `tool_call`.
  `ModelCapabilities::strict_tools`: tri-state like `structured_output`.

- `json::OrderedJson` (re-exported at the root): caller JSON that keeps its
  object member order. `Tool::parameters` and `JsonSchemaFormat::schema` are
  now `OrderedJson`, not `serde_json::Value`, so a schema reaches the provider
  in the order it was written (free2z/zuu#1132). Build one with
  `"…".parse::<OrderedJson>()` (keeps order) or `OrderedJson::from(value)`
  (keeps the `Value`'s order, i.e. sorted without `preserve_order`).
  Serialized bytes for a request whose schemas were already sorted are
  unchanged.
- `ChatRequest::response_format` — opt-in structured output
  (`{"type":"json_schema","json_schema":{name,schema,strict?}}` or
  `{"type":"json_object"}`), omitted on the wire when absent. Limits in
  `ResponseFormat::check`: name 1–64 of `[A-Za-z0-9_-]`, schema a JSON object
  of at most `MAX_RESPONSE_SCHEMA_BYTES` (32 KiB). Any other `type` is refused.
- `ModelCapabilities::structured_output`: optional, tri-state signed catalogue
  declaration (absent = the gateway's interim rule; `null` refused).
