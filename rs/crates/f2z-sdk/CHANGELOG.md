# Changelog

## 0.4.0 — unreleased

Apps don't sell 2Z. Not tagged yet: `sdk-v0.4.0` follows
once Free2Z's `/buy-2z` deep link is live. Consolidated notes:
[RELEASES.md](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/RELEASES.md#sdk-v040--unreleased).

Links `f2z-ai-proto` 0.3.0 (the wire contract is unchanged).

### Breaking

- `DEFAULT_SCOPES` (and so `Config::new`) no longer includes
  `purchase:create`. An app that relied on the default scopes and still calls
  `create_purchase` now gets `403 insufficient_scope`: list `purchase:create`
  with `Config::with_scopes`, or move to `Client::billing_url()`.

### Added

- `Client::billing_url()`: `{web origin}/buy-2z?client_id=…` with the
  `client_id` percent-encoded, precomputed by `Config` like
  `manage_account_url`. The user's Free2Z billing page (Zcash first, card
  second). Opt-in: web, direct-download desktop and Apple-US-storefront builds
  only; store builds show `manage_account_url()`, which is unchanged and stays
  purchase-free.

### Deprecated

- `Client::create_purchase`, `Client::purchase`, `Client::wait_for_purchase`,
  `purchase::PurchaseRequest` and `purchase::ReturnListener`
  (`#[deprecated(since = "0.4.0")]`). They keep working for apps that request
  `purchase:create`; card only.

### Changed

- The `Preflight::NeedsTopUp` and AI docs, and `examples/first_app.rs` /
  `full_flow.rs`, send the user to Free2Z billing (or Manage in a store
  build) instead of presenting a card purchase.

## 0.3.0 — 2026-10-15

Tagged `sdk-v0.3.0` with the other Free2Z SDK packages. Not on a registry:
pin the Git tag. Consolidated notes and compatibility: [RELEASES.md](https://github.com/free2z/zuu/blob/sdk-v0.3.0/docs/free2z/sdk/RELEASES.md#sdk-v030--2026-10-15).

Links `f2z-ai-proto` 0.3.0.

### Added

- `Client::profile()` and `SignedIn::profile`: the signed-in account's
  `preferred_username` and `name` (`f2z_sdk::Profile`), from the verified ID
  token, only when `profile` was granted. Stored with the session (additive
  members of the stored blob, ignored by older SDKs), so it survives a restart;
  a refresh that no longer grants `profile` drops it; sign-out clears it.
- `Client::manage_account_url()` (`{web origin}/account/apps?client_id=…`),
  `Client::delete_account_url()` (`{web origin}/account/delete`) and
  `Client::web_origin()`. The origin is the issuer's unless
  `Config::with_web_origin` sets one (`Config::web_origin`).
- Sign-out and sign-in also drop the cached model catalogue, and a catalogue
  read under one session is never revalidated or installed for another.
- A `prompt=login` sign-in requires the ID token's `auth_time` to be at or
  after the sign-in's start (60 s skew); otherwise `Error::IdToken`, nothing is
  installed, and the issued refresh token is revoked.
- `prompt=login` requires the `openid` scope (`Error::Config` before the
  browser opens), and its ID token must be present.
- Display names drop bidi controls and marks (U+200E, U+200F, U+061C,
  U+202A–U+202E, U+2066–U+2069).
- `Ai::report_call(call_id, ReportReason, Option<&str>) -> CallReport`: the
  user reports a call's AI output in the app (Google Play AI-Generated Content
  policy, App Store 4.7). Free2Z keeps the reference and reason, never the
  content; the developer (`GET /api/oauth/apps/{app_id}/reports/`) and Free2Z moderation see it, `unsafe`
  alerts Free2Z staff. A bad reason or `detail` is `Error::Config` before
  anything is sent. `f2z_sdk::ai::{ReportReason, CallReport}` re-exported.
- `Config::child_directed` / `with_child_directed` and `Client::child_directed()`:
  match the app's Free2Z registration; `report_call` then refuses any `detail`
  locally.

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
