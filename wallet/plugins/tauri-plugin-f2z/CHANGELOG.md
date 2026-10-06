# Changelog

## 0.1.0 (unreleased)

- Errors carry the server's documented refusal `details` (`required_2z`,
  `available_milli_2z`, `cap_remaining_milli_2z`, `resets_at`, `reason`,
  `field`, …; integers as decimal strings). Undocumented members are dropped.
- `ChatRequest.tool_choice` / `parallel_tool_calls` pass through to the
  gateway (free2z/zuu#1128).
- `ChatRequest.reasoning_effort` passes through to the gateway
  (free2z/zuu#1151); an unknown level is `invalid_request` before the call
  is registered. Guest types gain `ModelCapabilities.reasoning_effort` and
  `CatalogModel.controls.effort_levels`.
- Native Free2Z sign-in/session, exact balance, card/Zcash purchase and AI APIs.
- OS credential storage and system browser adapters for desktop, iOS and Android.
- Explicit command permissions and bounded, window/account-scoped pull streams.
- Caller-owned recovery keys and lossless decimal quantities across IPC.
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
