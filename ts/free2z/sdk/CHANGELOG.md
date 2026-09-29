# Changelog

## 0.1.0 — unreleased

Initial TypeScript facade, browser OAuth/Fetch transport, native pull bridge,
lossless integer decoding, purchase polling, and structured settlement recovery.

- `ChatRequest.max_output_tokens_strict` (free2z/zuu#1122): opt in to a refusal
  before any hold or charge instead of a gateway-lowered output limit. Sent only
  when `true`; requires `max_output_tokens`.
