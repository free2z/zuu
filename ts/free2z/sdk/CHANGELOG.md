# Changelog

## 0.1.0 — unreleased

- `Client.preflight(request)` → `Preflight` (`ready` / `needs_top_up` /
  `needs_budget` / `too_large`): a strict estimate mapped to the recovery UX.
  Refuses a non-strict request locally (`invalid_request`).
- `SdkErrorCode` (`ServerErrorCode | LocalErrorCode`, open-ended) types
  `SdkError.code`; `message` now ends with a developer hint (`errorHint`).
- `retryable` follows `errors.md`: also `internal`, `provider_error`,
  `provider_timeout`, `too_many_holds` — and never when `details` show the
  call may have run.
- `NativeTransport` keeps the plugin's refusal `details`, amounts as `bigint`.
- `formatMilli2z` for display. Typed `Estimate`'s optional members, `CallRecord` fields,
  `CallStatus`, `FinishReason`, `Usage`, `Purchase.status` / `rail` /
  `pricing_version`.

Initial TypeScript facade, browser OAuth/Fetch transport, native pull bridge,
lossless integer decoding, purchase polling, and structured settlement recovery.

- `ChatRequest.tool_choice` (`ToolChoice`) and `ChatRequest.parallel_tool_calls`
  (free2z/zuu#1128): OpenAI-shaped tool controls, passed through as sent;
  absent is never sent.
- `Models` types the catalogue (`Model`, `ModelCapabilities`, `ModelPrices`):
  `capabilities.{vision,tools,reasoning,structured_output}` as `boolean`
  (absent = unsupported; a non-boolean is `invalid_response`), prices and
  limits as `bigint`, `includes_markup_bps`. Additive; unknown members pass through.
- `Estimate` types the budget fields the gateway sends: optional `available_milli_2z`,
  `cap_remaining_milli_2z` (`null` = uncapped), `min_charge_2z`, `catalog_version`
  as `bigint`. Additive; unknown response fields still pass through.

- Tool calling (free2z/zuu#1128): `Tool` (with `strict?`), `ToolChoice`,
  `ChatRequest.tool_choice` / `parallel_tool_calls`, and the
  `tool_call_delta` event (`ToolCallDelta`, `index` a number). Checked
  locally against the gateway's limits and rebuilt before sending; absent is
  never sent. Helpers: `toolResult`, `assistantMessage`, `collectChat`,
  `ToolCallAccumulator`, and `runTools` (caller-supplied keys per round,
  each round pinned to the starting session; failures returned in `error`
  with completed rounds kept, a charged failed round included; each handler
  gets a `ToolContext`). `ChatOptions.sessionGeneration`: a chat
  refused with `signed_out` unless the session is still that one.

- `NativeSignInErrorCode` (free2z/zuu#1128): a native sign-in that ends at
  the browser rejects with `user_cancelled`, `browser_unavailable`, `timeout`
  or the `browser_error` fallback, passed through unchanged.
- `ChatRequest.response_format` (`ResponseFormat`): opt-in structured output,
  `json_schema` (`name`, `schema`, `strict?`) or `json_object`. Checked locally
  against the gateway's limits and rebuilt member by member before sending;
  absent is never sent. The native transport passes the schema as plain JSON.
- `ChatRequest.max_output_tokens_strict` (free2z/zuu#1122): opt in to a refusal
  before any hold or charge instead of a gateway-lowered output limit. Sent only
  when `true`; requires `max_output_tokens`.
- `SignInOptions.spendCap` (`SpendCapHint`, `CapPeriod`): an optional, additive
  suggested spend cap sent as `f2z_spend_cap` / `f2z_spend_period`.
  Only pre-selects the consent screen; read the result from
  `grant()`.
