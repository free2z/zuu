# Changelog

## 0.1.0 — unreleased

Initial reviewed SDK contract implementation. Publication is disabled pending
release acceptance; see the repository SDK release guide.

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
