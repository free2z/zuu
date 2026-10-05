# Changelog

## 0.1.0 (unreleased)

- Native Free2Z sign-in/session, exact balance, card/Zcash purchase and AI APIs.
- OS credential storage and system browser adapters for desktop, iOS and Android.
- Explicit command permissions and bounded, window/account-scoped pull streams.
- Caller-owned recovery keys and lossless decimal quantities across IPC.
- `ChatRequest.max_output_tokens_strict` passes through to the gateway
  (free2z/zuu#1122): refuse before any hold or charge instead of lowering
  `max_output_tokens`.
- `signIn({ spendCap, spendPeriod })`: an optional, additive suggested spend
  cap for the consent screen.
- `ChatRequest.response_format` passes through to the gateway: opt-in
  structured output (`json_schema` / `json_object`), plain JSON over IPC.
- Sign-in rejections say why the browser step ended (free2z/zuu#1128):
  `user_cancelled` (iOS `ASWebAuthenticationSession` cancel, Android Custom Tab
  dismissal), `browser_unavailable`, `timeout`. `browser_error` stays the
  fallback for anything else; the guest API exports `SignInErrorCode`.
