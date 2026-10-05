# Changelog

## 0.1.0 — unreleased

Initial reviewed SDK contract implementation. Publication is disabled pending
release acceptance; see the repository SDK release guide.

- `ChatRequest::tool_choice` (`ToolChoice`: `"auto"`, `"none"`, `"required"`,
  `{"type":"function","function":{"name":…}}`) and
  `ChatRequest::parallel_tool_calls` (free2z/zuu#1128): OpenAI's shapes,
  opt-in, omitted on the wire when absent; a present `null`, another string,
  another `type` or an extra member is refused at decode.
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
