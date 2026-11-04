# Changelog

## 0.4.0 — 2026-10-16

Apps don't sell 2Z. Tagged `sdk-v0.4.0` with the other Free2Z SDK packages.
Not on a registry: pin the Git tag. Consolidated notes:
[RELEASES.md](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/RELEASES.md#sdk-v040--2026-10-16).

### Breaking

- `DEFAULT_SCOPES` no longer includes `purchase:create`. A web app that
  relied on the default scopes and still calls `createPurchase` now gets
  `insufficient_scope`: list `purchase:create` in `FetchConfig.scopes`, or
  move to `openBilling()`.
- The optional peer is `@free2z/tauri-plugin-f2z-api@^0.4.0`.

### Added

- `Client.billingUrl()` / `Client.openBilling()`:
  `{web origin}/buy-2z?client_id=<percent-encoded id>`, the user's Free2Z
  billing page (Zcash first, card second), opened through
  `FetchConfig.openExternal` on the web and the plugin's `open_billing`
  natively. Opt-in: web, direct-download desktop and Apple-US-storefront
  builds only. `unsupported_operation` from a transport or bridge without
  them. `Transport` and `NativeBridge` gained them as optional members.
- `manageAccountUrl()` / `openManageAccount()` are unchanged and stay
  purchase-free.

### Deprecated

- `Client.createPurchase`, `purchase`, `waitForPurchase`, `openCheckout`,
  the `PurchaseRequest` type and `FetchConfig.purchaseReturnUri`. They keep
  working for apps that request `purchase:create`; card only.

### Changed

- The `insufficient_balance` and `account_in_debt` hints, and the
  `needs_top_up` docs, send the user to Free2Z billing, or Manage in store
  builds.

## 0.3.0 — 2026-10-15

Tagged `sdk-v0.3.0` with the other Free2Z SDK packages. Not on a registry:
pin the Git tag. Consolidated notes and compatibility: [RELEASES.md](https://github.com/free2z/zuu/blob/sdk-v0.3.0/docs/free2z/sdk/RELEASES.md#sdk-v030--2026-10-15).

### Breaking

- The optional peer is `@free2z/tauri-plugin-f2z-api@^0.3.0`; under 0.x
  semver a 0.2.0 guest-js build no longer satisfies it.

### Added

- `Session.preferredUsername` / `Session.name`: present only when `profile`
  was granted (native: when the plugin reports them; web: from the verified ID
  token, dropped when a refresh no longer grants `profile`).
- Web `prompt: "login"` sign-in requires a fresh `auth_time` in the ID token
  (`invalid_response` otherwise; the issued family is revoked). Display names
  drop bidi controls and marks.
- `SignInOptions.ephemeral` for `NativeTransport` (needs a plugin with it);
  `FetchTransport` refuses it with `invalid_request`.
- `Client.manageAccountUrl()`, `openManageAccount()`, `deleteAccountUrl()`,
  `openDeleteAccount()`. `unsupported_operation` from a transport or native
  bridge without them; against a Rust plugin without these commands the call
  rejects with that plugin's native error. `FetchConfig.webOrigin` (default: the issuer's origin); the
  web `open…` methods use `openExternal`.
- `Transport` gained the four as optional members, so custom transports keep
  compiling.
- `Client.reportCall(callId, reason, detail?, signal?)` → `CallReport`, on
  `FetchTransport` and `NativeTransport` (which needs a plugin with
  `reportCall`; `unsupported_operation` without it). `Transport.reportCall`
  is optional, so custom transports keep compiling. A bad argument is
  `invalid_request` with `details.field` before anything is sent.
  `REPORT_DETAIL_MAX_CHARS` exported; `not_found` added to `ServerErrorCode`.
  `FetchConfig.childDirected`: a child-directed web app's `reportCall` refuses
  any `detail` locally.

## 0.2.0 — 2026-10-06

First tagged release, `sdk-v0.2.0`, versioned together with the other Free2Z
SDK packages; `0.1.0` was never tagged or published. Not on a registry yet:
pin the Git tag. Consolidated notes and the gateway compatibility matrix
(minimum `f2z-ai` gateway: zuu `d26c9397`; `reasoning_effort` needs
`b8e0c814` or later): [RELEASES.md](https://github.com/free2z/zuu/blob/sdk-v0.2.0/docs/free2z/sdk/RELEASES.md#sdk-v020--2026-10-06).

### Breaking

- `SdkError.code` is typed `SdkErrorCode`, `message` ends with a developer
  hint, and `retryable` follows `errors.md` (#1136).
- A non-boolean value for a known `capabilities` member (`vision`, `tools`,
  `reasoning`, `structured_output`, `strict_tools`, `reasoning_effort`) is now
  `invalid_response`; unknown members still pass through; catalogue prices and limits decode as `bigint` (#1137).
- Native sign-in rejects with `user_cancelled` / `browser_unavailable` /
  `timeout` where it used to say `browser_error` (#1138).
- The `ChatEvent` union gained `tool_call_delta` (#1142): an exhaustive
  `switch` with a `never` check must handle it.
- The optional peer is `@free2z/tauri-plugin-f2z-api@^0.2.0`; a 0.1.0 guest-js
  build no longer satisfies it.

### Added and changed

- `ChatRequest.reasoning_effort` (`ReasoningEffort`: `"minimal" | "low" |
  "medium" | "high"`, free2z/zuu#1151): sent only when set; any other value is
  refused locally (`invalid_request`) on both transports.
  `ModelCapabilities.reasoning_effort` and `Model.controls`
  (`ModelControls.effort_levels`) are decoded from `/v1/models`.
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
  `ToolCallAccumulator`, and `runTools` (`maxRounds` at most
  `MAX_TOOL_ROUNDS`, 32; caller-supplied keys per round,
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

## 0.1.0 — source preview, never tagged

Initial TypeScript facade, browser OAuth/Fetch transport, native pull bridge,
lossless integer decoding, purchase polling, and structured settlement recovery.
