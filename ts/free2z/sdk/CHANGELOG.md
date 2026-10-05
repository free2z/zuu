# Changelog

## 0.1.0 — unreleased

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
