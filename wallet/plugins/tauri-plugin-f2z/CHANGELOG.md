# Changelog

## 0.4.0 — unreleased

Apps don't sell 2Z. Not tagged yet. Links `f2z-sdk`
0.4.0; guest-js is `@free2z/tauri-plugin-f2z-api` 0.4.0.
`Builder::new(config, checkout_return)` is unchanged.

### Added

- Commands `billing_url` and `open_billing` (guest `billingUrl()`,
  `openBilling()`): the user's Free2Z billing page,
  `{web origin}/buy-2z?client_id=…`, built from native configuration and
  opened in the system browser; neither takes a URL from JavaScript.
  **Opt-in:** reachable only through the explicit permissions
  `f2z:allow-billing-url` / `f2z:allow-open-billing`, which `f2z:default`
  does not include. A Google Play build, or an iOS build outside the US
  storefront, must not grant them.

### Deprecated

- `create_purchase`, `purchase`, `wait_for_purchase` and `open_checkout`
  (guest `createPurchase`, `purchase`, `waitForPurchase`, `openCheckout`):
  apps don't sell 2Z. They keep working for apps whose session holds
  `purchase:create`.

## 0.3.0 — 2026-10-15

Tagged `sdk-v0.3.0` with the other Free2Z SDK packages. Not on a registry:
pin the Git tag. Consolidated notes and compatibility: [RELEASES.md](https://github.com/free2z/zuu/blob/sdk-v0.3.0/docs/free2z/sdk/RELEASES.md#sdk-v030--2026-10-15).

Links `f2z-sdk` 0.3.0; guest-js is `@free2z/tauri-plugin-f2z-api` 0.3.0.

### Added

- `session` reports `preferredUsername` and `name` when `profile` was granted
  (omitted otherwise, never `null`).
- Sign-in option `ephemeral` (default `false`): iOS
  `prefersEphemeralWebBrowserSession`; Android an ephemeral Custom Tab where
  the browser supports one; ignored on desktop. An older plugin refuses it as
  an unknown option.
- Commands `manage_account_url`, `delete_account_url`, `open_manage_account`
  and `open_delete_account` (guest `manageAccountUrl()`, `deleteAccountUrl()`,
  `openManageAccount()`, `openDeleteAccount()`). URLs come from native
  configuration; the `open_*` commands use the system browser (Android
  `ACTION_VIEW`, not a Custom Tab). Grant `f2z:allow-…` for each one used.
- `report_call` command (permission `f2z:allow-report-call`) and guest-js
  `nativeBridge.reportCall(callId, reason, detail?)` with the `ReportReason`
  and `CallReport` types. Arguments are checked natively first:
  `invalid_request` with `details.field` (`call_id`, `reason`, `detail`);
  with a child-directed core `Config`, any `detail` is refused the same way.

### Changed

- Android: `androidx.browser` 1.8.0 → 1.9.0 (ephemeral Custom Tabs), and the
  library manifest queries `CustomTabsService` so the provider can be found on
  API 30+.

## 0.2.0 — 2026-10-06

First tagged release, `sdk-v0.2.0`, versioned together with the other Free2Z
SDK packages; `0.1.0` was never tagged or published. Not on a registry yet:
pin the Git tag. Consolidated notes and the gateway compatibility matrix
(minimum `f2z-ai` gateway: zuu `d26c9397`; `reasoning_effort` needs
`b8e0c814` or later): [RELEASES.md](https://github.com/free2z/zuu/blob/sdk-v0.2.0/docs/free2z/sdk/RELEASES.md#sdk-v020--2026-10-06).

### Breaking

- The plugin enables `serde_json`'s `preserve_order`, and Cargo unifies it
  into the host app (#1143): every `serde_json::Map` in the app keeps
  insertion order instead of sorting.
- Sign-in rejects with `user_cancelled` / `browser_unavailable` / `timeout`
  where it used to say `browser_error` (still the fallback) (#1138).
- Links `f2z-sdk` 0.2.0; guest-js is `@free2z/tauri-plugin-f2z-api` 0.2.0.

### Added and changed

- Errors carry the server's documented refusal `details` (`required_2z`,
  `available_milli_2z`, `cap_remaining_milli_2z`, `resets_at`, `reason`,
  `field`, …; integers as decimal strings). Undocumented members are dropped.
- `ChatRequest.tool_choice` / `parallel_tool_calls` pass through to the
  gateway (free2z/zuu#1128).
- Tool calling (free2z/zuu#1128): guest `Tool` (`strict?`), `ToolChoice`,
  `tool_choice`, `parallel_tool_calls`, and the `tool_call_delta` stream event
  (`index` a decimal string). `start_chat`/`estimate` refuse an out-of-limit
  tool request with `invalid_request` before the call is registered.
  `ChatOperation.sessionGeneration` (optional): registration refuses with
  `session_changed` unless the session is still that one.
- `ChatRequest.reasoning_effort` passes through to the gateway
  (free2z/zuu#1151); an unknown level is `invalid_request` before the call
  is registered. Guest types gain `ModelCapabilities.reasoning_effort` and
  `CatalogModel.controls.effort_levels`.
- Tool `parameters` and `response_format` schemas reach the gateway with
  their member order intact (free2z/zuu#1132): the plugin enables serde_json's
  `preserve_order`, which Cargo unifies into the host app.
- `ChatRequest.max_output_tokens_strict` passes through to the gateway
  (free2z/zuu#1122): refuse before any hold or charge instead of lowering
  `max_output_tokens`.
- `signIn({ spendCap, spendPeriod })`: an optional, additive suggested spend
  cap for the consent screen.
- `ChatRequest.response_format` passes through to the gateway: opt-in
  structured output (`json_schema` / `json_object`), plain JSON over IPC.
- `ModelCatalog.models` is typed (`CatalogModel`, `ModelCapabilities`):
  `capabilities.structured_output`/`tools`/`vision`/`reasoning` are booleans;
  limits are decimal strings. Types only; the IPC value is unchanged.
- Sign-in rejections say why the browser step ended (free2z/zuu#1128):
  `user_cancelled` (iOS `ASWebAuthenticationSession` cancel, Android Custom Tab
  dismissal), `browser_unavailable`, `timeout`. `browser_error` stays the
  fallback for anything else; the guest API exports `SignInErrorCode`.

## 0.1.0 — source preview, never tagged

- Native Free2Z sign-in/session, exact balance, card/Zcash purchase and AI APIs.
- OS credential storage and system browser adapters for desktop, iOS and Android.
- Explicit command permissions and bounded, window/account-scoped pull streams.
- Caller-owned recovery keys and lossless decimal quantities across IPC.
