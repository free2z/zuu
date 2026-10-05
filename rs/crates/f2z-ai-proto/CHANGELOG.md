# Changelog

## 0.1.0 — unreleased

Initial reviewed SDK contract implementation. Publication is disabled pending
release acceptance; see the repository SDK release guide.

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

- `ChatRequest::response_format` — opt-in structured output
  (`{"type":"json_schema","json_schema":{name,schema,strict?}}` or
  `{"type":"json_object"}`), omitted on the wire when absent. Limits in
  `ResponseFormat::check`: name 1–64 of `[A-Za-z0-9_-]`, schema a JSON object
  of at most `MAX_RESPONSE_SCHEMA_BYTES` (32 KiB). Any other `type` is refused.
- `ModelCapabilities::structured_output`: optional, tri-state signed catalogue
  declaration (absent = the gateway's interim rule; `null` refused).
