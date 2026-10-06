# Changelog

## 0.2.0 — 2026-10-06

First tagged release, `sdk-v0.2.0`, versioned together with the other Free2Z
SDK packages; `0.1.0` was never tagged or published. Not on a registry yet:
pin the Git tag. Consolidated notes and the gateway compatibility matrix
(minimum `f2z-ai` gateway: zuu `d26c9397`; `reasoning_effort` needs
`b8e0c814` or later): [RELEASES.md](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/RELEASES.md#sdk-v020--2026-10-06).

### Breaking

- The plugin enables `serde_json`'s `preserve_order`, and Cargo unifies it
  into the host app (#1143): every `serde_json::Map` in the app keeps
  insertion order instead of sorting.
- Sign-in rejects with `user_cancelled` / `browser_unavailable` / `timeout`
  where it used to say `browser_error` (still the fallback) (#1138).
- Refusal `details` carry only the documented members, integers as decimal
  strings; undocumented members are dropped (#1136).
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
