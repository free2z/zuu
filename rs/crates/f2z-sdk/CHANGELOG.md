# Changelog

## 0.1.0 — unreleased

Initial reviewed SDK contract implementation. Publication is disabled pending
release acceptance; see the repository SDK release guide.

- `Ai::preflight(&request)` → `ai::Preflight` (`Ready`, `NeedsTopUp`,
  `NeedsBudget`, `TooLarge`): a strict estimate mapped to the recovery UX.
  A non-strict request is `Error::Config`.
- `examples/first_app.rs`: the quickstart's first app, compiled by CI.
- Via `f2z_ai_proto`: `ChatRequest::new(model, messages)` with
  `with_max_output_tokens`, `strict`, `with_response_format`,
  `with_metadata`; `Message::{system, user, assistant, text}`;
  `Milli2z::display_2z()` (`41.500`).

- `ChatRequest::response_format` (via `f2z_ai_proto`): opt-in structured
  output, `ResponseFormat::JsonSchema { json_schema: JsonSchemaFormat { name,
  schema, strict } }` or `ResponseFormat::JsonObject {}`; `ResponseFormat::check`
  applies the gateway's limits locally. `Capabilities::structured_output`
  reports `/v1/models` support.

- `SignInOptions::spend_cap` / `with_spend_cap(SpendCapHint)` and `CapPeriod`:
  an optional, additive suggested spend cap sent as `f2z_spend_cap` /
  `f2z_spend_period`. Only pre-selects the consent screen.
