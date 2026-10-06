# Changelog

## 0.2.0 — 2026-10-06

First tagged release, `sdk-v0.2.0`, versioned together with the other Free2Z
SDK packages; `0.1.0` was never tagged or published. Not on a registry yet:
pin the Git tag. Consolidated notes and the gateway compatibility matrix
(minimum `f2z-ai` gateway: zuu `d26c9397`; `reasoning_effort` needs
`b8e0c814` or later): [RELEASES.md](https://github.com/free2z/zuu/blob/sdk-v0.2.0/docs/free2z/sdk/RELEASES.md#sdk-v020--2026-10-06).

### Breaking

- Tool `parameters` and the `response_format` schema are
  `f2z_ai_proto::OrderedJson` (#1143): `serde_json::json!(…).into()` compiles
  but is already sorted — parse the schema text to keep its order.
- `ChatRequest` / `Tool` (re-exported from `f2z_ai_proto`) gained fields; a
  struct literal must name them. Prefer `ChatRequest::new` and the builders.
- `Client::grant()` returns `f2z_ai_proto::grant::Grant`, which gained
  `enforcement_reason` (#1123): a `Grant { … }` literal in a test fake must
  name it.
- `LoopbackSession` reports an opener failure as `Error::BrowserUnavailable`,
  not `Error::Browser` (#1138).

### Added and changed

- SSE `: ping` keep-alive comments (#1165) are ignored mid-stream; pinned by
  `tests/keepalive.rs`.
- `Ai::preflight(&request)` → `ai::Preflight` (`Ready`, `NeedsTopUp`,
  `NeedsBudget`, `TooLarge`): a strict estimate mapped to the recovery UX.
  A non-strict request is `Error::Config`.
- `examples/first_app.rs`: the quickstart's first app, compiled by CI.
- `ChatRequest::reasoning_effort` / `with_reasoning_effort` (via
  `f2z_ai_proto`, free2z/zuu#1151); `Capabilities::reasoning_effort` and
  `ModelInfo::controls` (`Controls { effort_levels }`) from `/v1/models`.
- Via `f2z_ai_proto`: `ChatRequest::new(model, messages)` with
  `with_max_output_tokens`, `strict`, `with_response_format`,
  `with_metadata`; `Message::{system, user, assistant, text}`;
  `Milli2z::display_2z()` (`41.500`).
- `ChatRequest::tool_choice` / `parallel_tool_calls` (via `f2z_ai_proto`,
  free2z/zuu#1128): OpenAI-shaped tool controls, opt-in; a model that cannot
  express them refuses the call before any hold.
- Tool calling (zuu#1128): `ai::tools` — `function_tool`, `tool_result`,
  `Completion::assistant_message`, `ToolCallAssembler` for `tool_call_delta`
  fragments, and `Ai::run_tools` / `run_tools_with` (the round trip, at most
  `max_rounds` paid calls, itself at most `MAX_TOOL_ROUNDS` (32), a forcing `tool_choice` on the first round only,
  calls run only from a normally finished turn; a failed round is returned
  in `ToolRun::error` with the earlier rounds, results and keys kept). `chat`/`estimate`
  refuse an out-of-limit `tools`/`tool_choice`/`parallel_tool_calls` locally
  (`Error::Config`). `Capabilities::strict_tools`.

- Tool `parameters` and the `response_format` schema are
  `f2z_ai_proto::OrderedJson` (free2z/zuu#1132): sent in the order written.
  `serde_json::json!(…).into()` still compiles but is already sorted; parse
  the schema text to keep its order.
- `ChatRequest::response_format` (via `f2z_ai_proto`): opt-in structured
  output, `ResponseFormat::JsonSchema { json_schema: JsonSchemaFormat { name,
  schema, strict } }` or `ResponseFormat::JsonObject {}`; `ResponseFormat::check`
  applies the gateway's limits locally. `Capabilities::structured_output`
  reports `/v1/models` support.

- `Error::UserCancelled` and `Error::BrowserUnavailable` (free2z/zuu#1128):
  an `AuthSession` can say the user dismissed the sheet or nothing could be
  shown, distinctly from `Error::Timeout` and the `Error::Browser` fallback.
  `LoopbackSession` now reports an opener failure as `BrowserUnavailable`.

- `SignInOptions::spend_cap` / `with_spend_cap(SpendCapHint)` and `CapPeriod`:
  an optional, additive suggested spend cap sent as `f2z_spend_cap` /
  `f2z_spend_period`. Only pre-selects the consent screen.

## 0.1.0 — source preview, never tagged

Initial reviewed SDK contract implementation, consumed as source previews by
commit (last: `534d2a58`, #1106).
